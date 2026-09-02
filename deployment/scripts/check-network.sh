#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

ETHERNET_INTERFACE="${SFTS_ETHERNET_INTERFACE:-eth0}"
WIFI_INTERFACE="${SFTS_WIFI_INTERFACE:-wlan0}"
REMOTE_ROUTER_IP="${SFTS_REMOTE_ROUTER_IP:-192.168.50.1}"
failures=0

log() {
  printf '[sfts-network] %s\n' "$*"
}

fail() {
  printf '[sfts-network] FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

command -v ip >/dev/null 2>&1 || { fail "ip command is not available"; exit 1; }

ip link show "${ETHERNET_INTERFACE}" >/dev/null 2>&1 || fail "missing interface ${ETHERNET_INTERFACE}"
ip link show "${WIFI_INTERFACE}" >/dev/null 2>&1 || fail "missing interface ${WIFI_INTERFACE}"

ETHERNET_CIDR="$(ip -4 -o addr show dev "${ETHERNET_INTERFACE}" | awk '$4 ~ /^192\.168\.50\./ {print $4; exit}')"
WIFI_CIDR="$(ip -4 -o addr show dev "${WIFI_INTERFACE}" | awk '$4 !~ /^127\./ {print $4; exit}')"

if [[ -n "${ETHERNET_CIDR}" ]]; then
  log "${ETHERNET_INTERFACE}: ${ETHERNET_CIDR}"
else
  fail "${ETHERNET_INTERFACE} does not have a 192.168.50.x address"
fi

if [[ -n "${WIFI_CIDR}" ]]; then
  log "${WIFI_INTERFACE}: ${WIFI_CIDR}"
else
  fail "${WIFI_INTERFACE} does not have an IPv4 address"
fi

DEFAULT_INTERFACE="$(ip -4 route show default | awk 'NR == 1 {print $5}')"
if [[ "${DEFAULT_INTERFACE}" == "${WIFI_INTERFACE}" ]]; then
  log "default route uses ${WIFI_INTERFACE}"
else
  fail "default route uses ${DEFAULT_INTERFACE:-no interface}; expected ${WIFI_INTERFACE}"
fi

REMOTE_INTERFACE="$(ip -4 route get "${REMOTE_ROUTER_IP}" 2>/dev/null | awk '{for (i = 1; i <= NF; i += 1) if ($i == "dev") {print $(i + 1); exit}}')"
if [[ "${REMOTE_INTERFACE}" == "${ETHERNET_INTERFACE}" ]]; then
  log "${REMOTE_ROUTER_IP} is reached through ${ETHERNET_INTERFACE}"
else
  fail "${REMOTE_ROUTER_IP} is reached through ${REMOTE_INTERFACE:-no route}; expected ${ETHERNET_INTERFACE}"
fi

if command -v ping >/dev/null 2>&1 && ping -c 1 -W 2 "${REMOTE_ROUTER_IP}" >/dev/null 2>&1; then
  log "router ping succeeded"
else
  fail "could not ping ${REMOTE_ROUTER_IP}"
fi

if (( failures > 0 )); then
  exit 1
fi

log "network checks passed"
