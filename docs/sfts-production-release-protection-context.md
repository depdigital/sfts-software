# SFTS Production Release and Software Protection Context

## Status

- Planning context saved on 2026-10-23.
- No executable packaging, signed updater, secure-boot provisioning, or production-image changes have been implemented from this document.
- Development currently continues from a Git checkout using Node.js and npm.
- The intended final product is a controlled Raspberry Pi appliance, not a customer-accessible source checkout.
- Subscription and license-validation planning is recorded separately in `docs/sfts-licensing-validation-context.md`.

## Objective

Replace the current production workflow based on `git pull`, visible JavaScript source files, and locally installed npm dependencies with a controlled ARM64 release artifact.

The release system should:

- Remove the Git repository and development source tree from deployed customer devices.
- Make casual copying and modification substantially harder.
- Provide repeatable and testable releases.
- Verify that updates were produced by SFTS.
- Keep customer match and tournament data separate from program files.
- Preserve offline event operation.
- Integrate with the planned subscription-entitlement system.
- Support progressively stronger Raspberry Pi boot and storage protection.

## Security Expectation

An executable is useful packaging and hardening, but it is not perfect copy protection.

It can prevent a person with basic Linux knowledge from opening `src/server.js`, changing a condition, and restarting the application. It also removes the obvious repository structure, source history, tests, development scripts, and readable dependency installation.

It cannot guarantee secrecy because:

- Embedded JavaScript or bytecode can be extracted or reverse-engineered.
- Minification and obfuscation only increase analysis effort.
- HTML, CSS, images, and browser JavaScript must ultimately be delivered to Chromium and can therefore be recovered at runtime.
- A user with unrestricted root and physical access can replace an executable unless the boot and storage chain is also protected.
- Even native machine code can be disassembled and modified by a sufficiently capable attacker.

The product should therefore use defense in depth: release packaging, signed updates, backend license enforcement, restrictive permissions, secure boot, storage encryption, controlled distribution, contracts, copyright, and trademarks.

## Recommended Release Architecture

```text
Private SFTS source repository
            |
            v
Trusted ARM64 build pipeline
  - install locked dependencies
  - run automated tests
  - bundle backend
  - bundle/minify frontend
  - omit source maps
  - build executable
            |
            v
Signed production release
  - sfts-server ARM64 executable
  - required runtime assets
  - versioned manifest and hashes
  - Ed25519 release signature
            |
            v
Customer Raspberry Pi
  - verify signature
  - install atomically
  - retain prior working release
  - restart and health-check
  - roll back on failure
```

Development machines may continue using Git and normal Node.js tooling. Customer production devices must consume only signed release artifacts.

## Executable Strategy

The preferred direction is:

1. Bundle the SFTS Node.js backend and required JavaScript dependencies into a release entry point.
2. Minify the bundle and omit source maps from the customer artifact.
3. Embed the bundle in a Node.js Single Executable Application (SEA) targeting Linux ARM64.
4. Embed required static assets in the executable virtual filesystem or package them in a separately signed, root-owned asset archive.
5. Pin a supported Node.js LTS toolchain and reproduce releases from a controlled build environment.
6. Test the finished ARM64 artifact on the exact supported Raspberry Pi OS release and hardware models.

Node.js SEA is preferred over the deprecated `pkg` project. SEA is still evolving, so the chosen Node.js version must be pinned and qualified rather than automatically following the newest runtime.

Relevant references:

- Node.js Single Executable Applications: https://nodejs.org/api/single-executable-applications.html
- Archived `pkg` deprecation notice: https://github.com/vercel/pkg/commit/main

## Current Application Packaging Considerations

SFTS currently consists of more than the Node.js server:

- Node.js backend.
- Browser HTML, CSS, JavaScript, fonts, images, and audio assets.
- Chromium kiosk runtime.
- Raspberry Pi graphical session and system services.
- Piper speech service, Python environment, and voice model.
- Mutable match, tournament, rule, archive, and configuration data.

The initial executable should contain the SFTS Node.js backend and its appropriate application assets. Chromium, the operating system, and Piper can remain managed system components. The product should not be described as literally one self-contained executable until every required runtime dependency is accounted for.

Libraries that rely on dynamic filesystem paths, native modules, runtime-loaded templates, or assets must be explicitly tested during bundling. PDF generation, spreadsheet handling, ruleset loading, public assets, and Piper communication are priority compatibility areas.

## Frontend Exposure

Browser code cannot be made secret because Chromium must receive it to render and operate the scoreboard.

Production frontend handling should still:

- Bundle and minify JavaScript and CSS.
- Remove source maps.
- Remove comments and development diagnostics that disclose internal design unnecessarily.
- Exclude tests and unused source files.
- Keep subscription decisions, authorization, scoring validation, persistence, and release verification in the backend.
- Treat browser checks as user experience only, not security enforcement.

Obfuscation may be considered as a secondary deterrent but must not be relied on for licensing, integrity, or authorization.

## Production Filesystem Layout

A target layout is:

```text
/opt/sfts/
  bin/
    sfts-server
  releases/
    <version>/
  current -> releases/<version>

/etc/sfts/
  sfts-scoreboard.env
  trusted-release-keys.json

/var/lib/sfts/
  state/
  tournament-data/
  archives/
  license/
  backups/

/var/log/sfts/
```

Exact paths may change during implementation, but immutable program files and mutable customer data must remain separate.

Recommended ownership:

- Release executable, assets, and verification keys: owned by `root`, not writable by the SFTS service account.
- Configuration containing secrets: owned by `root`, readable only by the minimum required group or service.
- Runtime data: writable only by the dedicated SFTS service account.
- Browser kiosk account: unable to modify program, configuration, entitlement-verification, or update files.

The service should continue to run as an unprivileged account under systemd with the existing filesystem, privilege, kernel, and network restrictions strengthened as required.

## Files That Must Not Ship

Customer releases should not contain:

- `.git` or any Git credentials.
- Development source tree when it is not required at runtime.
- Source maps.
- Automated tests and fixtures.
- Firmware source code.
- Internal planning documents.
- Build scripts that are not required for update verification.
- npm cache or unnecessary package metadata.
- General compiler and development toolchains.
- Company release-signing private keys.
- Company license-entitlement signing private keys.
- Licensing administration credentials.
- Debug tokens or production secrets embedded during the build.

Public verification keys are not secrets and are expected to exist on deployed devices.

## Signed Release Format

Each release should contain a deterministic manifest such as:

```json
{
  "schemaVersion": 1,
  "product": "SFTS",
  "version": "3.1.0",
  "platform": "linux-arm64",
  "minimumOs": "supported-release-id",
  "createdAt": "2026-10-23T08:00:00Z",
  "files": [
    {
      "path": "bin/sfts-server",
      "sha256": "...",
      "size": 12345678
    }
  ],
  "releaseKeyId": "sfts-release-2026-01"
}
```

The manifest must be signed with an offline company-controlled release key. The Pi verifies the signature with an embedded trusted public key before installing anything.

A checksum stored beside an update without a trusted signature is insufficient because an attacker can replace both the update and checksum.

Release signing and subscription-entitlement signing should use separate keys. Compromise or rotation of one function should not automatically compromise the other.

## Update Workflow

Production updates should replace `git pull` and `npm ci`.

Recommended flow:

1. Retrieve a versioned update package and signed manifest.
2. Verify the release signature against an embedded trusted release key.
3. Verify product, platform, version, file sizes, and hashes.
4. Refuse an invalid, unsigned, incompatible, or unauthorized package.
5. Unpack into a new version-specific staging directory.
6. Preserve the existing executable and runtime data.
7. Stop the SFTS service at an operator-approved maintenance boundary.
8. Atomically switch the `current` release reference.
9. Start the service and run a bounded local health check.
10. Roll back automatically if startup or health verification fails.
11. Record the installed version and update result in a local audit log.

An update must never begin during an active bout. The UI should make maintenance state and restart consequences explicit.

The updater must not accept shell commands, arbitrary paths, or unsigned install scripts from a remote response.

## Release-Key Management

- Generate the release-signing private key on a trusted company system.
- Keep the private key offline or within appropriately protected signing infrastructure.
- Build artifacts may be generated automatically, but final signing authority should be narrowly controlled.
- Maintain encrypted and physically separate key backups.
- Use key identifiers and support more than one trusted public key during rotations.
- Document key rotation, compromise, and recovery procedures.
- Never store the release private key on customer devices or in the public update service.

The licensing validation Raspberry Pi may distribute signed artifacts or update metadata later, but it should not hold the offline root release key merely for convenience.

## Device Lockdown

The first production hardening level should include:

- Dedicated kiosk and service accounts.
- No customer sudo access.
- No normal desktop or file browser access.
- SSH disabled by default or restricted to a company maintenance key and controlled network path.
- Root-owned, read-only application installation.
- Firewall default-deny.
- No Git, npm, compiler, or unnecessary development services.
- Disabled unused boot and network services.
- Automatic restart and local health monitoring.
- Separate, backed-up mutable data partition or directory.
- Maintenance operations recorded in an audit log.

Filesystem permissions do not protect against a person who can remove the storage or obtain root. They are still valuable against casual inspection and accidental modification.

## Secure Boot and Storage Encryption

The stronger production stage should use Raspberry Pi verified boot and encrypted storage where supported.

Raspberry Pi documents a Secure Boot Provisioner capable of:

- Programming a company public-key hash into one-time programmable storage.
- Allowing only company-signed boot software.
- Building a verified boot chain from immutable hardware through the operating system.
- Creating LUKSv2 encrypted storage.
- Using a device-unique secret to unlock the encrypted filesystem without an operator password.

Reference:

- Raspberry Pi Secure Boot Provisioner: https://www.raspberrypi.com/documentation/security/secure-boot-provisioner.html
- Raspberry Pi security architecture: https://www.raspberrypi.com/documentation/security/security-architecture.html

This protection materially raises the difficulty of reading an SD card or booting a modified operating system to bypass SFTS. It is also operationally sensitive:

- OTP provisioning is permanent.
- Losing the corresponding signing key may prevent future trusted updates or recovery.
- A faulty signed image can make field recovery difficult.
- Provisioning and recovery must be rehearsed on non-customer devices first.
- A spare-device and key-backup process is mandatory.

Secure boot must be introduced only after reproducible images, signed update handling, rollback, and recovery are mature.

## Licensing Integration

Executable packaging must not become the licensing mechanism. The future subscription system should remain independently enforced by the local backend using signed, installation-bound entitlements.

Required relationship:

- The executable contains only licensing public verification keys.
- The company licensing service holds the entitlement signing authority.
- The backend verifies an entitlement before granting kiosk or remote host authorization.
- The launch page displays the result but cannot override it.
- Every relevant backend scoring and host entry path remains protected.
- An active bout is never interrupted due to license refresh failure or expiry.
- Records and exports remain accessible after scoring is locked.

Executable integrity and licensing solve different problems:

- Release signatures prove the installed software came from SFTS.
- Entitlement signatures prove the installation is currently permitted to operate.

Both are required for the intended commercial release.

## Anti-Copy Protection Levels

### Level 1: Release packaging

- No Git checkout.
- Bundled/minified executable.
- No source maps, tests, or development tools.
- Root-owned program files.

Protects against casual browsing and straightforward copying.

### Level 2: Commercial enforcement

- Installation-bound subscription entitlement.
- Backend launch and scoring gate.
- Central renewal and revocation.
- Signed release updates.

Protects normal subscription operation and raises the cost of maintaining an unauthorized copy.

### Level 3: Appliance hardening

- Signed operating-system image.
- Secure boot.
- Full-disk encryption with device-specific secret.
- Restricted maintenance access.
- Controlled recovery and update chain.

Protects against storage removal, offline modification, and many root-bypass attempts.

No level makes reverse engineering mathematically impossible. The target is a commercially reasonable barrier proportionate to the product and threat model.

## Legal and Business Protection

Technical controls should be supported by:

- Copyright notices in source and product output.
- Clear commercial license terms.
- Prohibition of redistribution, modification, sublicensing, and circumvention.
- Customer-specific license and installation records.
- SFTS product and company trademarks where appropriate.
- Controlled access to repositories and build infrastructure.
- Staff and contractor intellectual-property agreements.
- Version and build identifiers in reports and application status screens.

Legal advice should be obtained for the actual customer agreement and jurisdiction. Technical packaging does not by itself establish or enforce intellectual-property ownership.

## Testing Requirements

Before a packaged release can replace the current deployment, verify:

- Server startup and shutdown under systemd.
- All scoring and remote behavior.
- Tournament import and export.
- PDF generation.
- Spreadsheet generation and parsing.
- Ruleset loading.
- Match persistence and recovery.
- Static assets, fonts, sounds, and launch animations.
- Piper speech integration.
- Chromium kiosk startup.
- USB workflows.
- Restart, reboot, and shutdown actions.
- Subscription activation and offline entitlement behavior when implemented.
- Clean installation on a blank supported Pi image.
- Upgrade from the previous release.
- Automatic rollback from a broken release.
- Database and match-data preservation through upgrade and rollback.
- Power interruption during download, staging, switch, and first boot.
- Release-signature rejection and tampered-package rejection.
- ARM64 performance, memory use, and startup time.

Release qualification should include a tournament-length soak test on the same Raspberry Pi model used in production.

## Suggested Delivery Phases

### Phase 1: Reproducible release build

- Select and pin a supported Node.js LTS version.
- Bundle the backend and assets.
- Produce a Linux ARM64 SEA artifact.
- Verify all runtime features without a source checkout or `node_modules`.

### Phase 2: Signed installer and updater

- Define the release manifest.
- Create separate release signing keys.
- Implement signature and hash verification.
- Add atomic installation, health checks, and rollback.
- Remove Git-based production updating.

### Phase 3: Production filesystem and account hardening

- Separate immutable code, configuration, and mutable data.
- Apply root ownership and service restrictions.
- Remove development tools and interactive customer access.
- Produce a repeatable appliance image.

### Phase 4: Licensing enforcement

- Implement the separate licensing context.
- Gate local host authorization and scoring in the backend.
- Test offline event behavior and expiration boundaries.

### Phase 5: Secure appliance provisioning

- Pilot Raspberry Pi Secure Boot Provisioner.
- Add verified boot and encrypted storage.
- Rehearse key loss, update failure, and device replacement recovery.
- Provision commercial hardware only after successful pilot qualification.

## Decisions Required Before Implementation

- Supported Raspberry Pi models and minimum hardware.
- Supported Raspberry Pi OS release and architecture.
- Pinned Node.js LTS version for SEA.
- Whether assets are embedded in the executable or shipped as a separately signed archive.
- Debian package, signed archive, or complete signed appliance-image distribution.
- Update transport and whether it shares infrastructure with license validation.
- Update approval policy at event venues.
- Retained number of rollback releases.
- Release-key storage and signing procedure.
- Customer maintenance and physical-access policy.
- Timing for secure boot and disk-encryption rollout.
- Recovery policy if a provisioned device or company signing key is lost.

## Recommended Product Direction

Continue using Git for development and testing, but do not ship the Git working tree as the commercial product.

The preferred final direction is a signed ARM64 SFTS executable installed as part of a locked Raspberry Pi appliance, with mutable event data stored separately, subscription permission enforced by the backend, and all production updates delivered as verified signed releases. Secure boot and encrypted storage should follow after the release and recovery pipeline is proven.

