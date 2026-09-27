/*
  SmartNest ESP32 controller
  ---------------------------------------------------------------------------
  - Light and fan through relays, door through a servo motor.
  - MQ-2 gas/smoke safety: on detection the buzzer sounds and the door opens
    automatically. This runs in its own FreeRTOS task, so it reacts within a
    fraction of a second even while the microphone is recording, while
    Wit.ai is recognising speech, or when Wi-Fi / MQTT is down.
  - Always-on INMP441 microphone: each spoken command is captured as one
    utterance (starts when you speak, ends at the pause), sent to Wit.ai,
    applied on the ESP32 and published to MQTT.
  - Telemetry (devices, DHT11, solar voltage/current/power, gas) to MQTT.
  - Receives dashboard JSON commands: {"id":"...","device":"light","state":"ON"}

  Board: ESP32 Dev Module (ESP32-WROOM-32). Requires Arduino-ESP32 core 3.x
  (ESP-IDF 5): Tools > Board > esp32 > ESP32 Dev Module.
  Libraries: PubSubClient (Nick O'Leary), DHT sensor library (Adafruit) or
  a compatible "DHT.h" + Adafruit Unified Sensor.

  Copy secrets.example.h to secrets.h and fill it in before uploading.
  Full wiring: see WIRING.md in the project root.
*/
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <DHT.h>
// New ESP-IDF 5 I2S driver. The legacy <driver/i2s.h> must NOT be used: it links
// the legacy ADC driver, which aborts at boot next to analogRead() on core 3.x.
#include <driver/i2s_std.h>
#include <esp_arduino_version.h>
#include "secrets.h"

#if !defined(ESP_ARDUINO_VERSION_MAJOR) || ESP_ARDUINO_VERSION_MAJOR < 3
#error "This sketch needs the Arduino-ESP32 core 3.x (Boards Manager > esp32 by Espressif)."
#endif

// ============================ Configuration ================================

// Keep this prefix identical to VITE_MQTT_ROOM_PREFIX in .env.local.
#ifdef MQTT_ROOM_PREFIX
const char* ROOM_PREFIX = MQTT_ROOM_PREFIX;
#else
const char* ROOM_PREFIX = "smart-home";
#endif
const char* ROOM_ID = "living-room";
const uint16_t MQTT_BUFFER_SIZE = 768;

// ---- Relays (light, fan). Most relay modules are active LOW. ----
constexpr uint8_t LIGHT_RELAY_PIN = 26;
constexpr uint8_t FAN_RELAY_PIN = 27;
constexpr bool RELAY_ACTIVE_LOW = true;

// ---- Door servo (SG90 / MG90S / MG995 / MG996R) ----
constexpr uint8_t DOOR_SERVO_PIN = 18;
constexpr uint8_t DOOR_CLOSED_ANGLE = 0;    // Adjust to your door mechanism.
constexpr uint8_t DOOR_OPEN_ANGLE = 90;
constexpr uint16_t SERVO_MIN_PULSE_US = 500;  // Pulse width at 0 degrees.
constexpr uint16_t SERVO_MAX_PULSE_US = 2400; // Pulse width at 180 degrees.
constexpr uint8_t SERVO_LEDC_CHANNEL = 0;     // LEDC channel 0 -> timer 0 (50 Hz).

// ---- Buzzer ----
constexpr uint8_t BUZZER_PIN = 19;
// true  = passive buzzer (needs a tone signal, usually 2 pins, no "+" sticker seal)
// false = active buzzer  (beeps by itself when powered)
constexpr bool BUZZER_IS_PASSIVE = false;
constexpr bool BUZZER_ACTIVE_LOW = false;     // Some 3-pin modules are "low level trigger".
constexpr uint16_t BUZZER_TONE_HZ = 2500;     // Passive buzzer only.
constexpr uint8_t BUZZER_LEDC_CHANNEL = 2;    // LEDC channel 2 -> timer 1, separate from the servo.

// ---- DHT11 ----
constexpr uint8_t DHT_PIN = 4;
constexpr uint8_t DHT_TYPE = DHT11;           // DHT22 if you use a DHT22.

// ---- Solar sensors ----
// 0-25 V voltage-sensor S output -> GPIO34 (5:1 divider on the module).
// ACS712 OUT -> GPIO36 through a 10k/20k divider.
constexpr uint8_t SOLAR_VOLTAGE_ADC_PIN = 34;
constexpr uint8_t SOLAR_CURRENT_ADC_PIN = 36;
constexpr float VOLTAGE_SENSOR_DIVIDER_RATIO = 5.0f;
constexpr float ACS712_OUTPUT_DIVIDER_RATIO = 1.5f;
constexpr float ACS712_ZERO_CURRENT_VOLTS = 2.50f;   // Measure with no current.
// 05B = 0.185 V/A, 20A = 0.100 V/A, 30A = 0.066 V/A (printed on the IC).
constexpr float ACS712_SENSITIVITY_VOLTS_PER_AMP = 0.185f;
constexpr float ACS712_RANGE_AMPS = 5.0f;             // 05B = 5, 20A = 20, 30A = 30.
// Highest voltage your panel can produce (open-circuit). A "3.7 V" panel is
// usually 4.5-6 V open-circuit. Readings above this mean a wiring fault.
constexpr float PANEL_MAX_VOLTS = 8.0f;

// ---- MQ-2 gas / smoke ----
// MQ-2 AO -> GPIO39 through a 10k/20k divider (the AO can reach 5 V).
constexpr uint8_t MQ2_ADC_PIN = 39;
constexpr float MQ2_OUTPUT_DIVIDER_RATIO = 1.5f;
// Alarm threshold on the reconstructed MQ-2 output voltage. Check the value
// printed on Serial in clean air after warm-up and set this ~0.4-0.6 V above it.
constexpr float MQ2_ALERT_VOLTS = 1.35f;
constexpr float MQ2_CLEAR_HYSTERESIS_VOLTS = 0.10f;
// The heater makes readings high for a while after power-on; ignore that period
// so the door does not open at every boot.
constexpr uint32_t MQ2_WARMUP_MS = 60000;
constexpr uint8_t MQ2_TRIGGER_SAMPLES = 3;    // Consecutive high readings to alarm (~0.4 s).
constexpr uint8_t MQ2_CLEAR_SAMPLES = 20;     // Consecutive low readings to clear (~3 s).

// ---- INMP441 microphone ----
// VDD -> 3.3V, GND -> GND, SCK -> GPIO32, WS -> GPIO33, SD -> GPIO35, L/R -> GND.
constexpr uint8_t I2S_BCLK_PIN = 32;
constexpr uint8_t I2S_WS_PIN = 33;
constexpr uint8_t I2S_DATA_PIN = 35;
constexpr uint32_t SAMPLE_RATE = 16000;
// Speech is captured as one utterance: recording starts when the voice starts
// (plus a short pre-roll) and stops at the pause after it, so a command is never
// split across two fixed-length windows.
constexpr size_t FRAME_SAMPLES = 256;                 // 16 ms per frame.
constexpr uint8_t PREROLL_FRAMES = 20;                // 320 ms kept before speech starts.
constexpr uint8_t START_FRAMES = 3;                   // 48 ms of loud audio starts a capture.
constexpr uint8_t END_SILENCE_FRAMES = 45;            // 720 ms pause ends the command.
constexpr uint8_t MIN_SPEECH_FRAMES = 15;             // Ignore sounds shorter than 240 ms (clicks, relays).
// Loudness needed to count as speech: this many times the room's noise level,
// and never below the minimum. Raise the factors if background noise triggers it.
constexpr float SPEECH_START_FACTOR = 3.0f;
constexpr float SPEECH_CONTINUE_FACTOR = 2.0f;
constexpr uint16_t MIN_SPEECH_LEVEL = 60;
constexpr bool PRINT_MIC_LEVEL = false;                // true = print the mic level every 0.5 s.

constexpr uint32_t TELEMETRY_INTERVAL_MS = 30000;

// ================================ State ====================================

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);
DHT dht(DHT_PIN, DHT_TYPE);
char commandsTopic[96], telemetryTopic[96], ackTopic[96], voiceTopic[96], voiceStatusTopic[96];
unsigned long lastTelemetryAt = 0;
unsigned long lastWifiAttemptAt = 0;
unsigned long lastMqttAttemptAt = 0;
int16_t* audioBuffer = nullptr;       // One utterance of 16-bit PCM for Wit.ai.
size_t audioCapacity = 0;             // Samples that fit in audioBuffer.
int16_t prerollBuffer[PREROLL_FRAMES][FRAME_SAMPLES];
i2s_chan_handle_t micChannel = nullptr;
bool microphoneReady = false;
String lastVoiceStatus;

SemaphoreHandle_t adcMutex = nullptr;
SemaphoreHandle_t doorMutex = nullptr;
volatile bool doorOpen = false;
volatile bool gasAlert = false;
volatile bool gasStateChanged = false;
volatile float gasVoltage = 0.0f;

struct SolarReading {
  float voltage;
  float currentMilliAmps;
  float powerWatts;
  bool plausible;          // false = impossible reading (floating pin / wiring fault)
};

// ============================== Actuators ==================================

void setRelay(uint8_t pin, bool on) {
  digitalWrite(pin, RELAY_ACTIVE_LOW ? !on : on);
}

bool relayState(uint8_t pin) {
  return RELAY_ACTIVE_LOW ? digitalRead(pin) == LOW : digitalRead(pin) == HIGH;
}

void setupServo() {
  if (!ledcAttachChannel(DOOR_SERVO_PIN, 50, 14, SERVO_LEDC_CHANNEL)) Serial.println("Servo PWM setup failed");
}

void writeServoAngle(uint8_t angle) {
  angle = constrain(angle, 0, 180);
  const uint32_t pulseUs = SERVO_MIN_PULSE_US + (uint32_t)(SERVO_MAX_PULSE_US - SERVO_MIN_PULSE_US) * angle / 180;
  const uint32_t duty = pulseUs * 16383UL / 20000UL;   // 14-bit duty at 50 Hz (20 ms period).
  ledcWrite(DOOR_SERVO_PIN, duty);
}

// Thread-safe: called from the main loop and from the gas safety task.
void setDoor(bool open) {
  if (doorMutex) xSemaphoreTake(doorMutex, portMAX_DELAY);
  writeServoAngle(open ? DOOR_OPEN_ANGLE : DOOR_CLOSED_ANGLE);
  doorOpen = open;
  if (doorMutex) xSemaphoreGive(doorMutex);
}

void setupBuzzer() {
  if (BUZZER_IS_PASSIVE) {
    ledcAttachChannel(BUZZER_PIN, BUZZER_TONE_HZ, 10, BUZZER_LEDC_CHANNEL);
    ledcWriteTone(BUZZER_PIN, 0);
  } else {
    digitalWrite(BUZZER_PIN, BUZZER_ACTIVE_LOW ? HIGH : LOW);
    pinMode(BUZZER_PIN, OUTPUT);
  }
}

void setBuzzer(bool on) {
  if (BUZZER_IS_PASSIVE) {
    ledcWriteTone(BUZZER_PIN, on ? BUZZER_TONE_HZ : 0);
  } else {
    digitalWrite(BUZZER_PIN, (on != BUZZER_ACTIVE_LOW) ? HIGH : LOW);
  }
}

// =============================== Sensors ===================================

SolarReading readSolarPanel() {
  // Average ADC samples to reduce ESP32 ADC / ACS712 noise.
  uint32_t voltageMilliVolts = 0;
  uint32_t currentMilliVolts = 0;
  constexpr uint8_t sampleCount = 40;
  xSemaphoreTake(adcMutex, portMAX_DELAY);
  for (uint8_t index = 0; index < sampleCount; index++) {
    voltageMilliVolts += analogReadMilliVolts(SOLAR_VOLTAGE_ADC_PIN);
    currentMilliVolts += analogReadMilliVolts(SOLAR_CURRENT_ADC_PIN);
    delay(2);
  }
  xSemaphoreGive(adcMutex);
  const float voltageSensorOutput = voltageMilliVolts / (1000.0f * sampleCount);
  const float acs712AdcOutput = currentMilliVolts / (1000.0f * sampleCount);
  const float voltage = max(0.0f, voltageSensorOutput * VOLTAGE_SENSOR_DIVIDER_RATIO);
  const float acs712Output = acs712AdcOutput * ACS712_OUTPUT_DIVIDER_RATIO;
  const float currentMilliAmps = max(0.0f,
    (acs712Output - ACS712_ZERO_CURRENT_VOLTS) / ACS712_SENSITIVITY_VOLTS_PER_AMP * 1000.0f);
  // An unconnected ADC pin floats to a random, often high, value. Readings beyond
  // what the panel or the ACS712 can physically produce are flagged, not trusted.
  const bool voltageOk = voltage <= PANEL_MAX_VOLTS;
  const bool currentOk = currentMilliAmps <= ACS712_RANGE_AMPS * 1000.0f * 1.05f && acs712AdcOutput < 3.0f;
  static unsigned long lastWarningAt = 0;
  if ((!voltageOk || !currentOk) && millis() - lastWarningAt > 60000) {
    lastWarningAt = millis();
    Serial.printf("SOLAR SENSOR CHECK: GPIO34=%.2f V (-> %.2f V panel)%s, GPIO36=%.2f V (-> %.0f mA)%s\n",
      voltageSensorOutput, voltage, voltageOk ? "" : " IMPOSSIBLE: check voltage sensor S -> GPIO34 and - -> GND",
      acs712AdcOutput, currentMilliAmps, currentOk ? "" : " IMPOSSIBLE: check ACS712 OUT -> 10k -> GPIO36 -> 20k -> GND, VCC=5V");
  }
  return { voltage, currentMilliAmps, voltage * currentMilliAmps / 1000.0f, voltageOk && currentOk };
}

float readMq2Voltage() {
  uint32_t milliVolts = 0;
  constexpr uint8_t sampleCount = 20;
  xSemaphoreTake(adcMutex, portMAX_DELAY);
  for (uint8_t index = 0; index < sampleCount; index++) {
    milliVolts += analogReadMilliVolts(MQ2_ADC_PIN);
    delay(2);
  }
  xSemaphoreGive(adcMutex);
  return milliVolts / (1000.0f * sampleCount) * MQ2_OUTPUT_DIVIDER_RATIO;
}

// ========================= Gas safety (own task) ===========================

void gasSafetyTask(void*) {
  uint8_t highCount = 0, lowCount = 0;
  bool buzzerOn = false;
  unsigned long lastToggleAt = 0, lastPrintAt = 0;
  for (;;) {
    const float volts = readMq2Voltage();
    gasVoltage = volts;
    const bool warmedUp = millis() >= MQ2_WARMUP_MS;

    if (!gasAlert) {
      highCount = (warmedUp && volts >= MQ2_ALERT_VOLTS) ? highCount + 1 : 0;
      if (highCount >= MQ2_TRIGGER_SAMPLES) {
        gasAlert = true; gasStateChanged = true; highCount = 0; lowCount = 0;
        setDoor(true);   // Open the door for evacuation / ventilation.
        Serial.printf("!!! GAS / SMOKE DETECTED (%.2f V) - buzzer ON, door OPENED\n", volts);
      }
    } else {
      lowCount = volts < MQ2_ALERT_VOLTS - MQ2_CLEAR_HYSTERESIS_VOLTS ? lowCount + 1 : 0;
      if (lowCount >= MQ2_CLEAR_SAMPLES) {
        gasAlert = false; gasStateChanged = true; lowCount = 0;
        Serial.printf("Gas level normal again (%.2f V) - buzzer OFF, door stays open\n", volts);
      } else if (!doorOpen) {
        setDoor(true);   // Keep the door open for the whole alarm.
      }
    }

    // Alarm pattern: 250 ms on / 250 ms off.
    if (gasAlert) {
      if (millis() - lastToggleAt >= 250) { lastToggleAt = millis(); buzzerOn = !buzzerOn; setBuzzer(buzzerOn); }
    } else if (buzzerOn) {
      buzzerOn = false; setBuzzer(false);
    }

    if (millis() - lastPrintAt >= 5000) {
      lastPrintAt = millis();
      Serial.printf("MQ-2: %.2f V (alarm at %.2f V)%s\n", volts, MQ2_ALERT_VOLTS,
        warmedUp ? "" : " - warming up, alarm disabled");
    }
    vTaskDelay(pdMS_TO_TICKS(80));
  }
}

// ================================= MQTT ====================================

void publishTelemetry() {
  if (!mqttClient.connected()) return;
  const float temperature = dht.readTemperature();
  const float humidity = dht.readHumidity();
  const SolarReading solar = readSolarPanel();
  // A failed DHT read is sent as null so the dashboard keeps its last good value.
  char temperatureText[12] = "null", humidityText[12] = "null";
  if (!isnan(temperature)) snprintf(temperatureText, sizeof(temperatureText), "%.1f", temperature);
  if (!isnan(humidity)) snprintf(humidityText, sizeof(humidityText), "%.1f", humidity);
  char payload[448];
  snprintf(payload, sizeof(payload),
    "{\"light\":%s,\"fan\":%s,\"door\":%s,\"temperature\":%s,\"humidity\":%s,\"panelVoltage\":%.3f,\"panelCurrent\":%.2f,\"solarPower\":%.3f,\"solarSensorReady\":%s,\"gasVoltage\":%.3f,\"gasAlert\":%s}",
    relayState(LIGHT_RELAY_PIN) ? "true" : "false",
    relayState(FAN_RELAY_PIN) ? "true" : "false",
    doorOpen ? "true" : "false",
    temperatureText, humidityText,
    solar.voltage, solar.currentMilliAmps, solar.powerWatts, solar.plausible ? "true" : "false",
    (float)gasVoltage, gasAlert ? "true" : "false");
  mqttClient.publish(telemetryTopic, payload, true);
}

void publishAck(const char* id, bool success, const char* message) {
  if (!mqttClient.connected()) return;
  char payload[256];
  snprintf(payload, sizeof(payload), "{\"id\":\"%s\",\"success\":%s,\"message\":\"%s\"}",
    id, success ? "true" : "false", message);
  mqttClient.publish(ackTopic, payload);
}

// Publishes only when the status changes, to avoid flooding the broker.
void publishVoiceStatus(const char* status) {
  if (lastVoiceStatus == status) return;
  lastVoiceStatus = status;
  Serial.println(status);
  if (mqttClient.connected()) mqttClient.publish(voiceStatusTopic, status, true);
}

// Door requests go through here so a gas alarm always wins.
bool requestDoor(bool open) {
  if (!open && gasAlert) {
    Serial.println("Door close refused: gas alarm active");
    return false;
  }
  setDoor(open);
  return true;
}

// Supports the fixed dashboard command set without a JSON library.
void handleCommand(char* payload) {
  const bool isLight = strstr(payload, "\"device\":\"light\"");
  const bool isFan = strstr(payload, "\"device\":\"fan\"");
  const bool isDoor = strstr(payload, "\"device\":\"door\"");
  const bool turnOn = strstr(payload, "\"state\":\"ON\"") || strstr(payload, "\"state\":\"OPEN\"");
  const char* idStart = strstr(payload, "\"id\":\"");
  char id[48] = "unknown";
  if (idStart) sscanf(idStart, "\"id\":\"%47[^\"]", id);

  if (isLight) setRelay(LIGHT_RELAY_PIN, turnOn);
  else if (isFan) setRelay(FAN_RELAY_PIN, turnOn);
  else if (isDoor) {
    if (!requestDoor(turnOn)) {
      publishTelemetry();   // Corrects the dashboard back to "open".
      publishAck(id, false, "Gas alarm active: door kept open");
      return;
    }
  } else { publishAck(id, false, "Unsupported device"); return; }

  Serial.printf("Command: %s\n", payload);
  publishTelemetry();
  publishAck(id, true, "Command applied");
}

void onMqttMessage(char* topic, byte* bytes, unsigned int length) {
  if (length >= MQTT_BUFFER_SIZE) return;
  char payload[MQTT_BUFFER_SIZE];
  memcpy(payload, bytes, length); payload[length] = '\0';
  if (strcmp(topic, commandsTopic) == 0) handleCommand(payload);
}

// ============================== Microphone =================================

bool setupMicrophone(i2s_std_slot_mask_t slot) {
  if (micChannel) { i2s_channel_disable(micChannel); i2s_del_channel(micChannel); micChannel = nullptr; }
  i2s_chan_config_t channelConfig = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  channelConfig.dma_desc_num = 16;    // 16 x 256 frames = 256 ms of headroom for MQTT work.
  channelConfig.dma_frame_num = 256;
  if (i2s_new_channel(&channelConfig, nullptr, &micChannel) != ESP_OK) { micChannel = nullptr; return false; }
  // The INMP441 sends 24-bit samples in 32-bit slots (64 clocks per frame).
  i2s_std_config_t config = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = (gpio_num_t)I2S_BCLK_PIN,
      .ws = (gpio_num_t)I2S_WS_PIN,
      .dout = I2S_GPIO_UNUSED,
      .din = (gpio_num_t)I2S_DATA_PIN,
      .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
    },
  };
  config.slot_cfg.slot_mask = slot;
  if (i2s_channel_init_std_mode(micChannel, &config) != ESP_OK || i2s_channel_enable(micChannel) != ESP_OK) {
    i2s_del_channel(micChannel); micChannel = nullptr;
    return false;
  }
  return true;
}

// ---- Frame capture ----
int32_t dcPrevInput = 0;
float dcPrevOutput = 0.0f;

// Reads one 16 ms frame, converts 24-bit INMP441 data to 16-bit and removes the
// DC offset with a high-pass filter. Returns false on a read error.
bool readFrame(int16_t* frame) {
  int32_t raw[FRAME_SAMPLES];
  size_t bytesRead = 0;
  if (i2s_channel_read(micChannel, raw, sizeof(raw), &bytesRead, 200) != ESP_OK || bytesRead != sizeof(raw)) return false;
  for (size_t index = 0; index < FRAME_SAMPLES; index++) {
    const int32_t input = raw[index] >> 15;   // 24-bit sample -> 16-bit with 2x gain.
    const float output = (float)(input - dcPrevInput) + 0.995f * dcPrevOutput;
    dcPrevInput = input;
    dcPrevOutput = output;
    frame[index] = (int16_t)constrain((int32_t)output, -32768, 32767);
  }
  return true;
}

uint32_t frameLevel(const int16_t* frame) {
  uint32_t total = 0;
  for (size_t index = 0; index < FRAME_SAMPLES; index++) total += abs(frame[index]);
  return total / FRAME_SAMPLES;
}

// On the original ESP32 the mono left/right slot can be swapped. A slot with no
// microphone on it reads all zeros, so pick the one that carries a signal.
bool slotHasSignal() {
  int16_t frame[FRAME_SAMPLES];
  for (uint8_t attempt = 0; attempt < 10; attempt++) readFrame(frame);   // Let the filter settle.
  uint32_t nonZero = 0;
  for (uint8_t attempt = 0; attempt < 8; attempt++) {
    if (!readFrame(frame)) return false;
    for (size_t index = 0; index < FRAME_SAMPLES; index++) nonZero += frame[index] != 0;
  }
  return nonZero > FRAME_SAMPLES;
}

void startMicrophone() {
  if (setupMicrophone(I2S_STD_SLOT_LEFT) && slotHasSignal()) {
    microphoneReady = true;
    Serial.println("INMP441 ready (left slot)");
    return;
  }
  if (setupMicrophone(I2S_STD_SLOT_RIGHT) && slotHasSignal()) {
    microphoneReady = true;
    Serial.println("INMP441 ready (right slot)");
    return;
  }
  microphoneReady = false;
  Serial.println("INMP441 NOT detected: check VDD=3.3V, SCK=32, WS=33, SD=35, L/R=GND");
}

// Boosts quiet recordings (and never clips loud ones) so Wit.ai gets a
// consistent volume regardless of distance from the microphone.
void normalizeAudio(size_t sampleCount) {
  int32_t peak = 1;
  for (size_t index = 0; index < sampleCount; index++) peak = max(peak, (int32_t)abs(audioBuffer[index]));
  const float gain = min(12.0f, 24000.0f / peak);
  if (gain <= 1.05f) return;
  for (size_t index = 0; index < sampleCount; index++) {
    audioBuffer[index] = (int16_t)constrain((int32_t)(audioBuffer[index] * gain), -32768, 32767);
  }
}

// ============================ Speech (Wit.ai) ==============================

String extractTranscript(const String& response) {
  // Wit.ai streams several JSON objects ("text": "..."); the last holds the final transcript.
  const int marker = response.lastIndexOf("\"text\"");
  if (marker < 0) return "";
  const int colon = response.indexOf(':', marker);
  const int start = colon < 0 ? -1 : response.indexOf('"', colon) + 1;
  if (start <= 0) return "";
  const int end = response.indexOf('"', start);
  return end > start ? response.substring(start, end) : "";
}

String recognizeSpeech(size_t sampleCount) {
  for (uint8_t attempt = 1; attempt <= 2; attempt++) {
    WiFiClientSecure secureClient;
    secureClient.setInsecure();   // Replace with a root CA certificate for production.
    HTTPClient http;
    http.setTimeout(15000);
    if (!http.begin(secureClient, "https://api.wit.ai/speech?v=20230215")) continue;
    http.addHeader("Authorization", String("Bearer ") + WIT_AI_SERVER_TOKEN);
    http.addHeader("Content-Type", "audio/raw;encoding=signed-integer;bits=16;rate=16000;endian=little");
    const int status = http.POST(reinterpret_cast<uint8_t*>(audioBuffer), sampleCount * sizeof(int16_t));
    if (status >= 200 && status < 300) {
      const String transcript = extractTranscript(http.getString());
      http.end();
      return transcript;
    }
    Serial.printf("Wit.ai request failed (HTTP %d, free heap %u) - attempt %u\n", status, (unsigned)ESP.getFreeHeap(), attempt);
    http.end();
    if (status > 0 && status != 429 && status < 500) break;   // e.g. bad token: retrying will not help.
    delay(300);
  }
  return "";
}

void publishTranscript(const String& transcript) {
  if (transcript.isEmpty() || !mqttClient.connected()) return;
  String safe = transcript;
  safe.replace("\\", " "); safe.replace("\"", " ");
  char payload[320];
  snprintf(payload, sizeof(payload), "{\"transcript\":\"%s\",\"source\":\"ESP32 INMP441\"}", safe.c_str());
  mqttClient.publish(voiceTopic, payload, false);
}

// Normalises a transcript to " lower case words " with punctuation removed,
// so whole words can be matched as " word ".
String normalizeText(String text) {
  text.toLowerCase();
  String clean = " ";
  for (size_t index = 0; index < text.length(); index++) {
    const char c = text[index];
    clean += isalnum((unsigned char)c) ? c : ' ';
  }
  clean += ' ';
  while (clean.indexOf("  ") >= 0) clean.replace("  ", " ");
  return clean;
}

bool hasWord(const String& text, const char* const* words, size_t count) {
  for (size_t index = 0; index < count; index++) {
    if (text.indexOf(String(" ") + words[index] + " ") >= 0) return true;
  }
  return false;
}

// Applies light/fan/door phrases on the ESP32 itself, so the INMP441 works even
// when the dashboard is closed. Timers, thresholds and scenes need the dashboard.
// Accepts common speech-recognition variants ("lights", "lite", "turn of").
bool applyLocalVoiceCommand(const String& transcript) {
  static const char* const lightWords[] = { "light", "lights", "lite", "lamp", "lamps", "bulb", "delight" };
  static const char* const fanWords[] = { "fan", "fans", "fun" };
  static const char* const doorWords[] = { "door", "doors", "gate" };
  static const char* const onWords[] = { "on", "start", "enable" };
  static const char* const offWords[] = { "off", "stop", "disable" };
  static const char* const openWords[] = { "open", "unlock" };
  static const char* const closeWords[] = { "close", "lock", "shut" };
  const String text = normalizeText(transcript);
  if (text.indexOf(" timer ") >= 0 || text.indexOf(" threshold ") >= 0) return false;

  const bool saysOff = hasWord(text, offWords, 3) || text.indexOf(" turn of ") >= 0 || text.indexOf(" switch of ") >= 0;
  const bool saysOn = hasWord(text, onWords, 3) && !saysOff;

  if (text.indexOf(" good night ") >= 0 || text.indexOf(" all off ") >= 0 || text.indexOf(" everything off ") >= 0) {
    setRelay(LIGHT_RELAY_PIN, false); setRelay(FAN_RELAY_PIN, false); requestDoor(false);
    Serial.println("Voice -> good night (all off)");
  } else if (hasWord(text, doorWords, 3) || text.indexOf(" lock ") >= 0 || text.indexOf(" unlock ") >= 0) {
    if (hasWord(text, openWords, 2)) { requestDoor(true); Serial.println("Voice -> door OPEN"); }
    else if (hasWord(text, closeWords, 3)) { requestDoor(false); Serial.println("Voice -> door CLOSE"); }
    else return false;
  } else if (hasWord(text, lightWords, 7)) {
    if (saysOn) setRelay(LIGHT_RELAY_PIN, true); else if (saysOff) setRelay(LIGHT_RELAY_PIN, false); else return false;
    Serial.printf("Voice -> light %s\n", saysOn ? "ON" : "OFF");
  } else if (hasWord(text, fanWords, 3)) {
    if (saysOn) setRelay(FAN_RELAY_PIN, true); else if (saysOff) setRelay(FAN_RELAY_PIN, false); else return false;
    Serial.printf("Voice -> fan %s\n", saysOn ? "ON" : "OFF");
  } else return false;
  publishTelemetry();
  return true;
}

void processUtterance(size_t sampleCount) {
  Serial.printf("Heard %.2f s of speech - sending to Wit.ai\n", sampleCount / (float)SAMPLE_RATE);
  publishVoiceStatus("INMP441: speech detected - recognizing command...");
  normalizeAudio(sampleCount);
  const String transcript = recognizeSpeech(sampleCount);
  if (transcript.isEmpty()) {
    Serial.println("Wit.ai returned no text");
    publishVoiceStatus("INMP441: command not recognized - listening again");
    return;
  }
  Serial.printf("Wit.ai heard: \"%s\"\n", transcript.c_str());
  publishVoiceStatus((String("INMP441: recognized - ") + transcript).c_str());
  if (!applyLocalVoiceCommand(transcript)) Serial.println("No light/fan/door command in that sentence (the dashboard may still handle it)");
  publishTranscript(transcript);
}

// Called continuously from loop(): reads one 16 ms frame and runs the
// listen -> capture -> recognise state machine.
void serviceMicrophone() {
  static float noiseLevel = 30.0f;
  static uint8_t prerollHead = 0, prerollCount = 0, loudFrames = 0, readFailures = 0;
  static bool capturing = false;
  static size_t captured = 0;
  static uint16_t speechFrames = 0, silenceFrames = 0, capturedFrames = 0;
  static uint32_t capturedLevelSum = 0;
  static unsigned long lastPrintAt = 0;

  int16_t frame[FRAME_SAMPLES];
  if (!readFrame(frame)) {
    if (++readFailures == 5) publishVoiceStatus("INMP441: microphone read failed");
    return;
  }
  readFailures = 0;
  const uint32_t level = frameLevel(frame);
  const float startLevel = max((float)MIN_SPEECH_LEVEL, noiseLevel * SPEECH_START_FACTOR);
  const float continueLevel = max(MIN_SPEECH_LEVEL * 0.7f, noiseLevel * SPEECH_CONTINUE_FACTOR);

  if (PRINT_MIC_LEVEL && millis() - lastPrintAt >= 500) {
    lastPrintAt = millis();
    Serial.printf("Mic level %lu | noise %.0f | speech starts above %.0f\n", (unsigned long)level, noiseLevel, startLevel);
  }

  if (!capturing) {
    memcpy(prerollBuffer[prerollHead], frame, sizeof(frame));
    prerollHead = (prerollHead + 1) % PREROLL_FRAMES;
    if (prerollCount < PREROLL_FRAMES) prerollCount++;
    loudFrames = level > startLevel ? loudFrames + 1 : 0;
    if (loudFrames == 0) noiseLevel = noiseLevel * 0.98f + level * 0.02f;   // Learn the room noise.
    if (loudFrames >= START_FRAMES) {
      // Start the utterance with the pre-roll so the first word is not cut off.
      captured = 0;
      for (uint8_t index = 0; index < prerollCount; index++) {
        const uint8_t slot = (prerollHead + PREROLL_FRAMES - prerollCount + index) % PREROLL_FRAMES;
        memcpy(audioBuffer + captured, prerollBuffer[slot], sizeof(frame));
        captured += FRAME_SAMPLES;
      }
      capturing = true;
      speechFrames = loudFrames;
      silenceFrames = 0;
      capturedFrames = 0;
      capturedLevelSum = 0;
      loudFrames = 0;
    }
    return;
  }

  if (captured + FRAME_SAMPLES <= audioCapacity) {
    memcpy(audioBuffer + captured, frame, sizeof(frame));
    captured += FRAME_SAMPLES;
  }
  capturedFrames++;
  capturedLevelSum += level;
  if (level > continueLevel) { speechFrames++; silenceFrames = 0; }
  else silenceFrames++;

  const bool bufferFull = captured + FRAME_SAMPLES > audioCapacity;
  if (silenceFrames < END_SILENCE_FRAMES && !bufferFull) return;

  capturing = false;
  prerollCount = 0;
  if (bufferFull && silenceFrames < END_SILENCE_FRAMES) {
    // A spoken command ends with a pause. Several seconds of sound with no pause
    // is new background noise (e.g. the fan just turned on): learn it and discard.
    noiseLevel = capturedLevelSum / (float)max((uint16_t)1, capturedFrames);
    Serial.printf("Continuous background sound ignored - noise level now %.0f\n", noiseLevel);
  } else if (speechFrames >= MIN_SPEECH_FRAMES) processUtterance(captured);
  else if (PRINT_MIC_LEVEL) Serial.println("(short noise ignored)");
  publishVoiceStatus("INMP441: listening");
}

// ============================ Connectivity =================================

void connectWifi(uint32_t waitMs) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("Connecting to Wi-Fi \"%s\"", WIFI_SSID);
  const unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < waitMs) { delay(500); Serial.print('.'); }
  Serial.println(WiFi.status() == WL_CONNECTED ? String(" connected, IP ") + WiFi.localIP().toString() : String(" not yet (will retry)"));
}

void maintainWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiAttemptAt < 15000) return;
  lastWifiAttemptAt = millis();
  Serial.println("Wi-Fi lost, reconnecting...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void maintainMqtt() {
  if (mqttClient.connected() || WiFi.status() != WL_CONNECTED) return;
  if (lastMqttAttemptAt != 0 && millis() - lastMqttAttemptAt < 5000) return;
  lastMqttAttemptAt = millis();
  const String clientId = "smartnest-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  // Public brokers (e.g. broker.hivemq.com) take no login: send none when empty.
  const bool hasLogin = strlen(MQTT_USERNAME) > 0;
  Serial.printf("Connecting to MQTT %s:%d ... ", MQTT_HOST, MQTT_PORT);
  if (mqttClient.connect(clientId.c_str(), hasLogin ? MQTT_USERNAME : nullptr, hasLogin ? MQTT_PASSWORD : nullptr)) {
    Serial.println("connected");
    mqttClient.subscribe(commandsTopic, 1);
    lastVoiceStatus = "";   // Re-publish the current status after reconnecting.
    publishVoiceStatus(microphoneReady ? "INMP441: listening" : "INMP441: microphone not detected");
    publishTelemetry();
  } else {
    Serial.printf("failed (state %d)\n", mqttClient.state());
  }
}

// ============================== Setup / loop ===============================

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nSmartNest ESP32 starting");

  adcMutex = xSemaphoreCreateMutex();
  doorMutex = xSemaphoreCreateMutex();

  // Set the OFF level before enabling outputs so active-LOW relays do not click on at boot.
  setRelay(LIGHT_RELAY_PIN, false); setRelay(FAN_RELAY_PIN, false);
  pinMode(LIGHT_RELAY_PIN, OUTPUT); pinMode(FAN_RELAY_PIN, OUTPUT);
  setRelay(LIGHT_RELAY_PIN, false); setRelay(FAN_RELAY_PIN, false);

  setupBuzzer();
  setupServo();
  setDoor(false);

  dht.begin();
  analogReadResolution(12);
  analogSetPinAttenuation(SOLAR_VOLTAGE_ADC_PIN, ADC_11db);
  analogSetPinAttenuation(SOLAR_CURRENT_ADC_PIN, ADC_11db);
  analogSetPinAttenuation(MQ2_ADC_PIN, ADC_11db);

  // Gas safety starts before Wi-Fi so it protects even when offline.
  xTaskCreatePinnedToCore(gasSafetyTask, "gasSafety", 4096, nullptr, 2, nullptr, 1);

  // Short confirmation beep: buzzer wiring check.
  setBuzzer(true); delay(120); setBuzzer(false);

  // Longest command: 3.5 s, or less if memory is short.
  for (float seconds = 3.5f; seconds >= 1.99f && !audioBuffer; seconds -= 0.5f) {
    audioCapacity = (size_t)(SAMPLE_RATE * seconds);
    audioBuffer = static_cast<int16_t*>(malloc(audioCapacity * sizeof(int16_t)));
  }
  if (!audioBuffer) Serial.println("Not enough memory for the microphone buffer - voice disabled");
  else {
    Serial.printf("Voice buffer: %.1f s\n", audioCapacity / (float)SAMPLE_RATE);
    startMicrophone();
  }

  snprintf(commandsTopic, sizeof(commandsTopic), "%s/%s/commands", ROOM_PREFIX, ROOM_ID);
  snprintf(telemetryTopic, sizeof(telemetryTopic), "%s/%s/telemetry", ROOM_PREFIX, ROOM_ID);
  snprintf(ackTopic, sizeof(ackTopic), "%s/%s/ack", ROOM_PREFIX, ROOM_ID);
  snprintf(voiceTopic, sizeof(voiceTopic), "%s/%s/voice/transcript", ROOM_PREFIX, ROOM_ID);
  snprintf(voiceStatusTopic, sizeof(voiceStatusTopic), "%s/%s/voice/status", ROOM_PREFIX, ROOM_ID);
  Serial.printf("MQTT topics: %s/%s/...\n", ROOM_PREFIX, ROOM_ID);

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setBufferSize(MQTT_BUFFER_SIZE);
  mqttClient.setKeepAlive(60);   // Speech recognition can block the loop for a few seconds.
  mqttClient.setCallback(onMqttMessage);

  connectWifi(20000);
  lastWifiAttemptAt = millis();
}

void loop() {
  maintainWifi();
  maintainMqtt();
  if (mqttClient.connected()) mqttClient.loop();

  if (gasStateChanged) {
    gasStateChanged = false;
    publishTelemetry();   // Tell the dashboard about the alarm immediately.
  }
  if (millis() - lastTelemetryAt > TELEMETRY_INTERVAL_MS) {
    lastTelemetryAt = millis();
    publishTelemetry();
  }

  // Speech recognition needs the internet (Wit.ai).
  // serviceMicrophone() takes ~16 ms per call (one audio frame).
  // Recognition needs the internet (Wit.ai).
  if (microphoneReady && WiFi.status() == WL_CONNECTED) serviceMicrophone();
  else delay(50);
}
