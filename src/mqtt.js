import mqtt from 'mqtt'

// Configure these in .env.local. Keeping the broker out of source control is
// intentional: a public broker makes every room command visible to strangers.
export const MQTT_CONFIG = {
  url: import.meta.env.VITE_MQTT_URL?.trim(),
  username: import.meta.env.VITE_MQTT_USERNAME?.trim(),
  password: import.meta.env.VITE_MQTT_PASSWORD?.trim(),
  roomPrefix: (import.meta.env.VITE_MQTT_ROOM_PREFIX || 'smart-home').replace(/\/$/, ''),
}

export const topicFor = (room, name) => `${MQTT_CONFIG.roomPrefix}/${room}/${name}`

export const createMqttClient = () => {
  if (!MQTT_CONFIG.url) return null
  return mqtt.connect(MQTT_CONFIG.url, {
    clientId: `dashboard-${crypto.randomUUID()}`,
    username: MQTT_CONFIG.username || undefined,
    password: MQTT_CONFIG.password || undefined,
    reconnectPeriod: 3000,
    connectTimeout: 10_000,
    clean: true,
  })
}
