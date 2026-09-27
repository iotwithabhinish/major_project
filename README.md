# SmartNest Dashboard

A React/Vite smart-room dashboard with working local simulation, MQTT hardware integration, room-aware controls, telemetry, scenes, activity history, fan automation, and physical INMP441 microphone voice commands.

## Run locally

```bash
npm install
npm run dev
```

It starts in **simulation mode**, so every dashboard feature is usable without hardware. Device state, activity history, scenes, and schedules are saved in the browser.

## Connect real hardware

The complete ESP32 wiring guide (every module, pin, divider, and power note) is in [WIRING.md](WIRING.md).

1. Copy `.env.example` to `.env.local` and configure an authenticated WSS MQTT broker.
2. Keep `VITE_MQTT_ROOM_PREFIX` the same in the web app and ESP32 firmware.
3. Copy `esp32_voice_control/secrets.example.h` to `secrets.h`, configure it, then update relay/DHT pins in the firmware for your board.
4. Wire the INMP441: `VDD -> 3.3V`, `GND -> GND`, `SCK -> GPIO32`, `WS -> GPIO33`, `SD -> GPIO35`, and `L/R -> GND`.
5. Wire the solar voltage and current modules exactly as described in the next section.
6. Add a Wit.ai server token in `secrets.h`, then upload `esp32_voice_control.ino` after installing the Arduino **PubSubClient** and **DHT sensor library** dependencies.

## 3.7 V solar panel safety and monitoring

Your project uses the two modules shown in your photos:

- **0-25 V Voltage Sensor** - measures panel voltage through its built-in 5:1 resistor divider.
- **ACS712 Current Sensor** - measures current from the panel to the load or charge controller.

### Exact voltage-sensor wiring

The voltage sensor has two screw terminals marked `VCC` and `GND`, plus a three-pin header marked `S`, `+`, and `-`.

```text
Solar panel positive (+)  -> voltage-sensor screw terminal VCC
Solar panel negative (-)  -> voltage-sensor screw terminal GND
Voltage-sensor header S   -> ESP32 GPIO34
Voltage-sensor header -   -> ESP32 GND
Voltage-sensor header +   -> leave unconnected
```

Do **not** connect the voltage-sensor header `+` pin to ESP32 3.3 V. It is electrically the panel-voltage side of the divider, not a power input for the ESP32.

### Exact ACS712 wiring

The ACS712 header is labelled `VCC`, `OUT`, and `GND`.

```text
ACS712 VCC -> ESP32 5V/VIN (only when the ESP32 is USB-powered or has regulated 5 V)
ACS712 GND -> ESP32 GND
```

The ACS712 output may exceed the ESP32's 3.3 V ADC limit. Insert this divider before GPIO36:

```text
ACS712 OUT -> 10 kOhm resistor -> ESP32 GPIO36
ESP32 GPIO36 -> 20 kOhm resistor -> ESP32 GND
```

Current path through the ACS712 screw terminals:

```text
Solar panel positive (+) -> ACS712 IP+ terminal
ACS712 IP- terminal      -> positive side of your low-voltage load / charge controller
Solar panel negative (-) -> negative side of that load / charge controller
```

If your ACS712 board has no `IP+` / `IP-` marking, the direction only changes the sign. If the firmware reports zero current in sunlight with a load connected, swap the two screw-terminal wires.

### Power and calibration requirements

Do **not** power the ESP32 directly from the 3.7 V solar panel. Power it from USB or a regulated battery/charge-controller output. All sensor and panel negative connections must share the ESP32 GND.

The ACS712 is a high-current sensor, so current from a small panel can be noisy. Before testing, cover the panel or disconnect its load, power the ACS712 from 5 V, and measure its `OUT` voltage with a multimeter. Enter that value in `ACS712_ZERO_CURRENT_VOLTS` in the firmware. Also check the ACS712 chip label: `05B` uses `0.185 V/A`, `20A` uses `0.100 V/A`, and `30A` uses `0.066 V/A`.

The firmware publishes real panel voltage, current, and calculated watts as `voltage × current`. Current is only meaningful when the panel feeds a load or charge controller; an open-circuit panel has voltage but almost no current.

## MQ-2 gas sensor

```text
MQ-2 VCC -> ESP32 5V/VIN
MQ-2 GND -> ESP32 GND
MQ-2 AO  -> 10 kOhm resistor -> ESP32 GPIO39
ESP32 GPIO39 -> 20 kOhm resistor -> ESP32 GND
MQ-2 DO  -> leave unconnected (the project uses calibrated analog readings)
```

The MQ-2 analog output can reach 5 V, so the 10 kOhm / 20 kOhm divider is mandatory before GPIO39. Allow the MQ-2 to warm up for at least 20 minutes in clean air, note its displayed voltage, and adjust `MQ2_ALERT_VOLTS` in the firmware above that normal value. MQ-2 is suitable for a student-project alert only; it is not a certified gas-safety detector.

## Complete ESP32 connection map

| ESP32 pin | Connect to | Notes |
| --- | --- | --- |
| 3.3V | DHT VCC, INMP441 VDD | Never power MQ-2, ACS712, a relay module or the servo from this pin. |
| 5V/VIN | ACS712 VCC, MQ-2 VCC, relay-module VCC | Use a regulated 5 V supply with enough current. |
| GND | Every module GND and panel/load negative reference | All low-voltage grounds must be common. |
| GPIO4 | DHT DATA | Add a 10 kOhm pull-up to 3.3 V if the DHT board has no built-in pull-up. |
| GPIO18 | Door servo signal | 50 Hz PWM; power the servo from a separate 5 V supply with common GND. |
| GPIO19 | Buzzer | Sounds automatically with the MQ-2 gas alarm. |
| GPIO26 | Relay IN1: light | Logic output. |
| GPIO27 | Relay IN2: fan | Logic output. |
| GPIO32 | INMP441 SCK/BCLK | I2S clock. |
| GPIO33 | INMP441 WS/LRCL | I2S word-select. |
| GPIO35 | INMP441 SD | Input only; correct for microphone data. |
| GPIO34 | Voltage sensor `S` | Input only; measures solar panel voltage. |
| GPIO36 | ACS712 `OUT` through 10 kOhm/20 kOhm divider | Input only; never connect ACS712 OUT directly. |
| GPIO39 | MQ-2 `AO` through 10 kOhm/20 kOhm divider | Input only; never connect MQ-2 AO directly. |

### Relay and load warning

Use a relay module guaranteed to accept **3.3 V logic**. Some 5 V relay boards do not reliably trigger from ESP32 GPIO. If yours does not, add a transistor/level-shifter driver or use a 3.3 V-compatible opto-isolated relay board. For mains-powered lights/fans, use correctly rated enclosed relays, a fuse, insulated wiring, and qualified supervision. Do not build mains wiring on a breadboard. The door is driven by a servo on GPIO18; when the MQ-2 detects gas/smoke, the ESP32 sounds the buzzer on GPIO19 and opens the door automatically (see WIRING.md).

The INMP441 stays in **always-on listening mode**. The ESP32 records short audio windows, ignores silence using voice-activity detection, sends detected speech to Wit.ai, then publishes the recognized transcript to MQTT. The dashboard receives and applies it automatically. The website microphone also stays active in supported browsers, so either microphone can control the system.

The dashboard uses these topics per room:

- `<prefix>/<room>/commands` — JSON command with `id`, `device`, and `state`
- `<prefix>/<room>/telemetry` — device states, temperature, humidity
- `<prefix>/<room>/ack` — command acknowledgement
- `<prefix>/<room>/voice/transcript` — `{ "transcript": "turn on the light" }`
- `<prefix>/<room>/voice/status` — current INMP441 microphone / recognition status

## Solar power prediction

The **Solar prediction** page forecasts panel output and compares it with what the ESP32 measures:

1. **Irradiance on the panel plane** every 15 minutes from Open-Meteo (`global_tilted_irradiance` for the panel's tilt and azimuth). Clouds are already included in this value.
2. **Cell temperature** with the Faiman model, `Tc = Ta + G / (25 + 6.84 × wind)`, and a power loss of 0.4 %/°C above 25 °C.
3. **System factor k** learned from the panel's own measurements (robust median of measured ÷ modelled power in daylight), which absorbs shading, dust, wiring and load mismatch.
4. **Short-term correction**: the latest measured ÷ predicted ratio steers the next hours and fades back to the forecast (time constant 90 minutes).

The chart shows predicted vs measured power for yesterday, today and tomorrow with an 80 % prediction range, plus MAE, nRMSE and R². Days are scored with a calibration learned only from earlier days when enough data exists. Measured samples are stored in the browser for 3 days; readings that are physically impossible for the panel (e.g. a floating ADC pin) are rejected and flagged.

Configure the panel in `.env.local`:

```text
VITE_SOLAR_LAT=12.9716
VITE_SOLAR_LON=77.5946
VITE_SOLAR_RATED_WATTS=1
VITE_SOLAR_TILT=13          # degrees from horizontal
VITE_SOLAR_AZIMUTH=0        # 0 = south, -90 = east, 90 = west, 180 = north
VITE_SOLAR_TEMP_COEFF=-0.4  # %/°C
VITE_SOLAR_MAX_VOLTS=8      # highest open-circuit voltage of the panel
```

For a real deployment, use TLS, broker authentication and ACLs, unique device credentials, and server-side authorization for door-unlock commands. Browser-local schedules only run while the dashboard is open; move them to a backend scheduler for reliable unattended automation.
