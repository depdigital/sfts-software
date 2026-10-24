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
    ├── sfts-piper.service
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

`install.sh` is safe to run again. It installs missing system packages (Node.js/npm, Python virtual-environment support, `curl`, `polkitd`, and Chromium), verifies Node.js 18 or newer, installs production dependencies with `npm ci --omit=dev`, creates the runtime data directory, installs the local Piper Python environment and voice model when needed, installs both systemd units, and enables the services.

On Raspberry Pi OS Desktop with LightDM and labwc, the installer sets the graphical boot target, enables auto-login for the project user, and selects a dedicated SFTS kiosk session. After a reboot, the expected flow is:

```text
Pi power on → Raspberry Pi OS desktop auto-login → local server starts → Chromium opens in kiosk mode
```

The dedicated session prevents the standard Raspberry Pi desktop wallpaper, panel, notifications, and desktop icons from starting. The installer also overrides Raspberry Pi OS's explicit LightDM autologin selection when it points to `rpd-labwc`, preserving the original `/etc/lightdm/lightdm.conf` as `/etc/lightdm/lightdm.conf.sfts-scoreboard.original`. The kiosk launcher also stops Raspberry Pi OS's `lwrespawn` supervisors before stopping any remaining common desktop panels/icons, preventing them from being recreated during startup. It then starts a solid black background and waits until the local server responds. It uses a dedicated Chromium profile with the basic password store (so no keyring prompt is required), and reopens Chromium after either a clean exit or a crash. A Labwc autostart supervisor relaunches the kiosk launcher if that script itself exits, and a lock prevents duplicate kiosk windows.

Root-owned Chromium policy files block every URL except the configured local scoreboard HTTP/WebSocket origin and scoreboard-created blob downloads; new-tab, home, and startup pages point back to the scoreboard. Guest/incognito browsing, extensions, DevTools, browser sign-in/sync, background mode, file-selection dialogs, notifications, geolocation, and external-protocol persistence are disabled. Labwc consumes Chromium navigation, tab creation, browser UI, file, history, download, and developer shortcuts. The dashboard also rejects modified scoreboard hotkeys, context menus, and file drops. The backend grants automatic kiosk host access only when the WebSocket has the exact `http://127.0.0.1:PORT` browser origin.

For an internal Chromium error page or other unrecoverable browser display, press `Ctrl+Alt+Shift+R`. This dedicated Labwc binding terminates only the kiosk user's Chromium processes; the supervised launcher opens a clean dashboard two seconds later. It does not open a shell or expose the desktop.

The installer also configures a clean boot transition: it disables the Raspberry Pi firmware rainbow screen, removes the Plymouth splash, suppresses kernel/systemd boot messages, and hides the boot cursor. The original `/boot/firmware/config.txt` and `/boot/firmware/cmdline.txt` files are backed up once with the suffix `.sfts-scoreboard.original` before modification. Older Raspberry Pi OS images using `/boot` are handled too.

The installer requires Raspberry Pi OS Desktop with LightDM and labwc. It intentionally stops with a clear error on Raspberry Pi OS Lite or an unsupported display manager rather than reporting a successful kiosk setup that cannot launch a graphical browser. Desktop auto-login is enabled for this dedicated event kiosk, so anyone with physical access to the Pi can reach the scoreboard without entering a desktop password.

The SETTINGS screen includes REBOOT and SHUTDOWN controls. Each action requires confirmation and has a server-controlled 15-second countdown with a CANCEL option. During installation, the service account is granted only the required polkit reboot and power-off permissions, including their multiple-session variants, so the dashboard can invoke these actions without a sudo prompt. The permission rule is installed at `/etc/polkit-1/rules.d/49-sfts-scoreboard-power.rules`.

The installer configures local announcements automatically. It runs `sfts-piper.service` on `127.0.0.1:5000` with the `en_GB-alan-medium` voice, a medium speaking pace (`length-scale=1.20`) and short sentence pauses (`sentence-silence=0.15`). This British-English model is the closest official Piper option to formal Indian event English; Piper does not currently provide an official Indian-English voice. It sets `SFTS_TTS_ENGINE=piper` and `SFTS_TTS_URL=http://127.0.0.1:5000/synthesize`, and configures the kiosk session to set the default PipeWire output to 95% and unmute it. The scoreboard keeps returned announcement audio in memory with a bounded, expiring cache; it does not write new announcement WAV files to the SD card.

The dedicated kiosk session also forces the English/US keyboard layout through labwc's `XKB_DEFAULT_LAYOUT=us` setting, applied both in labwc's environment file and directly when the compositor starts. This is scoped to the scoreboard kiosk and does not change the system locale or other desktop users.

To tune the voice during a maintenance install, set the optional installer variables, for example:

```bash
sudo SFTS_PIPER_LENGTH_SCALE=1.15 SFTS_PIPER_SENTENCE_SILENCE=0.15 bash deployment/install.sh
```

The default `1.20` value is intentionally retained for a medium-paced announcement. Larger values speak more slowly; smaller values speak faster.

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

Installer runs are serialized with a system lock, generated systemd units are validated before installation, and environment updates are written atomically. Re-running the installer is therefore safe while another maintenance command is not already modifying the deployment.

## Service behavior

The service:

- Runs as the project owner, not root.
- Starts after the network is available.
- Listens on port `8080` using the project’s `config/remote-config.json`.
- Enables local kiosk authorization with `SFTS_KIOSK_MODE=true`.
- Restarts after an unexpected server failure.
- Stores match state in the project `data` directory.
- Loads an optional validated `data/active-rules.json` ruleset at startup and falls back to `config/rules.default.json` if it is missing or invalid. The host SETTINGS screen can apply validated rule packs from the USB drive or restore the built-in default rules.
- Runs with systemd filesystem, kernel, privilege, and network-family restrictions appropriate for a LAN-only scoreboard service.
- Does not print remote token values during installation.

## USB tournament files

In the deployment configuration, tournament player imports and the player template use the single USB storage device connected to the Pi. The dashboard does not open the Linux file picker: `REFRESH USB` checks for one USB storage partition, mounts it through UDisks when needed, and lists only `.xlsx`, `.xls`, and `.csv` files. `SAVE TEMPLATE TO USB` writes `sfts-player-template.xlsx` directly to that drive. Use `UNMOUNT USB SAFELY` before removing the drive.

If more than one physical USB flash drive is visible, the dashboard refuses file operations. A drive with one mounted filesystem partition is supported; set `SFTS_USB_UUID` in `/etc/sfts/sfts-scoreboard.env` if the drive has multiple unmounted filesystem partitions or you want to pin the deployment to one specific drive. The USB must be writable for template export.

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

To refresh the complete SFTS application stack after deploying code changes without rebooting the Pi:

```bash
sudo bash deployment/scripts/restart-stack.sh
```

The script first verifies the production dependency tree and runs `npm ci --omit=dev` as the scoreboard service user when the lockfile requires new or changed packages. It refreshes the supervised kiosk autostart, Labwc restrictions, and Chromium managed policies using the configured scoreboard port, reloads systemd, restarts Piper, restarts the scoreboard, waits for both local services to respond, and restarts LightDM so the kiosk browser loads the latest dashboard. The current graphical session will close and relaunch; saved match state is preserved and the match remains paused after the server restart.

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
