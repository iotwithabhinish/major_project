export const MQTT_TOPICS = {
  commands: 'room1/commands',
  telemetry: 'room1/telemetry',
  voiceTranscript: 'room1/voice/transcript',
}

export const VOICE_COMMAND_EXAMPLES = [
  'Turn on the light',
  'Turn off the fan',
  'Open the door',
  'Start fan timer for 15 minutes',
  'Set fan threshold to 26 degrees',
  'Go to analytics',
]

const DEVICE_ALIASES = {
  light: ['light', 'lights', 'lamp', 'lamps'],
  fan: ['fan', 'ceiling fan'],
  door: ['door', 'lock', 'main door'],
}

const NAV_TARGETS = [
  { id: 'home', label: 'Home', phrases: ['home', 'dashboard'] },
  { id: 'chart', label: 'Analytics', phrases: ['analytics', 'chart', 'stats'] },
  { id: 'cctv', label: 'CCTV', phrases: ['cctv', 'camera', 'cameras'] },
  { id: 'scenes', label: 'Scenes', phrases: ['scene', 'scenes'] },
  { id: 'profile', label: 'Profile', phrases: ['profile', 'account'] },
  { id: 'settings', label: 'Settings', phrases: ['settings', 'preferences'] },
]

const ON_PHRASES = ['turn on', 'switch on', 'start', 'enable', 'activate']
const OFF_PHRASES = ['turn off', 'switch off', 'stop', 'disable', 'deactivate']
const NAV_PHRASES = ['open', 'show', 'go to', 'switch to']

const containsAny = (text, phrases) => phrases.some((phrase) => text.includes(phrase))

const mentionsDevice = (text, device) =>
  DEVICE_ALIASES[device].some((alias) => text.includes(alias))

export const clampFanThreshold = (value) => Math.max(16, value)

export const clampFanTimerMinutes = (value) => Math.min(120, Math.max(5, value))

export const parseVoiceTranscriptPayload = (rawPayload) => {
  if (typeof rawPayload !== 'string' || !rawPayload.trim()) {
    return null
  }

  try {
    const parsed = JSON.parse(rawPayload)

    if (typeof parsed === 'string' && parsed.trim()) {
      return { transcript: parsed.trim(), source: 'INMP441 / MQTT' }
    }

    const transcript = parsed?.transcript ?? parsed?.text ?? parsed?.command
    if (typeof transcript === 'string' && transcript.trim()) {
      return {
        transcript: transcript.trim(),
        source: parsed?.source || 'INMP441 / MQTT',
      }
    }
  } catch {
    return { transcript: rawPayload.trim(), source: 'INMP441 / MQTT' }
  }

  return null
}

export const parseVoiceCommand = (transcript) => {
  const normalized = transcript
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return null
  }

  if (
    containsAny(normalized, [
      'turn everything off',
      'switch everything off',
      'all off',
      'shutdown room',
    ])
  ) {
    return { type: 'scene', scene: 'all-off', label: 'Turn everything off' }
  }

  const fanTimerStartMatch =
    normalized.match(
      /(?:start|set|run)\s+(?:the\s+)?fan\s+timer(?:\s+for)?\s+(\d{1,3})(?:\s*(?:minute|minutes|min))?/,
    ) || normalized.match(/fan\s+timer\s+(\d{1,3})/)

  if (fanTimerStartMatch) {
    return {
      type: 'fan-timer-start',
      minutes: clampFanTimerMinutes(Number.parseInt(fanTimerStartMatch[1], 10)),
      label: `Start fan timer for ${fanTimerStartMatch[1]} minutes`,
    }
  }

  if (
    normalized.match(/(?:stop|cancel|clear)\s+(?:the\s+)?fan\s+timer/) ||
    normalized.includes('stop timer')
  ) {
    return { type: 'fan-timer-stop', label: 'Stop fan timer' }
  }

  const fanThresholdMatch =
    normalized.match(
      /(?:set|change|update)\s+(?:the\s+)?fan\s+(?:threshold|temperature)(?:\s+to)?\s+(\d+(?:\.\d+)?)/,
    ) || normalized.match(/fan\s+(?:threshold|temperature)\s+(\d+(?:\.\d+)?)/)

  if (fanThresholdMatch) {
    const value = clampFanThreshold(Number.parseFloat(fanThresholdMatch[1]))

    return {
      type: 'fan-threshold',
      value,
      label: `Set fan threshold to ${value.toFixed(1)} C`,
    }
  }

  const navTarget = NAV_TARGETS.find(
    ({ phrases }) => containsAny(normalized, phrases) && containsAny(normalized, NAV_PHRASES),
  )
  if (navTarget) {
    return {
      type: 'navigation',
      target: navTarget.id,
      label: `Open ${navTarget.label}`,
    }
  }

  if (
    containsAny(normalized, ['play music', 'resume music', 'start music', 'play song', 'resume song'])
  ) {
    return { type: 'music', state: 'play', label: 'Play music' }
  }

  if (containsAny(normalized, ['pause music', 'stop music', 'pause song', 'stop song'])) {
    return { type: 'music', state: 'pause', label: 'Pause music' }
  }

  if (mentionsDevice(normalized, 'door')) {
    if (containsAny(normalized, ['open', 'unlock'])) {
      return { type: 'device', device: 'door', state: 'OPEN', label: 'Open door' }
    }

    if (containsAny(normalized, ['close', 'shut', 'lock'])) {
      return { type: 'device', device: 'door', state: 'CLOSE', label: 'Close door' }
    }
  }

  for (const device of ['light', 'fan']) {
    if (!mentionsDevice(normalized, device)) {
      continue
    }

    if (containsAny(normalized, ON_PHRASES) || normalized.includes(`${device} on`)) {
      return {
        type: 'device',
        device,
        state: 'ON',
        label: `Turn on ${device}`,
      }
    }

    if (containsAny(normalized, OFF_PHRASES) || normalized.includes(`${device} off`)) {
      return {
        type: 'device',
        device,
        state: 'OFF',
        label: `Turn off ${device}`,
      }
    }
  }

  return null
}
