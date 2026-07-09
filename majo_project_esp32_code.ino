#include <WiFi.h>
#include <PubSubClient.h>
#include <ESP32Servo.h>
#include <DHT.h>

// ================= WIFI =================
const char* ssid = "Alpha";
const char* password = "11223344";

// ================= MQTT =================
const char* mqtt_server = "broker.emqx.io";
const char* sub_topic = "room1/commands";
const char* pub_topic = "room1/telemetry";

// ================= PINS =================
#define LED_PIN       2     // Relay for Light 1
#define LED2_PIN      15    // Relay for Light 2
#define RELAY_PIN     4     // Relay for Fan
#define SERVO_PIN     18
#define DHT_PIN       5

#define DHTTYPE DHT11

#define RELAY_ON  LOW
#define RELAY_OFF HIGH

WiFiClient espClient;
PubSubClient client(espClient);
Servo myServo;
DHT dht(DHT_PIN, DHTTYPE);

// ================= STATES =================
bool lightState  = false;
bool light2State = false;
bool fanState    = false;
bool doorState   = false;

float temperature = 0.0;
float humidity    = 0.0;

// ================= WIFI =================
void setup_wifi() {
  Serial.println("Connecting to WiFi...");
  WiFi.begin(ssid, password);

  unsigned long startAttemptTime = millis();

  while (WiFi.status() != WL_CONNECTED &&
         millis() - startAttemptTime < 10000) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWiFi Failed!");
  }
}

// ================= DEVICE CONTROL =================
void controlLight(bool state) {
  digitalWrite(LED_PIN, state ? RELAY_ON : RELAY_OFF);   // Relay logic
  lightState = state;
}

void controlLight2(bool state) {
  digitalWrite(LED2_PIN, state ? RELAY_ON : RELAY_OFF);  // Relay logic
  light2State = state;
}

void controlFan(bool state) {
  digitalWrite(RELAY_PIN, state ? RELAY_ON : RELAY_OFF);
  fanState = state;
}

void controlDoor(bool state) {
  myServo.write(state ? 90 : 0);
  doorState = state;
}

// ================= READ SENSOR =================
void readDHTSensor() {
  float h = dht.readHumidity();
  float t = dht.readTemperature();

  if (!isnan(h) && !isnan(t)) {
    humidity    = h;
    temperature = t;
  } else {
    Serial.println("DHT11 Read Failed!");
  }
}

// ================= MQTT CALLBACK =================
void callback(char* topic, byte* payload, unsigned int length) {

  String msg = "";

  for (int i = 0; i < length; i++) {
    msg += (char)payload[i];
  }

  Serial.println("Received: " + msg);

  // Examples:
  // {"device":"light","state":"ON"}
  // {"device":"light2","state":"ON"}
  // {"device":"fan","state":"ON"}
  // {"device":"door","state":"OPEN"}

  if (msg.indexOf("light2") >= 0) {
    controlLight2(msg.indexOf("ON") >= 0);
  } else if (msg.indexOf("light") >= 0) {
    controlLight(msg.indexOf("ON") >= 0);
  }

  if (msg.indexOf("fan") >= 0) {
    controlFan(msg.indexOf("ON") >= 0);
  }

  if (msg.indexOf("door") >= 0) {
    controlDoor(msg.indexOf("OPEN") >= 0);
  }
}

// ================= MQTT RECONNECT =================
void reconnect() {
  while (!client.connected()) {

    Serial.print("Connecting to MQTT...");

    String clientId = "ESP32_" + String(random(1000, 9999));

    if (client.connect(clientId.c_str())) {
      Serial.println("Connected");
      client.subscribe(sub_topic);
    } else {
      Serial.print("Failed, rc=");
      Serial.print(client.state());
      Serial.println(" retrying...");
      delay(2000);
    }
  }
}

// ================= SETUP =================
void setup() {

  Serial.begin(115200);

  pinMode(LED_PIN,   OUTPUT);
  pinMode(LED2_PIN,  OUTPUT);
  pinMode(RELAY_PIN, OUTPUT);

  // Start all relays OFF (HIGH = coil not energised)
  digitalWrite(LED_PIN,   RELAY_OFF);
  digitalWrite(LED2_PIN,  RELAY_OFF);
  digitalWrite(RELAY_PIN, RELAY_OFF);

  myServo.attach(SERVO_PIN);
  myServo.write(0);

  dht.begin();

  setup_wifi();

  client.setServer(mqtt_server, 1883);
  client.setCallback(callback);
}

// ================= LOOP =================
unsigned long lastMsg = 0;

void loop() {

  if (WiFi.status() != WL_CONNECTED) {
    setup_wifi();
  }

  if (!client.connected()) {
    reconnect();
  }

  client.loop();

  // Send telemetry every 3 seconds
  if (millis() - lastMsg > 3000) {

    lastMsg = millis();

    readDHTSensor();

    String data = "{";
    data += "\"light\":"   + String(lightState)   + ",";
    data += "\"light2\":"  + String(light2State)  + ",";
    data += "\"fan\":"     + String(fanState)      + ",";
    data += "\"door\":"    + String(doorState)     + ",";
    data += "\"temp\":"    + String(temperature,1) + ",";
    data += "\"humidity\":" + String(humidity,1);
    data += "}";

    client.publish(pub_topic, data.c_str());

    Serial.println("Sent: " + data);
  }
}void setup() {
  // put your setup code here, to run once:

}

void loop() {
  // put your main code here, to run repeatedly:

}
