



/*
 * SFTS demo remote for the Adafruit ESP32 Feather V2.
 *
 * Wiring:
 *   - Connect one side of every momentary button to the GPIO below.
 *   - Connect the other side of every button to GND.
 *   - Keep the fitted external 10K pull-up from each GPIO to 3.3V.
 *   - Internal pull-ups are deliberately disabled in this sketch.
 *
 * The button GPIOs below are broken out on the Feather ESP32 V2 and support
 * GPIO interrupts on the ESP32 Arduino core. The map deliberately avoids:
 *   - GPIO0 and GPIO2: onboard NeoPixel and its power control
 *   - GPIO12: boot-strapping pin
 *   - GPIO13: onboard red LED
 *   - GPIO15: boot-time peripheral activity
 *   - GPIO34, GPIO36, GPIO37, GPIO39: input-only pins without internal pull-ups
 *   - GPIO4 and GPIO5: reserved here to avoid alternate board/boot functions
 *
 * Required Arduino library:
 *   WebSockets by Markus Sattler / Links2004
 *
 * The server protocol is documented in the project README. This demo sends
 * battery: 100 because the server field is a percentage, not a voltage.
 * It is intentionally a dummy value for the first hardware test.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <string.h>

// --------------------------- Test configuration ---------------------------

const char* WIFI_SSID = "CLABS";
const char* WIFI_PASSWORD = "clabs2023!";

// Use the Raspberry Pi or Windows PC LAN address, never localhost on the ESP32.
const char* SERVER_HOST = "192.168.0.106";
const uint16_t SERVER_PORT = 3000;
const char* SERVER_PATH = "/";

// MODE=1 on the dashboard enables C1. Change both this ID and the dashboard
// mode when testing another corner. Valid IDs are C1, C2, C3, and C4.
const char* REMOTE_DEVICE_ID = "C1";

// Leave empty when the server is started with SFTS_ALLOW_UNPAIRED_REMOTES=true.
// In a real event, set this to the matching SFTS_REMOTE_TOKEN_C1 value.
const char* REMOTE_TOKEN = "";

const uint8_t DUMMY_BATTERY_PERCENT = 100;
const uint32_t DEBOUNCE_MS = 45;
const uint32_t STATUS_INTERVAL_MS = 10000;
const uint32_t WIFI_RETRY_INTERVAL_MS = 5000;

// ----------------------------- Button pin map ------------------------------

// All eight selected pins are ordinary Feather ESP32 V2 GPIOs and are used
// with attachInterruptArg(..., FALLING). Buttons are active LOW.
struct ButtonDefinition {
  uint8_t pin;
  const char* protocolButton;
  uint8_t index;
};

ButtonDefinition buttons[] = {
  {26, "RED_1",         0}, // A0 / GPIO26
  {25, "RED_2",         1}, // A1 / GPIO25
  {27, "RED_3",         2}, // D27 / GPIO27
  {33, "RED_TECHNICAL", 3}, // D33 / GPIO33
  {32, "BLUE_1",        4}, // D32 / GPIO32
  {14, "BLUE_2",        5}, // D14 / GPIO14
  {20, "BLUE_3",        6}, // SCL / GPIO20
  {22, "BLUE_TECHNICAL", 7} // SDA / GPIO22
};

constexpr size_t BUTTON_COUNT = sizeof(buttons) / sizeof(buttons[0]);
static_assert(BUTTON_COUNT == 8, "The demo remote must have exactly eight buttons");

// ------------------------------- Runtime state ----------------------------

WebSocketsClient webSocket;
portMUX_TYPE buttonMux = portMUX_INITIALIZER_UNLOCKED;
volatile uint32_t pendingButtonMask = 0;
uint32_t lastButtonEventAt[BUTTON_COUNT] = {};
bool buttonDebouncePrimed[BUTTON_COUNT] = {};
uint32_t nextSequence = 0;
uint32_t lastStatusAt = 0;
uint32_t lastWiFiAttemptAt = 0;
bool webSocketConnected = false;
bool wifiBeginCalled = false;
String sessionId;

// ----------------------------- Interrupt handler --------------------------

void IRAM_ATTR buttonInterrupt(void* context) {
  ButtonDefinition* button = static_cast<ButtonDefinition*>(context);
  portENTER_CRITICAL_ISR(&buttonMux);
  pendingButtonMask |= (1UL << button->index);
  portEXIT_CRITICAL_ISR(&buttonMux);
}

uint32_t takePendingButtons() {
  portENTER_CRITICAL(&buttonMux);
  const uint32_t pending = pendingButtonMask;
  pendingButtonMask = 0;
  portEXIT_CRITICAL(&buttonMux);
  return pending;
}

// ------------------------------- JSON helpers -----------------------------

String jsonEscape(const String& value) {
  String escaped;
  escaped.reserve(value.length() + 4);
  for (size_t i = 0; i < value.length(); ++i) {
    const char character = value[i];
    if (character == '\\' || character == '"') escaped += '\\';
    escaped += character;
  }
  return escaped;
}

String buildHelloMessage() {
  String message = "{\"type\":\"remote_hello\",\"protocolVersion\":1";
  message += ",\"deviceId\":\"" + jsonEscape(REMOTE_DEVICE_ID) + "\"";
  message += ",\"sessionId\":\"" + jsonEscape(sessionId) + "\"";
  message += ",\"firmware\":\"sfts-demo-esp32-feather-v2\"";
  if (strlen(REMOTE_TOKEN) > 0) {
    message += ",\"token\":\"" + jsonEscape(REMOTE_TOKEN) + "\"";
  }
  message += "}";
  return message;
}

String buildStatusMessage() {
  const int32_t rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : -127;
  String message = "{\"type\":\"remote_status\"";
  message += ",\"deviceId\":\"" + jsonEscape(REMOTE_DEVICE_ID) + "\"";
  message += ",\"sessionId\":\"" + jsonEscape(sessionId) + "\"";
  message += ",\"rssi\":" + String(rssi);
  message += ",\"battery\":" + String(DUMMY_BATTERY_PERCENT);
  message += "}";
  return message;
}

void sendStatus() {
  if (!webSocketConnected || WiFi.status() != WL_CONNECTED) return;
  String message = buildStatusMessage();
  webSocket.sendTXT(message);
  lastStatusAt = millis();
}

void sendHello() {
  if (!webSocketConnected) return;
  String message = buildHelloMessage();
  webSocket.sendTXT(message);
  Serial.print("Remote hello sent for ");
  Serial.println(REMOTE_DEVICE_ID);
}

void sendButtonEvent(const ButtonDefinition& button) {
  if (!webSocketConnected) {
    Serial.print("Ignored offline button: ");
    Serial.println(button.protocolButton);
    return;
  }

  const uint32_t sequence = ++nextSequence;
  String message = "{\"type\":\"remote_event\"";
  message += ",\"deviceId\":\"" + jsonEscape(REMOTE_DEVICE_ID) + "\"";
  message += ",\"sessionId\":\"" + jsonEscape(sessionId) + "\"";
  message += ",\"sequence\":" + String(sequence);
  message += ",\"button\":\"" + jsonEscape(button.protocolButton) + "\"}";

  if (webSocket.sendTXT(message)) {
    Serial.print("Sent ");
    Serial.print(button.protocolButton);
    Serial.print(" sequence ");
    Serial.println(sequence);
  } else {
    Serial.print("Could not send ");
    Serial.println(button.protocolButton);
  }
}

// ------------------------------- WebSocket ---------------------------------

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      webSocketConnected = true;
      digitalWrite(LED_BUILTIN, HIGH);
      Serial.println("WebSocket connected");
      sendHello();
      break;

    case WStype_DISCONNECTED:
      webSocketConnected = false;
      digitalWrite(LED_BUILTIN, LOW);
      Serial.println("WebSocket disconnected; reconnecting");
      break;

    case WStype_TEXT: {
      String message;
      message.reserve(length + 1);
      for (size_t i = 0; i < length; ++i) message += static_cast<char>(payload[i]);

      if (message.indexOf("remote_ready") >= 0) {
        Serial.println("Remote accepted by SFTS server");
        sendStatus();
      } else if (message.indexOf("remote_event_ack") >= 0) {
        Serial.print("Server acknowledgement: ");
        Serial.println(message);
      } else if (message.indexOf("remote_status_ack") >= 0) {
        Serial.println("Status accepted");
      } else if (message.indexOf("\"type\":\"error\"") >= 0) {
        Serial.print("Server error: ");
        Serial.println(message);
      }
      break;
    }

    default:
      break;
  }
}

// -------------------------------- Wi-Fi ------------------------------------

void maintainWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  const uint32_t now = millis();
  if (wifiBeginCalled && now - lastWiFiAttemptAt < WIFI_RETRY_INTERVAL_MS) return;

  lastWiFiAttemptAt = now;
  wifiBeginCalled = true;
  Serial.println("Connecting to Wi-Fi...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

String makeSessionId() {
  String mac = WiFi.macAddress();
  mac.replace(":", "-");
  return "sfts-" + mac;
}

// -------------------------------- Arduino ----------------------------------

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);

  for (size_t i = 0; i < BUTTON_COUNT; ++i) {
    pinMode(buttons[i].pin, INPUT);
    attachInterruptArg(buttons[i].pin, buttonInterrupt, &buttons[i], FALLING);
  }

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  maintainWiFi();
  sessionId = makeSessionId();

  webSocket.begin(SERVER_HOST, SERVER_PORT, SERVER_PATH);
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
  webSocket.enableHeartbeat(15000, 3000, 2);

  Serial.println("SFTS ESP32 Feather V2 demo started");
  Serial.println("Buttons use external 10K pull-ups, INPUT, and FALLING-edge interrupts");
}

void loop() {
  maintainWiFi();
  webSocket.loop();

  const uint32_t now = millis();
  if (webSocketConnected && now - lastStatusAt >= STATUS_INTERVAL_MS) sendStatus();

  const uint32_t pending = takePendingButtons();
  for (size_t i = 0; i < BUTTON_COUNT; ++i) {
    if (!(pending & (1UL << buttons[i].index))) continue;
    if (buttonDebouncePrimed[i] && now - lastButtonEventAt[i] < DEBOUNCE_MS) continue;
    buttonDebouncePrimed[i] = true;
    lastButtonEventAt[i] = now;
    sendButtonEvent(buttons[i]);
  }
}
