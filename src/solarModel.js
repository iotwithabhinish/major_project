// Solar generation model for a small PV panel.
//
// 1. Irradiance on the panel plane (POA) at 15-minute resolution from Open-Meteo
//    (global_tilted_irradiance for the panel's tilt and azimuth). Clouds are
//    already included in this value, so they are NOT applied a second time.
// 2. Cell temperature with the Faiman model: Tc = Ta + G / (U0 + U1 * wind).
// 3. DC power: P = Prated * G/1000 * (1 + gamma*(Tc - 25)) * lowLight(G).
// 4. A system factor k learned from the panel's own measurements (robust median
//    of measured / modelled), which absorbs shading, dust, wiring and the fact
//    that a small panel feeding a load rarely runs at its maximum power point.
// 5. Short-term correction: the current measured/predicted ratio is carried into
//    the next hours and decays back to the model (passing clouds persist).

const env = import.meta.env ?? {}
const numberOr = (value, fallback) => (value === undefined || value === '' || !Number.isFinite(Number(value)) ? fallback : Number(value))

const latitude = numberOr(env.VITE_SOLAR_LAT, 12.9716)
export const SOLAR_CONFIG = {
  latitude,
  longitude: numberOr(env.VITE_SOLAR_LON, 77.5946),
  ratedWatts: numberOr(env.VITE_SOLAR_RATED_WATTS, 1),
  // Tilt from horizontal in degrees. A fixed panel tilted at about the latitude is the usual choice.
  tilt: numberOr(env.VITE_SOLAR_TILT, Math.round(Math.abs(latitude))),
  // Open-Meteo convention: 0 = facing south, -90 = east, 90 = west, 180 = north.
  azimuth: numberOr(env.VITE_SOLAR_AZIMUTH, latitude >= 0 ? 0 : 180),
  // Power temperature coefficient in %/°C (crystalline silicon is about -0.4).
  tempCoeffPercent: numberOr(env.VITE_SOLAR_TEMP_COEFF, -0.4),
  // Highest open-circuit voltage the panel can produce ("3.7 V" panels are ~4.5-6 V).
  maxVolts: numberOr(env.VITE_SOLAR_MAX_VOLTS, 8),
}

// Rejects physically impossible readings (floating ADC pin, wiring fault) so they
// are never plotted as real output or used for calibration.
export const isPlausibleReading = ({ power, voltage }, config = SOLAR_CONFIG) =>
  Number.isFinite(power) && power >= 0 && power <= config.ratedWatts * 1.5 + 0.05 &&
  (!Number.isFinite(voltage) || voltage <= config.maxVolts)

const FAIMAN_U0 = 25     // W/(m²·K)
const FAIMAN_U1 = 6.84   // W·s/(m³·K)
const DEFAULT_SYSTEM_FACTOR = 0.8
const DEFAULT_SPREAD = 0.25
const PRIOR_SAMPLES = 10
const NOWCAST_TAU_MS = 90 * 60 * 1000
const FIFTEEN_MIN = 15 * 60 * 1000
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export const weatherUrl = (config = SOLAR_CONFIG) => 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
  latitude: config.latitude,
  longitude: config.longitude,
  minutely_15: 'global_tilted_irradiance,shortwave_radiation,temperature_2m,wind_speed_10m,cloud_cover',
  tilt: config.tilt,
  azimuth: config.azimuth,
  past_days: 2,
  forecast_days: 2,
  wind_speed_unit: 'ms',
  timeformat: 'unixtime',
  timezone: 'GMT',
})

// Converts the Open-Meteo response into [{ time, poa, ghi, temperature, wind, cloudCover }].
// Radiation values are averages over the preceding 15 minutes, so each point is
// placed at the middle of its interval (-7.5 min) to line up with measurements.
export const parseWeather = (data) => {
  const block = data?.minutely_15
  if (!block?.time?.length) throw new Error('Weather data is incomplete')
  return block.time.map((seconds, index) => ({
    time: seconds * 1000 - FIFTEEN_MIN / 2,
    poa: Math.max(0, Number(block.global_tilted_irradiance?.[index] ?? block.shortwave_radiation?.[index]) || 0),
    ghi: Math.max(0, Number(block.shortwave_radiation?.[index]) || 0),
    temperature: Number(block.temperature_2m?.[index] ?? 25),
    wind: Math.max(0, Number(block.wind_speed_10m?.[index]) || 0),
    cloudCover: Number(block.cloud_cover?.[index] ?? 0),
  })).filter((point) => Number.isFinite(point.time))
}

export const cellTemperature = (poa, airTemperature, wind) => airTemperature + poa / (FAIMAN_U0 + FAIMAN_U1 * wind)

// Relative efficiency drop at low light (small panels lose efficiency in dim light).
const lowLightFactor = (poa) => (poa <= 0 ? 0 : clamp(1 + 0.03 * Math.log(poa / 1000), 0.75, 1.02))

// Physical model output before calibration (k = 1).
export const modelPower = (point, config = SOLAR_CONFIG) => {
  if (!point || point.poa <= 0) return 0
  const cellTemp = cellTemperature(point.poa, point.temperature, point.wind)
  const temperatureFactor = 1 + (config.tempCoeffPercent / 100) * (cellTemp - 25)
  return Math.max(0, config.ratedWatts * (point.poa / 1000) * temperatureFactor * lowLightFactor(point.poa))
}

// Linear interpolation of the weather series at any timestamp.
export const weatherAt = (series, time) => {
  if (!series.length || time < series[0].time || time > series.at(-1).time) return null
  let low = 0, high = series.length - 1
  while (high - low > 1) {
    const middle = (low + high) >> 1
    if (series[middle].time <= time) low = middle; else high = middle
  }
  const a = series[low], b = series[high]
  const f = b.time === a.time ? 0 : (time - a.time) / (b.time - a.time)
  const mix = (key) => a[key] + (b[key] - a[key]) * f
  return { time, poa: mix('poa'), ghi: mix('ghi'), temperature: mix('temperature'), wind: mix('wind'), cloudCover: mix('cloudCover') }
}

const median = (values) => {
  if (!values.length) return NaN
  const sorted = [...values].sort((x, y) => x - y)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// Learns the system factor k from measured history: [{ time, power }].
// Only clear daylight samples are used (POA >= 150 W/m²). The result is blended
// with a prior so a handful of samples cannot swing it wildly.
export const calibrate = (history, series, { before = Infinity, config = SOLAR_CONFIG } = {}) => {
  const ratios = []
  for (const sample of history) {
    if (sample.time >= before) continue
    const weather = weatherAt(series, sample.time)
    if (!weather || weather.poa < 150) continue
    const modelled = modelPower(weather, config)
    if (modelled < config.ratedWatts * 0.03) continue
    ratios.push(sample.power / modelled)
  }
  const samples = ratios.length
  if (samples < 3) return { factor: DEFAULT_SYSTEM_FACTOR, spread: DEFAULT_SPREAD, samples, learned: false }
  const measuredFactor = clamp(median(ratios), 0.02, 1.5)
  const weight = samples / (samples + PRIOR_SAMPLES)
  const factor = weight * measuredFactor + (1 - weight) * DEFAULT_SYSTEM_FACTOR
  // Robust relative spread (1.4826 * MAD) of the residuals.
  const residuals = ratios.map((ratio) => ratio / factor - 1)
  const mad = median(residuals.map((value) => Math.abs(value - median(residuals))))
  const spread = clamp(weight * 1.4826 * mad + (1 - weight) * DEFAULT_SPREAD, 0.05, 0.6)
  return { factor, spread, samples, learned: true }
}

// Latest measured / predicted ratio, used to steer the next hours.
export const nowcastRatio = (latest, series, calibration, now, config = SOLAR_CONFIG) => {
  if (!latest || now - latest.time > 10 * 60 * 1000) return null
  const weather = weatherAt(series, latest.time)
  if (!weather || weather.poa < 100) return null
  const expected = calibration.factor * modelPower(weather, config)
  if (expected < config.ratedWatts * 0.02) return null
  return clamp(latest.power / expected, 0.2, 2)
}

// Predicted power (with an 80 % range) for every 15-minute step in [start, end).
export const predictRange = (series, calibration, { start, end, now, ratio = null, config = SOLAR_CONFIG }) => {
  const points = []
  for (let time = start; time < end; time += FIFTEEN_MIN / 3) {   // 5-minute resolution
    const weather = weatherAt(series, time)
    if (!weather) continue
    const base = calibration.factor * modelPower(weather, config)
    const ahead = time - now
    const decay = ratio !== null && ahead > 0 ? Math.exp(-ahead / NOWCAST_TAU_MS) : 0
    const power = base * (1 + ((ratio ?? 1) - 1) * decay)
    // Uncertainty is smallest right after a measurement and grows with horizon.
    const spread = calibration.spread * (ratio !== null && ahead > 0 ? 0.5 + 0.5 * (1 - decay) : 1)
    points.push({ time, power, low: Math.max(0, power * (1 - 1.28 * spread)), high: power * (1 + 1.28 * spread), weather })
  }
  return points
}

// Energy (Wh) under a power curve, skipping gaps longer than 20 minutes.
export const energyWh = (points, key = 'power') => {
  let total = 0
  for (let index = 1; index < points.length; index++) {
    const dt = points[index].time - points[index - 1].time
    if (dt <= 0 || dt > 20 * 60 * 1000) continue
    total += ((points[index][key] + points[index - 1][key]) / 2) * (dt / 3600000)
  }
  return total
}

// Accuracy of the (calibrated, no-nowcast) model against measurements in [start, end).
export const accuracy = (history, series, calibration, { start, end, config = SOLAR_CONFIG }) => {
  const pairs = []
  for (const sample of history) {
    if (sample.time < start || sample.time >= end) continue
    const weather = weatherAt(series, sample.time)
    if (!weather || (weather.poa < 20 && sample.power < 0.005)) continue   // night
    pairs.push([sample.power, calibration.factor * modelPower(weather, config)])
  }
  if (pairs.length < 6) return null
  const n = pairs.length
  const meanMeasured = pairs.reduce((sum, [measured]) => sum + measured, 0) / n
  const mae = pairs.reduce((sum, [m, p]) => sum + Math.abs(m - p), 0) / n
  const rmse = Math.sqrt(pairs.reduce((sum, [m, p]) => sum + (m - p) ** 2, 0) / n)
  const totalVariance = pairs.reduce((sum, [m]) => sum + (m - meanMeasured) ** 2, 0)
  const r2 = totalVariance > 0 ? 1 - pairs.reduce((sum, [m, p]) => sum + (m - p) ** 2, 0) / totalVariance : null
  return { samples: n, mae, rmse, nrmse: meanMeasured > 0 ? rmse / meanMeasured : null, r2 }
}
