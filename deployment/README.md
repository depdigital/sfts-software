# Raspberry Pi Deployment

This directory contains the Raspberry Pi deployment files for SFTS. The installer is intended to be run from a checked-out `deployment` branch on the Pi.

## Files

```text
deployment/
├── README.md
├── install.sh
├── config/
│   └── sfts-scoreboard.env.example
├── polkit/
│   └── sfts-scoreboard-power.rules
├── scripts/
│   ├── check-network.sh
│   └── start-kiosk.sh
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

`install.sh` is safe to run again. It installs missing system packages (Node.js/npm, `curl`, `polkitd`, and Chromium), verifies Node.js 18 or newer, installs production dependencies with `npm ci --omit=dev`, creates the runtime data directory, installs the systemd unit, and enables the service.

On Raspberry Pi OS Desktop with LightDM and labwc, the installer sets the graphical boot target, enables auto-login for the project user, and selects a dedicated SFTS kiosk session. After a reboot, the expected flow is:

```text
Pi power on → Raspberry Pi OS desktop auto-login → local server starts → Chromium opens in kiosk mode
```

The dedicated session prevents the standard Raspberry Pi desktop wallpaper, panel, notifications, and desktop icons from starting. The kiosk launcher also immediately stops any remaining common desktop panels/icons and starts a solid black background, then waits until the local server responds. It uses a dedicated Chromium profile with the basic password store (so no keyring prompt is required), and reopens Chromium if it is closed. It uses a lock so repeated startup attempts cannot create duplicate kiosk windows.

The installer also configures a clean boot transition: it disables the Raspberry Pi firmware rainbow screen, removes the Plymouth splash, suppresses kernel/systemd boot messages, and hides the boot cursor. The original `/boot/firmware/config.txt` and `/boot/firmware/cmdline.txt` files are backed up once with the suffix `.sfts-scoreboard.original` before modification. Older Raspberry Pi OS images using `/boot` are handled too.

The installer requires Raspberry Pi OS Desktop with LightDM and labwc. It intentionally stops with a clear error on Raspberry Pi OS Lite or an unsupported display manager rather than reporting a successful kiosk setup that cannot launch a graphical browser. Desktop auto-login is enabled for this dedicated event kiosk, so anyone with physical access to the Pi can reach the scoreboard without entering a desktop password.

The SETTINGS screen includes REBOOT and SHUTDOWN controls. Each action requires confirmation and has a server-controlled 15-second countdown with a CANCEL option. During installation, the service account is granted only the required polkit reboot and power-off permissions, including their multiple-session variants, so the dashboard can invoke these actions without a sudo prompt. The permission rule is installed at `/etc/polkit-1/rules.d/49-sfts-scoreboard-power.rules`.

After all checks pass, the installer displays a 10-second countdown and reboots the Pi automatically. The final reboot uses non-interactive sudo, so it never pauses for another password prompt. The initial command may still ask for the normal sudo password once:

```bash
sudo bash deployment/install.sh
```

For a maintenance run where you do not want an automatic reboot, use:

```bash
sudo SFTS_SKIP_REBOOT=true bash deployment/install.sh
```

The countdown can be changed when needed with `SFTS_REBOOT_DELAY_SECONDS`, for example `sudo SFTS_REBOOT_DELAY_SECONDS=30 bash deployment/install.sh`.

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

After updating, reboot once to verify the complete power-on flow:

```bash
sudo reboot
```

After the desktop appears, verify the kiosk process and server:

```bash
pgrep -af 'chromium.*sfts-scoreboard-kiosk'
curl http://127.0.0.1:8080/
systemctl get-default
```

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

If a dashboard power action reports a failure, check that the polkit rule exists and that the service is running as the expected non-root account:

```bash
sudo cat /etc/polkit-1/rules.d/49-sfts-scoreboard-power.rules
systemctl show -p User sfts-scoreboard.service
sudo journalctl -u sfts-scoreboard.service -n 50 --no-pager
```
