#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCOREBOARD_SERVICE="sfts-scoreboard.service"
PIPER_SERVICE="sfts-piper.service"
DISPLAY_SERVICE="lightdm.service"
PIPER_URL="http://127.0.0.1:5000/info"
SCOREBOARD_URL="http://127.0.0.1:8080/"
WAIT_SECONDS=30

log() {
  printf '[sfts-restart] %s\n' "$*"
}

fail() {
  printf '[sfts-restart] FAIL: %s\n' "$*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "run this script with sudo"
command -v systemctl >/dev/null 2>&1 || fail "systemctl is not available"
command -v curl >/dev/null 2>&1 || fail "curl is not available"

systemctl cat "${PIPER_SERVICE}" >/dev/null 2>&1 || fail "${PIPER_SERVICE} is not installed"
systemctl cat "${SCOREBOARD_SERVICE}" >/dev/null 2>&1 || fail "${SCOREBOARD_SERVICE} is not installed"

log "Reloading systemd service definitions"
systemctl daemon-reload

log "Restarting ${PIPER_SERVICE}"
systemctl restart "${PIPER_SERVICE}"
log "Waiting for Piper"
piper_ready=false
for ((attempt = 1; attempt <= WAIT_SECONDS; attempt += 1)); do
  if curl --fail --silent --max-time 2 "${PIPER_URL}" >/dev/null; then
    piper_ready=true
    break
  fi
  sleep 1
done
if [[ "${piper_ready}" != true ]]; then
  systemctl status "${PIPER_SERVICE}" --no-pager >&2 || true
  journalctl -u "${PIPER_SERVICE}" -n 30 --no-pager >&2 || true
  fail "Piper did not respond on port 5000"
fi

log "Restarting ${SCOREBOARD_SERVICE}"
systemctl restart "${SCOREBOARD_SERVICE}"
log "Waiting for scoreboard"
scoreboard_ready=false
for ((attempt = 1; attempt <= WAIT_SECONDS; attempt += 1)); do
  if curl --fail --silent --max-time 2 "${SCOREBOARD_URL}" >/dev/null; then
    scoreboard_ready=true
    break
  fi
  sleep 1
done
if [[ "${scoreboard_ready}" != true ]]; then
  systemctl status "${SCOREBOARD_SERVICE}" --no-pager >&2 || true
  journalctl -u "${SCOREBOARD_SERVICE}" -n 30 --no-pager >&2 || true
  fail "scoreboard did not respond on port 8080"
fi

if systemctl cat "${DISPLAY_SERVICE}" >/dev/null 2>&1 && systemctl is-active --quiet "${DISPLAY_SERVICE}"; then
  log "Restarting ${DISPLAY_SERVICE} to relaunch the kiosk browser"
  systemctl restart "${DISPLAY_SERVICE}"
  log "Kiosk session relaunched; Chromium will reload the dashboard"
else
  log "${DISPLAY_SERVICE} is not active; application services were restarted"
fi

log "SFTS application stack restart completed"
