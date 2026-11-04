#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
GUARD_DEST="/etc/sfts/sfts-scoreboard-kiosk/guard"
GUARD_PORT="${1:-8080}"

[[ "${EUID}" -eq 0 ]] || { printf 'Kiosk guard installation requires root\n' >&2; exit 1; }
[[ "${GUARD_PORT}" =~ ^[0-9]+$ ]] && (( GUARD_PORT >= 1 && GUARD_PORT <= 65535 )) || exit 1
install -d -m 0755 -o root -g root "${GUARD_DEST}"
GUARD_BROWSER="$(command -v chromium || command -v chromium-browser || true)"
[[ -n "${GUARD_BROWSER}" ]] || { printf 'Chromium is required to package the kiosk guard\n' >&2; exit 1; }
umask 077
node "${PROJECT_DIR}/deployment/scripts/package-kiosk-guard.js" "${GUARD_BROWSER}" "${GUARD_PORT}" \
  "${GUARD_DEST}" /etc/sfts/kiosk-guard-signing.pem
