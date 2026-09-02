#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

# This script runs inside the logged-in Raspberry Pi desktop session. It is
# deliberately separate from the server service: the server runs at boot as a
# system service, while Chromium needs the user's graphical session.
SERVER_PORT="8080"
ENV_FILE="/etc/sfts/sfts-scoreboard.env"
KIOSK_URL="http://127.0.0.1:${SERVER_PORT}/"
PROFILE_DIR="${HOME}/.config/sfts-scoreboard-kiosk"
LOCK_DIR="${XDG_RUNTIME_DIR:-${HOME}/.cache}/sfts-scoreboard-kiosk"
BACKGROUND_PID=""
AUDIO_VOLUME="0.95"

log() {
  printf '[sfts-kiosk] %s\n' "$*" >&2
}

if [[ -r "${ENV_FILE}" ]]; then
  configured_port="$(awk -F= '$1 == "PORT" {gsub(/[[:space:]\r"]/, "", $2); print $2; exit}' "${ENV_FILE}")"
  if [[ "${configured_port}" =~ ^[0-9]+$ ]] && (( configured_port >= 1 && configured_port <= 65535 )); then
    SERVER_PORT="${configured_port}"
    KIOSK_URL="http://127.0.0.1:${SERVER_PORT}/"
  fi
fi

if ! command -v flock >/dev/null 2>&1; then
  log "flock is required to prevent duplicate kiosk windows"
  exit 1
fi

mkdir -p "${LOCK_DIR}" "${PROFILE_DIR}"
exec 9>"${LOCK_DIR}/browser.lock"
flock -n 9 || exit 0

stop_desktop_chrome() {
  local current_user_id
  local desktop_process

  current_user_id="$(id -u)"
  if command -v pkill >/dev/null 2>&1; then
    for desktop_process in waybar wf-panel-pi lxpanel pcmanfm pcmanfm-qt; do
      pkill -u "${current_user_id}" -x "${desktop_process}" 2>/dev/null || true
    done
  fi
}

start_black_background() {
  if command -v swaybg >/dev/null 2>&1; then
    pkill -u "$(id -u)" -x swaybg 2>/dev/null || true
    swaybg -c '#000000' >/dev/null 2>&1 &
    BACKGROUND_PID="$!"
  fi
}

set_audio_volume() {
  local audio_sink
  local analog_sink

  if ! command -v wpctl >/dev/null 2>&1; then
    log "wpctl was not found; leaving the desktop audio volume unchanged"
    return 0
  fi
  analog_sink="$(wpctl status 2>/dev/null | awk '
    /Sinks:/ { in_sinks = 1; next }
    /Sources:/ { in_sinks = 0 }
    in_sinks && /Built-in Audio Stereo/ {
      gsub(/[*.]/, "", $1)
      if ($1 ~ /^[0-9]+$/) { print $1; exit }
    }
  ')"
  audio_sink="@DEFAULT_AUDIO_SINK@"
  if [[ "${analog_sink}" =~ ^[0-9]+$ ]]; then
    wpctl set-default "${analog_sink}" >/dev/null 2>&1 || true
    audio_sink="${analog_sink}"
  fi
  for attempt in {1..20}; do
    if wpctl set-volume "${audio_sink}" "${AUDIO_VOLUME}" >/dev/null 2>&1 &&
       wpctl set-mute "${audio_sink}" 0 >/dev/null 2>&1; then
      if [[ "${audio_sink}" == "@DEFAULT_AUDIO_SINK@" ]]; then
        log "Default audio output set to 95% and unmuted"
      else
        log "Analog audio output selected, set to 95%, and unmuted"
      fi
      return 0
    fi
    sleep 1
  done
  log "Could not set the default audio output to 95%; continuing kiosk startup"
}

cleanup() {
  if [[ -n "${BACKGROUND_PID}" ]]; then
    kill "${BACKGROUND_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
stop_desktop_chrome
start_black_background
set_audio_volume

BROWSER=""
for candidate in chromium chromium-browser; do
  if command -v "${candidate}" >/dev/null 2>&1; then
    BROWSER="$(command -v "${candidate}")"
    break
  fi
done

if [[ -z "${BROWSER}" ]]; then
  log "Chromium was not found; run deployment/install.sh again"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  log "curl was not found; run deployment/install.sh again"
  exit 1
fi

wait_for_server() {
  until curl --fail --silent --max-time 3 "${KIOSK_URL}" >/dev/null; do
    sleep 2
  done
}

readonly -a BROWSER_ARGS=(
  --kiosk
  --noerrdialogs
  --disable-infobars
  --no-first-run
  --disable-session-crashed-bubble
  --password-store=basic
  "--user-data-dir=${PROFILE_DIR}"
)

log "Waiting for ${KIOSK_URL}"
while true; do
  wait_for_server
  log "Launching scoreboard kiosk"
  "${BROWSER}" "${BROWSER_ARGS[@]}" "${KIOSK_URL}"
  log "Chromium exited; restarting kiosk in 2 seconds"
  sleep 2
done
