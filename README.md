# Smart Room Dashboard

React + Vite smart room dashboard with MQTT device control, live telemetry, fan automation, and voice commands.

## Features

- MQTT-powered control for `light`, `fan`, and `door`
- Real-time telemetry updates from `room1/telemetry`
- Fan auto-threshold and timer automation
- Voice control from:
  - the browser microphone using Web Speech API
  - MQTT transcripts published from an INMP441 + ESP32 pipeline

## Run the app

```bash
npm install
npm run dev
```

## MQTT topics

- `room1/telemetry`
  - Example: `{"light":1,"fan":0,"door":1,"temperature":24.6}`
- `room1/commands`
  - Example: `{"device":"light","state":"ON"}`
- `room1/voice/transcript`
  - Example: `{"transcript":"turn on the light","source":"INMP441"}`
  - Plain text is also accepted, for example: `turn off the fan`

## Voice control

The dashboard can now:

- listen from the local browser microphone
- show the latest transcript and command result
- parse phrases like `turn on the light`, `open the door`, `start fan timer for 15 minutes`, and `go to analytics`
- apply the same MQTT control path as the buttons in the UI

For the INMP441 wiring and the recommended ESP32/MQTT speech pipeline, see [VOICE_CONTROL_SETUP.md](./VOICE_CONTROL_SETUP.md).
