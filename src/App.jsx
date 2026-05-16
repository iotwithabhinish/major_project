import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import client from './mqtt'
import {
  AirVent,
  BarChart3,
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Clapperboard,
  DoorClosed,
  Home,
  Lightbulb,
  Mic,
  MicOff,
  Music2,
  RefreshCcw,
  Search,
  Shield,
  SlidersHorizontal,
  Thermometer,
  User,
  Video,
  Wifi,
  Zap,
} from 'lucide-react'
import {
  clampFanThreshold,
  clampFanTimerMinutes,
  MQTT_TOPICS,
  parseVoiceCommand,
  parseVoiceTranscriptPayload,
  VOICE_COMMAND_EXAMPLES,
} from './voiceControl'

const navItems = [
  { id: 'home', icon: Home, label: 'Home' },
  { id: 'chart', icon: BarChart3, label: 'Analytics' },
  { id: 'cctv', icon: Video, label: 'CCTV' },
  { id: 'scenes', icon: Clapperboard, label: 'Scenes' },
  { id: 'profile', icon: User, label: 'Profile' },
  { id: 'settings', icon: SlidersHorizontal, label: 'Settings' },
]

const topActions = [
  { id: 'weather', icon: Thermometer, label: '24 C' },
  { id: 'energy', icon: Zap, label: 'Energy' },
  { id: 'alerts', icon: Bell, label: 'Alerts' },
]

const activityFeed = [
  { id: 1, time: '09:36 AM', title: 'Smart Lamp', detail: 'Turned on automatically' },
  { id: 2, time: '09:04 AM', title: 'Air Conditioner', detail: 'Set to 20 C' },
]

const quickDeviceMeta = [
  { id: 'light', title: 'Light', subtitle: '1 device', icon: Lightbulb },
  { id: 'fan', title: 'Fan', subtitle: '1 device', icon: AirVent },
  { id: 'door', title: 'Door', subtitle: '1 device', icon: DoorClosed },
]

function App() {
  const [activeNav, setActiveNav] = useState('home')
  const [activeAction, setActiveAction] = useState('weather')
  const [fanThreshold, setFanThreshold] = useState(24.0)
  const [fanMode, setFanMode] = useState('manual')
  const [timerMinutes, setTimerMinutes] = useState(30)
  const [timerActive, setTimerActive] = useState(false)
  const [timerRemaining, setTimerRemaining] = useState(0)
  const [isPlaying, setIsPlaying] = useState(true)
  const [activeRoom, setActiveRoom] = useState('Room')
  const [chartRange, setChartRange] = useState('Last week')
  const [data, setData] = useState({ light: 1, fan: 0, door: 1, temperature: 23.5 })
  const [currentTime, setCurrentTime] = useState(new Date())
  const [mqttStatus, setMqttStatus] = useState(client.connected ? 'connected' : 'connecting')
  const [isListening, setIsListening] = useState(false)
  const [lastTranscript, setLastTranscript] = useState('')
  const [lastVoiceSource, setLastVoiceSource] = useState('Ready')
  const [voiceStatus, setVoiceStatus] = useState('Voice control is idle.')
  const [voiceError, setVoiceError] = useState('')
  const [voiceEvents, setVoiceEvents] = useState([])
  const [manualCommand, setManualCommand] = useState(VOICE_COMMAND_EXAMPLES[0])
  const [browserSpeechRuntimeError, setBrowserSpeechRuntimeError] = useState('')
  const [isWakeWordMode, setIsWakeWordMode] = useState(true)
  const isWakeWordModeRef = useRef(true)
  const [isManualListening, setIsManualListening] = useState(false)
  const isManualListeningRef = useRef(false)
  const recognitionRef = useRef(null)
  const fanModeRef = useRef(fanMode)
  const voiceTranscriptHandlerRef = useRef(null)
  const publishDeviceCommandRef = useRef(null)
  const shouldAutoRestartRef = useRef(true)

  const resolveDht11Temperature = (payload, fallbackTemperature) => {
    if (!payload || typeof payload !== 'object') {
      return fallbackTemperature
    }

    const candidateValues = [
      payload.dht11Temperature,
      payload.dhtTemperature,
      payload.dht11_temperature,
      payload.temperature_dht11,
      payload.temp_dht11,
      payload.currentTemperature,
      payload.temp,
      payload.tempC,
      payload.dht11?.temperature,
      payload.dht?.temperature,
      payload.sensor?.temperature,
      payload.temperature,
    ]

    for (const value of candidateValues) {
      const parsedValue =
        typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : NaN

      if (Number.isFinite(parsedValue)) {
        return parsedValue
      }
    }

    return fallbackTemperature
  }

  const resolveTelemetryDeviceState = (value, fallbackState, device = 'switch') => {
    if (typeof value === 'number') {
      return Number(value > 0)
    }

    if (typeof value === 'boolean') {
      return Number(value)
    }

    if (typeof value === 'string') {
      const normalizedValue = value.trim().toLowerCase()

      if (['1', 'on', 'true', 'open', 'opened', 'unlock', 'unlocked'].includes(normalizedValue)) {
        return 1
      }

      if (['0', 'off', 'false', 'close', 'closed', 'shut', 'lock', 'locked'].includes(normalizedValue)) {
        return 0
      }

      if (device === 'door') {
        if (normalizedValue.includes('open') || normalizedValue.includes('unlock')) {
          return 1
        }

        if (normalizedValue.includes('close') || normalizedValue.includes('lock')) {
          return 0
        }
      }
    }

    return fallbackState
  }

  const browserSpeechSupport = useMemo(() => {
    if (typeof window === 'undefined') {
      return {
        available: false,
        reason: 'Browser microphone detection is unavailable during server rendering.',
      }
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      return {
        available: false,
        reason: 'This browser does not expose the SpeechRecognition API.',
      }
    }

    const host = window.location.hostname
    const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(host)

    if (!window.isSecureContext && !isLocalHost) {
      return {
        available: false,
        reason: 'Browser speech needs HTTPS or localhost.',
      }
    }

    if (navigator.onLine === false) {
      return {
        available: false,
        reason: 'Browser speech is unavailable while the device is offline.',
      }
    }

    return { available: true, reason: '' }
  }, [])

  const browserSpeechReady = browserSpeechSupport.available

  const quickDevices = useMemo(
    () =>
      quickDeviceMeta.map((item) => ({
        ...item,
        active: Boolean(data[item.id]),
      })),
    [data],
  )

  const deviceControls = useMemo(
    () => [
      {
        id: 'light',
        title: 'Smart Light',
        description: 'Toggle room lighting',
        icon: Lightbulb,
        active: Boolean(data.light),
        activeLabel: data.light ? 'ON' : 'OFF',
        actionLabel: data.light ? 'Turn Off' : 'Turn On',
        iconActiveTheme: 'from-amber-300/20 to-white/10 text-amber-100',
        iconInactiveTheme: 'bg-white/5 text-zinc-400',
        badgeActiveTheme: 'text-amber-300 border-amber-300/50 bg-amber-300/10',
        badgeInactiveTheme: 'text-zinc-400 border-zinc-400/50 bg-zinc-400/10',
        btnActiveTheme:
          'bg-gradient-to-r from-red-500 to-orange-500 text-white shadow-lg shadow-red-500/20 hover:shadow-red-500/40',
        btnInactiveTheme:
          'bg-gradient-to-r from-amber-400 to-amber-300 text-zinc-900 shadow-lg shadow-amber-400/20 hover:shadow-amber-400/40',
      },
      {
        id: 'fan',
        title: 'Ceiling Fan',
        description: 'Start or stop the fan',
        icon: AirVent,
        active: Boolean(data.fan),
        activeLabel: data.fan ? 'ON' : 'OFF',
        actionLabel: data.fan ? 'Turn Off' : 'Turn On',
        iconActiveTheme: 'from-blue-300/20 to-white/10 text-blue-100',
        iconInactiveTheme: 'bg-white/5 text-zinc-400',
        badgeActiveTheme: 'text-blue-300 border-blue-300/50 bg-blue-300/10',
        badgeInactiveTheme: 'text-zinc-400 border-zinc-400/50 bg-zinc-400/10',
        btnActiveTheme:
          'bg-gradient-to-r from-red-500 to-orange-500 text-white shadow-lg shadow-red-500/20 hover:shadow-red-500/40',
        btnInactiveTheme:
          'bg-gradient-to-r from-blue-400 to-cyan-300 text-zinc-900 shadow-lg shadow-blue-400/20 hover:shadow-blue-400/40',
      },
      {
        id: 'door',
        title: 'Door Lock',
        description: 'Open or close the door',
        icon: DoorClosed,
        active: Boolean(data.door),
        activeLabel: data.door ? 'OPEN' : 'CLOSED',
        actionLabel: data.door ? 'Close Door' : 'Open Door',
        iconActiveTheme: 'from-green-300/20 to-white/10 text-green-100',
        iconInactiveTheme: 'bg-white/5 text-zinc-400',
        badgeActiveTheme: 'text-green-300 border-green-300/50 bg-green-300/10',
        badgeInactiveTheme: 'text-zinc-400 border-zinc-400/50 bg-zinc-400/10',
        btnActiveTheme:
          'bg-gradient-to-r from-red-500 to-orange-500 text-white shadow-lg shadow-red-500/20 hover:shadow-red-500/40',
        btnInactiveTheme:
          'bg-gradient-to-r from-green-400 to-emerald-300 text-zinc-900 shadow-lg shadow-green-400/20 hover:shadow-green-400/40',
      },
    ],
    [data],
  )

  const activeQuickCount = useMemo(
    () => quickDevices.reduce((count, item) => count + Number(item.active), 0),
    [quickDevices],
  )

  const pushVoiceEvent = (transcript, source, result, success) => {
    setVoiceEvents((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        transcript,
        source,
        result,
        success,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
      ...prev,
    ].slice(0, 4))
  }

  const applyLocalDeviceState = (device, state) => {
    setData((prev) => ({
      ...prev,
      [device]: device === 'door' ? Number(state === 'OPEN') : Number(state === 'ON'),
    }))

    if (device === 'fan' && state === 'OFF') {
      setTimerActive(false)
      setTimerRemaining(0)
    }
  }

  const publishDeviceCommand = (device, state) => {
    client.publish(MQTT_TOPICS.commands, JSON.stringify({ device, state }))
    applyLocalDeviceState(device, state)
  }

  const setManualFanPower = (state) => {
    stopFanTimer()
    fanModeRef.current = 'manual'
    setFanMode('manual')
    publishDeviceCommand('fan', state)
  }

  const handleFanModeChange = (nextMode) => {
    fanModeRef.current = nextMode
    setFanMode(nextMode)

    if (nextMode !== 'timer') {
      stopFanTimer()
    }
  }

  const handleFanPowerToggle = () => {
    setManualFanPower(data.fan ? 'OFF' : 'ON')
  }

  const toggleQuickDevice = (id) => {
    if (id === 'fan') {
      setManualFanPower(data.fan ? 'OFF' : 'ON')
      return
    }

    const nextState = id === 'door' ? (data[id] ? 'CLOSE' : 'OPEN') : (data[id] ? 'OFF' : 'ON')
    publishDeviceCommand(id, nextState)
  }

  const startFanTimer = (minutes = timerMinutes) => {
    const nextMinutes = clampFanTimerMinutes(minutes)
    fanModeRef.current = 'timer'
    setFanMode('timer')
    setTimerMinutes(nextMinutes)
    setTimerRemaining(nextMinutes * 60)
    setTimerActive(true)
    publishDeviceCommand('fan', 'ON')
  }

  const stopFanTimer = () => {
    setTimerActive(false)
    setTimerRemaining(0)
  }

  const handleVoiceTranscript = (transcript, source = 'Browser mic') => {
    const cleanedTranscript = transcript.trim()
    if (!cleanedTranscript) {
      return
    }

    setLastTranscript(cleanedTranscript)
    setLastVoiceSource(source)
    setVoiceError('')

    const parsedCommand = parseVoiceCommand(cleanedTranscript)
    if (!parsedCommand) {
      const result = 'Command not recognized. Try one of the sample phrases.'
      setVoiceStatus(result)
      pushVoiceEvent(cleanedTranscript, source, result, false)
      return
    }

    let result = ''

    switch (parsedCommand.type) {
      case 'device':
        if (parsedCommand.device === 'fan') {
          setManualFanPower(parsedCommand.state)
        } else {
          publishDeviceCommand(parsedCommand.device, parsedCommand.state)
        }
        result =
          parsedCommand.device === 'door'
            ? `Door ${parsedCommand.state === 'OPEN' ? 'opened' : 'closed'}.`
            : `${parsedCommand.device[0].toUpperCase()}${parsedCommand.device.slice(1)} ${
                parsedCommand.state === 'ON' ? 'turned on' : 'turned off'
              }.`
        break
      case 'fan-threshold':
        handleFanModeChange('auto')
        setFanThreshold(clampFanThreshold(parsedCommand.value))
        result = `Fan threshold set to ${clampFanThreshold(parsedCommand.value).toFixed(1)} C.`
        break
      case 'fan-timer-start':
        startFanTimer(parsedCommand.minutes)
        result = `Fan timer started for ${parsedCommand.minutes} minutes.`
        break
      case 'fan-timer-stop':
        stopFanTimer()
        result = 'Fan timer stopped.'
        break
      case 'navigation':
        setActiveNav(parsedCommand.target)
        result = `${parsedCommand.label}.`
        break
      case 'music':
        setIsPlaying(parsedCommand.state === 'play')
        result = parsedCommand.state === 'play' ? 'Music resumed.' : 'Music paused.'
        break
      case 'scene':
        stopFanTimer()
        publishDeviceCommand('light', 'OFF')
        setManualFanPower('OFF')
        publishDeviceCommand('door', 'CLOSE')
        result = 'Room powered down. Light and fan are off, and the door is closed.'
        break
      default:
        result = 'Voice command received.'
    }

    setVoiceStatus(result)
    pushVoiceEvent(cleanedTranscript, source, result, true)
  }

  const submitManualCommand = () => {
    const command = manualCommand.trim()

    if (!command) {
      setVoiceError('Enter a command or tap one of the sample phrases first.')
      return
    }

    setVoiceError('')
    handleVoiceTranscript(command, 'Command box')
  }

  const toggleVoiceCapture = () => {
    if (!browserSpeechSupport.available) {
      setVoiceError(
        browserSpeechSupport.reason ||
          'Browser speech recognition is unavailable here. Use the command box or publish transcripts to room1/voice/transcript.',
      )
      return
    }

    const recognition = recognitionRef.current
    if (!recognition) {
      setVoiceError('Speech recognition is not initialized yet.')
      return
    }

    try {
      if (isListening) {
        setIsManualListening(false)
        isManualListeningRef.current = false
        shouldAutoRestartRef.current = false
        recognition.abort()
        return
      }

      if (browserSpeechRuntimeError) {
        setBrowserSpeechRuntimeError('')
      }

      setIsManualListening(true)
      isManualListeningRef.current = true
      shouldAutoRestartRef.current = false
      setVoiceError('')
      setVoiceStatus('Listening for your command...')
      recognition.start()
    } catch (error) {
      console.error('Unable to toggle speech recognition', error)
      setVoiceError('Unable to start speech recognition. Please retry after granting microphone access.')
    }
  }

  useEffect(() => {
    fanModeRef.current = fanMode
    publishDeviceCommandRef.current = publishDeviceCommand
    voiceTranscriptHandlerRef.current = handleVoiceTranscript
  })

  useEffect(() => {
    let interval = null
    if (timerActive && timerRemaining > 0) {
      interval = setInterval(() => setTimerRemaining((prev) => prev - 1), 1000)
    } else if (timerActive && timerRemaining === 0) {
      stopFanTimer()
      publishDeviceCommandRef.current?.('fan', 'OFF')
    }
    return () => clearInterval(interval)
  }, [timerActive, timerRemaining])

  useEffect(() => {
    if (fanMode !== 'auto') {
      return
    }

    const currentTemp = data.temperature ?? 23.5
    const nextState = currentTemp >= fanThreshold ? 'ON' : 'OFF'

    if (Number(data.fan) !== Number(nextState === 'ON')) {
      publishDeviceCommandRef.current?.('fan', nextState)
    }
  }, [data.temperature, data.fan, fanThreshold, fanMode])

  useEffect(() => {
    client.subscribe(MQTT_TOPICS.telemetry)
    client.subscribe(MQTT_TOPICS.voiceTranscript)

    const handleMessage = (topic, message) => {
      if (topic === MQTT_TOPICS.telemetry) {
        try {
          const parsed = JSON.parse(message.toString())
          setData((prev) => {
            const nextTemperature = resolveDht11Temperature(parsed, prev.temperature)
            const nextData = { ...prev, ...parsed, temperature: nextTemperature }

            if (Object.prototype.hasOwnProperty.call(parsed, 'light')) {
              nextData.light = resolveTelemetryDeviceState(parsed.light, prev.light)
            }

            if (Object.prototype.hasOwnProperty.call(parsed, 'door')) {
              nextData.door = resolveTelemetryDeviceState(parsed.door, prev.door, 'door')
            }

            if (Object.prototype.hasOwnProperty.call(parsed, 'fan')) {
              nextData.fan =
                fanModeRef.current === 'auto'
                  ? resolveTelemetryDeviceState(parsed.fan, prev.fan)
                  : prev.fan
            }

            return nextData
          })
        } catch (error) {
          console.error('Invalid telemetry payload', error)
        }
      }

      if (topic === MQTT_TOPICS.voiceTranscript) {
        const payload = parseVoiceTranscriptPayload(message.toString())
        if (payload?.transcript) {
          voiceTranscriptHandlerRef.current?.(payload.transcript, payload.source)
        }
      }
    }

    client.on('message', handleMessage)
    return () => {
      client.off('message', handleMessage)
    }
  }, [])

  useEffect(() => {
    const handleConnect = () => setMqttStatus('connected')
    const handleReconnect = () => setMqttStatus('reconnecting')
    const handleOffline = () => setMqttStatus('offline')
    const handleClose = () => setMqttStatus('offline')
    const handleError = () => setMqttStatus('error')

    client.on('connect', handleConnect)
    client.on('reconnect', handleReconnect)
    client.on('offline', handleOffline)
    client.on('close', handleClose)
    client.on('error', handleError)

    return () => {
      client.off('connect', handleConnect)
      client.off('reconnect', handleReconnect)
      client.off('offline', handleOffline)
      client.off('close', handleClose)
      client.off('error', handleError)
    }
  }, [])

  useEffect(() => {
    if (!browserSpeechSupport.available) {
      return undefined
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    const recognition = new SpeechRecognition()

    recognition.continuous = true
    recognition.interimResults = false
    recognition.lang = 'en-US'
    recognition.maxAlternatives = 1

    recognition.onstart = () => {
      setIsListening(true)
      if (isManualListeningRef.current) {
        setVoiceStatus('Listening for your command...')
      } else {
        setVoiceStatus('Waiting for "Ok Google" or "Hey Puntu"...')
      }
      setVoiceError('')
      setBrowserSpeechRuntimeError('')
      setLastVoiceSource('Browser mic')
    }

    recognition.onend = () => {
      setIsListening(false)
      if (shouldAutoRestartRef.current && !isManualListeningRef.current) {
        isWakeWordModeRef.current = true
        setIsWakeWordMode(true)
        try {
          recognition.start()
        } catch {
          // Ignore if already starting
        }
      }
    }

    recognition.onspeechend = () => {
      try {
        recognition.stop()
      } catch {
        // Ignore cleanup errors when the recognizer is already stopping.
      }
    }

    recognition.onnomatch = () => {
      setVoiceStatus('Speech heard, but no supported command was matched.')
    }

    recognition.onerror = (event) => {
      setIsListening(false)

      if (event.error === 'aborted') {
        setVoiceStatus('Listening stopped.')
        setIsManualListening(false)
        isManualListeningRef.current = false
        shouldAutoRestartRef.current = true
        return
      }

      if (event.error === 'no-speech') {
        if (isManualListeningRef.current) {
          setVoiceStatus('No speech detected. Try again.')
          return
        }
        setVoiceStatus('No speech detected. Listening for "Ok Google" or "Hey Puntu"...')
        shouldAutoRestartRef.current = true
        try {
          setTimeout(() => recognitionRef.current?.start(), 500)
        } catch {}
        return
      }

      if (event.error === 'not-allowed') {
        setVoiceError('Microphone access was denied. Allow microphone permission and try again.')
        return
      }

      if (event.error === 'audio-capture') {
        setVoiceError('No microphone audio was captured. Check the device microphone and browser permission.')
        return
      }

      if (event.error === 'network') {
        const message =
          'Browser speech is blocked in this browser or webview. Use Chrome or Edge over HTTPS, or use the command box / INMP441 MQTT transcript below.'
        setBrowserSpeechRuntimeError(message)
        setVoiceStatus('Browser mic unavailable in this environment.')
        setVoiceError(message)
        return
      }

      setVoiceError(`Speech recognition error: ${event.error}`)
    }

    recognition.onresult = (event) => {
      const speechWindow = Array.from(event.results).slice(event.resultIndex)
      const transcript = speechWindow
        .map((result) => result[0]?.transcript ?? '')
        .join(' ')
        .trim()

      if (transcript) {
        const normalizedTranscript = transcript.toLowerCase()
        
        if (!isManualListeningRef.current && isWakeWordModeRef.current) {
          // Wake word listening mode
          const wakeWords = ['hey puntu', 'hello puntu', 'ok google', 'hey punto', 'hello punto', 'hey ponto', 'hello ponto', 'hey bantu', 'hello bantu', 'hey pantu', 'hello pantu']
          const matchedWakeWord = wakeWords.find(w => normalizedTranscript.includes(w))

          if (matchedWakeWord) {
            const commandAfterWakeWord = normalizedTranscript.split(matchedWakeWord)[1]?.trim()

            if (commandAfterWakeWord) {
              setVoiceStatus(`Wake word detected! Processing: "${commandAfterWakeWord}"`)
              setLastTranscript(transcript)
              setLastVoiceSource('Browser mic')
              voiceTranscriptHandlerRef.current?.(commandAfterWakeWord, 'Browser mic')
              // Keep it running and reset to wait for the next wake word
              isWakeWordModeRef.current = true
              setIsWakeWordMode(true)
            } else {
              isWakeWordModeRef.current = false
              setIsWakeWordMode(false)
              setVoiceStatus('Wake word detected! Listening for your command...')
              setLastTranscript('Wake word detected')
            }
          } else {
            // Not a wake word, just keep listening
          }
        } else {
          // Manual listening or command processing mode
          setLastTranscript(transcript)
          setLastVoiceSource('Browser mic')
          voiceTranscriptHandlerRef.current?.(transcript, 'Browser mic')
          isWakeWordModeRef.current = true
          setIsWakeWordMode(true)
          if (isManualListeningRef.current) {
            isManualListeningRef.current = false
            setIsManualListening(false)
            shouldAutoRestartRef.current = false
            try { recognition.stop() } catch {}
          }
        }
      }
    }

    recognitionRef.current = recognition

    try {
      recognition.start()
    } catch {
      // Ignore if already starting
    }

    return () => {
      recognition.onstart = null
      recognition.onend = null
      recognition.onspeechend = null
      recognition.onnomatch = null
      recognition.onerror = null
      recognition.onresult = null

      try {
        recognition.abort()
      } catch {
        // Ignore browser cleanup errors when recognition is already stopped.
      }

      if (recognitionRef.current === recognition) {
        recognitionRef.current = null
      }
    }
  }, [browserSpeechSupport.available])

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 60000)
    return () => clearInterval(timer)
  }, [])

  const mqttStatusLabel =
    {
      connected: 'MQTT Connected',
      connecting: 'MQTT Connecting',
      reconnecting: 'MQTT Reconnecting',
      offline: 'MQTT Offline',
      error: 'MQTT Error',
    }[mqttStatus] || 'MQTT Connecting'

  const mqttStatusTone =
    mqttStatus === 'connected'
      ? 'text-emerald-300'
      : mqttStatus === 'reconnecting' || mqttStatus === 'connecting'
        ? 'text-amber-300'
        : 'text-rose-300'

  const browserSpeechBadgeLabel = !browserSpeechSupport.available
    ? 'Browser mic unavailable'
    : browserSpeechRuntimeError
      ? 'Command box recommended'
      : 'Browser mic ready'

  const browserSpeechHint =
    browserSpeechRuntimeError ||
    browserSpeechSupport.reason ||
    'Tap Start listening and speak one supported command.'

  const currentTemperature = data.temperature ?? 23.5
  const currentTemperatureLabel = `${currentTemperature.toFixed(1)} C`
  const timerProgress = timerMinutes > 0 ? (timerRemaining / (timerMinutes * 60)) * 360 : 0
  const thresholdGaugeFloor = 16
  const thresholdGaugeCeiling = Math.max(30, currentTemperature, fanThreshold) + 4
  const thresholdGaugeProgress = Math.max(
    0,
    Math.min(270, ((fanThreshold - thresholdGaugeFloor) / (thresholdGaugeCeiling - thresholdGaugeFloor)) * 270),
  )
  const fanModeLabel =
    fanMode === 'auto'
      ? currentTemperature >= fanThreshold
        ? 'Auto active'
        : 'Auto waiting'
      : fanMode === 'timer'
        ? timerActive
          ? 'Timer running'
          : 'Timer ready'
        : data.fan
          ? 'Manual on'
          : 'Manual off'

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_15%_6%,#8d7b4233_0%,transparent_35%),linear-gradient(120deg,#1d1d1f_0%,#101012_48%,#1c1c1e_100%)] p-3 text-white sm:p-6 relative overflow-hidden">
      {/* Animated background particles */}
      <div className="absolute inset-0 opacity-30">
        <div className="absolute top-1/4 left-1/4 w-2 h-2 bg-blue-400 rounded-full animate-pulse"></div>
        <div className="absolute top-1/3 right-1/3 w-1 h-1 bg-purple-400 rounded-full animate-pulse" style={{animationDelay: '1s'}}></div>
        <div className="absolute bottom-1/4 left-1/2 w-1.5 h-1.5 bg-yellow-400 rounded-full animate-pulse" style={{animationDelay: '2s'}}></div>
        <div className="absolute top-1/2 right-1/4 w-1 h-1 bg-green-400 rounded-full animate-pulse" style={{animationDelay: '3s'}}></div>
      </div>

      <div className="mx-auto max-w-7xl overflow-hidden rounded-[30px] border border-white/10 bg-black/50 p-3 shadow-glass backdrop-blur-xl sm:p-5 fade-in-up">
        <div
          className="relative overflow-hidden rounded-[26px] border border-white/10 p-3 sm:p-4 animated-bg"
          style={{
            backgroundImage:
              'linear-gradient(100deg, rgba(4,5,8,0.58), rgba(9,12,16,0.7)), url(/images/hostel_room_bg.png)',
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        >
          {/* Ambient lighting effect */}
          <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 via-transparent to-purple-500/5 pointer-events-none"></div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[78px_1fr_430px] relative z-10">
            <aside className="glass-panel flex h-full flex-row items-center justify-center gap-2 rounded-[22px] p-2 xl:flex-col xl:justify-between xl:py-6 fade-in-left">
              <div className="hidden text-xl font-bold text-white/90 xl:block glow-pulse">S</div>
              <nav className="flex flex-row gap-2 xl:flex-col">
                {navItems.map(({ id, icon, label }, index) => (
                  <button
                    key={id}
                    onClick={() => setActiveNav(id)}
                    className={`inline-flex h-11 w-11 items-center justify-center rounded-2xl border transition-all duration-300 stagger-${index + 1} ${
                      activeNav === id
                        ? 'border-white/30 bg-white/25 text-white shadow-glow glow-pulse'
                        : 'border-white/10 bg-white/5 text-zinc-300 hover:-translate-y-0.5 hover:bg-white/15 hover:text-white hover:shadow-lg'
                    }`}
                    aria-label={label}
                    title={label}
                  >
                    {createElement(icon, { className: 'h-[18px] w-[18px]' })}
                  </button>
                ))}
              </nav>
              <img
                src="/images/user_avatar.png"
                alt="User avatar"
                className="h-11 w-11 rounded-full border border-white/35 object-cover hover:scale-110 transition-transform duration-300"
              />
            </aside>

            <section className="space-y-4 fade-in-up stagger-2">
              <div className="glass-panel flex flex-wrap items-center justify-between gap-2 rounded-2xl p-2.5 premium-card">
                <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-full bg-white/10 px-3 py-2 hover:bg-white/15 transition-colors duration-300">
                  <Search className="h-4 w-4 text-zinc-200" />
                  <input
                    type="text"
                    placeholder="Search devices, rooms..."
                    className="w-full bg-transparent text-sm text-white outline-none placeholder:text-zinc-300 focus:placeholder:text-zinc-400 transition-colors"
                  />
                </label>
                <div className="flex items-center gap-2">
                  {topActions.map(({ id, icon, label }, index) => {
                    const actionLabel = id === 'weather' ? currentTemperatureLabel : label

                    return (
                      <button
                        key={id}
                        onClick={() => setActiveAction(id)}
                        className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs transition-all duration-300 hover:scale-105 stagger-${index + 3} ${
                          activeAction === id
                            ? 'border-yellow-300/50 bg-yellow-300/20 text-yellow-100 shadow-lg shadow-yellow-300/20'
                            : 'border-white/15 bg-white/5 text-zinc-200 hover:bg-white/15 hover:shadow-md'
                        }`}
                      >
                        {createElement(icon, { className: 'h-3.5 w-3.5' })}
                        {actionLabel}
                      </button>
                    )
                  })}
                  <button className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-2.5 py-1.5 text-xs hover:bg-white/20 transition-all duration-300 hover:scale-105">
                    <img
                      src="/images/user_avatar.png"
                      alt="Profile"
                      className="h-6 w-6 rounded-full object-cover"
                    />
                    Olivia Baker
                    <ChevronDown className="h-3.5 w-3.5 transition-transform duration-300 hover:rotate-180" />
                  </button>
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
                <article className="glass-panel rounded-3xl p-6 premium-card fade-in-up stagger-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.32em] text-zinc-400">Now</p>
                      <p className="mt-2 text-6xl font-semibold text-white">{currentTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                      <p className="mt-1 text-sm text-zinc-400">{currentTime.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</p>
                    </div>
                    <div className="inline-flex h-16 w-16 items-center justify-center rounded-3xl bg-gradient-to-br from-blue-500/25 to-cyan-400/20 text-blue-100 shadow-lg shadow-cyan-400/10">
                      <div className="text-center">
                        <p className="text-3xl font-semibold">16°</p>
                        <p className="text-[10px] uppercase tracking-[0.35em] text-zinc-300">C</p>
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 grid gap-3">
                    <div className="rounded-3xl bg-white/5 p-4 border border-white/10">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-zinc-400 uppercase tracking-[0.32em]">Morning</span>
                        <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs text-cyan-200">
                          <span>Cloudy</span>
                        </div>
                      </div>
                      <div className="mt-4 flex items-center gap-3 text-sm text-zinc-300">
                        <div className="rounded-2xl bg-white/10 px-3 py-2">20°C</div>
                        <div className="rounded-2xl bg-white/10 px-3 py-2">19 km/h</div>
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="rounded-3xl bg-white/5 p-4 border border-white/10">
                        <p className="text-xs uppercase tracking-[0.28em] text-zinc-400">Wind</p>
                        <p className="mt-2 text-lg font-semibold text-white">30 km/h</p>
                        <p className="text-xs text-zinc-400">↗ 6 km/h</p>
                      </div>
                      <div className="rounded-3xl bg-white/5 p-4 border border-white/10">
                        <p className="text-xs uppercase tracking-[0.28em] text-zinc-400">Pressure</p>
                        <p className="mt-2 text-lg font-semibold text-white">720 hPa</p>
                        <p className="text-xs text-zinc-400">↓ 20 hPa</p>
                      </div>
                      <div className="rounded-3xl bg-white/5 p-4 border border-white/10">
                        <p className="text-xs uppercase tracking-[0.28em] text-zinc-400">Rain</p>
                        <p className="mt-2 text-lg font-semibold text-white">60%</p>
                        <p className="text-xs text-zinc-400">↑ 12%</p>
                      </div>
                    </div>
                  </div>
                </article>

                <div className="space-y-4">
                  <div className="pl-1 fade-in-up stagger-3">
                    <h1 className="text-5xl font-semibold leading-tight tracking-tight bg-gradient-to-r from-white via-white to-zinc-300 bg-clip-text text-transparent">
                      Hey, Jack!
                    </h1>
                    <p className="mt-2 text-[2rem] font-light text-zinc-200">
                      Ready to control your <span className="text-blue-400 font-medium">smart home</span>?
                    </p>
                  </div>

                  <article className="glass-panel rounded-3xl h-[350px] overflow-hidden premium-card fade-in-up stagger-4">
                    <div className="relative h-full rounded-3xl bg-cover bg-center" style={{ backgroundImage: 'url(/images/hostel_room_bg.png)' }}>
                      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/15 to-transparent"></div>
                      <div className="absolute bottom-5 left-5 right-5 flex items-center justify-between gap-4 rounded-3xl bg-black/30 px-4 py-3 backdrop-blur-md">
                        <div>
                          <p className="text-sm uppercase tracking-[0.32em] text-zinc-300">Living Room</p>
                          <p className="text-lg font-semibold text-white">Smart Home Overview</p>
                        </div>
                        <button className="rounded-2xl bg-white/10 px-4 py-2 text-sm text-white transition hover:bg-white/15">
                          View details
                        </button>
                      </div>
                    </div>
                  </article>
                </div>
              </div>

              <div className="flex items-center justify-between px-1 fade-in-up stagger-5">
                <button
                  onClick={() => setActiveRoom('Room')}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition-all duration-300 hover:scale-105 ${
                    activeRoom === 'Room'
                      ? 'bg-gradient-to-r from-blue-500 to-purple-500 text-white shadow-lg shadow-blue-500/25'
                      : 'bg-white/10 text-zinc-300 hover:bg-white/20 hover:text-white'
                  }`}
                >
                  Living Room
                </button>
                <div className="flex items-center gap-2">
                  <button className="glass-icon-btn hover:rotate-12 transition-transform duration-300" aria-label="Previous scene">
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button className="glass-icon-btn hover:-rotate-12 transition-transform duration-300" aria-label="Next scene">
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </section>

            <section className="space-y-3 fade-in-right stagger-2">
              <article className="glass-panel rounded-3xl p-4 premium-card">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-medium">Activity Feed</h3>
                    <p className="text-xs text-zinc-300">{new Date().toLocaleDateString()}</p>
                  </div>
                  <button className="rounded-full bg-gradient-to-r from-blue-500 to-purple-500 px-3 py-1 text-xs font-semibold text-white transition-all duration-300 hover:scale-105 hover:shadow-lg shadow-blue-500/25">
                    See all
                  </button>
                </div>
                <div className="space-y-2">
                  {activityFeed.map((item, index) => (
                    <button
                      key={item.id}
                      className={`flex w-full items-center gap-3 rounded-2xl bg-white/80 p-2 text-left text-zinc-900 transition-all duration-300 hover:scale-[1.02] hover:shadow-md stagger-${index + 1}`}
                    >
                      <div className="w-11 text-xs font-medium text-zinc-500">{item.time}</div>
                      <div className="rounded-xl bg-zinc-50 p-2 flex-1 hover:bg-zinc-100 transition-colors">
                        <p className="text-sm font-semibold">{item.title}</p>
                        <p className="text-xs text-zinc-500">{item.detail}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </article>

              <article className="glass-panel rounded-3xl p-4 premium-card relative overflow-hidden">
                <div className={`absolute top-0 left-0 w-full h-full transition-opacity duration-1000 pointer-events-none ${data.fan ? 'opacity-100' : 'opacity-0'} bg-gradient-to-b from-blue-500/10 to-transparent`} />
                <div className="mb-4 flex items-center justify-between relative z-10">
                  <div>
                    <h3 className="text-xl font-medium">Smart Fan</h3>
                    <p className="text-xs text-zinc-300">Manual, Auto Temp & Timer</p>
                  </div>
	                  <button
	                    onClick={handleFanPowerToggle}
	                    className={`relative h-7 w-14 rounded-full border transition-all duration-300 hover:scale-110 ${
	                      data.fan ? 'border-blue-400 bg-blue-500/80 shadow-[0_0_15px_rgba(59,130,246,0.6)]' : 'border-white/20 bg-white/10'
	                    }`}
	                  >
                    <span
                      className={`absolute top-0.5 h-5.5 w-5.5 rounded-full bg-white transition-all duration-500 shadow-md ${
                        data.fan ? 'left-8 shadow-blue-300/50' : 'left-1'
                      }`}
                    />
                  </button>
                </div>

                <div className="flex bg-white/5 rounded-xl p-1 mb-4 border border-white/10 relative z-10">
                  <button onClick={() => handleFanModeChange('manual')} className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-all ${fanMode === 'manual' ? 'bg-emerald-500/30 text-emerald-100 shadow-md' : 'text-zinc-400 hover:text-zinc-200'}`}>Manual</button>
                  <button onClick={() => handleFanModeChange('auto')} className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-all ${fanMode === 'auto' ? 'bg-blue-500/30 text-blue-100 shadow-md' : 'text-zinc-400 hover:text-zinc-200'}`}>Auto</button>
                  <button onClick={() => handleFanModeChange('timer')} className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-all ${fanMode === 'timer' ? 'bg-purple-500/30 text-purple-100 shadow-md' : 'text-zinc-400 hover:text-zinc-200'}`}>Timer</button>
                </div>

                <div className="mb-4 flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-[11px] text-zinc-300 relative z-10">
                  <span>{fanModeLabel}</span>
                  <span>DHT11: {currentTemperatureLabel}</span>
                </div>

                {fanMode !== 'timer' ? (
                  <>
                    <div className="relative mx-auto mb-4 grid h-48 w-48 place-items-center rounded-full border-2 border-white/10 premium-card hover:scale-105 transition-transform duration-500">
                      <div
                        className="absolute inset-3 rounded-full border border-blue-400/20 rotate-slow"
                        style={{
                          background: `conic-gradient(from 220deg, rgba(59,130,246,0.8) 0deg ${
                            thresholdGaugeProgress
                          }deg, rgba(255,255,255,0.05) ${
                            thresholdGaugeProgress
                          }deg 270deg, transparent 270deg 360deg)`,
                        }}
                      />
                      <div className="relative z-10 text-center">
                        <p className="text-xs text-blue-200 mb-1">{fanMode === 'auto' ? 'Threshold' : 'Ready Threshold'}</p>
                        <p className="text-4xl font-light text-white">
                          {fanThreshold.toFixed(1)} C
                        </p>
	                        <p className="text-[10px] text-zinc-400 mt-1">Current: {currentTemperatureLabel}</p>
                      </div>
                    </div>
                    <label className="mb-3 block px-2">
                      <span className="mb-2 block text-[10px] uppercase tracking-wider text-zinc-400">Set threshold temperature</span>
                      <input
                        type="number"
                        min="16"
                        step="0.5"
                        value={fanThreshold.toFixed(1)}
                        onChange={(event) => {
                          const nextValue = Number.parseFloat(event.target.value)
                          if (Number.isFinite(nextValue)) {
                            setFanThreshold(clampFanThreshold(nextValue))
                          }
                        }}
                        className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none transition-colors focus:border-cyan-300/40"
                      />
                    </label>
                    <div className="mb-2 flex items-center justify-between px-2">
	                       <button onClick={() => setFanThreshold((prev) => clampFanThreshold(prev - 0.5))} className="glass-icon-btn hover:scale-110">-</button>
                       <p className="text-[10px] uppercase tracking-wider text-zinc-400 text-center px-1">Fan turns OFF below this temperature</p>
	                       <button onClick={() => setFanThreshold((prev) => clampFanThreshold(prev + 0.5))} className="glass-icon-btn hover:scale-110">+</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="relative mx-auto mb-4 grid h-48 w-48 place-items-center rounded-full border-2 border-white/10 premium-card hover:scale-105 transition-transform duration-500">
                      <div
                        className="absolute inset-3 rounded-full border border-purple-400/20"
                        style={{
	                          background: timerActive ? `conic-gradient(from 0deg, rgba(168,85,247,0.8) 0deg ${timerProgress}deg, rgba(255,255,255,0.05) ${timerProgress}deg 360deg)` : 'transparent',
                        }}
                      />
                      <div className="relative z-10 text-center">
                        <p className="text-xs text-purple-200 mb-1">Timer</p>
                        <p className="text-4xl font-light text-white">
                          {timerActive ? 
                            `${Math.floor(timerRemaining / 60)}:${(timerRemaining % 60).toString().padStart(2, '0')}` : 
                            `${timerMinutes} min`
                          }
                        </p>
                      </div>
                    </div>
                    <div className="mb-2 flex items-center justify-between px-2">
	                       <button onClick={() => !timerActive && setTimerMinutes((prev) => clampFanTimerMinutes(prev - 5))} className="glass-icon-btn hover:scale-110" disabled={timerActive}>-</button>
                       <button 
                         onClick={() => {
	                           if (timerActive) {
	                             stopFanTimer()
	                           } else {
	                             startFanTimer(timerMinutes)
	                           }
                         }}
                         className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all shadow-lg active:scale-95 control-button ${timerActive ? 'bg-red-500/80 text-white shadow-red-500/30' : 'bg-purple-500/80 text-white shadow-purple-500/30'}`}
                       >
                         {timerActive ? 'Stop' : 'Start'}
                       </button>
	                       <button onClick={() => !timerActive && setTimerMinutes((prev) => clampFanTimerMinutes(prev + 5))} className="glass-icon-btn hover:scale-110" disabled={timerActive}>+</button>
                    </div>
                  </>
                )}
              </article>

              <div className="grid grid-cols-2 gap-3">
                {quickDevices.map((item, idx) => (
                  <article
                    key={item.id}
                    className={`glass-panel float-card rounded-3xl p-3 premium-card ${idx === 0 ? 'rotate-[-2deg]' : ''} ${idx === 1 ? 'translate-y-1 rotate-[1deg]' : ''} stagger-${idx + 1}`}
                  >
                    <div className="mb-5 flex items-center justify-between">
                      <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-yellow-300/20 to-white/10 text-yellow-100 shadow-inner">
                        {createElement(item.icon, { className: 'h-4 w-4' })}
                      </div>
                      <span className={`text-xs px-2 py-1 rounded-full border transition-all duration-300 ${
                        item.active
                          ? 'text-emerald-300 border-emerald-300/50 bg-emerald-300/10'
                          : 'text-zinc-400 border-zinc-400/50 bg-zinc-400/10'
                      }`}>
                        {item.active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <p className="text-2xl font-medium">{item.title}</p>
                    <p className="mb-3 text-sm text-zinc-300">{item.subtitle}</p>
                    <button
                      onClick={() => toggleQuickDevice(item.id)}
                      className={`relative h-7 w-14 rounded-full border transition-all duration-300 hover:scale-110 ${
                        item.active ? 'border-yellow-300/50 bg-yellow-300/70 shadow-lg shadow-yellow-300/30' : 'border-white/20 bg-white/15'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-5.5 w-5.5 rounded-full bg-white transition-all duration-500 shadow-md ${
                          item.active ? 'left-8 shadow-yellow-300/50' : 'left-1'
                        }`}
                      />
                    </button>
                  </article>
                ))}
              </div>

              <article className="glass-panel rounded-3xl p-4 premium-card">
                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="text-xl font-medium">Live Device Control</h3>
                    <p className="text-xs text-zinc-400">Send commands to your ESP32 devices and monitor real-time status.</p>
                  </div>
	                  <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs text-zinc-200 status-indicator">
	                    <Wifi className={`h-3.5 w-3.5 ${mqttStatusTone}`} /> {mqttStatusLabel}
	                  </span>
	                </div>
	
	                <div className="grid gap-3 sm:grid-cols-3">
	                  {deviceControls.map((control, index) => (
                    <div key={control.id} className={`rounded-3xl border border-white/10 bg-white/5 p-4 shadow-[0_20px_80px_rgba(0,0,0,0.16)] backdrop-blur-xl premium-card stagger-${index + 1} hover:shadow-2xl transition-all duration-500`}>
                      <div className="mb-4 flex items-center justify-between gap-3">
                        <div className={`inline-flex h-11 w-11 items-center justify-center rounded-3xl ${control.active ? `bg-gradient-to-br shadow-inner glow-pulse ${control.iconActiveTheme}` : control.iconInactiveTheme}`}>
                          {createElement(control.icon, { className: 'h-5 w-5' })}
                        </div>
                        <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.3em] transition-all duration-300 ${
                          control.active ? control.badgeActiveTheme : control.badgeInactiveTheme
                        }`}>
                          {control.activeLabel}
                        </span>
                      </div>
                      <div className="space-y-2">
                        <p className="text-lg font-semibold text-white">{control.title}</p>
                        <p className="text-sm text-zinc-400">{control.description}</p>
                      </div>
	                      <button
	                        onClick={() => {
	                          if (control.id === 'fan') {
	                            setManualFanPower(control.active ? 'OFF' : 'ON')
	                            return
	                          }

	                          publishDeviceCommand(
	                            control.id,
	                            control.id === 'door'
	                              ? control.active
	                                ? 'CLOSE'
	                                : 'OPEN'
	                              : control.active
	                                ? 'OFF'
	                                : 'ON',
	                          )
	                        }}
	                        className={`mt-4 inline-flex w-full items-center justify-center rounded-2xl px-4 py-3 text-sm font-semibold control-button transition-all duration-300 ${
	                          control.active ? control.btnActiveTheme : control.btnInactiveTheme
	                        }`}
                      >
                        {control.actionLabel}
                      </button>
                    </div>
                  ))}
                </div>
	              </article>

		              <article className="glass-panel rounded-3xl p-4 premium-card">
		                <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
		                  <div>
		                    <h3 className="text-xl font-medium">Voice Control</h3>
		                    <p className="text-xs text-zinc-400">
		                      Use the browser microphone when supported, or run commands through the command box / INMP441 transcript topic <span className="font-mono text-zinc-200">{MQTT_TOPICS.voiceTranscript}</span>.
		                    </p>
		                  </div>
		                  <div className="flex flex-wrap items-center gap-2">
		                    <span className="inline-flex items-center rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs text-zinc-200">
		                      {browserSpeechBadgeLabel}
		                    </span>
		                    <button
		                      onClick={toggleVoiceCapture}
		                      disabled={!browserSpeechSupport.available && !isListening}
		                      className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-all duration-300 control-button ${
		                        isListening
		                          ? 'bg-gradient-to-r from-rose-500 to-orange-500 text-white shadow-lg shadow-rose-500/20'
		                          : browserSpeechReady
		                            ? 'bg-gradient-to-r from-cyan-300 to-blue-400 text-zinc-950 shadow-lg shadow-cyan-400/20'
		                            : 'cursor-not-allowed bg-white/10 text-zinc-400 shadow-none'
		                      }`}
		                    >
		                      {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
		                      {isListening
		                        ? 'Stop listening'
		                        : browserSpeechSupport.available
		                          ? browserSpeechRuntimeError
		                            ? 'Retry listening'
		                            : 'Start listening'
		                          : 'Mic unavailable'}
		                    </button>
		                  </div>
		                </div>
		                <p className="mb-4 text-xs text-zinc-400">{browserSpeechHint}</p>

		                <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_280px]">
		                  <div className="rounded-3xl border border-white/10 bg-white/5 p-4">
		                    <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.28em] text-zinc-400">
		                      <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 ${isListening ? 'border-rose-300/40 bg-rose-300/10 text-rose-100' : 'border-white/10 bg-white/5 text-zinc-300'}`}>
		                        <span className={`h-2 w-2 rounded-full ${isListening ? 'animate-pulse bg-rose-300' : 'bg-zinc-500'}`}></span>
		                        {isListening ? 'Listening' : 'Idle'}
	                      </span>
	                      <span>Source: {lastVoiceSource}</span>
	                    </div>
	                    <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 p-4">
	                      <p className="text-xs uppercase tracking-[0.28em] text-zinc-400">Transcript</p>
	                      <p className="mt-3 min-h-[56px] text-lg text-white">
	                        {lastTranscript || 'Waiting for a browser or INMP441 transcript...'}
	                      </p>
	                    </div>
		                    <div className="mt-3 rounded-3xl border border-white/10 bg-white/5 p-4">
		                      <p className="text-xs uppercase tracking-[0.28em] text-zinc-400">Result</p>
		                      <p className="mt-2 text-sm text-zinc-200">{voiceStatus}</p>
		                      {voiceError ? <p className="mt-2 text-sm text-rose-200">{voiceError}</p> : null}
		                    </div>
		                    <div className="mt-3 rounded-3xl border border-white/10 bg-white/5 p-4">
		                      <p className="text-xs uppercase tracking-[0.28em] text-zinc-400">Command box</p>
		                      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
		                        <input
		                          type="text"
		                          value={manualCommand}
		                          onChange={(event) => setManualCommand(event.target.value)}
		                          onKeyDown={(event) => {
		                            if (event.key === 'Enter') {
		                              submitManualCommand()
		                            }
		                          }}
		                          placeholder="Type a command like 'turn on the light'"
		                          className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-cyan-300/40"
		                        />
		                        <button
		                          onClick={submitManualCommand}
		                          className="inline-flex items-center justify-center rounded-2xl bg-gradient-to-r from-emerald-300 to-cyan-300 px-4 py-3 text-sm font-semibold text-zinc-950 shadow-lg shadow-emerald-400/20 transition-all duration-300 hover:scale-[1.02]"
		                        >
		                          Run command
		                        </button>
		                      </div>
		                    </div>
		                  </div>

		                  <div className="rounded-3xl border border-white/10 bg-white/5 p-4">
		                    <p className="text-xs uppercase tracking-[0.28em] text-zinc-400">Try saying</p>
		                    <div className="mt-3 space-y-2">
		                      {VOICE_COMMAND_EXAMPLES.map((sample) => (
		                        <button
		                          key={sample}
		                          onClick={() => setManualCommand(sample)}
		                          className="w-full rounded-2xl border border-white/10 bg-black/15 px-3 py-2 text-left text-sm text-zinc-200 transition-all duration-300 hover:border-cyan-300/30 hover:bg-white/10"
		                        >
		                          {sample}
		                        </button>
		                      ))}
		                    </div>
		                  </div>
		                </div>

	                {voiceEvents.length ? (
	                  <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
	                    {voiceEvents.map((event) => (
	                      <div key={event.id} className="rounded-3xl border border-white/10 bg-white/5 p-3">
	                        <div className="flex items-center justify-between gap-3">
	                          <span className={`rounded-full px-2 py-1 text-[10px] uppercase tracking-[0.28em] ${event.success ? 'bg-emerald-300/10 text-emerald-200' : 'bg-rose-300/10 text-rose-200'}`}>
	                            {event.success ? 'Applied' : 'Ignored'}
	                          </span>
	                          <span className="text-[10px] uppercase tracking-[0.28em] text-zinc-500">{event.time}</span>
	                        </div>
	                        <p className="mt-3 text-sm font-medium text-white">{event.transcript}</p>
	                        <p className="mt-2 text-xs text-zinc-400">{event.result}</p>
	                        <p className="mt-2 text-[11px] text-zinc-500">{event.source}</p>
	                      </div>
	                    ))}
	                  </div>
	                ) : null}
	              </article>

	              <article className="glass-panel rounded-3xl p-4 premium-card">
	                <div className="mb-3 flex items-center justify-between">
	                  <div className="flex items-center gap-2">
	                    <img
                      src="https://picsum.photos/seed/music200/200/200"
                      alt="Song cover"
                      className="h-10 w-10 rounded-xl object-cover hover:scale-110 transition-transform duration-300 shadow-lg"
                    />
                    <div>
                      <p className="text-sm font-semibold">The Mood Keep Score</p>
                      <p className="text-xs text-zinc-300">Mamadou</p>
                    </div>
                  </div>
                  <Music2 className="h-4 w-4 text-zinc-200" />
                </div>
                <div className="mb-3 h-1.5 rounded-full bg-white/20 overflow-hidden">
                  <div className="soft-pulse h-full rounded-full bg-gradient-to-r from-yellow-300 to-orange-300 shadow-lg"></div>
                </div>
                <div className="flex items-center justify-center gap-3">
                  <button className="glass-icon-btn hover:scale-110 transition-transform duration-300">
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setIsPlaying((prev) => !prev)}
                    className={`inline-flex h-11 w-11 items-center justify-center rounded-full transition-all duration-300 hover:scale-110 ${
                      isPlaying
                        ? 'bg-gradient-to-r from-red-500 to-pink-500 text-white shadow-lg shadow-red-500/25'
                        : 'bg-gradient-to-r from-green-400 to-emerald-300 text-zinc-900 shadow-lg shadow-green-400/25'
                    }`}
                  >
                    {isPlaying ? <CirclePause className="h-5 w-5" /> : <CirclePlay className="h-5 w-5" />}
                  </button>
                  <button className="glass-icon-btn hover:scale-110 transition-transform duration-300">
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </article>
            </section>
          </div>

          <section className="mt-4 grid gap-3 lg:grid-cols-[1fr_240px] fade-in-up stagger-3">
            <article className="glass-panel rounded-3xl p-4 premium-card">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h3 className="text-2xl font-medium">Electricity Consumption</h3>
                  <p className="text-sm text-zinc-300">
                    <span className="text-3xl text-white font-bold">{(9 + activeQuickCount * 0.55).toFixed(1)}</span> kWh of clean energy
                  </p>
                </div>
                <button
                  onClick={() => setChartRange((prev) => (prev === 'Last week' ? 'Last month' : 'Last week'))}
                  className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20 transition-all duration-300 hover:scale-105 hover:shadow-md"
                >
                  {chartRange}
                  <ChevronDown className="ml-1 inline h-3.5 w-3.5 transition-transform duration-300 hover:rotate-180" />
                </button>
              </div>
              <div className="relative h-28 rounded-2xl bg-gradient-to-r from-yellow-300/20 via-yellow-300/50 to-white/5 px-2 pt-8 overflow-hidden">
                <svg className="h-full w-full" viewBox="0 0 900 220" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="chartGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="rgba(250,204,21,0.8)" />
                      <stop offset="50%" stopColor="rgba(250,204,21,1)" />
                      <stop offset="100%" stopColor="rgba(255,255,255,0.6)" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M0,140 C60,100 120,180 180,150 C240,120 300,165 360,135 C420,105 480,170 540,128 C600,86 660,150 720,110 C780,80 840,118 900,90"
                    stroke="url(#chartGradient)"
                    strokeWidth="6"
                    fill="none"
                    strokeLinecap="round"
                    className="drop-shadow-lg"
                  />
                </svg>
                <div className="absolute inset-0 bg-gradient-to-t from-transparent via-transparent to-white/5 pointer-events-none"></div>
              </div>
            </article>
            <article className="glass-panel rounded-3xl p-4 premium-card">
              <p className="text-sm text-zinc-300">System Status</p>
              <p className="mt-1 text-xl font-medium">
                <span className="text-2xl font-bold text-blue-400">{activeQuickCount}</span> modules active
              </p>
              <div className="mt-3 grid gap-2">
                <button className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-left text-sm transition-all duration-300 hover:bg-white/20 hover:scale-[1.02] hover:shadow-md">
                  <Shield className="inline h-4 w-4 mr-2 text-green-400" />
                  Security check
                </button>
                <button className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-left text-sm transition-all duration-300 hover:bg-white/20 hover:scale-[1.02] hover:shadow-md">
                  <Zap className="inline h-4 w-4 mr-2 text-yellow-400" />
                  Energy saving mode
                </button>
                <button className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-left text-sm transition-all duration-300 hover:bg-white/20 hover:scale-[1.02] hover:shadow-md">
                  <RefreshCcw className="inline h-4 w-4 mr-2 text-blue-400" />
                  System diagnostics
                </button>
              </div>
            </article>
          </section>
        </div>
      </div>
    </main>
  )
}

export default App
