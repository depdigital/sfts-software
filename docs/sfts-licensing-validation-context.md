# SFTS Licensing and Subscription Validation Context

## Status

- Planning context saved on 2026-10-23.
- No licensing, subscription, activation, or launch-gate functionality has been implemented yet.
- The intended first deployment is a dedicated company-controlled Raspberry Pi used only for SFTS license activation and validation.
- Initial subscription renewals may be administered manually; payment-provider automation can be added later.
- The target is a low-cost startup deployment with no recurring software or hosting fee when the company internet connection supports direct hosting.

## Business Objective

SFTS is intended to use a monthly subscription model. A deployed installation should require a valid subscription before entering the operational scoreboard. The design is meant to discourage unauthorized copying and ordinary license sharing.

It is not possible to make locally distributed software impossible to modify. A sufficiently capable person with full control of a customer Raspberry Pi can patch local checks. The practical objective is therefore:

- Reliable enforcement for legitimate installations.
- Installation-bound activation to deter casual copying and key sharing.
- Cryptographically tamper-evident entitlements.
- Central suspension and renewal control.
- Safe offline operation at tournament venues.
- No interruption of a live bout because the licensing server or internet is unavailable.

## Core Architecture

```text
Company administrator
        |
        | local CLI renewal, suspension and activation management
        v
Company licensing Raspberry Pi
  - private subscription database
  - public validation API
  - online entitlement signing key
  - audit log
        |
        | HTTPS
        v
Customer SFTS Raspberry Pi backend
  - installation-specific key pair
  - cached signed entitlement
  - local entitlement verification
  - server-side scoreboard authorization
        |
        v
SFTS launch page and scoreboard
```

The browser must not call the public licensing service directly. The local SFTS backend performs activation and validation, verifies the signed entitlement, and supplies only the resulting license status to the launch page.

The launch page is the visible checkpoint, but it is not the security boundary. The SFTS backend must also reject host authorization, new bouts, and scoring operations when the installation is not entitled. Local kiosk authorization must not bypass licensing.

## Recommended Free Deployment

Use a dedicated Raspberry Pi at the company office with:

- Raspberry Pi OS Lite 64-bit.
- A small private Node.js licensing service, separate from the distributed SFTS application.
- SQLite for licenses, installations, subscription status, and audit records.
- Node.js built-in Ed25519 cryptography for signed entitlements.
- Caddy as the only public HTTPS reverse proxy.
- DuckDNS for a free dynamic hostname.
- Let's Encrypt certificates maintained automatically by Caddy.
- `systemd` for service supervision and automatic restart.
- `nftables` with default-deny inbound policy.
- `unattended-upgrades` for operating-system security updates.

This can avoid recurring hosting fees if all of the following are already available:

- A company-owned Raspberry Pi.
- Reliable company power and internet.
- A router that can forward ports 80 and 443.
- An ISP connection with a publicly reachable IPv4 address, or otherwise usable public connectivity.

This direct-hosting approach will generally not work behind carrier-grade NAT (CGNAT). If CGNAT is present, the practical upgrade is a production tunnel with a company domain or paid hosting. Cloudflare Tunnel can avoid opening inbound router ports, but a production public hostname normally requires a domain. Tailscale's free Personal plan must not be assumed valid for commercial SFTS infrastructure.

Do not use temporary development tunnels for production licensing.

## Activation Flow

1. On first activation, the customer SFTS backend generates an installation ID and an Ed25519 device key pair.
2. The device private key remains on that customer Raspberry Pi with restrictive permissions.
3. The operator enters the supplied SFTS license key on the launch page.
4. The local backend sends the license key, installation ID, device public key, product version, nonce, and request timestamp to the company validation API over HTTPS.
5. The validation service confirms that the license is active, paid, for the correct SFTS product, and below its activation limit.
6. The validation service binds the license to the installation public key.
7. It returns a signed, time-limited entitlement.
8. The local SFTS backend verifies the signature using an embedded company public key and stores the entitlement atomically.
9. Only after successful verification may the backend authorize entry to the scoreboard.

The company private signing key must never be included in customer software, repositories distributed to customers, browser JavaScript, firmware, or environment files shipped with an SFTS device.

## Periodic Validation Flow

The customer installation should refresh its entitlement in the background, normally once every 24 hours. A refresh request should contain:

- Installation ID.
- License identifier, not necessarily the original activation secret.
- Cryptographically random nonce.
- Request timestamp.
- Current SFTS version.
- Signature created by the installation private key.

The company service verifies the registered device public key, rejects replayed or stale requests, checks subscription status, and returns a newly signed entitlement.

Validation must never occur in the remote scoring input path and must never delay score updates.

## Entitlement Contents

A signed entitlement should contain at least:

```json
{
  "schemaVersion": 1,
  "product": "SFTS",
  "licenseId": "SFTS-000012",
  "installationId": "installation-identifier",
  "customer": "Example Academy",
  "plan": "professional",
  "features": ["scoreboard", "tournament", "four-remotes"],
  "issuedAt": "2026-10-23T08:00:00Z",
  "validUntil": "2026-10-30T08:00:00Z",
  "keyId": "sfts-online-2026-01"
}
```

The serialized payload must be deterministic before signing. Use a maintained cryptographic implementation and a documented envelope format rather than inventing a custom signature algorithm.

The local verifier must check:

- Signature validity.
- Expected signature algorithm.
- Trusted key ID.
- Product name.
- Schema version.
- Installation ID match.
- Issue and expiry times.
- Required feature entitlement.
- Local clock rollback indicators.

## Event-Safe Policy

Recommended initial policy:

- Attempt a refresh once every 24 hours when internet is available.
- Issue entitlements valid for 7 days.
- Warn the operator when fewer than 3 days remain.
- Never interrupt a round or bout already in progress.
- If entitlement expires during a bout, allow that bout to finish and block preparation or start of the next bout.
- Continue to allow viewing, exporting, backing up, and recovering existing records after expiry.
- Block host authorization, new-bout loading, and scoring when no valid entitlement or protected active-bout exception exists.
- Provide the company with a controlled method to issue an emergency 24-hour signed entitlement.

This policy deliberately accepts that a cancelled subscription may continue for up to the entitlement lifetime in exchange for reliable offline tournaments.

The final offline duration is still a business decision. Seven days is the current recommendation, not a finalized requirement.

## Minimum Database Model

### `licenses`

- Internal license ID.
- Hash of the randomly generated license key.
- Customer name and contact reference.
- Product and plan.
- Status: active, past-due, suspended, cancelled, or revoked.
- Paid-through timestamp.
- Maximum installation count.
- Created and updated timestamps.

### `installations`

- Installation ID.
- License ID.
- Registered Ed25519 public key.
- Optional non-authoritative hardware metadata.
- Activation timestamp.
- Last successful validation timestamp.
- Last seen software version.
- Revocation status and reason.

### `audit_log`

- Timestamp.
- Administrative or device action.
- License and installation references.
- Acting administrator or authenticated device.
- Result and non-sensitive reason.
- Source metadata needed for investigation.

License activation secrets must be generated with at least 128 bits of cryptographic randomness. Store a secure hash of each license key, not the original activation key. Logs must never contain complete license keys, private keys, authorization headers, or entitlement signing secrets.

## Public API Surface

Keep the public API deliberately small:

- `POST /v1/activate`
- `POST /v1/refresh`
- Optional minimal `GET /health`

Administrative renewal and suspension operations should initially be local command-line operations over LAN-only SSH. Do not expose a public administration dashboard during the startup phase.

The API should enforce:

- HTTPS only.
- Strict request schemas.
- Small request-body limits.
- Timeouts.
- Rate limits by source, license, and installation.
- Nonce and timestamp replay protection.
- Generic public errors without database or account details.
- Constant-time secret comparison where applicable.
- Audit records for activation and validation decisions.
- No arbitrary database queries, filesystem access, or command execution.

## Company Raspberry Pi Hardening

The validation Pi should be dedicated to licensing and should not also run development tools, the tournament scoreboard, general file sharing, or unrelated websites.

Recommended controls:

- Wired Ethernet.
- UPS and automatic power recovery.
- High-endurance SD card or USB SSD.
- Minimal Raspberry Pi OS installation.
- Separate unprivileged service account with no interactive shell.
- Validation service bound only to `127.0.0.1`.
- Caddy as the only internet-facing application.
- Default-deny firewall.
- Public router forwarding only for TCP 80 and 443.
- No public SSH port.
- SSH keys only; disable password and root login.
- Administrative SSH restricted to the office LAN or a properly licensed private-access solution.
- Automatic security updates with a defined maintenance/reboot policy.
- `systemd` restart-on-failure and boot startup.
- Database and signing-key files readable only by the licensing service account or a narrower signing component.
- System logs configured to avoid secrets and bounded to prevent disk exhaustion.
- External uptime monitoring when practical.

## Signing-Key Protection and Rotation

The online signing private key is the most sensitive asset. If it is stolen, an attacker could mint apparently valid entitlements.

Initial controls:

- Generate the key on a trusted company machine or the dedicated licensing Pi.
- Store it outside the application source tree.
- Restrict file ownership and permissions.
- Keep an encrypted offline backup in a physically separate location.
- Never transmit or log it.
- Use a `keyId` in entitlements.
- Embed a small trusted public-key set in SFTS so planned rotation is possible.
- Document emergency revocation and rotation before production launch.

A later security upgrade can introduce an offline root signing key and a short-lived online intermediate key, or hardware-backed signing. Raspberry Pi file permissions alone cannot fully protect a key after complete root compromise or physical theft.

## Backups and Recovery

- Create an encrypted daily SQLite backup to separate storage.
- Keep at least one offline backup of the database and signing material.
- Test restoration onto a spare SD card or spare Pi.
- Keep a documented rebuild procedure.
- Monitor disk usage and database integrity.
- Ensure the entitlement lifetime gives customers enough time to continue operating while the company restores the validation server.

Losing the database may lose activation bindings. Losing the only private signing key may prevent renewal of existing entitlements. Both must be included in recovery testing.

## Direct Free Internet Exposure

For a zero-recurring-cost initial deployment:

1. Register a DuckDNS hostname.
2. Configure a system service to keep the public IP updated.
3. Forward router TCP ports 80 and 443 to the licensing Pi.
4. Configure Caddy to terminate HTTPS and proxy only to the local validation service.
5. Do not forward SSH, SQLite, the Node.js application port, or any administration port.
6. Test the API from an external network rather than the office Wi-Fi.
7. Confirm whether the ISP uses CGNAT and whether inbound hosting is permitted by the service agreement.

Relevant references:

- DuckDNS free dynamic DNS: https://www.duckdns.org/faqs.jsp
- Caddy automatic HTTPS: https://caddyserver.com/docs/quick-starts/https
- Cloudflare Tunnel connectivity model: https://developers.cloudflare.com/cloudflare-one/networks/connectivity-options/
- OWASP authorization guidance: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- OWASP key-management guidance: https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html

## Manual Startup-Phase Operations

Payment processing does not have to be integrated initially.

Suggested monthly workflow:

1. Confirm the customer's payment through the company's existing process.
2. Connect to the validation Pi from the office LAN.
3. Run a private administrative CLI command to extend the license's paid-through date.
4. Record the action in the audit log.
5. The customer's next background refresh receives an entitlement limited by the new paid-through date and offline policy.

The administration CLI should also support creating a license, registering an activation allowance, suspending or revoking a license, removing an installation after verification, inspecting status, exporting an audit report, and producing an emergency entitlement.

## SFTS Integration Requirements

Future implementation in the deployed scoreboard should include:

- A local license module in the backend.
- An atomic local entitlement store outside the public web directory.
- An activation screen on the launch page.
- License status display including customer, plan, last check, and entitlement expiry.
- Background refresh with bounded backoff and clear operator warnings.
- Backend enforcement independent of the browser UI.
- Enforcement before local kiosk host authorization.
- Protection for every host/scoring entry path, including WebSocket roles and relevant HTTP APIs.
- Active-bout completion semantics.
- Read-only access to historical records and exports after expiry.
- Clock-rollback detection that does not create unsafe event-day false positives.
- Test coverage for valid, expired, tampered, wrong-device, revoked, offline, clock-change, server-down, and mid-bout-expiry cases.

The current SFTS `openHost()` flow displays the host screen before authorization is confirmed. Licensing implementation should change the entry flow so the operational host interface is shown only after both license authorization and host authorization succeed.

## Important Limitations

- Client-side launch-page checks alone are bypassable.
- Obfuscation is not a licensing security boundary.
- Hardware identifiers on a Raspberry Pi can be copied or emulated by a determined attacker.
- A cloned disk image may also clone the installation private key unless hardware-backed storage is introduced.
- A customer with full root access can patch locally distributed enforcement code.
- A central validation service does not establish ownership of the underlying source code; contracts, copyright notices, trademarks, controlled distribution, and private repositories remain important.
- The system raises the effort required for copying and controls legitimate subscriptions, but it cannot guarantee that piracy is impossible.

## Decisions Still Required Before Implementation

- Exact offline entitlement lifetime: current recommendation is 7 days.
- Grace behavior after failed payment versus deliberate revocation.
- Number of permitted SFTS installations per subscription.
- Whether replacement hardware consumes or transfers an activation.
- Plan and feature definitions.
- Customer identity and support workflow.
- Emergency-license approval and audit process.
- Whether the first public deployment has a usable public IP or is behind CGNAT.
- Whether to accept direct router exposure or purchase a domain and use a managed tunnel.
- Signing-key rotation interval and compromise procedure.
- Customer terms covering copying, redistribution, modification, availability, offline operation, and subscription termination.

## Suggested Delivery Phases

### Phase 1: Local prototype

- Build the licensing database, admin CLI, signer, activation endpoint, refresh endpoint, and entitlement verifier.
- Run everything on a private LAN.
- Test tampering, wrong installations, expiry, replay, and database restoration.

### Phase 2: SFTS launch enforcement

- Add activation and status UI.
- Enforce entitlements in the backend and kiosk flow.
- Add offline caching, warnings, active-bout protection, and tests.

### Phase 3: Dedicated company Pi

- Harden the operating system.
- Configure HTTPS exposure.
- Install the database, signing service, backup, monitoring, and administrative CLI.
- Conduct an external security and failure test.

### Phase 4: Pilot customers

- Start with a small number of installations.
- Operate renewals manually.
- Measure validation availability and support workload.
- Rehearse company-Pi outage and complete restoration.

### Phase 5: Automation and stronger key custody

- Integrate payment webhooks when manual renewals become burdensome.
- Add a customer subscription portal if required.
- Move signing into stronger hardware-backed or managed key storage.
- Add redundant validation infrastructure while preserving offline operation.

