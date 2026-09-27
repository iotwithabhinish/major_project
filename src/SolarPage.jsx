import { useEffect, useMemo, useRef, useState } from 'react'
import { Sun } from 'lucide-react'
import {
  SOLAR_CONFIG, accuracy, calibrate, cellTemperature, energyWh, nowcastRatio, predictRange, weatherAt,
} from './solarModel'

// Validated with the dataviz palette checker against the dark card surface.
const MEASURED_COLOR = '#c47f00'
const PREDICTED_COLOR = '#3a8fd6'
const DAY = 24 * 3600 * 1000
const DAY_TABS = [{ offset: -1, label: 'Yesterday' }, { offset: 0, label: 'Today' }, { offset: 1, label: 'Tomorrow' }]

const startOfDay = (time, offset = 0) => { const date = new Date(time); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() + offset); return date.getTime() }
const clock = (time) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const watts = (value, digits = 3) => `${Number(value || 0).toFixed(digits)} W`

export default function SolarPrediction({ current, currentTime, weatherSeries, weatherStatus, solarHistory }) {
  const [dayOffset, setDayOffset] = useState(0)
  const solar = current.solar || { panelVoltage: 0, panelCurrent: 0, solarPower: 0, available: false }
  const minute = Math.floor(currentTime / 60000)

  const model = useMemo(() => {
    const now = minute * 60000
    if (!weatherSeries.length) return null
    const calibration = calibrate(solarHistory, weatherSeries)
    const ratio = nowcastRatio(solarHistory.at(-1), weatherSeries, calibration, now)
    const range = (offset) => ({ start: startOfDay(now, offset), end: startOfDay(now, offset + 1) })
    const predictDay = (offset) => predictRange(weatherSeries, calibration, { ...range(offset), now, ratio })
    const today = predictDay(0)
    const nextHour = predictRange(weatherSeries, calibration, { start: now, end: now + 3600000, now, ratio })
    const measuredToday = solarHistory.filter((sample) => sample.time >= range(0).start)
    const upcoming = []
    for (let hour = 1; hour <= 12; hour++) {
      const time = Math.ceil(now / 3600000) * 3600000 + (hour - 1) * 3600000
      const point = predictRange(weatherSeries, calibration, { start: time, end: time + 1, now, ratio })[0]
      if (point) upcoming.push(point)
    }
    return {
      now, calibration, ratio, range, predictDay, upcoming,
      nextHourPower: nextHour.length ? nextHour.reduce((sum, point) => sum + point.power, 0) / nextHour.length : 0,
      todayWh: energyWh(today),
      todayMeasuredWh: energyWh(measuredToday),
      tomorrowWh: energyWh(predictDay(1)),
      weatherNow: weatherAt(weatherSeries, now),
    }
  }, [minute, weatherSeries, solarHistory])

  const day = useMemo(() => {
    if (!model) return null
    const { start, end } = model.range(dayOffset)
    const predicted = model.predictDay(dayOffset)
    const measured = solarHistory.filter((sample) => sample.time >= start && sample.time < end)
    // Score each day with a calibration learned only from earlier days (out-of-sample)
    // when enough of that exists; otherwise fall back to all data and say so.
    const earlier = calibrate(solarHistory, weatherSeries, { before: start })
    const scoring = earlier.samples >= 30 ? earlier : model.calibration
    return {
      start, end, predicted, measured,
      score: accuracy(solarHistory, weatherSeries, scoring, { start, end }),
      inSample: scoring !== earlier,
      predictedWh: energyWh(predicted),
      measuredWh: energyWh(measured),
    }
  }, [model, dayOffset, solarHistory, weatherSeries])

  const cal = model?.calibration
  const weatherNow = model?.weatherNow
  return <div className="space-y-5">
    <section className="glass border-amber-300/15 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3"><div className="icon-tile tone-amber"><Sun size={20} aria-hidden="true"/></div><h2 className="font-display text-xl font-semibold tracking-tight">Solar generation prediction</h2></div>
          <p className="mt-2 text-sm text-slate-400">
            {cal?.learned ? `Calibrated on ${cal.samples} measured daylight samples from your panel` : 'Physical model only - collecting measured data to calibrate'}
            {model?.ratio !== null && model?.ratio !== undefined ? ` · live correction ×${model.ratio.toFixed(2)}` : ''}
          </p>
        </div>
        <span className="pill pill-warn live"><span className="pill-dot"/>{weatherStatus}</span>
      </div>
      {solar.updatedAt && !solar.available && <div role="alert" className="alert-critical mt-5 rounded-2xl border p-4 text-sm text-rose-100">
        <p className="font-semibold">The solar sensors are reporting impossible values: {solar.panelVoltage.toFixed(2)} V, {solar.panelCurrent.toFixed(0)} mA, {solar.solarPower.toFixed(2)} W for a {SOLAR_CONFIG.ratedWatts} W panel.</p>
        <p className="mt-1 text-rose-100/80">These readings are ignored for the chart and calibration. This usually means a sensor output is not connected (a floating ESP32 pin reads a random high value) or a divider is missing. Check: voltage sensor S → GPIO34 and − → GND; ACS712 VCC → 5 V, OUT → 10 kΩ → GPIO36 → 20 kΩ → GND; and all grounds shared. The ESP32 Serial Monitor prints the raw pin voltages.</p>
      </div>}
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Measured now" value={solar.available ? watts(solar.solarPower) : '—'} sub={`${solar.panelVoltage.toFixed(2)} V · ${solar.panelCurrent.toFixed(1)} mA`} />
        <Stat label="Next hour (average)" value={watts(model?.nextHourPower)} sub={`Rated panel ${SOLAR_CONFIG.ratedWatts} W`} />
        <Stat label="Today" value={`${(model?.todayWh ?? 0).toFixed(2)} Wh`} sub={`Predicted · ${(model?.todayMeasuredWh ?? 0).toFixed(2)} Wh measured so far`} />
        <Stat label="Tomorrow" value={`${(model?.tomorrowWh ?? 0).toFixed(2)} Wh`} sub="Predicted energy" />
      </div>
    </section>

    <section className="glass p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight">Predicted vs measured power</h2>
          <p className="text-sm text-slate-400">Panel output in watts, 5-minute steps. Hover for exact values.</p>
        </div>
        <div className="segmented" role="tablist" aria-label="Day">
          {DAY_TABS.map((tab) => <button key={tab.offset} role="tab" aria-selected={dayOffset === tab.offset} onClick={() => setDayOffset(tab.offset)} className={`seg-btn ${dayOffset === tab.offset ? 'is-active' : ''}`}>{tab.label}</button>)}
        </div>
      </div>
      <Legend />
      {day ? <div className="glass-inset mt-4 px-2 pb-1 pt-2 sm:px-3"><SolarChart start={day.start} end={day.end} predicted={day.predicted} measured={day.measured} now={model.now} /></div> : <p className="mt-6 text-sm text-slate-500">No weather forecast has been received yet.</p>}
      {day && <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
        <Metric label="Predicted energy" value={`${day.predictedWh.toFixed(2)} Wh`} />
        <Metric label="Measured energy" value={day.measured.length ? `${day.measuredWh.toFixed(2)} Wh` : '—'} />
        <Metric label="Mean abs. error" value={day.score ? `${(day.score.mae * 1000).toFixed(0)} mW` : '—'} />
        <Metric label="nRMSE" value={day.score?.nrmse != null ? `${(day.score.nrmse * 100).toFixed(1)} %` : '—'} />
        <Metric label="R²" value={day.score?.r2 != null ? day.score.r2.toFixed(3) : '—'} />
      </div>}
      {day && <p className="mt-2 text-xs text-slate-500">
        {day.score
          ? `Accuracy from ${day.score.samples} daylight samples${day.inSample ? ' (in-sample: not enough earlier data yet for an independent score)' : ', scored against a calibration learned only from earlier days'}.`
          : 'Accuracy appears once the ESP32 has reported panel measurements for this day.'}
      </p>}
    </section>

    <div className="grid gap-5 xl:grid-cols-2">
      <section className="glass min-w-0 p-5 sm:p-6">
        <h2 className="font-display text-lg font-semibold tracking-tight">Next 12 hours</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-sm">
            <thead className="eyebrow"><tr><th className="py-2 font-medium">Time</th><th className="font-medium">Panel irradiance</th><th className="font-medium">Cell temp</th><th className="font-medium">Cloud</th><th className="text-right font-medium">Predicted</th></tr></thead>
            <tbody>{(model?.upcoming ?? []).map((point) => <tr key={point.time} className="border-t border-white/5 transition-colors hover:bg-white/[0.03]">
              <td className="py-2">{clock(point.time)}</td>
              <td className="text-slate-300">{point.weather.poa.toFixed(0)} W/m²</td>
              <td className="text-slate-300">{cellTemperature(point.weather.poa, point.weather.temperature, point.weather.wind).toFixed(1)} °C</td>
              <td className="text-slate-300">{point.weather.cloudCover.toFixed(0)} %</td>
              <td className="readout text-right text-slate-100">{watts(point.power)}<span className="block text-xs text-slate-500">{point.low.toFixed(3)}–{point.high.toFixed(3)}</span></td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>
      <section className="glass min-w-0 border-cyan-300/15 p-5 sm:p-6">
        <h2 className="font-display text-lg font-semibold tracking-tight">How the prediction works</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-slate-300">
          <li>Open-Meteo gives sunlight on the panel's own plane every 15 minutes (tilt {SOLAR_CONFIG.tilt}°, facing {SOLAR_CONFIG.azimuth === 0 ? 'south' : SOLAR_CONFIG.azimuth === 180 ? 'north' : `${SOLAR_CONFIG.azimuth}°`}). Clouds are already included in this value.</li>
          <li>Panel temperature from sunlight, air temperature and wind (Faiman model){weatherNow ? `: now ${cellTemperature(weatherNow.poa, weatherNow.temperature, weatherNow.wind).toFixed(1)} °C` : ''}. Output falls {Math.abs(SOLAR_CONFIG.tempCoeffPercent)} % per °C above 25 °C.</li>
          <li>A system factor learned from your panel's measurements: <strong>k = {cal ? cal.factor.toFixed(3) : '—'}</strong>{cal?.learned ? ` (±${(cal.spread * 100).toFixed(0)} %)` : ' (default until data arrives)'}. It captures shading, dust, angle and the load the panel drives.</li>
          <li>The latest measurement corrects the next hours (a cloud overhead now is likely still there in 30 minutes), fading back to the weather forecast over about 3 hours.</li>
        </ol>
        <p className="glass-inset mt-4 overflow-x-auto p-3 font-mono text-xs text-cyan-100">P = k × P<sub>rated</sub> × G<sub>poa</sub>/1000 × (1 + γ(T<sub>cell</sub> − 25)) × η<sub>low-light</sub></p>
      </section>
    </div>
  </div>
}

const Stat = ({ label, value, sub }) => <div className="glass-inset lift p-4"><p className="eyebrow">{label}</p><p className="readout mt-2 text-3xl font-semibold text-amber-200">{value}</p><p className="mt-1 text-xs text-slate-400">{sub}</p></div>
const Metric = ({ label, value }) => <div className="glass-inset px-4 py-3"><p className="eyebrow">{label}</p><p className="readout mt-1 text-lg font-semibold text-slate-100">{value}</p></div>

function Legend() {
  return <div className="mt-4 flex flex-wrap gap-4 text-xs text-slate-300">
    <span className="flex items-center gap-2"><svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke={MEASURED_COLOR} strokeWidth="2"/></svg>Measured (ESP32)</span>
    <span className="flex items-center gap-2"><svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke={PREDICTED_COLOR} strokeWidth="2" strokeDasharray="5 3"/></svg>Predicted</span>
    <span className="flex items-center gap-2"><span className="h-3 w-5 rounded-sm" style={{ background: PREDICTED_COLOR, opacity: 0.25 }} aria-hidden="true"/>80 % prediction range</span>
  </div>
}

function SolarChart({ start, end, predicted, measured, now }) {
  const containerRef = useRef(null)
  const [width, setWidth] = useState(0)   // Measured from the container before drawing.
  const [hover, setHover] = useState(null)
  useEffect(() => {
    const element = containerRef.current
    if (!element) return undefined
    setWidth(element.clientWidth)
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const height = 280
  const margin = { top: 12, right: 12, bottom: 28, left: 52 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const peak = Math.max(0.05, ...predicted.map((point) => point.high), ...measured.map((sample) => sample.power))
  const step = niceStep(peak / 4)
  const yMax = Math.ceil((peak * 1.05) / step) * step
  const x = (time) => margin.left + ((time - start) / (end - start)) * plotWidth
  const y = (value) => margin.top + plotHeight - (value / yMax) * plotHeight
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0

  const bandPath = predicted.length ? `M${predicted.map((p) => `${x(p.time)},${y(p.high)}`).join('L')}L${[...predicted].reverse().map((p) => `${x(p.time)},${y(p.low)}`).join('L')}Z` : ''
  const predictedPath = predicted.length ? `M${predicted.map((p) => `${x(p.time)},${y(p.power)}`).join('L')}` : ''
  // Break the measured line where the ESP32 was offline for more than 10 minutes.
  const measuredPath = measured.map((sample, index) => `${index && sample.time - measured[index - 1].time <= 600000 ? 'L' : 'M'}${x(sample.time)},${y(sample.power)}`).join('')

  const onMove = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const time = start + ((event.clientX - bounds.left - margin.left) / plotWidth) * (end - start)
    if (time < start || time > end || !predicted.length) { setHover(null); return }
    const point = predicted.reduce((best, p) => (Math.abs(p.time - time) < Math.abs(best.time - time) ? p : best))
    const nearest = measured.length ? measured.reduce((best, s) => (Math.abs(s.time - time) < Math.abs(best.time - time) ? s : best)) : null
    setHover({ point, measured: nearest && Math.abs(nearest.time - point.time) <= 5 * 60000 ? nearest : null })
  }

  const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24]
  return <div ref={containerRef} className="relative mt-3 h-[280px] w-full min-w-0 overflow-hidden">
    {width > 0 && <svg width={width} height={height} role="img" aria-label="Predicted and measured solar panel power over the day" onPointerMove={onMove} onPointerLeave={() => setHover(null)} className="block touch-none">
      {Array.from({ length: Math.round(yMax / step) + 1 }, (_, index) => index * step).map((tick) => <g key={tick}>
        <line x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} stroke="rgba(255,255,255,0.08)"/>
        <text x={margin.left - 8} y={y(tick) + 4} textAnchor="end" fontSize="11" fill="#94a3b8">{tick.toFixed(decimals)}</text>
      </g>)}
      <text x={12} y={margin.top + plotHeight / 2} fontSize="11" fill="#94a3b8" transform={`rotate(-90 12 ${margin.top + plotHeight / 2})`} textAnchor="middle">Watts</text>
      {hours.map((hour) => <text key={hour} x={x(start + hour * 3600000)} y={height - 8} textAnchor="middle" fontSize="11" fill="#94a3b8">{String(hour % 24).padStart(2, '0')}:00</text>)}
      <path d={bandPath} fill={PREDICTED_COLOR} opacity="0.2"/>
      <path d={measuredPath} fill="none" stroke={MEASURED_COLOR} strokeWidth="1.5" strokeLinejoin="round"/>
      {/* Prediction on top, with a surface-coloured halo so it stays readable over noisy measurements. */}
      <path d={predictedPath} fill="none" stroke="#0b1220" strokeWidth="5" strokeLinejoin="round" opacity="0.7"/>
      <path d={predictedPath} fill="none" stroke={PREDICTED_COLOR} strokeWidth="2" strokeDasharray="6 4" strokeLinejoin="round"/>
      {now >= start && now < end && <g>
        <line x1={x(now)} x2={x(now)} y1={margin.top} y2={margin.top + plotHeight} stroke="#cbd5e1" strokeDasharray="2 3" opacity="0.6"/>
        <text x={x(now) + 4} y={margin.top + 10} fontSize="11" fill="#cbd5e1">Now</text>
      </g>}
      {hover && <g>
        <line x1={x(hover.point.time)} x2={x(hover.point.time)} y1={margin.top} y2={margin.top + plotHeight} stroke="#e2e8f0" opacity="0.5"/>
        <circle cx={x(hover.point.time)} cy={y(hover.point.power)} r="4" fill={PREDICTED_COLOR} stroke="#0f172a" strokeWidth="2"/>
        {hover.measured && <circle cx={x(hover.measured.time)} cy={y(hover.measured.power)} r="4" fill={MEASURED_COLOR} stroke="#0f172a" strokeWidth="2"/>}
      </g>}
    </svg>}
    {hover && <div className="pointer-events-none absolute top-2 z-10 rounded-xl border border-white/10 bg-slate-950/90 px-3 py-2 text-xs shadow-2xl backdrop-blur-md" style={{ left: Math.min(Math.max(x(hover.point.time) + 12, 0), width - 190) }}>
      <p className="font-medium text-slate-100">{clock(hover.point.time)}</p>
      <p className="mt-1 text-slate-300">Predicted: <span className="text-slate-100">{watts(hover.point.power)}</span></p>
      <p className="text-slate-400">Range: {hover.point.low.toFixed(3)}–{hover.point.high.toFixed(3)} W</p>
      <p className="text-slate-300">Measured: <span className="text-slate-100">{hover.measured ? watts(hover.measured.power) : '—'}</span></p>
      <p className="text-slate-400">Irradiance: {hover.point.weather.poa.toFixed(0)} W/m² · cloud {hover.point.weather.cloudCover.toFixed(0)} %</p>
    </div>}
  </div>
}

function niceStep(raw) {
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude
}
