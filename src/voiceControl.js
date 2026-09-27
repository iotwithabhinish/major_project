export const VOICE_COMMAND_EXAMPLES = [
  'Turn on the light', 'Turn off the fan', 'Open the door',
  'Start fan timer for 15 minutes', 'Set fan threshold to 26 degrees', 'Activate good night scene',
]

// Includes common speech-recognition variants (matches the ESP32 firmware parser).
const aliases = {
  door: ['door', 'doors', 'gate', 'lock', 'unlock'],
  light: ['light', 'lights', 'lite', 'lamp', 'lamps', 'bulb', 'delight'],
  fan: ['fan', 'fans', 'fun'],
}
const hasWord = (text, words) => words.some((word) => ` ${text} `.includes(` ${word} `))
const includesAny = (text, terms) => terms.some((term) => text.includes(term))

export const clampFanThreshold = (value) => Math.min(40, Math.max(16, Number(value) || 24))
export const clampFanTimerMinutes = (value) => Math.min(120, Math.max(1, Number(value) || 15))

export const parseVoiceTranscriptPayload = (payload) => {
  const raw = payload?.toString().trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    const transcript = typeof parsed === 'string' ? parsed : parsed.transcript || parsed.text || parsed.command
    return typeof transcript === 'string' && transcript.trim() ? { transcript: transcript.trim(), source: parsed.source || 'MQTT device' } : null
  } catch { return { transcript: raw, source: 'MQTT device' } }
}

export const parseVoiceCommand = (input) => {
  // Keep "." only inside numbers (26.5 degrees); a sentence full stop would
  // otherwise turn "light." into a different word.
  const text = input.toLowerCase().replace(/[^a-z0-9.\s]/g, ' ').replace(/\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return null
  if (includesAny(text, ['good night', 'all off', 'everything off'])) return { type: 'scene', id: 'good-night' }
  if (includesAny(text, ['movie scene', 'movie mode'])) return { type: 'scene', id: 'movie' }
  if (includesAny(text, ['stop timer', 'cancel timer'])) return { type: 'timer-stop' }
  const timer = text.match(/(?:fan\s+timer|timer)(?:\s+(?:for|to))?\s+(\d{1,3})/)
  if (timer) return { type: 'timer', minutes: clampFanTimerMinutes(timer[1]) }
  const threshold = text.match(/(?:threshold|fan temperature)(?:\s+to)?\s+(\d+(?:\.\d+)?)/)
  if (threshold) return { type: 'threshold', value: clampFanThreshold(threshold[1]) }
  const saysOff = hasWord(text, ['off', 'stop', 'disable']) || includesAny(` ${text} `, [' turn of ', ' switch of '])
  const saysOn = hasWord(text, ['on', 'start', 'enable']) && !saysOff
  for (const [device, terms] of Object.entries(aliases)) {
    if (!hasWord(text, terms)) continue
    if (device === 'door' && hasWord(text, ['open', 'unlock'])) return { type: 'device', device, state: 'OPEN' }
    if (device === 'door' && hasWord(text, ['close', 'lock', 'shut'])) return { type: 'device', device, state: 'CLOSE' }
    if (device === 'door') continue
    if (saysOn) return { type: 'device', device, state: 'ON' }
    if (saysOff) return { type: 'device', device, state: 'OFF' }
  }
  return null
}
