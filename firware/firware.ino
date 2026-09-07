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
#include <esp_system.h>
#include <stdio.h>
#include <string.h>

// --------------------------- Test configuration ---------------------------

const char* WIFI_SSID = "sfts-gateway";
const char* WIFI_PASSWORD = "sfts-gateway#";

// Use the Raspberry Pi or Windows PC LAN address, never localhost on the ESP32.
const char* SERVER_HOST = "192.168.50.102";
const uint16_t SERVER_PORT = 8080;
const char* SERVER_PATH = "/";

// MODE=1 on the dashboard enables C1. Change both this ID and the dashboard
// mode when testing another corner. Valid IDs are C1, C2, C3, and C4.
const char* REMOTE_DEVICE_ID = "C1";

// Must match remoteTokens.C1 in config/remote-config.json on the server.
// Flash each remote with its own matching ID and token before the event.
const char* REMOTE_TOKEN = "sfts-c1-9a3f7d2c8e1b4f60a5d9c7e2b6f1a804";

const uint8_t DUMMY_BATTERY_PERCENT = 100;
const uint32_t DEBOUNCE_MS = 45;
const uint32_t STATUS_INTERVAL_MS = 10000;
const uint32_t WIFI_RETRY_INTERVAL_MS = 5000;
const uint32_t EVENT_RETRY_INTERVAL_MS = 1000;
constexpr size_t EVENT_OUTBOX_SIZE = 16;

// ----------------------------- Button pin map ------------------------------

// All eight selected pins are ordinary Feather ESP32 V2 GPIOs and are used
// with attachInterruptArg(..., CHANGE). Buttons are active LOW. The interrupt
// only records that a pin changed; debounce and button-state decisions happen
// in loop(), outside the ISR.
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
  {21, "BLUE_3",        6}, // MI / MISO / GPIO21 (replacement for SCL / GPIO20)
  {22, "BLUE_TECHNICAL", 7} // SDA / GPIO22
};

constexpr size_t BUTTON_COUNT = sizeof(buttons) / sizeof(buttons[0]);
static_assert(BUTTON_COUNT == 8, "The demo remote must have exactly eight buttons");

// ------------------------------- Runtime state ----------------------------

WebSocketsClient webSocket;
portMUX_TYPE buttonMux = portMUX_INITIALIZER_UNLOCKED;
volatile uint32_t pendingButtonMask = 0;
uint32_t buttonHighSince[BUTTON_COUNT] = {};
bool buttonArmed[BUTTON_COUNT] = {};
uint32_t nextSequence = 0;
uint32_t lastStatusAt = 0;
uint32_t lastWiFiAttemptAt = 0;
// Transport connection and server acceptance are separate states. A TCP/
// WebSocket connection can exist even when the server rejects remote_hello.
bool webSocketConnected = false;
bool remoteAccepted = false;
bool wifiBeginCalled = false;
String sessionId;

struct RemoteEvent {
  uint32_t sequence;
  uint8_t buttonIndex;
  uint32_t sentAt;
  uint32_t attempts;
};

RemoteEvent eventOutbox[EVENT_OUTBOX_SIZE] = {};
size_t eventOutboxCount = 0;
uint16_t pendingButtonEvents[BUTTON_COUNT] = {};

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
  if (!webSocketConnected || !remoteAccepted || WiFi.status() != WL_CONNECTED) return;
  String message = buildStatusMessage();
  if (webSocket.sendTXT(message)) lastStatusAt = millis();
}

void sendHello() {
  if (!webSocketConnected) return;
  String message = buildHelloMessage();
  webSocket.sendTXT(message);
  Serial.print("Remote hello sent for ");
  Serial.println(REMOTE_DEVICE_ID);
}

bool enqueueButtonEvent(const ButtonDefinition& button) {
  if (eventOutboxCount >= EVENT_OUTBOX_SIZE) {
    return false;
  }

  RemoteEvent& event = eventOutbox[eventOutboxCount++];
  event.sequence = ++nextSequence;
  event.buttonIndex = button.index;
  event.sentAt = 0;
  event.attempts = 0;
  Serial.print("Queued ");
  Serial.print(button.protocolButton);
  Serial.print(" sequence ");
  Serial.println(event.sequence);
  return true;
}

void drainPendingButtonEvents() {
  for (size_t index = 0; index < BUTTON_COUNT && eventOutboxCount < EVENT_OUTBOX_SIZE; ++index) {
    while (pendingButtonEvents[index] > 0 && eventOutboxCount < EVENT_OUTBOX_SIZE) {
      if (!enqueueButtonEvent(buttons[index])) return;
      --pendingButtonEvents[index];
    }
  }
}

bool extractSequence(const String& message, uint32_t& sequence) {
  const int marker = message.indexOf("\"sequence\"");
  if (marker < 0) return false;
  int cursor = message.indexOf(':', marker);
  if (cursor < 0) return false;
  ++cursor;
  while (cursor < static_cast<int>(message.length()) && message[cursor] == ' ') ++cursor;
  if (cursor >= static_cast<int>(message.length()) || message[cursor] < '0' || message[cursor] > '9') return false;

  uint64_t parsed = 0;
  while (cursor < static_cast<int>(message.length()) && message[cursor] >= '0' && message[cursor] <= '9') {
    parsed = parsed * 10 + static_cast<uint8_t>(message[cursor] - '0');
    if (parsed > UINT32_MAX) return false;
    ++cursor;
  }
  sequence = static_cast<uint32_t>(parsed);
  return true;
}

void acknowledgeEvent(uint32_t sequence) {
  for (size_t index = 0; index < eventOutboxCount; ++index) {
    if (eventOutbox[index].sequence != sequence) continue;
    for (size_t move = index + 1; move < eventOutboxCount; ++move) {
      eventOutbox[move - 1] = eventOutbox[move];
    }
    --eventOutboxCount;
    Serial.print("Acknowledged sequence ");
    Serial.println(sequence);
    return;
  }
}

void flushEventOutbox() {
  if (!webSocketConnected || !remoteAccepted || eventOutboxCount == 0) return;

  RemoteEvent& event = eventOutbox[0];
  const uint32_t now = millis();
  if (event.sentAt != 0 && now - event.sentAt < EVENT_RETRY_INTERVAL_MS) return;

  const ButtonDefinition& button = buttons[event.buttonIndex];
  char message[192] = {};
  const int written = snprintf(
    message, sizeof(message),
    "{\"type\":\"remote_event\",\"deviceId\":\"%s\",\"sessionId\":\"%s\",\"sequence\":%lu,\"button\":\"%s\"}",
    REMOTE_DEVICE_ID, sessionId.c_str(), static_cast<unsigned long>(event.sequence), button.protocolButton
  );
  if (written <= 0 || static_cast<size_t>(written) >= sizeof(message)) return;

  event.attempts++;
  event.sentAt = now;
  if (webSocket.sendTXT(message)) {
    Serial.print("Sent ");
    Serial.print(button.protocolButton);
    Serial.print(" sequence ");
    Serial.println(event.sequence);
  } else {
    Serial.print("Could not send sequence ");
    Serial.println(event.sequence);
  }
}

// ------------------------------- WebSocket ---------------------------------

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      webSocketConnected = true;
      remoteAccepted = false;
      for (size_t index = 0; index < eventOutboxCount; ++index) eventOutbox[index].sentAt = 0;
      digitalWrite(LED_BUILTIN, LOW);
      Serial.println("WebSocket connected");
      sendHello();
      break;

    case WStype_DISCONNECTED:
      webSocketConnected = false;
      remoteAccepted = false;
      digitalWrite(LED_BUILTIN, LOW);
      Serial.println("WebSocket disconnected; reconnecting");
      break;

    case WStype_TEXT: {
      String message;
      message.reserve(length + 1);
      for (size_t i = 0; i < length; ++i) message += static_cast<char>(payload[i]);

      if (message.indexOf("remote_ready") >= 0) {
        remoteAccepted = true;
        digitalWrite(LED_BUILTIN, HIGH);
        Serial.println("Remote accepted by SFTS server");
        sendStatus();
      } else if (message.indexOf("remote_event_ack") >= 0) {
        uint32_t sequence = 0;
        if (extractSequence(message, sequence)) acknowledgeEvent(sequence);
        Serial.print("Server acknowledgement: ");
        Serial.println(message);
      } else if (message.indexOf("remote_status_ack") >= 0) {
        Serial.println("Status accepted");
      } else if (message.indexOf("\"type\":\"error\"") >= 0) {
        remoteAccepted = false;
        digitalWrite(LED_BUILTIN, LOW);
        Serial.print("Server error: ");
        Serial.println(message);

        // An application error leaves this connection unusable. Force a
        // reconnect even after authentication so the READY state is rebuilt.
        webSocket.disconnect();
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
  char generated[32] = {};
  snprintf(
    generated, sizeof(generated), "sfts-%08lx%08lx",
    static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random())
  );
  return String(generated);
}

// -------------------------------- Arduino ----------------------------------

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);

  for (size_t i = 0; i < BUTTON_COUNT; ++i) {
    pinMode(buttons[i].pin, INPUT);

    // The fitted external pull-up makes HIGH the released state. A button
    // held while the board boots is intentionally not treated as a press.
    buttonArmed[i] = digitalRead(buttons[i].pin) == HIGH;
    buttonHighSince[i] = buttonArmed[i] ? millis() : 0;

    // Capture both transitions. The loop emits one event for a stable LOW
    // transition and waits for a stable HIGH release before re-arming.
    attachInterruptArg(buttons[i].pin, buttonInterrupt, &buttons[i], CHANGE);
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
  Serial.println("Buttons use external 10K pull-ups, INPUT, and CHANGE-edge interrupts");
}

void loop() {
  maintainWiFi();
  webSocket.loop();

  const uint32_t now = millis();
  if (webSocketConnected && now - lastStatusAt >= STATUS_INTERVAL_MS) sendStatus();

  const uint32_t pending = takePendingButtons();
  for (size_t i = 0; i < BUTTON_COUNT; ++i) {
    const bool changed = pending & (1UL << buttons[i].index);

    // Normally a pin is examined after its ISR flag is consumed. While a
    // button is waiting for a stable release, keep checking it so release
    // debounce can complete even though no new interrupt is generated.
    if (!changed && buttonArmed[i]) continue;

    const bool pressed = digitalRead(buttons[i].pin) == LOW;
    if (pressed) {
      // A LOW pin is a press only when the button was previously armed. Any
      // LOW bounce while held is therefore ignored.
      buttonHighSince[i] = 0;
      if (!buttonArmed[i]) continue;

      buttonArmed[i] = false;
      if (!enqueueButtonEvent(buttons[i])) pendingButtonEvents[i]++;
      continue;
    }

    // The pin is HIGH. Require it to remain HIGH for the full debounce period
    // before allowing the next LOW transition to generate an event.
    if (buttonArmed[i]) continue;
    if (buttonHighSince[i] == 0) buttonHighSince[i] = now;
    if (now - buttonHighSince[i] >= DEBOUNCE_MS) {
      buttonArmed[i] = true;
      buttonHighSince[i] = 0;
    }
  }

  drainPendingButtonEvents();
  flushEventOutbox();
}
