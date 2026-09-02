#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SERVICE_NAME="sfts-scoreboard"
SERVICE_DEST="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_DIR="/etc/sfts"
ENV_FILE="${ENV_DIR}/sfts-scoreboard.env"

log() {
  printf '[sfts-deploy] %s\n' "$*"
}

die() {
  printf '[sfts-deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ "${EUID}" -ne 0 ]]; then
  die "run this installer with sudo, for example: sudo bash deployment/install.sh"
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  die "this installer supports Raspberry Pi/Linux only"
fi

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SERVICE_TEMPLATE="${PROJECT_DIR}/deployment/systemd/${SERVICE_NAME}.service"
ENV_TEMPLATE="${PROJECT_DIR}/deployment/config/sfts-scoreboard.env.example"

[[ -f "${PROJECT_DIR}/package.json" ]] || die "package.json was not found at ${PROJECT_DIR}"
[[ -f "${PROJECT_DIR}/package-lock.json" ]] || die "package-lock.json was not found at ${PROJECT_DIR}"
[[ -f "${PROJECT_DIR}/src/server.js" ]] || die "src/server.js was not found at ${PROJECT_DIR}"
[[ -f "${PROJECT_DIR}/config/remote-config.json" ]] || die "config/remote-config.json is missing"
[[ -f "${SERVICE_TEMPLATE}" ]] || die "systemd service template is missing"
[[ -f "${ENV_TEMPLATE}" ]] || die "environment template is missing"

SERVICE_USER="${SFTS_SERVICE_USER:-${SUDO_USER:-}}"
if [[ -z "${SERVICE_USER}" || "${SERVICE_USER}" == "root" ]]; then
  SERVICE_USER="$(stat -c '%U' "${PROJECT_DIR}")"
fi
[[ -n "${SERVICE_USER}" && "${SERVICE_USER}" != "root" ]] || die "could not determine a non-root service user; use SFTS_SERVICE_USER=sfts"
id "${SERVICE_USER}" >/dev/null 2>&1 || die "service user does not exist: ${SERVICE_USER}"
SERVICE_GROUP="$(id -gn "${SERVICE_USER}")"

if [[ ! -x /usr/bin/node || ! -x /usr/bin/npm ]]; then
  command -v apt-get >/dev/null 2>&1 || die "APT is required to install Node.js"
  log "Node.js or npm is missing; installing nodejs and npm"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm
fi

[[ -x /usr/bin/node ]] || die "Node.js was not installed at /usr/bin/node"
command -v runuser >/dev/null 2>&1 || die "runuser is required to install dependencies as ${SERVICE_USER}"

NODE_MAJOR="$(/usr/bin/node -p 'process.versions.node.split(".")[0]')"
[[ "${NODE_MAJOR}" =~ ^[0-9]+$ && "${NODE_MAJOR}" -ge 18 ]] || die "Node.js 18 or newer is required; found $(/usr/bin/node --version)"

NPM_BIN="$(command -v npm || true)"
[[ -n "${NPM_BIN}" ]] || die "npm is not installed"

log "Using project directory: ${PROJECT_DIR}"
log "Using service user: ${SERVICE_USER}"
log "Installing production dependencies"
runuser -u "${SERVICE_USER}" -- env PATH="/usr/bin:/bin" "${NPM_BIN}" ci --omit=dev

install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${PROJECT_DIR}/data"
install -d -m 0750 -o root -g "${SERVICE_GROUP}" "${ENV_DIR}"

if [[ ! -e "${ENV_FILE}" ]]; then
  install -m 0640 -o root -g "${SERVICE_GROUP}" "${ENV_TEMPLATE}" "${ENV_FILE}"
  log "Created ${ENV_FILE}"
else
  log "Preserving existing ${ENV_FILE}"
fi

escape_sed_value() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

PROJECT_VALUE="$(escape_sed_value "${PROJECT_DIR}")"
USER_VALUE="$(escape_sed_value "${SERVICE_USER}")"
GROUP_VALUE="$(escape_sed_value "${SERVICE_GROUP}")"
SERVICE_TMP="$(mktemp)"
trap 'rm -f "${SERVICE_TMP}"' EXIT

sed \
  -e "s|@PROJECT_DIR@|${PROJECT_VALUE}|g" \
  -e "s|@NODE_BIN@|/usr/bin/node|g" \
  -e "s|@SERVICE_USER@|${USER_VALUE}|g" \
  -e "s|@SERVICE_GROUP@|${GROUP_VALUE}|g" \
  "${SERVICE_TEMPLATE}" > "${SERVICE_TMP}"

install -m 0644 -o root -g root "${SERVICE_TMP}" "${SERVICE_DEST}"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
systemctl restart "${SERVICE_NAME}.service"

if ! systemctl is-active --quiet "${SERVICE_NAME}.service"; then
  journalctl -u "${SERVICE_NAME}.service" -n 40 --no-pager >&2 || true
  die "${SERVICE_NAME}.service did not start"
fi

if command -v curl >/dev/null 2>&1; then
  curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8080/ >/dev/null \
    || die "service is active but the dashboard did not respond on port 8080"
fi

log "${SERVICE_NAME}.service is enabled and running"
log "Open the local kiosk dashboard at http://localhost:8080"
log "View logs with: journalctl -u ${SERVICE_NAME}.service -f"
