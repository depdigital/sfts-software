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
  until curl --fail --silent --show-error --max-time 3 "${KIOSK_URL}" >/dev/null; do
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
