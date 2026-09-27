# SmartNest ESP32 Wiring Guide

Pin numbers match `esp32_voice_control/esp32_voice_control.ino`. Board: any
ESP32 DevKit (ESP32-WROOM-32, 30- or 38-pin). On many boards GPIO36 is
printed **VP** and GPIO39 is printed **VN**.

## Parts

| Part | Qty | Purpose |
| --- | --- | --- |
| ESP32 DevKit | 1 | Controller, Wi-Fi, MQTT |
| INMP441 I2S microphone | 1 | Always-on voice commands |
| DHT11 (or DHT22) module | 1 | Temperature / humidity (fan auto mode) |
| 2-channel relay module (5 V coil, opto-isolated, 3.3 V-logic compatible) | 1 | Light, fan |
| Servo motor (SG90 / MG90S, or MG995 / MG996R for a heavier door) | 1 | Opens and closes the door |
| Buzzer (5 V active buzzer module recommended) + NPN transistor (BC547 / 2N2222) + 1 kΩ resistor for a bare buzzer | 1 | Gas / smoke alarm |
| 470–1000 µF electrolytic capacitor | 1 | Across the servo supply, prevents ESP32 resets |
| 0-25 V voltage sensor module | 1 | Solar panel voltage |
| ACS712 current sensor (05B / 20A / 30A) | 1 | Solar panel current |
| MQ-2 gas sensor module | 1 | Gas / smoke alert |
| 10 kΩ resistors | 2 | Top half of the two 5 V → 3.3 V dividers |
| 20 kΩ resistors (or 2 × 10 kΩ in series) | 2 | Bottom half of the dividers |
| Regulated 5 V supply (≥ 2 A) or USB | 1 | Powers the ESP32 and 5 V modules |

## Master pin map

| ESP32 pin | Connects to | Direction / notes |
| --- | --- | --- |
| **3V3** | INMP441 VDD, DHT11 VCC | 3.3 V only. Never power the MQ-2, ACS712, relays or servo from here. |
| **VIN / 5V** | Relay VCC, ACS712 VCC, MQ-2 VCC, buzzer + | 5 V. Only present when the board is powered from USB or a 5 V supply. Power the servo from a separate 5 V supply (see section 3). |
| **GND** | Every module GND, servo GND, solar panel −, external 5 V supply − | All grounds must be common. |
| **GPIO32** | INMP441 SCK | I2S bit clock |
| **GPIO33** | INMP441 WS | I2S word select |
| **GPIO35** | INMP441 SD | I2S data (input-only pin) |
| **GPIO4** | DHT11 DATA | 10 kΩ pull-up to 3V3 if the sensor is a bare 4-pin part (modules include it) |
| **GPIO26** | Relay IN1 → **Light** | Active LOW |
| **GPIO27** | Relay IN2 → **Fan** | Active LOW |
| **GPIO18** | Servo **signal** (orange / yellow wire) → **Door** | 50 Hz PWM, 3.3 V signal works with SG90 / MG996R |
| **GPIO19** | Buzzer **I/O** (module) or transistor base via 1 kΩ | HIGH = buzzer on |
| **GPIO34** | Voltage sensor **S** | Input-only ADC1 |
| **GPIO36 (VP)** | ACS712 OUT via 10 k/20 k divider | Input-only ADC1, never direct |
| **GPIO39 (VN)** | MQ-2 AO via 10 k/20 k divider | Input-only ADC1, never direct |

All analog inputs use ADC1 pins because ADC2 stops working while Wi-Fi is on.
Avoid GPIO0, 2, 12 and 15 (boot pins) and GPIO6-11 (flash).

## 1. INMP441 microphone

```text
INMP441 VDD -> ESP32 3V3
INMP441 GND -> ESP32 GND
INMP441 SCK -> ESP32 GPIO32
INMP441 WS  -> ESP32 GPIO33
INMP441 SD  -> ESP32 GPIO35
INMP441 L/R -> ESP32 GND      (selects the left channel; do not leave floating)
```

Keep these wires short (under about 15 cm). Never use 5 V.

## 2. DHT11 temperature / humidity

```text
DHT VCC (+)  -> ESP32 3V3
DHT GND (-)  -> ESP32 GND
DHT DATA (S) -> ESP32 GPIO4
```

For a DHT22, change `DHT_TYPE` to `DHT22` in the firmware.

## 3. Relay module (light, fan)

```text
Relay VCC -> ESP32 VIN (5 V)
Relay GND -> ESP32 GND
Relay IN1 -> ESP32 GPIO26   (light)
Relay IN2 -> ESP32 GPIO27   (fan)
```

Load side of each relay (COM / NO / NC screw terminals):

```text
Supply live (+) -> relay COM
relay NO        -> load live (+)    (load is OFF until the relay energises)
load neutral (-)-> supply neutral (-)
```

- The firmware assumes **active-LOW** relays (`RELAY_ACTIVE_LOW = true`). If
  your relays are on when they should be off, set it to `false`.
- If a 5 V relay does not click reliably from 3.3 V GPIO, remove the `JD-VCC`
  jumper and feed `JD-VCC` with 5 V and `VCC` with 3.3 V, or use a relay board
  that is rated for 3.3 V logic.
- **Mains (230 V) light or fan:** switch only the live wire, use an enclosed
  relay rated for mains with a fuse, and have a qualified person check it. Do
  not use a breadboard for mains. For a demo, use a 5 V/12 V DC LED and fan.

## 3a. Door servo motor

Servo wire colours: brown/black = GND, red = +5 V, orange/yellow = signal.

```text
Servo signal (orange) -> ESP32 GPIO18
Servo + (red)         -> external 5 V supply +   (1-2 A for SG90, 2-3 A for MG996R)
Servo - (brown)       -> external 5 V supply -  AND  ESP32 GND  (common ground!)
470-1000 uF capacitor -> across the servo 5 V and GND (stripe/negative to GND)
```

- A small SG90 can run from the ESP32 VIN pin when the board is on a good USB
  supply, but a servo starting to move draws a current spike that often resets
  the ESP32. A separate 5 V supply is strongly recommended; MG995/MG996R must
  use one.
- Set `DOOR_CLOSED_ANGLE` and `DOOR_OPEN_ANGLE` in the firmware to match your
  door (defaults 0° and 90°). Fit the servo horn with the door closed after the
  first boot, because the firmware moves the servo to the closed angle on start-up.

## 3b. Buzzer (gas alarm)

**3-pin buzzer module (VCC, GND, I/O):**

```text
Buzzer VCC -> ESP32 VIN (5 V)  (or 3V3 for a 3.3 V module)
Buzzer GND -> ESP32 GND
Buzzer I/O -> ESP32 GPIO19
```

If the buzzer sounds when it should be silent, the module is "low-level
trigger": set `BUZZER_ACTIVE_LOW = true`.

**Bare 2-pin 5 V active buzzer (through a transistor):**

```text
ESP32 GPIO19 -> 1 kΩ -> BC547 / 2N2222 base
Transistor emitter    -> GND
Transistor collector  -> buzzer (-)
Buzzer (+)            -> 5 V
```

An active buzzer beeps on its own when powered. If you have a **passive**
buzzer (it only clicks when powered from DC), set `BUZZER_IS_PASSIVE = true`
and the firmware drives it with a 2.5 kHz tone.

## 4. Solar panel voltage sensor (0-25 V module)

```text
Solar panel +          -> voltage sensor VCC screw terminal
Solar panel -          -> voltage sensor GND screw terminal
Voltage sensor pin S   -> ESP32 GPIO34
Voltage sensor pin -   -> ESP32 GND
Voltage sensor pin +   -> NOT CONNECTED
```

The module divides by 5, so a 3.7 V panel gives about 0.74 V at GPIO34.

## 5. ACS712 current sensor

Logic side:

```text
ACS712 VCC -> ESP32 VIN (5 V)
ACS712 GND -> ESP32 GND
ACS712 OUT -> 10 kΩ -> GPIO36 (VP)
GPIO36 (VP)-> 20 kΩ -> GND
```

Current path (in series with the panel, like an ammeter):

```text
Solar panel +   -> ACS712 IP+ screw terminal
ACS712 IP-      -> load / charge-controller +
Load / charge-controller - -> solar panel -   (and to ESP32 GND)
```

If the current reads 0 A in sunlight with a load connected, swap the two
screw-terminal wires. With no current flowing, measure the ACS712 OUT pin and
enter that value in `ACS712_ZERO_CURRENT_VOLTS`. Set
`ACS712_SENSITIVITY_VOLTS_PER_AMP` to 0.185 for 05B, 0.100 for 20A, or 0.066
for 30A.

## 6. MQ-2 gas sensor (automatic alarm)

```text
MQ-2 VCC -> ESP32 VIN (5 V)
MQ-2 GND -> ESP32 GND
MQ-2 AO  -> 10 kΩ -> GPIO39 (VN)
GPIO39 (VN) -> 20 kΩ -> GND
MQ-2 DO  -> NOT CONNECTED
```

How the alarm works: the ESP32 checks the MQ-2 about 7 times a second in its
own task. When the reading stays above `MQ2_ALERT_VOLTS` for about 0.4 s, the
buzzer starts beeping and the servo opens the door, even without Wi-Fi.
While the alarm is on, the door cannot be closed from the dashboard or by voice.
When the level has stayed normal for about 3 s, the buzzer stops. The door stays
open until someone closes it. Alarms are ignored for the first 60 s after
power-on while the heater warms up.

Calibration: let the sensor warm up for 20 minutes, read the `MQ-2: x.xx V`
line printed on the Serial Monitor every 5 s in clean air, and set
`MQ2_ALERT_VOLTS` 0.4–0.6 V above it. Test with smoke from a blown-out
match or incense stick, never with an open gas supply.

## 7. Power

```text
USB 5 V (or regulated 5 V, 2 A) -> ESP32 VIN / USB
5 V supply -                    -> ESP32 GND (common ground)
```

- Do **not** power the ESP32 from the 3.7 V solar panel directly.
- The relays, MQ-2 heater (~150 mA) and Wi-Fi draw together can brown out a
  weak USB port. If the ESP32 resets when a relay clicks, use a separate 5 V
  2 A supply for the relay module and MQ-2 and join its GND to ESP32 GND.

## Voltage-divider diagram (used twice)

```text
 5 V signal (ACS712 OUT or MQ-2 AO)
        |
      [10 kΩ]
        |
        +--------> ESP32 GPIO36 (ACS712) / GPIO39 (MQ-2)
        |
      [20 kΩ]
        |
       GND
```

5 V × 20 / (10 + 20) = 3.33 V maximum at the pin. The firmware multiplies by
1.5 to get the original voltage back.

## Bring-up checklist

1. Power the ESP32 from USB with nothing connected. You should hear one short
   beep from the buzzer at start-up once it is connected. Upload the firmware and
   open the Serial Monitor at 115200 baud.
2. Add the modules one at a time: DHT, then relays, servo and buzzer, then
   INMP441, then the solar sensors, then the MQ-2.
3. Check that the dashboard shows telemetry (the connection card reads
   `connected` and the temperature is updating).
4. Click each device card and listen for the matching relay; the door card
   should swing the servo.
5. The Serial Monitor must show `INMP441 ready`. Say "turn on the light" near the INMP441. The dashboard's physical
   microphone status should show `recognized - turn on the light`. If it keeps
   saying `no speech detected`, lower `VOICE_ACTIVITY_THRESHOLD`; if it
   triggers on background noise, raise it.
