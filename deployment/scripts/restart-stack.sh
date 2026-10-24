#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCOREBOARD_SERVICE="sfts-scoreboard.service"
PIPER_SERVICE="sfts-piper.service"
DISPLAY_SERVICE="lightdm.service"
PIPER_URL="http://127.0.0.1:5000/info"
WAIT_SECONDS=30
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
KIOSK_RC_SOURCE="${PROJECT_DIR}/deployment/config/labwc-kiosk-rc.xml"
KIOSK_RC_DEST="/etc/sfts/sfts-scoreboard-kiosk/labwc/rc.xml"
KIOSK_SCRIPT="${PROJECT_DIR}/deployment/scripts/start-kiosk.sh"
KIOSK_AUTOSTART_DEST="/etc/sfts/sfts-scoreboard-kiosk/labwc/autostart"
CHROMIUM_POLICY_SOURCE="${PROJECT_DIR}/deployment/config/chromium-kiosk-policy.json"
ENV_FILE="/etc/sfts/sfts-scoreboard.env"
PACKAGE_JSON="${PROJECT_DIR}/package.json"
PACKAGE_LOCK="${PROJECT_DIR}/package-lock.json"
CHROMIUM_POLICY_TMP=""

cleanup() {
  if [[ -n "${CHROMIUM_POLICY_TMP:-}" ]]; then
    rm -f "${CHROMIUM_POLICY_TMP}"
  fi
}

trap cleanup EXIT

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
command -v runuser >/dev/null 2>&1 || fail "runuser is not available"
command -v flock >/dev/null 2>&1 || fail "flock is not available"
[[ -f "${KIOSK_RC_SOURCE}" ]] || fail "kiosk Labwc configuration is missing"
[[ -f "${KIOSK_SCRIPT}" ]] || fail "kiosk launcher is missing"
[[ -f "${CHROMIUM_POLICY_SOURCE}" ]] || fail "Chromium kiosk policy template is missing"
[[ -f "${PACKAGE_JSON}" ]] || fail "package.json is missing"
[[ -f "${PACKAGE_LOCK}" ]] || fail "package-lock.json is missing"

SERVER_PORT="8080"
if [[ -r "${ENV_FILE}" ]]; then
  configured_port="$(awk -F= '$1 == "PORT" {gsub(/[[:space:]\r"]/, "", $2); print $2; exit}' "${ENV_FILE}")"
  if [[ "${configured_port}" =~ ^[0-9]+$ ]] && (( configured_port >= 1 && configured_port <= 65535 )); then
    SERVER_PORT="${configured_port}"
  fi
fi
SCOREBOARD_URL="http://127.0.0.1:${SERVER_PORT}/"

systemctl cat "${PIPER_SERVICE}" >/dev/null 2>&1 || fail "${PIPER_SERVICE} is not installed"
systemctl cat "${SCOREBOARD_SERVICE}" >/dev/null 2>&1 || fail "${SCOREBOARD_SERVICE} is not installed"

SERVICE_USER="$(systemctl show -p User --value "${SCOREBOARD_SERVICE}")"
[[ -n "${SERVICE_USER}" && "${SERVICE_USER}" != "root" ]] || fail "could not determine the non-root scoreboard service user"
id "${SERVICE_USER}" >/dev/null 2>&1 || fail "scoreboard service user does not exist: ${SERVICE_USER}"
NPM_BIN="$(command -v npm || true)"
[[ -n "${NPM_BIN}" ]] || fail "npm is not installed"

install -d -m 0755 /run/lock
exec 8>/run/lock/sfts-scoreboard-install.lock
flock -n 8 || fail "another SFTS install or restart is already running"

if runuser -u "${SERVICE_USER}" -- env PATH="/usr/bin:/bin" \
  "${NPM_BIN}" --prefix "${PROJECT_DIR}" ls --omit=dev --all >/dev/null 2>&1; then
  log "Production dependencies are current"
else
  log "Production dependencies changed; stopping ${SCOREBOARD_SERVICE} before installation"
  systemctl stop "${SCOREBOARD_SERVICE}"
  runuser -u "${SERVICE_USER}" -- env PATH="/usr/bin:/bin" \
    "${NPM_BIN}" --prefix "${PROJECT_DIR}" ci --omit=dev
  runuser -u "${SERVICE_USER}" -- env PATH="/usr/bin:/bin" \
    "${NPM_BIN}" --prefix "${PROJECT_DIR}" ls --omit=dev --all >/dev/null 2>&1 \
    || fail "production dependency verification failed"
  log "Production dependencies installed"
fi

log "Reloading systemd service definitions"
systemctl daemon-reload

log "Installing kiosk Labwc restrictions"
install -d -m 0755 -o root -g root "$(dirname -- "${KIOSK_RC_DEST}")"
install -m 0644 -o root -g root "${KIOSK_RC_SOURCE}" "${KIOSK_RC_DEST}"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  "while true; do \"${KIOSK_SCRIPT}\"; sleep 2; done &" \
  > "${KIOSK_AUTOSTART_DEST}"
chown root:root "${KIOSK_AUTOSTART_DEST}"
chmod 0644 "${KIOSK_AUTOSTART_DEST}"
chmod 0755 "${KIOSK_SCRIPT}"

log "Installing Chromium kiosk policies"
CHROMIUM_POLICY_TMP="$(mktemp)"
sed "s|@PORT@|${SERVER_PORT}|g" "${CHROMIUM_POLICY_SOURCE}" > "${CHROMIUM_POLICY_TMP}"
for chromium_policy_dir in /etc/chromium/policies/managed /etc/chromium-browser/policies/managed; do
  install -d -m 0755 -o root -g root "${chromium_policy_dir}"
  install -m 0644 -o root -g root "${CHROMIUM_POLICY_TMP}" "${chromium_policy_dir}/sfts-scoreboard-kiosk.json"
done
rm -f "${CHROMIUM_POLICY_TMP}"
CHROMIUM_POLICY_TMP=""

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
