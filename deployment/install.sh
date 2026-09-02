#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SERVICE_NAME="sfts-scoreboard"
SERVICE_DEST="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_DIR="/etc/sfts"
ENV_FILE="${ENV_DIR}/sfts-scoreboard.env"
SERVICE_TMP=""
REBOOT_DELAY_SECONDS="${SFTS_REBOOT_DELAY_SECONDS:-10}"
SKIP_REBOOT="${SFTS_SKIP_REBOOT:-false}"

TOTAL_STEPS=8
CURRENT_STEP=0

log() {
  printf '[sfts-deploy] %s\n' "$*"
}

step() {
  CURRENT_STEP=$((CURRENT_STEP + 1))
  printf '\n[sfts-deploy] [%d/%d] %s\n' "${CURRENT_STEP}" "${TOTAL_STEPS}" "$*"
}

success() {
  printf '[sfts-deploy] OK: %s\n' "$*"
}

die() {
  printf '[sfts-deploy] ERROR: %s\n' "$*" >&2
  printf '[sfts-deploy] Installation stopped. No reboot was scheduled.\n' >&2
  exit 1
}

cleanup() {
  if [[ -n "${SERVICE_TMP:-}" ]]; then
    rm -f "${SERVICE_TMP}"
  fi
}

trap cleanup EXIT

printf '\n'
printf '%s\n' '============================================================'
printf '%s\n' ' SFTS Taekwondo Scoring System - Raspberry Pi Installer'
printf '%s\n' '============================================================'
log "Starting installation. Existing match data and environment settings will be preserved."

[[ "${REBOOT_DELAY_SECONDS}" =~ ^[0-9]+$ ]] || die "SFTS_REBOOT_DELAY_SECONDS must be a non-negative integer"
case "${SKIP_REBOOT}" in
  true|false) ;;
  *) die "SFTS_SKIP_REBOOT must be true or false" ;;
esac

if [[ "${EUID}" -ne 0 ]]; then
  die "run this installer with sudo, for example: sudo bash deployment/install.sh"
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  die "this installer supports Raspberry Pi/Linux only"
fi

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SERVICE_TEMPLATE="${PROJECT_DIR}/deployment/systemd/${SERVICE_NAME}.service"
ENV_TEMPLATE="${PROJECT_DIR}/deployment/config/sfts-scoreboard.env.example"
KIOSK_SCRIPT="${PROJECT_DIR}/deployment/scripts/start-kiosk.sh"

[[ -f "${PROJECT_DIR}/package.json" ]] || die "package.json was not found at ${PROJECT_DIR}"
[[ -f "${PROJECT_DIR}/package-lock.json" ]] || die "package-lock.json was not found at ${PROJECT_DIR}"
[[ -f "${PROJECT_DIR}/src/server.js" ]] || die "src/server.js was not found at ${PROJECT_DIR}"
[[ -f "${PROJECT_DIR}/config/remote-config.json" ]] || die "config/remote-config.json is missing"
[[ -f "${SERVICE_TEMPLATE}" ]] || die "systemd service template is missing"
[[ -f "${ENV_TEMPLATE}" ]] || die "environment template is missing"
[[ -f "${KIOSK_SCRIPT}" ]] || die "kiosk launcher is missing"
success "Installer prerequisites found"

step "Selecting the service account"
SERVICE_USER="${SFTS_SERVICE_USER:-${SUDO_USER:-}}"
if [[ -z "${SERVICE_USER}" || "${SERVICE_USER}" == "root" ]]; then
  SERVICE_USER="$(stat -c '%U' "${PROJECT_DIR}")"
fi
[[ -n "${SERVICE_USER}" && "${SERVICE_USER}" != "root" ]] || die "could not determine a non-root service user; use SFTS_SERVICE_USER=sfts"
id "${SERVICE_USER}" >/dev/null 2>&1 || die "service user does not exist: ${SERVICE_USER}"
SERVICE_GROUP="$(id -gn "${SERVICE_USER}")"
success "Service will run as ${SERVICE_USER}:${SERVICE_GROUP}"

step "Checking required system packages"
APT_PACKAGES=()
if [[ ! -x /usr/bin/node || ! -x /usr/bin/npm ]]; then
  APT_PACKAGES+=(nodejs npm)
fi
command -v curl >/dev/null 2>&1 || APT_PACKAGES+=(curl)
command -v flock >/dev/null 2>&1 || APT_PACKAGES+=(util-linux)
if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
  APT_PACKAGES+=(chromium)
fi

if (( ${#APT_PACKAGES[@]} > 0 )); then
  command -v apt-get >/dev/null 2>&1 || die "APT is required to install: ${APT_PACKAGES[*]}"
  log "Installing missing system packages: ${APT_PACKAGES[*]}"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${APT_PACKAGES[@]}"
  success "System packages installed"
else
  success "Required system packages are already installed"
fi

[[ -x /usr/bin/node ]] || die "Node.js was not installed at /usr/bin/node"
command -v runuser >/dev/null 2>&1 || die "runuser is required to install dependencies as ${SERVICE_USER}"

NODE_MAJOR="$(/usr/bin/node -p 'process.versions.node.split(".")[0]')"
[[ "${NODE_MAJOR}" =~ ^[0-9]+$ && "${NODE_MAJOR}" -ge 18 ]] || die "Node.js 18 or newer is required; found $(/usr/bin/node --version)"

NPM_BIN="$(command -v npm || true)"
[[ -n "${NPM_BIN}" ]] || die "npm is not installed"
success "Node.js $(/usr/bin/node --version) and npm are ready"

step "Installing production dependencies"
log "Using project directory: ${PROJECT_DIR}"
log "Using service user: ${SERVICE_USER}"
runuser -u "${SERVICE_USER}" -- env PATH="/usr/bin:/bin" "${NPM_BIN}" ci --omit=dev
success "Production dependencies installed"

step "Preparing application data and environment"
install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${PROJECT_DIR}/data"
install -d -m 0750 -o root -g "${SERVICE_GROUP}" "${ENV_DIR}"

if [[ ! -e "${ENV_FILE}" ]]; then
  install -m 0640 -o root -g "${SERVICE_GROUP}" "${ENV_TEMPLATE}" "${ENV_FILE}"
  log "Created ${ENV_FILE}"
else
  log "Preserving existing ${ENV_FILE}"
fi
success "Application data and environment are ready"

step "Installing and starting the system service"
escape_sed_value() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

PROJECT_VALUE="$(escape_sed_value "${PROJECT_DIR}")"
USER_VALUE="$(escape_sed_value "${SERVICE_USER}")"
GROUP_VALUE="$(escape_sed_value "${SERVICE_GROUP}")"
SERVICE_TMP="$(mktemp)"

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
success "Systemd service installed and restarted"

configure_desktop_kiosk() {
  local service_user_home
  local display_manager_target
  local lightdm_config
  local lightdm_tmp
  local labwc_dir
  local labwc_autostart
  local xdg_autostart_dir
  local xdg_desktop_entry
  local kiosk_line

  service_user_home="$(getent passwd "${SERVICE_USER}" | cut -d: -f6)"
  [[ -n "${service_user_home}" && -d "${service_user_home}" ]] || die "could not determine ${SERVICE_USER}'s home directory"
  [[ -d /usr/share/wayland-sessions || -d /usr/share/xsessions ]] || die "a graphical desktop is not installed; install Raspberry Pi OS Desktop"

  display_manager_target="$(readlink -f /etc/systemd/system/display-manager.service 2>/dev/null || true)"
  if [[ "${display_manager_target}" != *lightdm* && ! -e /etc/init.d/lightdm ]]; then
    die "LightDM was not detected; the kiosk installer supports Raspberry Pi OS Desktop with LightDM"
  fi

  lightdm_config="/etc/lightdm/lightdm.conf.d/50-sfts-scoreboard-kiosk.conf"
  lightdm_tmp="$(mktemp)"
  printf '%s\n' '[Seat:*]' "autologin-user=${SERVICE_USER}" 'autologin-user-timeout=0' > "${lightdm_tmp}"
  install -d -m 0755 -o root -g root /etc/lightdm/lightdm.conf.d
  install -m 0644 -o root -g root "${lightdm_tmp}" "${lightdm_config}"
  rm -f "${lightdm_tmp}"

  systemctl set-default graphical.target
  if systemctl list-unit-files --no-legend display-manager.service 2>/dev/null | grep -q 'display-manager.service'; then
    systemctl enable display-manager.service
  else
    systemctl enable lightdm.service
  fi

  chmod 0755 "${KIOSK_SCRIPT}"
  labwc_dir="${service_user_home}/.config/labwc"
  labwc_autostart="${labwc_dir}/autostart"
  kiosk_line="\"${KIOSK_SCRIPT}\" &"
  install -d -m 0700 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${labwc_dir}"
  touch "${labwc_autostart}"
  if ! grep -Fqx -- "${kiosk_line}" "${labwc_autostart}"; then
    {
      printf '\n# SFTS scoreboard kiosk (managed by deployment/install.sh)\n'
      printf '%s\n' "${kiosk_line}"
    } >> "${labwc_autostart}"
  fi
  chown "${SERVICE_USER}:${SERVICE_GROUP}" "${labwc_autostart}"
  chmod 0600 "${labwc_autostart}"

  # This covers older Raspberry Pi OS images using an X11 desktop. On labwc,
  # the lock in start-kiosk.sh prevents a duplicate if both mechanisms run.
  xdg_autostart_dir="${service_user_home}/.config/autostart"
  xdg_desktop_entry="${xdg_autostart_dir}/sfts-scoreboard-kiosk.desktop"
  install -d -m 0700 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${xdg_autostart_dir}"
  printf '%s\n' \
    '[Desktop Entry]' \
    'Type=Application' \
    'Name=SFTS Scoreboard Kiosk' \
    "Exec=\"${KIOSK_SCRIPT}\"" \
    'Terminal=false' \
    'X-GNOME-Autostart-enabled=true' \
    > "${xdg_desktop_entry}"
  chown "${SERVICE_USER}:${SERVICE_GROUP}" "${xdg_desktop_entry}"
  chmod 0600 "${xdg_desktop_entry}"

  log "Configured desktop auto-login and kiosk autostart for ${SERVICE_USER}"
}

step "Verifying the application health"
if ! systemctl is-active --quiet "${SERVICE_NAME}.service"; then
  journalctl -u "${SERVICE_NAME}.service" -n 40 --no-pager >&2 || true
  die "${SERVICE_NAME}.service did not start"
fi

if command -v curl >/dev/null 2>&1; then
  dashboard_ready=false
  for attempt in {1..15}; do
    if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8080/ >/dev/null; then
      dashboard_ready=true
      break
    fi
    sleep 1
  done
  [[ "${dashboard_ready}" == true ]] || die "service is active but the dashboard did not respond on port 8080"
fi
success "Dashboard is responding on http://127.0.0.1:8080"

step "Configuring desktop auto-login and kiosk startup"
configure_desktop_kiosk
success "Desktop kiosk startup is configured"

step "Installation complete"
log "Service: ${SERVICE_NAME}.service (enabled and running)"
log "Dashboard: http://localhost:8080"
log "Boot behavior: desktop auto-login and Chromium kiosk"
log "Logs: journalctl -u ${SERVICE_NAME}.service -f"

if [[ "${SKIP_REBOOT}" == true ]]; then
  log "Automatic reboot skipped because SFTS_SKIP_REBOOT=true"
  log "Run 'sudo reboot' when you are ready to test kiosk startup."
  exit 0
fi

log "The Pi will reboot in ${REBOOT_DELAY_SECONDS} seconds. Save any other work now."
for ((remaining = REBOOT_DELAY_SECONDS; remaining > 0; remaining--)); do
  printf '\r[sfts-deploy] Rebooting in %2d seconds...' "${remaining}"
  sleep 1
done
printf '\n'
log "Rebooting now without prompting for a password"
sudo -n /sbin/reboot || die "automatic reboot failed; run 'sudo reboot' manually"
