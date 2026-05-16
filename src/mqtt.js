import mqtt from "mqtt";

const client = mqtt.connect("wss://broker.emqx.io:8084/mqtt");

client.on("connect", () => {
  console.log("MQTT Connected");
});

export default client;