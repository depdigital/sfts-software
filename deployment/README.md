# Raspberry Pi Deployment

This directory contains the Raspberry Pi deployment files for SFTS. The installer is intended to be run from a checked-out `deployment` branch on the Pi.

## Files

```text
deployment/
├── README.md
├── install.sh
├── config/
│   └── sfts-scoreboard.env.example
├── scripts/
│   └── check-network.sh
└── systemd/
    └── sfts-scoreboard.service
```

## Prerequisites

- Raspberry Pi OS/Linux.
- The Pi’s personal Wi-Fi connected for internet and SSH.
- The Pi’s Ethernet connected to a yellow LAN port on the dedicated remote router.
- The Pi’s Ethernet network configured as `192.168.50.x`.
- The project checked out at a path owned by the service user, for example `/home/sfts/sfts-software`.
- `config/remote-config.json` present in the checkout.

The installer does not configure the TP-Link router and does not change Pi network settings. This avoids interrupting an active SSH session. Run `check-network.sh` before installation to verify the network.

## First-time installation

From the project directory on the Pi:

```bash
cd ~/sfts-software
git switch deployment
git pull --ff-only origin deployment
bash deployment/scripts/check-network.sh
sudo bash deployment/install.sh
```

`install.sh` is safe to run again. It installs Node.js/npm with APT if `/usr/bin/node` is missing, verifies Node.js 18 or newer, installs production dependencies with `npm ci --omit=dev`, creates the runtime data directory, installs the systemd unit, and enables the service.

The installer creates `/etc/sfts/sfts-scoreboard.env` from the example only when that file does not already exist. Existing environment settings and the project `data` directory are preserved.

## Service behavior

The service:

- Runs as the project owner, not root.
- Starts after the network is available.
- Listens on port `8080` using the project’s `config/remote-config.json`.
- Enables local kiosk authorization with `SFTS_KIOSK_MODE=true`.
- Restarts after an unexpected server failure.
- Stores match state in the project `data` directory.
- Does not print remote token values during installation.

Open the host dashboard on the Pi at:

```text
http://localhost:8080
```

Configure the ESP32 remotes with the Pi’s Ethernet address, normally:

```text
ws://192.168.50.102:8080
```

Use the actual reserved Ethernet address if it differs.

## Service commands

```bash
sudo systemctl status sfts-scoreboard.service --no-pager
sudo systemctl restart sfts-scoreboard.service
sudo systemctl stop sfts-scoreboard.service
sudo systemctl start sfts-scoreboard.service
sudo journalctl -u sfts-scoreboard.service -n 50 --no-pager
sudo journalctl -u sfts-scoreboard.service -f
```

Check the local HTTP endpoint:

```bash
curl http://127.0.0.1:8080/
```

## Updating the Pi

Run updates only from the deployment checkout:

```bash
cd ~/sfts-software
git status --short
git pull --ff-only origin deployment
sudo bash deployment/install.sh
```

The installer restarts the service through systemd and does not delete saved match or tournament data.

## Secrets and local configuration

- Keep `config/remote-config.json` private because it contains remote pairing tokens.
- Keep `/etc/sfts/sfts-scoreboard.env` private if a fixed host token or TTS paths are added.
- Never commit real environment secrets to `deployment/config/sfts-scoreboard.env.example`.
- Do not enable `SFTS_ALLOW_UNPAIRED_REMOTES` during a real event.

## Troubleshooting

If installation fails because port `8080` is already in use, inspect the process before starting another server:

```bash
sudo ss -ltnp | grep ':8080'
sudo journalctl -u sfts-scoreboard.service -n 50 --no-pager
```

If the network check fails, verify that the Pi still has a `192.168.50.x` Ethernet address and that the default route uses `wlan0`:

```bash
ip -4 addr show eth0
ip route
```
