import { createElement, useEffect, useState } from 'react'
import {
  Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun,
  Droplets, MapPin, Moon, Sun, Sunrise, Sunset, Umbrella, Wind,
} from 'lucide-react'
import { SOLAR_CONFIG } from './solarModel'

// Current weather + today's outlook from Open-Meteo (free, no API key) for the
// same location as the solar forecast. Self-contained: it does not touch any
// device, MQTT or solar state.
const LOCATION_NAME = import.meta.env.VITE_LOCATION_NAME?.trim()
const REFRESH_MS = 10 * 60 * 1000
let cache = null   // { data, fetchedAt } shared across mounts so page switches don't refetch

const weatherUrl = () => 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
  latitude: SOLAR_CONFIG.latitude,
  longitude: SOLAR_CONFIG.longitude,
  current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day',
  hourly: 'temperature_2m,weather_code,is_day',
  daily: 'temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max',
  forecast_days: 2,
  timezone: 'auto',
})

// WMO weather interpretation codes -> label and icon.
const describe = (code, isDay) => {
  if (code === 0) return { label: isDay ? 'Clear sky' : 'Clear night', icon: isDay ? Sun : Moon }
  if (code <= 2) return { label: 'Partly cloudy', icon: isDay ? CloudSun : CloudMoon }
  if (code === 3) return { label: 'Overcast', icon: Cloud }
  if (code === 45 || code === 48) return { label: 'Fog', icon: CloudFog }
  if (code >= 51 && code <= 57) return { label: 'Drizzle', icon: CloudDrizzle }
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { label: code >= 80 ? 'Rain showers' : 'Rain', icon: CloudRain }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { label: 'Snow', icon: CloudSnow }
  if (code >= 95) return { label: 'Thunderstorm', icon: CloudLightning }
  return { label: 'Cloudy', icon: Cloud }
}

// "2026-09-28T06:08" (already in the location's timezone) -> "06:08"
const clockOf = (localIso) => localIso?.slice(11, 16) ?? '--:--'

export default function WeatherWidget({ now }) {
  const [data, setData] = useState(cache?.data ?? null)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      if (cache && Date.now() - cache.fetchedAt < REFRESH_MS) { setData(cache.data); return }
      try {
        const response = await fetch(weatherUrl(), { signal: controller.signal })
        if (!response.ok) throw new Error(`Weather request failed (${response.status})`)
        const json = await response.json()
        if (!json.current) throw new Error('Weather data is incomplete')
        cache = { data: json, fetchedAt: Date.now() }
        setData(json)
        setError('')
      } catch (err) {
        if (err.name !== 'AbortError') setError('Weather unavailable - check the internet connection.')
      }
    }
    load()
    const interval = window.setInterval(load, REFRESH_MS)
    return () => { controller.abort(); window.clearInterval(interval) }
  }, [])

  // Time and date are shown in the weather location's timezone (the browser's until data arrives).
  const timeZone = data?.timezone
  const time = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone })
  const [clockMain, clockSuffix] = (() => { const match = time.match(/^(.*?)(\s?[AaPp][Mm])$/); return match ? [match[1], match[2].trim()] : [time, ''] })()
  const date = new Date(now).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone })
  const place = LOCATION_NAME || (timeZone ? timeZone.split('/').pop().replace(/_/g, ' ') : `${SOLAR_CONFIG.latitude.toFixed(2)}, ${SOLAR_CONFIG.longitude.toFixed(2)}`)

  const current = data?.current
  const condition = current ? describe(current.weather_code, current.is_day) : null
  const daily = data?.daily
  // Next 5 hours, matched in the location's local time.
  const localHour = data ? new Date(now + data.utc_offset_seconds * 1000).toISOString().slice(0, 13) : ''
  const startIndex = data ? data.hourly.time.findIndex((t) => t.slice(0, 13) > localHour) : -1
  const upcoming = startIndex >= 0 ? data.hourly.time.slice(startIndex, startIndex + 5).map((t, i) => ({
    time: t.slice(11, 16),
    temperature: data.hourly.temperature_2m[startIndex + i],
    ...describe(data.hourly.weather_code[startIndex + i], data.hourly.is_day[startIndex + i]),
  })) : []

  return <section className="glass relative overflow-hidden p-5 sm:p-6" aria-label="Weather, time and date">
    {/* soft glow tinted by day/night */}
    <div aria-hidden="true" className={`pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full blur-3xl ${current?.is_day === 0 ? 'bg-indigo-500/15' : 'bg-amber-400/15'}`}/>
    <div className="relative grid gap-6 lg:grid-cols-[1.1fr_1fr_1.2fr] lg:items-center">
      {/* Time & date */}
      <div>
        <p className="eyebrow flex items-center gap-1.5"><MapPin size={12} aria-hidden="true"/>{place}</p>
        <p className="readout mt-2 text-5xl font-semibold text-white sm:text-6xl" aria-live="off">{clockMain}{clockSuffix && <span className="ml-2 text-xl font-medium text-slate-400">{clockSuffix}</span>}</p>
        <p className="mt-2 text-sm text-slate-300">{date}</p>
      </div>

      {/* Current conditions */}
      <div className="flex items-center gap-4 lg:border-l lg:border-white/5 lg:pl-6">
        {condition
          ? <>
              <div className={`icon-tile h-16 w-16 rounded-2xl ${current.is_day ? 'tone-amber' : 'tone-violet'}`}>{createElement(condition.icon, { size: 32, 'aria-hidden': true })}</div>
              <div className="min-w-0">
                <p className="readout text-4xl font-semibold text-white">{Math.round(current.temperature_2m)}<span className="text-xl text-slate-400">°C</span></p>
                <p className="text-sm font-medium text-slate-200">{condition.label}</p>
                <p className="text-xs text-slate-400">Feels like {Math.round(current.apparent_temperature)}°C{daily ? ` · H ${Math.round(daily.temperature_2m_max[0])}° L ${Math.round(daily.temperature_2m_min[0])}°` : ''}</p>
              </div>
            </>
          : <p className="text-sm text-slate-400">{error || 'Loading weather…'}</p>}
      </div>

      {/* Details + next hours */}
      <div className="space-y-3">
        {current && <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-2">
          <Detail icon={Droplets} label="Humidity" value={`${current.relative_humidity_2m}%`}/>
          <Detail icon={Wind} label="Wind" value={`${Math.round(current.wind_speed_10m)} km/h`}/>
          <Detail icon={Sunrise} label="Sunrise" value={clockOf(daily?.sunrise[0])}/>
          <Detail icon={Sunset} label="Sunset" value={clockOf(daily?.sunset[0])}/>
        </div>}
        {upcoming.length > 0 && <div className="glass-inset flex items-stretch justify-between gap-1 px-2 py-2">
          {upcoming.map((hour) => <div key={hour.time} className="flex flex-1 flex-col items-center gap-1 rounded-lg py-1" title={hour.label}>
            <span className="text-[11px] text-slate-500">{hour.time}</span>
            {createElement(hour.icon, { size: 18, className: 'text-slate-300', 'aria-label': hour.label })}
            <span className="readout text-sm text-slate-100">{Math.round(hour.temperature)}°</span>
          </div>)}
        </div>}
        {daily && <p className="flex items-center gap-1.5 text-xs text-slate-400"><Umbrella size={13} aria-hidden="true"/>{daily.precipitation_probability_max[0]}% chance of rain today · Open-Meteo</p>}
      </div>
    </div>
  </section>
}

const Detail = ({ icon, label, value }) => <div className="glass-inset flex items-center gap-2 px-3 py-2">
  {createElement(icon, { size: 15, className: 'shrink-0 text-cyan-300', 'aria-hidden': true })}
  <div className="min-w-0"><p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p><p className="readout truncate text-sm text-slate-100">{value}</p></div>
</div>
