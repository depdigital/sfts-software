#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SERVICE_NAME="sfts-scoreboard"
SERVICE_DEST="/etc/systemd/system/${SERVICE_NAME}.service"
PIPER_SERVICE_NAME="sfts-piper"
PIPER_SERVICE_DEST="/etc/systemd/system/${PIPER_SERVICE_NAME}.service"
ENV_DIR="/etc/sfts"
ENV_FILE="${ENV_DIR}/sfts-scoreboard.env"
SERVICE_TMP=""
PIPER_SERVICE_TMP=""
LIGHTDM_MAIN_TMP=""
ENV_TMP=""
REBOOT_DELAY_SECONDS="${SFTS_REBOOT_DELAY_SECONDS:-10}"
SKIP_REBOOT="${SFTS_SKIP_REBOOT:-false}"
PIPER_MODEL_NAME="${SFTS_PIPER_MODEL:-en_GB-alan-medium}"
PIPER_LENGTH_SCALE="${SFTS_PIPER_LENGTH_SCALE:-1.20}"
PIPER_SENTENCE_SILENCE="${SFTS_PIPER_SENTENCE_SILENCE:-0.15}"

TOTAL_STEPS=11
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
  if [[ -n "${PIPER_SERVICE_TMP:-}" ]]; then
    rm -f "${PIPER_SERVICE_TMP}"
  fi
  if [[ -n "${LIGHTDM_MAIN_TMP:-}" ]]; then
    rm -f "${LIGHTDM_MAIN_TMP}"
  fi
  if [[ -n "${ENV_TMP:-}" ]]; then
    rm -f "${ENV_TMP}"
  fi
}

escape_sed_value() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
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
[[ "${PIPER_LENGTH_SCALE}" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "SFTS_PIPER_LENGTH_SCALE must be a positive number"
[[ "${PIPER_SENTENCE_SILENCE}" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "SFTS_PIPER_SENTENCE_SILENCE must be zero or a positive number"
awk -v value="${PIPER_LENGTH_SCALE}" 'BEGIN { exit !(value > 0) }' || die "SFTS_PIPER_LENGTH_SCALE must be greater than zero"

if [[ "${EUID}" -ne 0 ]]; then
  die "run this installer with sudo, for example: sudo bash deployment/install.sh"
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  die "this installer supports Raspberry Pi/Linux only"
fi

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SERVICE_TEMPLATE="${PROJECT_DIR}/deployment/systemd/${SERVICE_NAME}.service"
PIPER_SERVICE_TEMPLATE="${PROJECT_DIR}/deployment/systemd/${PIPER_SERVICE_NAME}.service"
ENV_TEMPLATE="${PROJECT_DIR}/deployment/config/sfts-scoreboard.env.example"
KIOSK_SCRIPT="${PROJECT_DIR}/deployment/scripts/start-kiosk.sh"
POLKIT_TEMPLATE="${PROJECT_DIR}/deployment/polkit/sfts-scoreboard-power.rules"
POLKIT_DEST="/etc/polkit-1/rules.d/49-sfts-scoreboard-power.rules"

[[ -f "${PROJECT_DIR}/package.json" ]] || die "package.json was not found at ${PROJECT_DIR}"
[[ -f "${PROJECT_DIR}/package-lock.json" ]] || die "package-lock.json was not found at ${PROJECT_DIR}"
[[ -f "${PROJECT_DIR}/src/server.js" ]] || die "src/server.js was not found at ${PROJECT_DIR}"
[[ -f "${PROJECT_DIR}/config/remote-config.json" ]] || die "config/remote-config.json is missing"
[[ -f "${SERVICE_TEMPLATE}" ]] || die "systemd service template is missing"
[[ -f "${PIPER_SERVICE_TEMPLATE}" ]] || die "Piper systemd service template is missing"
[[ -f "${ENV_TEMPLATE}" ]] || die "environment template is missing"
[[ -f "${KIOSK_SCRIPT}" ]] || die "kiosk launcher is missing"
[[ -f "${POLKIT_TEMPLATE}" ]] || die "polkit power-permission template is missing"
success "Installer prerequisites found"

step "Selecting the service account"
SERVICE_USER="${SFTS_SERVICE_USER:-${SUDO_USER:-}}"
if [[ -z "${SERVICE_USER}" || "${SERVICE_USER}" == "root" ]]; then
  SERVICE_USER="$(stat -c '%U' "${PROJECT_DIR}")"
fi
[[ -n "${SERVICE_USER}" && "${SERVICE_USER}" != "root" ]] || die "could not determine a non-root service user; use SFTS_SERVICE_USER=sfts"
id "${SERVICE_USER}" >/dev/null 2>&1 || die "service user does not exist: ${SERVICE_USER}"
SERVICE_GROUP="$(id -gn "${SERVICE_USER}")"
SERVICE_USER_HOME="$(getent passwd "${SERVICE_USER}" | cut -d: -f6)"
[[ -n "${SERVICE_USER_HOME}" && -d "${SERVICE_USER_HOME}" ]] || die "could not determine ${SERVICE_USER}'s home directory"
PIPER_ROOT="${SFTS_PIPER_ROOT:-${SERVICE_USER_HOME}/sfts-tts}"
PIPER_VENV="${PIPER_ROOT}/venv"
PIPER_PYTHON="${PIPER_VENV}/bin/python"
PIPER_VOICES="${PIPER_ROOT}/voices"
PIPER_MODEL="${PIPER_VOICES}/${PIPER_MODEL_NAME}.onnx"
[[ "${PIPER_MODEL_NAME}" =~ ^[A-Za-z0-9_-]+$ ]] || die "SFTS_PIPER_MODEL contains unsupported characters"
success "Service will run as ${SERVICE_USER}:${SERVICE_GROUP}"

step "Checking required system packages"
APT_PACKAGES=()
if [[ ! -x /usr/bin/node || ! -x /usr/bin/npm ]]; then
  APT_PACKAGES+=(nodejs npm)
fi
command -v python3 >/dev/null 2>&1 || APT_PACKAGES+=(python3)
if ! python3 -m venv --help >/dev/null 2>&1; then
  APT_PACKAGES+=(python3-venv)
fi
command -v pip3 >/dev/null 2>&1 || APT_PACKAGES+=(python3-pip)
command -v curl >/dev/null 2>&1 || APT_PACKAGES+=(curl)
command -v flock >/dev/null 2>&1 || APT_PACKAGES+=(util-linux)
command -v wpctl >/dev/null 2>&1 || APT_PACKAGES+=(pipewire-bin)
command -v swaybg >/dev/null 2>&1 || APT_PACKAGES+=(swaybg)
command -v pkcheck >/dev/null 2>&1 || APT_PACKAGES+=(polkitd)
command -v udisksctl >/dev/null 2>&1 || APT_PACKAGES+=(udisks2)
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
command -v flock >/dev/null 2>&1 || die "flock is required to prevent concurrent installations"
INSTALL_LOCK_FILE="/run/lock/sfts-scoreboard-install.lock"
install -d -m 0755 /run/lock
exec 8>"${INSTALL_LOCK_FILE}"
flock -n 8 || die "another SFTS installer is already running"
log "Installer lock acquired"

NODE_MAJOR="$(/usr/bin/node -p 'process.versions.node.split(".")[0]')"
[[ "${NODE_MAJOR}" =~ ^[0-9]+$ && "${NODE_MAJOR}" -ge 18 ]] || die "Node.js 18 or newer is required; found $(/usr/bin/node --version)"

NPM_BIN="$(command -v npm || true)"
[[ -n "${NPM_BIN}" ]] || die "npm is not installed"
success "Node.js $(/usr/bin/node --version) and npm are ready"

configure_piper() {
  local piper_root_value
  local piper_venv_value
  local piper_python_value
  local piper_voices_value
  local piper_model_value
  local piper_length_scale_value
  local piper_sentence_silence_value
  local service_user_value
  local service_group_value
  local piper_ready

  log "Preparing Piper environment at ${PIPER_ROOT}"
  install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${PIPER_ROOT}" "${PIPER_VOICES}"

  if [[ ! -x "${PIPER_PYTHON}" ]]; then
    log "Creating the Piper Python virtual environment"
    runuser -u "${SERVICE_USER}" -- python3 -m venv "${PIPER_VENV}"
  fi
  [[ -x "${PIPER_PYTHON}" ]] || die "Piper Python virtual environment was not created"

  if runuser -u "${SERVICE_USER}" -- "${PIPER_PYTHON}" -c 'import piper, flask' >/dev/null 2>&1; then
    log "Piper HTTP support is already installed"
  else
    log "Installing Piper HTTP support"
    runuser -u "${SERVICE_USER}" -- "${PIPER_PYTHON}" -m pip install \
      --disable-pip-version-check "piper-tts[http]"
  fi

  if [[ ! -f "${PIPER_MODEL}" || ! -f "${PIPER_MODEL}.json" ]]; then
    log "Downloading Piper voice model ${PIPER_MODEL_NAME}"
    runuser -u "${SERVICE_USER}" -- "${PIPER_PYTHON}" -m piper.download_voices \
      "${PIPER_MODEL_NAME}" --data-dir "${PIPER_VOICES}"
  else
    log "Piper voice model ${PIPER_MODEL_NAME} is already present"
  fi
  [[ -s "${PIPER_MODEL}" && -s "${PIPER_MODEL}.json" ]] || die "Piper voice model files are missing"

  piper_root_value="$(escape_sed_value "${PIPER_ROOT}")"
  piper_venv_value="$(escape_sed_value "${PIPER_VENV}")"
  piper_python_value="$(escape_sed_value "${PIPER_PYTHON}")"
  piper_voices_value="$(escape_sed_value "${PIPER_VOICES}")"
  piper_model_value="$(escape_sed_value "${PIPER_MODEL}")"
  piper_length_scale_value="$(escape_sed_value "${PIPER_LENGTH_SCALE}")"
  piper_sentence_silence_value="$(escape_sed_value "${PIPER_SENTENCE_SILENCE}")"
  service_user_value="$(escape_sed_value "${SERVICE_USER}")"
  service_group_value="$(escape_sed_value "${SERVICE_GROUP}")"
  PIPER_SERVICE_TMP="$(mktemp "/tmp/${PIPER_SERVICE_NAME}.XXXXXX.service")"
  sed \
    -e "s|@SERVICE_USER@|${service_user_value}|g" \
    -e "s|@SERVICE_GROUP@|${service_group_value}|g" \
    -e "s|@PIPER_ROOT@|${piper_root_value}|g" \
    -e "s|@PIPER_VENV@|${piper_venv_value}|g" \
    -e "s|@PIPER_PYTHON@|${piper_python_value}|g" \
    -e "s|@PIPER_VOICES@|${piper_voices_value}|g" \
    -e "s|@PIPER_MODEL@|${piper_model_value}|g" \
    -e "s|@PIPER_LENGTH_SCALE@|${piper_length_scale_value}|g" \
    -e "s|@PIPER_SENTENCE_SILENCE@|${piper_sentence_silence_value}|g" \
    "${PIPER_SERVICE_TEMPLATE}" > "${PIPER_SERVICE_TMP}"
  if command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze verify "${PIPER_SERVICE_TMP}" >/dev/null || die "generated Piper systemd unit failed validation"
  fi
  install -m 0644 -o root -g root "${PIPER_SERVICE_TMP}" "${PIPER_SERVICE_DEST}"
  rm -f "${PIPER_SERVICE_TMP}"
  PIPER_SERVICE_TMP=""

  systemctl daemon-reload
  systemctl enable "${PIPER_SERVICE_NAME}.service"
  systemctl restart "${PIPER_SERVICE_NAME}.service"
  log "Waiting for Piper to load the voice model"
  piper_ready=false
  for attempt in {1..60}; do
    if curl --fail --silent --max-time 3 http://127.0.0.1:5000/info >/dev/null; then
      piper_ready=true
      break
    fi
    sleep 1
  done
  if [[ "${piper_ready}" != true ]]; then
    journalctl -u "${PIPER_SERVICE_NAME}.service" -n 40 --no-pager >&2 || true
    die "Piper HTTP service did not respond on port 5000"
  fi
}

step "Installing production dependencies"
log "Using project directory: ${PROJECT_DIR}"
log "Using service user: ${SERVICE_USER}"
runuser -u "${SERVICE_USER}" -- env PATH="/usr/bin:/bin" "${NPM_BIN}" ci --omit=dev
success "Production dependencies installed"

step "Installing local Piper speech service"
configure_piper
success "Local Piper speech service is installed and responding"

step "Preparing application data and environment"
install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${PROJECT_DIR}/data"
install -d -m 0750 -o root -g "${SERVICE_GROUP}" "${ENV_DIR}"

if [[ ! -e "${ENV_FILE}" ]]; then
  install -m 0640 -o root -g "${SERVICE_GROUP}" "${ENV_TEMPLATE}" "${ENV_FILE}"
  log "Created ${ENV_FILE}"
else
  log "Preserving existing ${ENV_FILE}"
fi
ENV_TMP="$(mktemp "${ENV_DIR}/.sfts-scoreboard.env.XXXXXX")"
sed -E '/^SFTS_TTS_(COMMAND|MODEL|CACHE_DIR)=/d' "${ENV_FILE}" > "${ENV_TMP}"
if grep -Eq '^SFTS_TTS_ENGINE=' "${ENV_TMP}"; then
  sed -i -E 's|^SFTS_TTS_ENGINE=.*$|SFTS_TTS_ENGINE=piper|' "${ENV_TMP}"
else
  printf '%s\n' 'SFTS_TTS_ENGINE=piper' >> "${ENV_TMP}"
fi
if grep -Eq '^SFTS_TTS_URL=' "${ENV_TMP}"; then
  sed -i -E 's|^SFTS_TTS_URL=.*$|SFTS_TTS_URL=http://127.0.0.1:5000/synthesize|' "${ENV_TMP}"
else
  printf '%s\n' 'SFTS_TTS_URL=http://127.0.0.1:5000/synthesize' >> "${ENV_TMP}"
fi
if grep -Eq '^SFTS_USB_IMPORT_ONLY=' "${ENV_TMP}"; then
  sed -i -E 's|^SFTS_USB_IMPORT_ONLY=.*$|SFTS_USB_IMPORT_ONLY=true|' "${ENV_TMP}"
else
  printf '%s\n' 'SFTS_USB_IMPORT_ONLY=true' >> "${ENV_TMP}"
fi
chown root:"${SERVICE_GROUP}" "${ENV_TMP}"
chmod 0640 "${ENV_TMP}"
mv -f -- "${ENV_TMP}" "${ENV_FILE}"
ENV_TMP=""
log "Configured announcements to use the local Piper HTTP service"
log "Configured deployment imports and player templates to use the USB drive"
success "Application data and environment are ready"

step "Installing and starting the system service"
PROJECT_VALUE="$(escape_sed_value "${PROJECT_DIR}")"
USER_VALUE="$(escape_sed_value "${SERVICE_USER}")"
GROUP_VALUE="$(escape_sed_value "${SERVICE_GROUP}")"
SERVICE_TMP="$(mktemp "/tmp/${SERVICE_NAME}.XXXXXX.service")"

sed \
  -e "s|@PROJECT_DIR@|${PROJECT_VALUE}|g" \
  -e "s|@NODE_BIN@|/usr/bin/node|g" \
  -e "s|@SERVICE_USER@|${USER_VALUE}|g" \
  -e "s|@SERVICE_GROUP@|${GROUP_VALUE}|g" \
  "${SERVICE_TEMPLATE}" > "${SERVICE_TMP}"
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "${SERVICE_TMP}" >/dev/null || die "generated scoreboard systemd unit failed validation"
fi

install -m 0644 -o root -g root "${SERVICE_TMP}" "${SERVICE_DEST}"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
systemctl restart "${SERVICE_NAME}.service"
success "Systemd service installed and restarted"

configure_desktop_kiosk() {
  local service_user_home
  local display_manager_target
  local display_manager_service
  local labwc_bin
  local lightdm_main_config
  local lightdm_main_backup
  local lightdm_config
  local lightdm_tmp
  local lightdm_show_config
  local kiosk_config_root
  local kiosk_labwc_dir
  local kiosk_autostart
  local kiosk_environment
  local kiosk_session_dir
  local kiosk_session
  local kiosk_session_tmp

  service_user_home="$(getent passwd "${SERVICE_USER}" | cut -d: -f6)"
  [[ -n "${service_user_home}" && -d "${service_user_home}" ]] || die "could not determine ${SERVICE_USER}'s home directory"
  [[ -d /usr/share/wayland-sessions ]] || die "a Wayland desktop is not installed; install Raspberry Pi OS Desktop with labwc"

  labwc_bin="$(command -v labwc-pi || command -v labwc || true)"
  [[ -n "${labwc_bin}" ]] || die "labwc was not found; install Raspberry Pi OS Desktop with labwc"

  display_manager_target="$(readlink -f /etc/systemd/system/display-manager.service 2>/dev/null || true)"
  if [[ "${display_manager_target}" != *lightdm* && ! -e /etc/init.d/lightdm ]]; then
    die "LightDM was not detected; the kiosk installer supports Raspberry Pi OS Desktop with LightDM"
  fi

  # Raspberry Pi OS stores an explicit rpd-labwc autologin session in the
  # main LightDM configuration. That setting takes precedence over the
  # drop-in above, so update only that selector and keep the original file.
  lightdm_main_config="/etc/lightdm/lightdm.conf"
  lightdm_main_backup="${lightdm_main_config}.sfts-scoreboard.original"
  if [[ -f "${lightdm_main_config}" ]] && grep -Eq '^[[:space:]]*autologin-session=' "${lightdm_main_config}"; then
    if [[ ! -e "${lightdm_main_backup}" ]]; then
      cp -p "${lightdm_main_config}" "${lightdm_main_backup}"
      log "Saved original LightDM configuration to ${lightdm_main_backup}"
    fi
    LIGHTDM_MAIN_TMP="$(mktemp)"
    sed -E 's|^[[:space:]]*autologin-session=.*$|autologin-session=sfts-scoreboard-kiosk|' \
      "${lightdm_main_config}" > "${LIGHTDM_MAIN_TMP}"
    install -m 0644 -o root -g root "${LIGHTDM_MAIN_TMP}" "${lightdm_main_config}"
    rm -f "${LIGHTDM_MAIN_TMP}"
    LIGHTDM_MAIN_TMP=""
    log "Selected the SFTS kiosk session for LightDM autologin"
  fi

  lightdm_config="/etc/lightdm/lightdm.conf.d/50-sfts-scoreboard-kiosk.conf"
  lightdm_tmp="$(mktemp)"
  printf '%s\n' '[Seat:*]' "autologin-user=${SERVICE_USER}" 'autologin-user-timeout=0' 'autologin-session=sfts-scoreboard-kiosk' > "${lightdm_tmp}"
  install -d -m 0755 -o root -g root /etc/lightdm/lightdm.conf.d
  install -m 0644 -o root -g root "${lightdm_tmp}" "${lightdm_config}"
  rm -f "${lightdm_tmp}"

  systemctl set-default graphical.target
  display_manager_service=""
  if [[ -n "${display_manager_target}" ]]; then
    display_manager_service="$(basename "${display_manager_target}")"
  fi
  [[ -n "${display_manager_service}" ]] || display_manager_service="lightdm.service"
  systemctl enable "${display_manager_service}"

  lightdm_show_config="$(/usr/sbin/lightdm --show-config 2>&1 || true)"
  if [[ -n "${lightdm_show_config}" ]]; then
    if ! grep -Eq 'autologin-session[[:space:]]*=[[:space:]]*sfts-scoreboard-kiosk' <<< "${lightdm_show_config}"; then
      printf '%s\n' "${lightdm_show_config}" >&2
      die "LightDM did not select sfts-scoreboard-kiosk for autologin"
    fi
  elif ! grep -Eq '^[[:space:]]*autologin-session[[:space:]]*=[[:space:]]*sfts-scoreboard-kiosk[[:space:]]*$' "${lightdm_main_config}" 2>/dev/null && \
      ! grep -Eq '^[[:space:]]*autologin-session[[:space:]]*=[[:space:]]*sfts-scoreboard-kiosk[[:space:]]*$' "${lightdm_config}" 2>/dev/null; then
    die "LightDM configuration does not select sfts-scoreboard-kiosk for autologin"
  else
    log "LightDM did not print effective configuration; verified the active configuration files"
  fi

  kiosk_config_root="/etc/sfts/sfts-scoreboard-kiosk"
  kiosk_labwc_dir="${kiosk_config_root}/labwc"
  kiosk_autostart="${kiosk_labwc_dir}/autostart"
  kiosk_environment="${kiosk_labwc_dir}/environment"
  kiosk_session_dir="/usr/share/wayland-sessions"
  kiosk_session="${kiosk_session_dir}/sfts-scoreboard-kiosk.desktop"
  kiosk_session_tmp="$(mktemp)"

  # Use a separate labwc configuration root so the regular Raspberry Pi
  # desktop wallpaper, panel, notifications, and icons are never started.
  install -d -m 0755 -o root -g root "${kiosk_config_root}" "${kiosk_labwc_dir}"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    "\"${KIOSK_SCRIPT}\" &" \
    > "${kiosk_autostart}"
  chown root:root "${kiosk_autostart}"
  chmod 0644 "${kiosk_autostart}"

  # Keep the dedicated kiosk session on a US/English keyboard layout. This
  # avoids changing the system locale or other users' desktop sessions.
  printf '%s\n' \
    '# SFTS scoreboard kiosk: use English keyboard input' \
    'XKB_DEFAULT_LAYOUT=us' \
    > "${kiosk_environment}"
  chown root:root "${kiosk_environment}"
  chmod 0644 "${kiosk_environment}"

  printf '%s\n' \
    '[Desktop Entry]' \
    'Name=SFTS Scoreboard Kiosk' \
    'Comment=Dedicated SFTS scoring kiosk session' \
    'Type=Application' \
    "Exec=/usr/bin/env XDG_CONFIG_HOME=${kiosk_config_root} XKB_DEFAULT_LAYOUT=us XKB_DEFAULT_VARIANT= ${labwc_bin}" \
    'DesktopNames=labwc' \
    > "${kiosk_session_tmp}"
  install -m 0644 -o root -g root "${kiosk_session_tmp}" "${kiosk_session}"
  rm -f "${kiosk_session_tmp}"

  chmod 0755 "${KIOSK_SCRIPT}"
  log "Configured dedicated labwc kiosk session for ${SERVICE_USER}"
}

configure_power_permissions() {
  local polkit_tmp
  polkit_tmp="$(mktemp)"
  sed -e "s|@SERVICE_USER@|$(escape_sed_value "${SERVICE_USER}")|g" \
    "${POLKIT_TEMPLATE}" > "${polkit_tmp}"
  install -d -m 0755 -o root -g root /etc/polkit-1/rules.d
  install -m 0644 -o root -g root "${polkit_tmp}" "${POLKIT_DEST}"
  rm -f "${polkit_tmp}"
  log "Enabled password-free reboot and shutdown for ${SERVICE_USER}"
}

configure_quiet_boot() {
  local boot_config
  local cmdline_file
  local config_backup
  local cmdline_backup
  local cmdline
  local token

  if [[ -f /boot/firmware/config.txt ]]; then
    boot_config="/boot/firmware/config.txt"
    cmdline_file="/boot/firmware/cmdline.txt"
  elif [[ -f /boot/config.txt ]]; then
    boot_config="/boot/config.txt"
    cmdline_file="/boot/cmdline.txt"
  else
    die "Raspberry Pi boot configuration was not found under /boot/firmware or /boot"
  fi
  [[ -f "${cmdline_file}" ]] || die "kernel command line file is missing: ${cmdline_file}"
  [[ -w "${boot_config}" && -w "${cmdline_file}" ]] || die "boot configuration files are not writable"

  config_backup="${boot_config}.sfts-scoreboard.original"
  cmdline_backup="${cmdline_file}.sfts-scoreboard.original"
  if [[ ! -e "${config_backup}" ]]; then
    cp -p "${boot_config}" "${config_backup}"
    log "Saved original boot configuration to ${config_backup}"
  fi
  if [[ ! -e "${cmdline_backup}" ]]; then
    cp -p "${cmdline_file}" "${cmdline_backup}"
    log "Saved original kernel command line to ${cmdline_backup}"
  fi

  if grep -Eq '^[[:space:]]*#?[[:space:]]*disable_splash=' "${boot_config}"; then
    sed -i -E 's|^[[:space:]]*#?[[:space:]]*disable_splash=.*$|disable_splash=1|' "${boot_config}"
  else
    printf '\n# SFTS scoreboard: hide the Raspberry Pi firmware splash\ndisable_splash=1\n' >> "${boot_config}"
  fi

  cmdline="$(tr -s '[:space:]' ' ' < "${cmdline_file}" | sed -E 's/^ //; s/ $//')"
  cmdline="$(printf '%s' "${cmdline}" | sed -E 's/(^|[[:space:]])splash([[:space:]]|$)/ /g; s/[[:space:]]+/ /g; s/^ //; s/ $//')"
  for token in quiet loglevel=0 logo.nologo vt.global_cursor_default=0 systemd.show_status=false; do
    case " ${cmdline} " in
      *" ${token} "*) ;;
      *) cmdline="${cmdline} ${token}" ;;
    esac
  done
  printf '%s\n' "${cmdline}" > "${cmdline_file}"

  log "Disabled firmware/Plymouth splash and suppressed boot messages"
}

step "Verifying the application health"
if ! systemctl is-active --quiet "${SERVICE_NAME}.service"; then
  journalctl -u "${SERVICE_NAME}.service" -n 40 --no-pager >&2 || true
  die "${SERVICE_NAME}.service did not start"
fi

if command -v curl >/dev/null 2>&1; then
  dashboard_ready=false
  for attempt in {1..15}; do
    if curl --fail --silent --max-time 5 http://127.0.0.1:8080/ >/dev/null; then
      dashboard_ready=true
      break
    fi
    sleep 1
  done
  [[ "${dashboard_ready}" == true ]] || die "service is active but the dashboard did not respond on port 8080"
fi
success "Dashboard is responding on http://127.0.0.1:8080"

step "Configuring dedicated kiosk session"
configure_desktop_kiosk
success "Dedicated kiosk session and auto-login are configured"

step "Configuring password-free power controls"
configure_power_permissions
success "Dashboard reboot and shutdown controls are configured"

step "Applying quiet boot configuration"
configure_quiet_boot
success "Boot visuals are configured for a clean kiosk startup"

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
