import { createElement, useEffect, useId, useRef, useState } from 'react'
import {
  Activity, BarChart3, DoorClosed, Fan, Home, Lightbulb, Lock, Mic, Play, Sun,
  Plus, Power, RefreshCcw, Settings, Shield, Wifi, X,
  CalendarClock, Clock, Cpu, Database, DoorOpen, Droplets, Film, Flame, LockOpen, Moon,
  Radio, RotateCcw, Search, ShieldCheck, Sparkles, Thermometer, Timer, TriangleAlert, Zap,
} from 'lucide-react'
import { createMqttClient, MQTT_CONFIG, topicFor } from './mqtt'
import { clampFanThreshold, parseVoiceCommand, parseVoiceTranscriptPayload } from './voiceControl'
import { SOLAR_CONFIG, energyWh, isPlausibleReading, parseWeather, weatherUrl } from './solarModel'
import SolarPrediction from './SolarPage'
import WeatherWidget from './WeatherWidget'

const ROOM_IDS = ['living-room', 'bedroom', 'kitchen']
const ROOM_LABELS = { 'living-room': 'Living room', bedroom: 'Bedroom', kitchen: 'Kitchen' }
const initialRooms = Object.fromEntries(ROOM_IDS.map((id, index) => [id, {
  light: index === 0, fan: false, door: false, temperature: 23 + index, humidity: 52,
  gasVoltage: 0, gasAlert: false,
  solar: { panelVoltage: 0, panelCurrent: 0, solarPower: 0, available: false, updatedAt: null },
  lastSeen: new Date().toISOString(),
}]))
const deviceMeta = [
  { id: 'light', label: 'Smart light', icon: Lightbulb, on: 'ON', off: 'OFF', color: 'amber' },
  { id: 'fan', label: 'Ceiling fan', icon: Fan, on: 'ON', off: 'OFF', color: 'cyan' },
  { id: 'door', label: 'Door (servo)', icon: DoorClosed, on: 'OPEN', off: 'CLOSE', color: 'emerald' },
]
const store = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback } }
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value))
const formatTime = (value) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const SOLAR_HISTORY_DAYS = 3

function App() {
  const [rooms, setRooms] = useState(() => store('smart-home.rooms', initialRooms))
  const [room, setRoom] = useState(() => store('smart-home.active-room', 'living-room'))
  const [page, setPage] = useState('home')
  const [status, setStatus] = useState(MQTT_CONFIG.url ? 'connecting' : 'simulation')
  const [events, setEvents] = useState(() => store('smart-home.events', []))
  const [history, setHistory] = useState(() => store('smart-home.history', []))
  const [fanMode, setFanMode] = useState('manual')
  const [threshold, setThreshold] = useState(25)
  const [timerEnd, setTimerEnd] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [voiceResult, setVoiceResult] = useState('Waiting for a command from the INMP441 microphone.')
  const [browserVoiceStatus, setBrowserVoiceStatus] = useState('Checking browser microphone support...')
  const [physicalVoiceStatus, setPhysicalVoiceStatus] = useState('Waiting for ESP32 INMP441 status...')
  const [weatherSeries, setWeatherSeries] = useState([])
  // Measured panel power [{ time, power }] at most once a minute, kept for a few days.
  const [solarHistory, setSolarHistory] = useState(() => store('smart-home.solar-history', []).filter((sample) => isPlausibleReading(sample)))
  const [weatherStatus, setWeatherStatus] = useState('Loading weather forecast...')
  const [scenes] = useState(() => store('smart-home.scenes', [
    { id: 'good-night', name: 'Good night', values: { light: false, fan: false, door: false } },
    { id: 'movie', name: 'Movie time', values: { light: false, fan: true, door: false } },
  ]))
  const [schedules, setSchedules] = useState(() => store('smart-home.schedules', []))
  const [scheduleName, setScheduleName] = useState('')
  const [search, setSearch] = useState('')
  const clientRef = useRef(null)
  const runVoiceRef = useRef(() => {})
  const timerRoomRef = useRef(room)
  const roomRef = useRef(room)
  const roomsRef = useRef(rooms)
  const current = rooms[room] || initialRooms['living-room']
  const simulation = status === 'simulation'

  useEffect(() => { save('smart-home.rooms', rooms); roomsRef.current = rooms }, [rooms])
  useEffect(() => { save('smart-home.active-room', room); roomRef.current = room }, [room])
  useEffect(() => save('smart-home.events', events), [events])
  useEffect(() => save('smart-home.history', history), [history])
  useEffect(() => { try { save('smart-home.solar-history', solarHistory) } catch { /* storage full: keep in memory */ } }, [solarHistory])
  useEffect(() => save('smart-home.scenes', scenes), [scenes])
  useEffect(() => save('smart-home.schedules', schedules), [schedules])
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])

  useEffect(() => {
    const controller = new AbortController()
    const loadWeather = async () => {
      try {
        setWeatherStatus('Refreshing weather forecast...')
        const response = await fetch(weatherUrl(), { signal: controller.signal })
        if (!response.ok) throw new Error('Weather request failed')
        setWeatherSeries(parseWeather(await response.json()))
        setWeatherStatus(`Forecast updated at ${formatTime(new Date())}`)
      } catch (error) {
        if (error.name !== 'AbortError') setWeatherStatus('Weather forecast is unavailable. Check internet connection.')
      }
    }
    loadWeather()
    const interval = window.setInterval(loadWeather, 15 * 60 * 1000)
    return () => { controller.abort(); window.clearInterval(interval) }
  }, [])

  const log = (message, level = 'info') => setEvents((previous) => [
    { id: crypto.randomUUID(), message, level, time: new Date().toISOString() }, ...previous,
  ].slice(0, 30))

  const updateRoom = (id, patch, eventMessage) => {
    setRooms((previous) => ({ ...previous, [id]: { ...previous[id], ...patch, lastSeen: new Date().toISOString() } }))
    if (eventMessage) log(eventMessage)
  }

  const publish = (id, device, state) => {
    const command = { id: crypto.randomUUID(), device, state, requestedAt: new Date().toISOString() }
    if (clientRef.current?.connected) clientRef.current.publish(topicFor(id, 'commands'), JSON.stringify(command), { qos: 1 })
    else if (!simulation) log(`Command queued locally: ${device} ${state}. MQTT is not connected.`, 'warn')
    return command
  }

  const command = (device, state, id = room) => {
    publish(id, device, state)
    updateRoom(id, { [device]: device === 'door' ? state === 'OPEN' : state === 'ON' }, `${ROOM_LABELS[id]}: ${device} ${state.toLowerCase()}.`)
  }

  const subscribeRoom = (client, id) => {
    client.subscribe([topicFor(id, 'telemetry'), topicFor(id, 'voice/transcript'), topicFor(id, 'voice/status'), topicFor(id, 'ack')], { qos: 1 })
  }

  useEffect(() => {
    const client = createMqttClient()
    if (!client) return undefined
    clientRef.current = client
    const connected = () => { setStatus('connected'); ROOM_IDS.forEach((id) => subscribeRoom(client, id)); log('Secure MQTT connection established.') }
    const disconnected = () => setStatus('offline')
    const failed = () => setStatus('error')
    const message = (topic, payload) => {
      // Topics are <prefix>/<room>/<name>, where name may itself contain a slash
      // (voice/transcript), so the room must be read right after the prefix.
      const prefix = `${MQTT_CONFIG.roomPrefix}/`
      if (!topic.startsWith(prefix)) return
      const [id, ...rest] = topic.slice(prefix.length).split('/')
      const name = rest.join('/')
      if (!ROOM_IDS.includes(id)) return
      if (name === 'telemetry') {
        try {
          const value = JSON.parse(payload.toString())
          const normalize = (item, fallback) => typeof item === 'boolean' ? item : ['1', 1, 'on', 'open', 'true'].includes(String(item).toLowerCase()) ? true : ['0', 0, 'off', 'close', 'false'].includes(String(item).toLowerCase()) ? false : fallback
          const hasSolarData = ['panelVoltage', 'panelCurrent', 'solarPower'].some((key) => Number.isFinite(Number(value[key])))
          const solar = hasSolarData ? {
            panelVoltage: Number(value.panelVoltage) || 0,
            panelCurrent: Number(value.panelCurrent) || 0,
            solarPower: Number(value.solarPower) || 0,
            available: Boolean(value.solarSensorReady) && isPlausibleReading({ power: Number(value.solarPower), voltage: Number(value.panelVoltage) }),
            updatedAt: new Date().toISOString(),
          } : roomsRef.current[id].solar
          if (hasSolarData && solar.available) {
            const sample = { time: Date.now(), power: Math.max(0, solar.solarPower) }
            setSolarHistory((previous) => {
              if (previous.length && sample.time - previous.at(-1).time < 60000) return previous
              const oldest = sample.time - SOLAR_HISTORY_DAYS * 24 * 3600 * 1000
              return [...previous.filter((entry) => entry.time >= oldest), sample]
            })
          }
          const gasAlert = normalize(value.gasAlert, roomsRef.current[id].gasAlert)
          if (gasAlert && !roomsRef.current[id].gasAlert) log(`${ROOM_LABELS[id]}: MQ-2 gas / smoke alert!`, 'warn')
          updateRoom(id, { light: normalize(value.light, roomsRef.current[id].light), fan: normalize(value.fan, roomsRef.current[id].fan), door: normalize(value.door, roomsRef.current[id].door), temperature: Number(value.temperature ?? value.temp ?? roomsRef.current[id].temperature), humidity: Number(value.humidity ?? roomsRef.current[id].humidity), gasVoltage: Number(value.gasVoltage ?? roomsRef.current[id].gasVoltage) || 0, gasAlert, solar })
        } catch { log('Ignored invalid telemetry payload.', 'warn') }
      }
      if (name === 'voice/transcript') {
        const parsed = parseVoiceTranscriptPayload(payload)
        if (parsed) runVoiceRef.current(parsed.transcript, parsed.source, id)
      }
      if (name === 'voice/status') {
        setPhysicalVoiceStatus(payload.toString())
      }
      if (name === 'ack') {
        let ack = {}
        try { ack = JSON.parse(payload.toString()) } catch { /* plain-text ack */ }
        if (ack.success === false) log(`${ROOM_LABELS[id]}: command refused - ${ack.message || 'unknown reason'}.`, 'warn')
        else log(`${ROOM_LABELS[id]} device confirmed a command.`)
      }
    }
    client.on('connect', connected); client.on('reconnect', () => setStatus('reconnecting')); client.on('offline', disconnected); client.on('close', disconnected); client.on('error', failed); client.on('message', message)
    return () => { client.end(true); clientRef.current = null }
  }, [])

  useEffect(() => {
    if (fanMode !== 'auto') return
    const target = current.temperature >= threshold ? 'ON' : 'OFF'
    if (current.fan !== (target === 'ON')) command('fan', target)
  }, [fanMode, threshold, current.temperature])

  useEffect(() => {
    if (!timerEnd || now < timerEnd) return
    command('fan', 'OFF', timerRoomRef.current); setTimerEnd(null); setFanMode('manual'); log('Fan timer ended.')
  }, [now, timerEnd])

  useEffect(() => {
    const points = Object.entries(rooms).map(([id, data]) => ({ id, temperature: data.temperature, active: Number(data.light) + Number(data.fan) + Number(data.door), time: Date.now() }))
    setHistory((previous) => [...previous, ...points].slice(-72))
  }, [Math.floor(now / 300000)])

  useEffect(() => {
    if (!simulation) return undefined
    const id = setInterval(() => setRooms((previous) => Object.fromEntries(
      Object.entries(previous).map(([key, value]) => [key, {
        ...value,
        temperature: Math.max(18, Math.min(34, +(value.temperature + (Math.random() - 0.5) * 0.4).toFixed(1))),
        humidity: Math.round(Math.max(30, Math.min(80, value.humidity + (Math.random() - 0.5) * 2))),
        lastSeen: new Date().toISOString(),
      }]),
    )), 8000)
    return () => clearInterval(id)
  }, [simulation])

  const applyScene = (scene, targetRoom = room) => { Object.entries(scene.values).forEach(([device, active]) => command(device, device === 'door' ? active ? 'OPEN' : 'CLOSE' : active ? 'ON' : 'OFF', targetRoom)); log(`Applied ${scene.name} scene.`) }
  const runVoice = (text, source = 'Command box', targetRoom = roomRef.current) => {
    const parsed = parseVoiceCommand(text)
    if (!parsed) { setVoiceResult(`Could not understand “${text}”.`); log('Unrecognized voice command.', 'warn'); return }
    if (parsed.type === 'device') command(parsed.device, parsed.state, targetRoom)
    if (parsed.type === 'timer') { timerRoomRef.current = targetRoom; setFanMode('timer'); setTimerEnd(Date.now() + parsed.minutes * 60000); command('fan', 'ON', targetRoom) }
    if (parsed.type === 'timer-stop') { setTimerEnd(null); setFanMode('manual') }
    if (parsed.type === 'threshold') { setThreshold(parsed.value); setFanMode('auto') }
    if (parsed.type === 'scene') { const scene = scenes.find((item) => item.id === parsed.id); if (scene) applyScene(scene, targetRoom) }
    setVoiceResult(`${source}: applied “${text}”.`)
  }
  // Long-lived MQTT / speech listeners call the latest runVoice through this ref.
  useEffect(() => { runVoiceRef.current = runVoice })

  // Run saved schedules once per day at their HH:MM time while the dashboard is open.
  const minuteKey = new Date(now).toISOString().slice(0, 16)
  const scheduleRunsRef = useRef(new Set())
  useEffect(() => {
    const date = new Date()
    const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    const today = date.toDateString()
    const due = schedules.filter((item) => item.enabled && item.time === hhmm && item.lastRun !== today && !scheduleRunsRef.current.has(`${item.id}:${today}`))
    if (!due.length) return
    due.forEach((item) => {
      scheduleRunsRef.current.add(`${item.id}:${today}`)
      const scene = scenes.find((entry) => entry.id === item.scene)
      if (scene) { applyScene(scene, item.room || roomRef.current); log(`Schedule “${item.name}” ran.`) }
    })
    setSchedules((all) => all.map((item) => due.some((entry) => entry.id === item.id) ? { ...item, lastRun: today } : item))
  }, [minuteKey])

  useEffect(() => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Recognition) { setBrowserVoiceStatus('Browser microphone is unavailable. Use Chrome or Edge for website voice control.'); return undefined }
    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
      setBrowserVoiceStatus('Website microphone requires HTTPS or localhost.'); return undefined
    }
    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = false
    recognition.lang = 'en-US'
    let shouldRestart = true
    let restartTimer = null
    const start = () => { try { recognition.start() } catch { /* recognition is already active */ } }
    recognition.onstart = () => setBrowserVoiceStatus('Always listening for website voice commands.')
    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        if (!event.results[index].isFinal) continue
        const transcript = event.results[index][0].transcript.trim()
        if (transcript) runVoiceRef.current(transcript, 'Website microphone')
      }
    }
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        shouldRestart = false
        setBrowserVoiceStatus('Microphone permission was denied. Allow it in browser settings to enable website voice control.')
      } else if (event.error !== 'no-speech') setBrowserVoiceStatus(`Website microphone: ${event.error}. Retrying...`)
    }
    recognition.onend = () => {
      if (shouldRestart) restartTimer = window.setTimeout(start, 400)
    }
    start()
    return () => { shouldRestart = false; window.clearTimeout(restartTimer); recognition.abort() }
  }, [])
  const filtered = deviceMeta.filter((item) => item.label.toLowerCase().includes(search.toLowerCase()))
  const timerSeconds = timerEnd ? Math.max(0, Math.ceil((timerEnd - now) / 1000)) : 0
  const activeCount = Object.values(current).filter((value) => value === true).length

  const nav = [
    { id: 'home', label: 'Dashboard', short: 'Home', icon: Home },
    { id: 'solar', label: 'Solar prediction', short: 'Solar', icon: Sun },
    { id: 'analytics', label: 'Analytics', short: 'Stats', icon: BarChart3 },
    { id: 'scenes', label: 'Scenes', short: 'Scenes', icon: Play },
    { id: 'security', label: 'Security', short: 'Safety', icon: Shield },
    { id: 'settings', label: 'Settings', short: 'Settings', icon: Settings },
  ]
  const connection = connectionStatus(status, simulation)
  return <div className="relative min-h-screen text-slate-100">
    <div className="app-backdrop" aria-hidden="true"/>
    <div className="relative z-10 mx-auto grid max-w-[1400px] gap-5 p-3 pb-28 sm:p-5 sm:pb-28 lg:grid-cols-[248px_minmax(0,1fr)] lg:p-6">
      <aside className="min-w-0 lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)]">
        <div className="sidebar-panel">
          <div className="mb-8 hidden items-center gap-3 px-1 lg:flex">
            <div className="icon-tile tone-cyan"><Power size={20}/></div>
            <div><p className="font-display text-lg font-semibold tracking-tight">SmartNest</p><p className="text-xs text-slate-500">Room control</p></div>
          </div>
          <p className="eyebrow mb-2 hidden px-2 lg:block">Navigation</p>
          <nav className="mobile-dock lg:flex lg:flex-col lg:gap-1 lg:pl-2" aria-label="Main">
            {nav.map((item) => <button key={item.id} onClick={() => setPage(item.id)} aria-current={page === item.id ? 'page' : undefined} className={`nav-btn ${page === item.id ? 'is-active' : ''}`}>
              {createElement(item.icon, { size: 18, 'aria-hidden': true })}
              <span className="truncate lg:hidden">{item.short}</span>
              <span className="hidden lg:inline">{item.label}</span>
            </button>)}
          </nav>
          <div className="glass-inset mt-auto hidden p-4 lg:block">
            <p className="eyebrow">System</p>
            <div className="mt-3 flex items-center gap-2 text-sm font-medium"><span className={`pill live pill-${connection.tone}`}><span className="pill-dot"/>{connection.short}</span></div>
            <p className="mt-3 text-sm font-medium text-slate-200">{simulation ? 'Simulation mode' : `MQTT ${status}`}</p>
            <p className="mt-1 truncate text-xs text-slate-500">{simulation ? 'Add VITE_MQTT_URL to connect hardware.' : MQTT_CONFIG.roomPrefix}</p>
          </div>
        </div>
      </aside>
      <main className="min-w-0 space-y-5">
        <header className="glass p-4 sm:p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <div className="icon-tile tone-cyan lg:hidden"><Power size={20}/></div>
              <div className="min-w-0">
                <p className="eyebrow">{new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</p>
                <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">{page === 'home' ? 'Your smart home' : nav.find((item) => item.id === page)?.label}</h1>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className={`pill live pill-${connection.tone} lg:hidden`} title={simulation ? 'Add VITE_MQTT_URL to connect hardware.' : MQTT_CONFIG.roomPrefix}><span className="pill-dot"/>{simulation ? 'Simulation mode' : `MQTT ${status}`}</span>
              <div className="segmented max-w-full overflow-x-auto" role="group" aria-label="Room">
                {ROOM_IDS.map((id) => <button key={id} onClick={() => setRoom(id)} aria-pressed={room === id} className={`seg-btn ${room === id ? 'is-active' : ''}`}>{ROOM_LABELS[id]}</button>)}
              </div>
            </div>
          </div>
        </header>
        <div key={page} className="page-enter">
          {page === 'home' && <Dashboard timerRoomRef={timerRoomRef} current={current} room={room} filtered={filtered} search={search} setSearch={setSearch} command={command} status={status} simulation={simulation} activeCount={activeCount} fanMode={fanMode} setFanMode={setFanMode} threshold={threshold} setThreshold={setThreshold} timerSeconds={timerSeconds} setTimerEnd={setTimerEnd} voiceResult={voiceResult} browserVoiceStatus={browserVoiceStatus} physicalVoiceStatus={physicalVoiceStatus} scenes={scenes} applyScene={applyScene} history={history} solarHistory={solarHistory} connection={connection} now={now} />}
          {page === 'solar' && <SolarPrediction current={current} currentTime={now} weatherSeries={weatherSeries} weatherStatus={weatherStatus} solarHistory={solarHistory} />}
          {page === 'analytics' && <Analytics rooms={rooms} history={history} />}
          {page === 'scenes' && <Scenes room={room} scenes={scenes} applyScene={applyScene} schedules={schedules} setSchedules={setSchedules} scheduleName={scheduleName} setScheduleName={setScheduleName} />}
          {page === 'security' && <Security current={current} events={events} command={command} />}
          {page === 'settings' && <SettingsPage simulation={simulation} status={status} setRooms={setRooms} events={events} />}
        </div>
      </main>
    </div>
  </div>
}

// ---------------------------------------------------------------------------
// Presentation helpers (display only - no effect on device state or data)
// ---------------------------------------------------------------------------

const ROOM_COLORS = { 'living-room': '#3987e5', bedroom: '#d95926', kitchen: '#199e70' }   // validated for CVD on the dark surface
const DEVICE_DETAILS = { light: 'Relay channel 1', fan: 'Relay channel 2', door: 'Servo motor' }

function connectionStatus(status, simulation) {
  if (simulation) return { tone: 'info', short: 'Simulation' }
  if (status === 'connected') return { tone: 'good', short: 'Online' }
  if (status === 'connecting' || status === 'reconnecting') return { tone: 'warn', short: status === 'connecting' ? 'Connecting' : 'Reconnecting' }
  return { tone: 'crit', short: 'Offline' }
}

function temperatureStatus(value) {
  if (value >= 32) return { tone: 'crit', label: 'Hot' }
  if (value >= 28) return { tone: 'warn', label: 'Warm' }
  if (value < 18) return { tone: 'info', label: 'Cool' }
  return { tone: 'good', label: 'Normal' }
}

function solarStatus(solar) {
  if (solar.available) return { tone: 'good', label: 'Measuring', live: true }
  if (solar.updatedAt) return { tone: 'crit', label: 'Sensor fault', live: false }
  return { tone: 'muted', label: 'Awaiting data', live: false }
}

const Pill = ({ tone = 'muted', live = false, children }) => <span className={`pill pill-${tone} ${live ? 'live' : ''}`}><span className="pill-dot"/>{children}</span>

function Sparkline({ values, color = '#22d3ee', label }) {
  const id = useId()
  if (values.length < 2) return <div className="h-10" aria-hidden="true"/>
  const width = 160, height = 40
  const min = Math.min(...values), max = Math.max(...values)
  const span = max - min || 1
  const points = values.map((value, index) => [(index / (values.length - 1)) * width, height - 4 - ((value - min) / span) * (height - 8)])
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
  return <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-10 w-full" role="img" aria-label={label}>
    <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.35"/><stop offset="100%" stopColor={color} stopOpacity="0"/></linearGradient></defs>
    <path d={`${line}L${width},${height}L0,${height}Z`} fill={`url(#${id})`}/>
    <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
  </svg>
}

const SectionHeader = ({ icon, tone = 'cyan', title, subtitle, action }) => <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
  <div className="flex items-center gap-3">
    {icon && <div className={`icon-tile tone-${tone}`}>{createElement(icon, { size: 20, 'aria-hidden': true })}</div>}
    <div><h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2>{subtitle && <p className="text-sm text-slate-400">{subtitle}</p>}</div>
  </div>
  {action}
</div>

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function Dashboard({ timerRoomRef, current, room, filtered, search, setSearch, command, status, simulation, activeCount, fanMode, setFanMode, threshold, setThreshold, timerSeconds, setTimerEnd, voiceResult, browserVoiceStatus, physicalVoiceStatus, scenes, applyScene, history, solarHistory, connection, now }) {
  const solar = current.solar || initialRooms['living-room'].solar
  const solarState = solarStatus(solar)
  const tempState = temperatureStatus(current.temperature)
  const temperatureTrend = history.filter((point) => point.id === room).slice(-24).map((point) => point.temperature)
  const powerTrend = solarHistory.slice(-120).map((sample) => sample.power)
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const energyToday = energyWh(solarHistory.filter((sample) => sample.time >= todayStart.getTime()))
  const percent = (value, max) => `${Math.max(0, Math.min(100, (value / max) * 100))}%`
  return <div className="space-y-5">
    {current.gasAlert && <section role="alert" className="glass alert-critical p-5">
      <div className="flex items-center gap-3"><div className="icon-tile tone-rose"><Flame size={20}/></div><h2 className="font-display text-lg font-semibold text-rose-100">Gas / smoke detected in the {ROOM_LABELS[room]}</h2></div>
      <p className="mt-3 text-sm text-rose-100">MQ-2 reading {Number(current.gasVoltage || 0).toFixed(2)} V. The buzzer is sounding and the door has been opened automatically. The door cannot be closed until the gas level is normal. Ventilate the area and check safely.</p>
    </section>}

    <WeatherWidget now={now}/>

    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Metric icon={Thermometer} tone="cyan" label="Temperature" value={current.temperature.toFixed(1)} unit="°C" sub={`${current.humidity}% humidity`} status={<Pill tone={tempState.tone}>{tempState.label}</Pill>}>
        <Sparkline values={temperatureTrend} color="#22d3ee" label="Temperature trend"/>
      </Metric>
      <Metric icon={Sun} tone="amber" label="Solar power" value={solar.solarPower.toFixed(2)} unit="W" sub={solar.available ? `Measured ${solar.updatedAt ? formatTime(solar.updatedAt) : 'now'}` : 'Solar sensors awaiting data'} status={<Pill tone={solarState.tone} live={solarState.live}>{solarState.label}</Pill>}>
        <Sparkline values={powerTrend} color="#f5b73b" label="Solar power trend"/>
      </Metric>
      <Metric icon={Power} tone="violet" label="Active devices" value={`${activeCount} / 3`} sub={`Updated ${formatTime(current.lastSeen)}`} status={<Pill tone={activeCount ? 'good' : 'muted'}>{activeCount ? 'Running' : 'Idle'}</Pill>}>
        <div className="flex h-10 items-end gap-1.5">{deviceMeta.map((item) => <div key={item.id} className="flex-1"><div className={`h-2 rounded-full ${current[item.id] ? 'bg-violet-400 shadow-[0_0_12px_rgba(167,139,250,0.6)]' : 'bg-white/10'}`}/><p className="mt-1.5 truncate text-[10px] text-slate-500">{item.label}</p></div>)}</div>
      </Metric>
      <Metric icon={simulation ? RefreshCcw : Wifi} tone="emerald" label="Connection" value={simulation ? 'Demo ready' : status} sub={simulation ? 'Live simulated telemetry' : 'Hardware MQTT status'} status={<Pill tone={connection.tone} live>{connection.short}</Pill>}>
        <div className="flex h-10 items-end gap-1" aria-hidden="true">{[0.35, 0.55, 0.75, 1].map((h, index) => <span key={h} className={`w-2 rounded-sm ${connection.tone === 'good' || connection.tone === 'info' ? 'bg-emerald-400/80' : index < 2 ? 'bg-amber-400/80' : 'bg-white/10'}`} style={{ height: `${h * 100}%` }}/>)}</div>
      </Metric>
    </div>

    <section className="glass p-5 sm:p-6">
      <SectionHeader icon={Zap} tone="amber" title="Live Solar Panel Monitor" subtitle="Actual measurements from the 3.7 V solar panel through the voltage sensor and ACS712 current sensor." action={<Pill tone={solarState.tone} live={solarState.live}>{solarState.label}</Pill>}/>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="glass-inset lift p-4"><p className="eyebrow">Panel voltage</p><p className="readout mt-2 text-3xl font-semibold text-amber-200">{solar.panelVoltage.toFixed(2)}<span className="ml-1 text-base text-amber-200/60">V</span></p><div className="meter mt-3"><span className="bg-gradient-to-r from-amber-500 to-amber-300" style={{ width: percent(solar.panelVoltage, SOLAR_CONFIG.maxVolts) }}/></div><p className="mt-2 text-xs text-slate-500">Scale 0–{SOLAR_CONFIG.maxVolts} V</p></div>
        <div className="glass-inset lift p-4"><p className="eyebrow">Panel current</p><p className="readout mt-2 text-3xl font-semibold text-amber-200">{solar.panelCurrent.toFixed(1)}<span className="ml-1 text-base text-amber-200/60">mA</span></p><p className="mt-5 text-xs text-slate-500">ACS712 Hall-effect sensor</p></div>
        <div className="glass-inset lift p-4"><p className="eyebrow">Generated power</p><p className="readout mt-2 text-3xl font-semibold text-amber-200">{solar.solarPower.toFixed(2)}<span className="ml-1 text-base text-amber-200/60">W</span></p><div className="meter mt-3"><span className="bg-gradient-to-r from-amber-500 to-amber-300" style={{ width: percent(solar.solarPower, SOLAR_CONFIG.ratedWatts) }}/></div><p className="mt-2 text-xs text-slate-500">Of {SOLAR_CONFIG.ratedWatts} W rated</p></div>
        <div className="glass-inset lift p-4"><p className="eyebrow">Energy today</p><p className="readout mt-2 text-3xl font-semibold text-amber-200">{energyToday.toFixed(2)}<span className="ml-1 text-base text-amber-200/60">Wh</span></p><Sparkline values={powerTrend} color="#f5b73b" label="Recent solar power"/></div>
      </div>
      {!solar.available && <p className="mt-4 flex items-center gap-2 text-xs text-amber-200"><TriangleAlert size={14} aria-hidden="true"/>Connect the voltage sensor and ACS712 before treating these values as real solar power.</p>}
    </section>

    <section className="glass p-5 sm:p-6">
      <SectionHeader icon={Cpu} title="Devices" subtitle="Commands are published to the selected room." action={<label className="relative block w-full sm:w-64"><Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden="true"/><span className="sr-only">Search devices</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search devices" className="field w-full pl-9"/></label>}/>
      <div className="grid gap-4 md:grid-cols-3">{filtered.map((item) => <Device key={item.id} item={item} active={current[item.id]} action={() => command(item.id, current[item.id] ? item.off : item.on, room)} />)}</div>
      {!filtered.length && <p className="text-sm text-slate-500">No devices match “{search}”.</p>}
    </section>

    <div className="grid gap-5 xl:grid-cols-2">
      <section className="glass p-5 sm:p-6">
        <SectionHeader icon={Fan} title="Fan automation" subtitle="Timer and temperature rule."/>
        <div className="segmented mb-5 grid w-full grid-cols-3" role="group" aria-label="Fan mode">{['manual','auto','timer'].map((mode) => <button key={mode} onClick={() => setFanMode(mode)} aria-pressed={fanMode === mode} className={`seg-btn capitalize ${fanMode === mode ? 'is-active' : ''}`}>{mode}</button>)}</div>
        {fanMode === 'auto'
          ? <div className="glass-inset p-4">
              <label className="flex flex-wrap items-center gap-3 text-sm text-slate-300">Turn fan on at <input type="number" min="16" max="40" value={threshold} onChange={(event) => setThreshold(clampFanThreshold(event.target.value))} className="field w-24 text-center font-display text-lg"/> °C</label>
              <div className="mt-4 flex items-center justify-between text-xs text-slate-400"><span>Room now {current.temperature.toFixed(1)} °C</span><Pill tone={current.temperature >= threshold ? 'good' : 'muted'}>{current.temperature >= threshold ? 'Fan should run' : 'Below threshold'}</Pill></div>
              <div className="meter mt-2"><span className="bg-gradient-to-r from-cyan-500 to-cyan-300" style={{ width: percent(current.temperature - 16, 24) }}/></div>
            </div>
          : <div className="glass-inset flex flex-wrap items-center justify-between gap-4 p-4">
              <div className="flex items-center gap-3"><div className="icon-tile tone-cyan"><Timer size={20} aria-hidden="true"/></div><span className={timerSeconds ? 'readout text-2xl font-semibold text-cyan-100' : 'text-sm text-slate-400'}>{timerSeconds ? `${Math.floor(timerSeconds/60)}:${String(timerSeconds%60).padStart(2,'0')} remaining` : 'No active timer'}</span></div>
              <button onClick={() => { timerRoomRef.current = room; setFanMode('timer'); setTimerEnd(Date.now() + 15 * 60000); command('fan','ON',room) }} className="btn btn-primary">Start 15 min</button>
            </div>}
      </section>
      <section className="glass p-5 sm:p-6">
        <SectionHeader icon={Sparkles} tone="violet" title="Quick scenes" subtitle="Apply a coordinated set of device commands."/>
        <div className="grid gap-3 sm:grid-cols-2">{scenes.map((scene) => <button key={scene.id} onClick={() => applyScene(scene)} className="lift glass-inset flex items-center gap-3 p-4 text-left font-medium hover:border-violet-400/30">{createElement(scene.id === 'good-night' ? Moon : scene.id === 'movie' ? Film : Sparkles, { size: 20, className: 'text-violet-300', 'aria-hidden': true })}{scene.name}</button>)}</div>
      </section>
    </div>

    <section className="glass p-5 sm:p-6">
      <SectionHeader icon={Mic} title="Always-on voice control" subtitle="Commands can be spoken through the website microphone or the physical ESP32 INMP441 microphone."/>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="glass-inset p-4"><div className="flex items-center justify-between gap-2"><p className="eyebrow text-cyan-300">Website microphone</p><Pill tone={/Always listening/.test(browserVoiceStatus) ? 'good' : /denied|unavailable|requires/.test(browserVoiceStatus) ? 'crit' : 'warn'} live={/Always listening/.test(browserVoiceStatus)}>{/Always listening/.test(browserVoiceStatus) ? 'Listening' : /denied|unavailable|requires/.test(browserVoiceStatus) ? 'Unavailable' : 'Starting'}</Pill></div><p className="mt-3 text-sm text-slate-200">{browserVoiceStatus}</p></div>
        <div className="glass-inset p-4"><div className="flex items-center justify-between gap-2"><p className="eyebrow text-cyan-300">INMP441 physical microphone</p><Pill tone={/fail|NOT/.test(physicalVoiceStatus) ? 'crit' : /Waiting/.test(physicalVoiceStatus) ? 'muted' : 'good'} live={/listening|recogni/i.test(physicalVoiceStatus)}>{/fail|NOT/.test(physicalVoiceStatus) ? 'Fault' : /Waiting/.test(physicalVoiceStatus) ? 'Waiting' : 'Active'}</Pill></div><p className="mt-3 text-sm text-slate-200">{physicalVoiceStatus}</p></div>
      </div>
      <div className="mt-3 rounded-2xl border border-cyan-300/20 bg-gradient-to-r from-cyan-400/10 to-transparent p-4"><p className="eyebrow text-cyan-300">Latest command result</p><p className="mt-2 text-sm text-cyan-50">{voiceResult}</p></div>
      <p className="mt-4 text-xs text-slate-500">Supported examples: turn on the light, turn off the fan, open the door, start fan timer for 15 minutes, set fan threshold to 26 degrees, and activate good night scene.</p>
    </section>
  </div>
}

function Metric({ icon, tone = 'cyan', label, value, unit, sub, status, children }) {
  return <article className="glass lift flex flex-col p-5 backdrop-blur-xl">
    <div className="flex items-start justify-between gap-3">
      <div className={`icon-tile tone-${tone}`}>{createElement(icon, { size: 20, 'aria-hidden': true })}</div>
      {status}
    </div>
    <p className="mt-4 text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</p>
    <p className="readout mt-1 text-3xl font-bold capitalize text-white">{value}{unit && <span className="ml-1 text-lg font-medium text-slate-400">{unit}</span>}</p>
    <p className="mt-1 text-xs text-slate-400 font-medium">{sub}</p>
    {children && <div className="mt-3.5">{children}</div>}
  </article>
}

const Device = ({item, active, action}) => {
  const activeBg = item.id === 'light'
    ? 'bg-gradient-to-br from-amber-500/15 via-slate-900/70 to-slate-950/80 border-amber-400/40 shadow-[0_0_45px_-12px_rgba(251,191,36,0.35)]'
    : item.id === 'fan'
    ? 'bg-gradient-to-br from-cyan-500/15 via-slate-900/70 to-slate-950/80 border-cyan-400/40 shadow-[0_0_45px_-12px_rgba(56,189,248,0.35)]'
    : 'bg-gradient-to-br from-emerald-500/15 via-slate-900/70 to-slate-950/80 border-emerald-400/40 shadow-[0_0_45px_-12px_rgba(52,211,153,0.35)]'
    
  return <article className={`glass lift flex flex-col p-5.5 ${active ? activeBg : 'hover:border-white/20'}`}>
    <div className="flex items-start justify-between gap-3">
      <div className={`icon-tile h-12 w-12 ${active ? (item.id === 'light' ? 'tone-amber' : item.id === 'fan' ? 'tone-cyan' : 'tone-emerald') : 'tone-slate'}`}>
        {createElement(item.id === 'door' && active ? DoorOpen : item.icon, { size: 22, className: item.id === 'fan' && active ? 'spin-slow' : undefined, 'aria-hidden': true })}
      </div>
      <Pill tone={active ? 'good' : 'muted'} live={active}>{active ? item.on : item.off}</Pill>
    </div>
    <h3 className="mt-5 font-display text-lg font-semibold tracking-tight text-white">{item.label}</h3>
    <p className="text-xs font-medium text-slate-400">{DEVICE_DETAILS[item.id]}</p>
    <button onClick={action} className={`btn mt-5 w-full ${active ? 'btn-danger' : 'btn-primary'}`}>
      {active ? (item.id === 'door' ? 'Close door' : 'Turn off') : (item.id === 'door' ? 'Open door' : 'Turn on')}
    </button>
  </article>
}

function Analytics({rooms, history}) {
  const latest = history.slice(-18)
  return <div className="space-y-5">
    <section className="glass p-5 sm:p-6">
      <SectionHeader icon={BarChart3} title="Temperature history" subtitle="Sampled every five minutes and stored in this browser."/>
      <div className="mb-4 flex flex-wrap gap-4 text-xs text-slate-300">{ROOM_IDS.map((id) => <span key={id} className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: ROOM_COLORS[id] }} aria-hidden="true"/>{ROOM_LABELS[id]}</span>)}</div>
      <div className="glass-inset relative p-4">
        <div className="pointer-events-none absolute inset-x-4 top-4 bottom-4 flex flex-col justify-between" aria-hidden="true">{[0, 1, 2, 3].map((line) => <div key={line} className="border-t border-white/5"/>)}</div>
        <div className="relative flex h-52 items-end gap-2">{latest.length ? latest.map((point, index) => <div key={`${point.time}-${index}`} title={`${ROOM_LABELS[point.id]}: ${point.temperature}°C`} className="flex-1 rounded-t-md opacity-90 transition-opacity hover:opacity-100" style={{height:`${Math.max(10, (point.temperature - 15) * 4)}%`, background: `linear-gradient(180deg, ${ROOM_COLORS[point.id] || '#3987e5'}, ${ROOM_COLORS[point.id] || '#3987e5'}55)`}} />) : <p className="self-center text-slate-500">History will appear after the first sample.</p>}</div>
      </div>
    </section>
    <div className="grid gap-4 md:grid-cols-3">{Object.entries(rooms).map(([id,data]) => {
      const state = temperatureStatus(data.temperature)
      return <Metric key={id} icon={Home} tone="cyan" label={ROOM_LABELS[id]} value={`${data.temperature}°C`} sub={`${data.humidity}% humidity • ${Number(data.light)+Number(data.fan)+Number(data.door)} active`} status={<Pill tone={state.tone}>{state.label}</Pill>}>
        <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: ROOM_COLORS[id] }} aria-hidden="true"/><div className="meter flex-1"><span style={{ width: `${Math.max(0, Math.min(100, (data.humidity / 100) * 100))}%`, background: ROOM_COLORS[id] }}/></div><Droplets size={14} className="text-slate-500" aria-hidden="true"/></div>
      </Metric>
    })}</div>
  </div>
}

function Scenes({room, scenes, applyScene, schedules, setSchedules, scheduleName, setScheduleName}) {
  const [time, setTime] = useState('22:00')
  const [sceneId, setSceneId] = useState(scenes[0]?.id)
  const add = () => { if (!scheduleName.trim() || !time) return; setSchedules((items) => [...items, { id: crypto.randomUUID(), name: scheduleName.trim(), time, scene: sceneId, room, enabled: true }]); setScheduleName('') }
  return <div className="grid gap-5 lg:grid-cols-2">
    <section className="glass p-5 sm:p-6">
      <SectionHeader icon={Sparkles} tone="violet" title="Scenes" subtitle="One-tap room automations."/>
      <div className="space-y-3">{scenes.map((scene) => <div key={scene.id} className="glass-inset lift flex items-center justify-between gap-3 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="icon-tile tone-violet">{createElement(scene.id === 'good-night' ? Moon : scene.id === 'movie' ? Film : Sparkles, { size: 20, 'aria-hidden': true })}</div>
          <div className="min-w-0"><p className="font-medium">{scene.name}</p><div className="mt-1 flex flex-wrap gap-1.5">{Object.entries(scene.values).map(([key,value]) => <span key={key} className={`rounded-md px-1.5 py-0.5 text-[11px] ${value ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/5 text-slate-400'}`}>{`${key} ${value ? 'on' : 'off'}`}</span>)}</div></div>
        </div>
        <button onClick={() => applyScene(scene)} className="btn btn-primary shrink-0">Apply</button>
      </div>)}</div>
    </section>
    <section className="glass p-5 sm:p-6">
      <SectionHeader icon={CalendarClock} title="Schedules" subtitle={`New schedules apply to the ${ROOM_LABELS[room]}.`}/>
      <div className="glass-inset grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
        <input value={scheduleName} onChange={(event) => setScheduleName(event.target.value)} placeholder="Schedule name" className="field min-w-0"/>
        <input type="time" value={time} onChange={(event) => setTime(event.target.value)} className="field"/>
        <select value={sceneId} onChange={(event) => setSceneId(event.target.value)} className="field">{scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.name}</option>)}</select>
        <button onClick={add} aria-label="Add schedule" className="btn btn-primary px-3"><Plus size={18}/></button>
      </div>
      <p className="mt-3 flex items-center gap-2 text-xs text-amber-200"><TriangleAlert size={14} aria-hidden="true"/>Schedules run only while this dashboard is open; add a backend worker for automation when it is closed.</p>
      <div className="mt-2 space-y-2">{schedules.map((item) => <div key={item.id} className="glass-inset mt-3 flex items-center justify-between gap-3 p-3">
        <div className="flex min-w-0 items-center gap-3"><Clock size={18} className={item.enabled ? 'shrink-0 text-cyan-300' : 'shrink-0 text-slate-600'} aria-hidden="true"/><span className="min-w-0 text-sm"><span className="font-medium text-slate-100">{item.name}</span><span className="block text-xs text-slate-400">{scenes.find((scene) => scene.id === item.scene)?.name || item.scene} at <span className="readout text-slate-200">{item.time}</span> • {ROOM_LABELS[item.room] || 'current room'}</span></span></div>
        <div className="flex shrink-0 items-center gap-2"><button onClick={() => setSchedules((all) => all.map((entry) => entry.id === item.id ? { ...entry, enabled: !entry.enabled } : entry))} aria-pressed={item.enabled} className={`btn px-3 py-1.5 text-xs ${item.enabled ? 'btn-success' : 'btn-ghost'}`}>{item.enabled ? 'On' : 'Off'}</button><button aria-label="Delete schedule" onClick={() => setSchedules((all) => all.filter((entry) => entry.id !== item.id))} className="btn btn-ghost px-2 py-1.5 hover:text-rose-300"><X size={16}/></button></div>
      </div>)}</div>
      {!schedules.length && <p className="mt-4 text-sm text-slate-500">No schedules yet.</p>}
    </section>
  </div>
}

function Security({current, events, command}) {
  return <div className="grid gap-5 lg:grid-cols-2">
    <section className={`glass p-5 sm:p-6 ${current.gasAlert ? 'alert-critical' : ''}`}>
      <SectionHeader icon={current.gasAlert ? Flame : ShieldCheck} tone={current.gasAlert ? 'rose' : 'emerald'} title="MQ-2 gas safety" action={<Pill tone={current.gasAlert ? 'crit' : 'good'} live>{current.gasAlert ? 'Alarm' : 'Safe'}</Pill>}/>
      <div className="glass-inset p-4"><p className="eyebrow">Sensor output</p><p className="mt-2 text-sm text-slate-300">Sensor output: <strong className="readout text-2xl text-white">{Number(current.gasVoltage || 0).toFixed(3)} V</strong></p><div className="meter mt-3"><span className={current.gasAlert ? 'bg-gradient-to-r from-rose-500 to-rose-300' : 'bg-gradient-to-r from-emerald-500 to-emerald-300'} style={{ width: `${Math.max(0, Math.min(100, (Number(current.gasVoltage || 0) / 3.3) * 100))}%` }}/></div></div>
      <p className="mt-4 text-sm font-medium">{current.gasAlert ? 'Gas / smoke alert - ventilate the area and inspect safely.' : 'No gas alert reported.'}</p>
      <p className="mt-3 text-xs text-amber-100/80">MQ-2 is a demonstration detector, not a certified life-safety device. Do not use a normal relay or fan as an automatic LPG safety system.</p>
    </section>
    <section className="glass p-5 sm:p-6">
      <SectionHeader icon={current.door ? LockOpen : Lock} tone={current.door ? 'amber' : 'emerald'} title="Door security" action={<Pill tone={current.door ? 'warn' : 'good'}>{current.door ? 'Open' : 'Closed'}</Pill>}/>
      <p className="text-sm text-slate-400">Door is currently <strong className="text-slate-100">{current.door ? 'open' : 'closed'}</strong>.</p>
      <button onClick={() => command('door', current.door ? 'CLOSE' : 'OPEN')} className={`btn mt-5 w-full sm:w-auto ${current.door ? 'btn-success' : 'btn-ghost'}`}>{createElement(current.door ? Lock : LockOpen, { size: 16, 'aria-hidden': true })}{current.door ? 'Lock door' : 'Unlock door'}</button>
      <p className="mt-4 text-xs text-amber-200/90">For a real lock, require a PIN or server-side authorization before unlock commands.</p>
    </section>
    <section className="glass p-5 sm:p-6 lg:col-span-2">
      <SectionHeader icon={Activity} title="Activity log" subtitle={`${events.length} most recent events`}/>
      <div className="max-h-96 space-y-2 overflow-auto pr-1">{events.length ? events.map((event) => <div key={event.id} className="glass-inset flex items-start gap-3 p-3 text-sm">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${event.level === 'warn' ? 'bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.7)]' : 'bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.6)]'}`} aria-hidden="true"/>
        <div className="min-w-0 flex-1"><p className="text-slate-200">{event.message}</p><p className="mt-1 text-xs text-slate-500">{formatTime(event.time)}</p></div>
      </div>) : <p className="text-sm text-slate-500">No activity yet.</p>}</div>
    </section>
  </div>
}

function SettingsPage({simulation, status, setRooms, events}) {
  const reset = () => { localStorage.clear(); setRooms(initialRooms); window.location.reload() }
  return <div className="grid gap-5 lg:grid-cols-2">
    <section className="glass p-5 sm:p-6">
      <SectionHeader icon={Radio} title="Connection configuration" action={<Pill tone={simulation ? 'info' : status === 'connected' ? 'good' : 'warn'}>{simulation ? 'Simulation' : status}</Pill>}/>
      <p className="text-sm text-slate-400">Status: <strong className="text-slate-100">{simulation ? 'Simulation mode' : status}</strong></p>
      <code className="mt-4 block overflow-auto rounded-xl border border-white/5 bg-black/40 p-4 text-xs leading-relaxed text-cyan-200">VITE_MQTT_URL=wss://your-broker.example/mqtt{`\n`}VITE_MQTT_ROOM_PREFIX=smart-home</code>
      <p className="mt-3 text-sm text-slate-400">Put credentials in <code className="rounded bg-white/5 px-1.5 py-0.5 text-slate-200">.env.local</code>; never use public unauthenticated topics for a real door lock.</p>
    </section>
    <section className="glass p-5 sm:p-6">
      <SectionHeader icon={Database} tone="violet" title="Local data"/>
      <p className="text-sm text-slate-400">{events.length} activity records and device state are stored in this browser.</p>
      <button onClick={reset} className="btn btn-danger mt-5"><RotateCcw size={16} aria-hidden="true"/>Reset dashboard data</button>
    </section>
  </div>
}

export default App
