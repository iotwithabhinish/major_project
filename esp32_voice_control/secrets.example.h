#pragma once

// Copy this file to secrets.h. It is intentionally excluded from Git.
#define WIFI_SSID "your-wifi-name"
#define WIFI_PASSWORD "your-wifi-password"
#define MQTT_HOST "mqtt.example.com"
#define MQTT_PORT 1883
#define MQTT_USERNAME "dashboard-device-user"
#define MQTT_PASSWORD "replace-with-device-password"
// Must match VITE_MQTT_ROOM_PREFIX in .env.local. Use something unique.
#define MQTT_ROOM_PREFIX "smart-home"
// Create a server access token at https://wit.ai/. Do not commit the real token.
#define WIT_AI_SERVER_TOKEN "replace-with-wit-ai-server-token"
