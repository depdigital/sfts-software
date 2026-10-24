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
SERVICE_TEMPLATE="${PROJECT_DIR}/deployment/systemd/sfts-scoreboard.service"
CHROMIUM_POLICY_TMP=""
SERVICE_TMP=""

cleanup() {
  if [[ -n "${CHROMIUM_POLICY_TMP:-}" ]]; then
    rm -f "${CHROMIUM_POLICY_TMP}"
  fi
  if [[ -n "${SERVICE_TMP:-}" ]]; then
    rm -f "${SERVICE_TMP}"
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
[[ -f "${SERVICE_TEMPLATE}" ]] || fail "scoreboard service template is missing"
[[ -x /usr/bin/node ]] || fail "Node.js was not found at /usr/bin/node"

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

DEPENDENCY_STAMP="${PROJECT_DIR}/node_modules/.sfts-production-lock.sha256"
DEPENDENCY_HASH="$(sha256sum "${PACKAGE_LOCK}" | awk '{print $1}')"
if grep -Fxq "${DEPENDENCY_HASH}" "${DEPENDENCY_STAMP}" 2>/dev/null && \
  runuser -u "${SERVICE_USER}" -- env PATH="/usr/bin:/bin" \
  "${NPM_BIN}" --prefix "${PROJECT_DIR}" ls --omit=dev --all >/dev/null 2>&1; then
  log "Production dependencies are current"
else
  log "Production dependencies changed; stopping ${SCOREBOARD_SERVICE} before installation"
  systemctl stop "${SCOREBOARD_SERVICE}"
  runuser -u "${SERVICE_USER}" -- env PATH="/usr/bin:/bin" npm_config_allow_remote=root \
    "${NPM_BIN}" --prefix "${PROJECT_DIR}" ci --omit=dev
  runuser -u "${SERVICE_USER}" -- env PATH="/usr/bin:/bin" \
    "${NPM_BIN}" --prefix "${PROJECT_DIR}" ls --omit=dev --all >/dev/null 2>&1 \
    || fail "production dependency verification failed"
  log "Production dependencies installed"
  runuser -u "${SERVICE_USER}" -- sh -c 'printf "%s\n" "$1" > "$2"' sh "${DEPENDENCY_HASH}" "${DEPENDENCY_STAMP}"
fi

log "Installing the current scoreboard service hardening"
SERVICE_GROUP="$(id -gn "${SERVICE_USER}")"
PROJECT_VALUE="$(printf '%s' "${PROJECT_DIR}" | sed 's/[&|\\]/\\&/g')"
USER_VALUE="$(printf '%s' "${SERVICE_USER}" | sed 's/[&|\\]/\\&/g')"
GROUP_VALUE="$(printf '%s' "${SERVICE_GROUP}" | sed 's/[&|\\]/\\&/g')"
SERVICE_TMP="$(mktemp /tmp/sfts-scoreboard.XXXXXX.service)"
sed -e "s|@PROJECT_DIR@|${PROJECT_VALUE}|g" \
  -e 's|@NODE_BIN@|/usr/bin/node|g' \
  -e "s|@SERVICE_USER@|${USER_VALUE}|g" \
  -e "s|@SERVICE_GROUP@|${GROUP_VALUE}|g" \
  "${SERVICE_TEMPLATE}" > "${SERVICE_TMP}"
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "${SERVICE_TMP}" >/dev/null || fail "scoreboard service validation failed"
fi
install -m 0644 -o root -g root "${SERVICE_TMP}" /etc/systemd/system/sfts-scoreboard.service
rm -f "${SERVICE_TMP}"
SERVICE_TMP=""

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
