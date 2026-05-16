#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <driver/i2s.h>

// =====================================================
// WIFI SETTINGS
// =====================================================
const char* ssid       = "Alpha";
const char* password   = "11223344";

// =====================================================
// MQTT SETTINGS
// =====================================================
const char* mqtt_server = "broker.hivemq.com";
const int   mqtt_port   = 1883;
const char* mqtt_topic  = "room1/voice/transcript";

// =====================================================
// WIT.AI TOKEN
// =====================================================
const char* wit_ai_token = "YOUR_WIT_AI_SERVER_TOKEN";

// =====================================================
// INMP441 CONNECTION
// =====================================================
// VCC -> 3.3V
// GND -> GND
// WS  -> GPIO25
// SD  -> GPIO22
// SCK -> GPIO26
// L/R -> GND

#define I2S_WS   25
#define I2S_SD   22
#define I2S_SCK  26
#define I2S_PORT I2S_NUM_0

// =====================================================
// BUTTON
// =====================================================
#define RECORD_BTN_PIN 0   // BOOT button

// =====================================================
// AUDIO SETTINGS
// =====================================================
#define SAMPLE_RATE 16000
#define RECORD_SECONDS 3
#define AUDIO_BUFFER_SIZE (SAMPLE_RATE * 2 * RECORD_SECONDS)

uint8_t* audioBuffer = NULL;

// =====================================================
// CLIENTS
// =====================================================
WiFiClient espClient;
PubSubClient mqttClient(espClient);

// =====================================================
// I2S SETUP
// =====================================================
void setupI2S()
{
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S,
    .intr_alloc_flags = 0,
    .dma_buf_count = 8,
    .dma_buf_len = 1024,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pin_config = {
    .bck_io_num   = I2S_SCK,
    .ws_io_num    = I2S_WS,
    .data_out_num = -1,
    .data_in_num  = I2S_SD
  };

  i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  i2s_set_pin(I2S_PORT, &pin_config);
  i2s_zero_dma_buffer(I2S_PORT);
}

// =====================================================
// WIFI CONNECT
// =====================================================
void connectWiFi()
{
  Serial.print("Connecting WiFi");

  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED)
  {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("WiFi Connected");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}

// =====================================================
// MQTT CONNECT
// =====================================================
void reconnectMQTT()
{
  while (!mqttClient.connected())
  {
    Serial.print("Connecting MQTT...");

    String clientId = "ESP32Voice-" + String(random(1000,9999));

    if (mqttClient.connect(clientId.c_str()))
    {
      Serial.println("Connected");
    }
    else
    {
      Serial.print("Failed rc=");
      Serial.println(mqttClient.state());
      delay(3000);
    }
  }
}

// =====================================================
// RECORD AUDIO
// =====================================================
void recordAudio()
{
  Serial.println("Recording... Speak Now");

  memset(audioBuffer, 0, AUDIO_BUFFER_SIZE);

  size_t bytesRead = 0;
  size_t totalBytes = 0;

  while (totalBytes < AUDIO_BUFFER_SIZE)
  {
    i2s_read(I2S_PORT,
             audioBuffer + totalBytes,
             AUDIO_BUFFER_SIZE - totalBytes,
             &bytesRead,
             portMAX_DELAY);

    totalBytes += bytesRead;
  }

  Serial.print("Recording Finished: ");
  Serial.println(totalBytes);
}

// =====================================================
// SEND TO WIT.AI (FIXED)
// =====================================================
String recognizeSpeech()
{
  Serial.println("Sending to Wit.ai...");

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;

  if (!http.begin(client, "https://api.wit.ai/speech?v=20230401"))
  {
    Serial.println("HTTP Begin Failed");
    return "";
  }

  http.useHTTP10(true);

  String auth = "Bearer ";
  auth += wit_ai_token;

  http.addHeader("Authorization", auth);
  http.addHeader("Content-Type",
  "audio/raw;encoding=signed-integer;bits=16;rate=16000;endian=little");
  http.addHeader("User-Agent", "ESP32");

  int code = http.POST(audioBuffer, AUDIO_BUFFER_SIZE);

  if (code <= 0)
  {
    Serial.print("HTTP Error: ");
    Serial.println(http.errorToString(code));
    http.end();
    return "";
  }

  Serial.print("HTTP Code: ");
  Serial.println(code);

  String payload = http.getString();
  http.end();

  Serial.println(payload);

  String text = "";

  int p = payload.lastIndexOf("\"text\":\"");

  if (p != -1)
  {
    int start = p + 8;
    int end = payload.indexOf("\"", start);

    if (end != -1)
    {
      text = payload.substring(start, end);
    }
  }

  return text;
}

// =====================================================
// MQTT SEND
// =====================================================
void publishTranscript(String msg)
{
  if (msg == "") return;

  String payload =
  "{\"transcript\":\"" + msg + "\",\"source\":\"ESP32 Voice\"}";

  mqttClient.publish(mqtt_topic, payload.c_str());

  Serial.print("Published: ");
  Serial.println(payload);
}

// =====================================================
// SETUP
// =====================================================
void setup()
{
  Serial.begin(115200);
  delay(1500);

  Serial.println("ESP32 Voice Control Starting");

  pinMode(RECORD_BTN_PIN, INPUT_PULLUP);

  audioBuffer = (uint8_t*)malloc(AUDIO_BUFFER_SIZE);

  if (!audioBuffer)
  {
    Serial.println("Memory Failed");
    while(1);
  }

  connectWiFi();

  mqttClient.setServer(mqtt_server, mqtt_port);

  setupI2S();

  Serial.println("System Ready");
  Serial.println("Press BOOT Button");
}

// =====================================================
// LOOP
// =====================================================
void loop()
{
  if (!mqttClient.connected())
    reconnectMQTT();

  mqttClient.loop();

  if (digitalRead(RECORD_BTN_PIN) == LOW)
  {
    delay(50);

    if (digitalRead(RECORD_BTN_PIN) == LOW)
    {
      recordAudio();

      String text = recognizeSpeech();

      if (text != "")
      {
        Serial.print("Recognized: ");
        Serial.println(text);

        publishTranscript(text);
      }
      else
      {
        Serial.println("No Speech Detected");
      }

      while (digitalRead(RECORD_BTN_PIN) == LOW)
      {
        delay(10);
      }

      Serial.println("Ready Next Command");
    }
  }
}