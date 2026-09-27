# Voice Control Setup

There are two ways to give voice commands:

1. **Website microphone:** the browser's speech recognition. Use Chrome or Edge on `localhost` or HTTPS.
2. **INMP441 on the ESP32:** always listening. Detected speech goes to Wit.ai, and the transcript is published to MQTT.

## INMP441 wiring

See [WIRING.md](WIRING.md) for the complete board wiring.

```text
VDD -> 3.3V     GND -> GND
SCK -> GPIO32   WS  -> GPIO33
SD  -> GPIO35   L/R -> GND
```

Do not use GPIO18/19/26/27 for the microphone. The servo, buzzer and relays use those pins.

## Flow

1. The ESP32 records 2-second windows at 16 kHz and skips windows that contain only silence.
2. It sends speech to Wit.ai (`WIT_AI_SERVER_TOKEN` in `secrets.h`).
3. Simple light/fan/door phrases are applied on the ESP32 itself, so they work even when the dashboard is closed.
4. The transcript is published to `<prefix>/<room>/voice/transcript`. The dashboard also handles timers, thresholds, and scenes.

## MQTT payloads

`<prefix>/<room>/voice/transcript` accepts JSON or plain text:

```json
{ "transcript": "turn on the light", "source": "ESP32 INMP441" }
```

`<prefix>/<room>/commands` (dashboard → ESP32):

```json
{ "id": "uuid", "device": "light", "state": "ON" }
```

`state` is `ON`/`OFF` for light and fan, and `OPEN`/`CLOSE` for the door.

## Supported phrases

- turn on / turn off the light (or lamp)
- turn on / turn off the fan
- open / unlock the door, close / lock the door
- start fan timer for 15 minutes, stop timer
- set fan threshold to 26 degrees
- good night (all off), movie mode
