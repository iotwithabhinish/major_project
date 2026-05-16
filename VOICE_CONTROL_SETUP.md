# Voice Control Setup

This project now supports two voice input paths:

1. Browser microphone
2. MQTT transcripts coming from an INMP441 microphone pipeline

The browser path is the fastest way to test voice commands. The INMP441 path is the right option when you want the voice trigger to come from your ESP32 hardware.

## INMP441 to ESP32 wiring

Use `3.3V` only. Do not power the INMP441 from `5V`.

One working ESP32 pin example is:

- `VDD` -> `3.3V`
- `GND` -> `GND`
- `SCK` or `BCLK` -> `GPIO26`
- `WS` or `LRCL` -> `GPIO25`
- `SD` -> `GPIO33`
- `L/R` -> `GND` for left channel, or `3.3V` for right channel

Notes:

- The ESP32 I2S pin mapping is configurable, so you can choose different GPIOs if your firmware matches them.
- Use only one channel from the INMP441 for speech commands.

## Recommended voice pipeline

The React app in this repo is a dashboard. It can parse transcripts and control devices, but it does not directly decode raw I2S audio from the ESP32.

Recommended flow:

1. ESP32 reads PCM audio from the INMP441 over I2S.
2. Your firmware sends audio to a speech recognizer.
3. The recognizer publishes the final transcript to MQTT.
4. The dashboard receives the transcript on `room1/voice/transcript`.
5. The dashboard converts that transcript into device commands on `room1/commands`.

## MQTT payloads

The dashboard accepts either JSON or plain text on `room1/voice/transcript`.

JSON example:

```json
{
  "transcript": "turn on the light",
  "source": "INMP441"
}
```

Plain text example:

```text
open the door
```

Generated command examples:

```json
{ "device": "light", "state": "ON" }
{ "device": "fan", "state": "OFF" }
{ "device": "door", "state": "OPEN" }
```

Telemetry example:

```json
{
  "light": 1,
  "fan": 0,
  "door": 1,
  "temperature": 24.6
}
```

## Supported phrases

The dashboard parser currently supports phrases like:

- `turn on the light`
- `turn off the fan`
- `open the door`
- `close the door`
- `start fan timer for 15 minutes`
- `stop fan timer`
- `set fan threshold to 26 degrees`
- `go to analytics`
- `play music`
- `pause music`
- `turn everything off`

## Browser testing

To test without the ESP32 first:

1. Start the app.
2. Open it in Chrome or Edge.
3. Use the `Start listening` button in the new `Voice Control` panel.
4. Say one of the supported phrases.
5. Confirm the transcript and resulting MQTT/device action in the dashboard.

## Next step for the ESP32 side

If you want, the next good addition is an ESP32 firmware folder that:

- captures INMP441 audio over I2S
- packages audio frames
- forwards them to your recognizer or gateway
- publishes recognized text to `room1/voice/transcript`

That firmware is not in this repo yet, so the dashboard side is now ready for it.
