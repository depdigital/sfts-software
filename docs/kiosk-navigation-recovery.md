# Kiosk browser policy/error recovery

Reported during testing: the Raspberry Pi kiosk unexpectedly replaced manual entry with Chromium's white "page is blocked / organization doesn't allow" screen while the operator was idle. The requested scope covers the complete kiosk, including scoring, import, practice, settings, results, and idle screens.

## Findings

- The deployed Chromium URL policy blocks `*`, allowing the configured `127.0.0.1` scoreboard origin and blob downloads. The reported wording is consistent with a browser policy denial. The backend does not generate that message.
- The dashboard is one local document. Screens are overlays, all assets are local, and there is no idle redirect, automatic page reload, external iframe, or external script dependency in the application.
- The kiosk launcher previously watched only browser exit status. Chromium stays running when a policy block replaces its page, so that failure could remain on screen indefinitely. Dashboard reconnect logic cannot operate after its document has been replaced.
- Labwc omitted F5, Ctrl+Shift+R, and browser multimedia navigation keys. The application rejected modified scoring hotkeys but did not cancel browser navigation shortcuts globally.
- The exact URL, input, or OS/browser event that triggered the reported incident was not captured. Code review cannot prove that trigger or guarantee that no browser error will ever be displayed. No Raspberry Pi session or incident logs were available in this workspace.

## Implemented protection

`public/js/navigationGuard.js` loads before the application. It blocks browser refresh/navigation keys, links, form submissions, and auxiliary clicks on every screen while preserving editing, scoring keys, and authenticated blob downloads. Labwc also consumes the missing keys so protection persists when the dashboard renderer is unavailable.

The SFTS Kiosk Guard runs as a managed browser extension, independently of dashboard JavaScript. It watches top-level navigation errors, tab updates/activation, and a periodic browser alarm. Extra tabs/windows are closed in favor of a healthy dashboard, preserving that document and any draft edits. A replaced/error document is navigated back to the configured local root. Attachment cancellations (`ERR_ABORTED`) and subframe errors do not cause recovery. Failed navigation retries are bounded to one per three seconds. Service-worker restarts recheck current tabs.

Recovery does not restart the scoring server or send match-control commands. If the dashboard document must be replaced, unsaved edits in that document can be lost and the operator returns to the launch page. Persistent records and the live backend match are retained.

Both deployment paths install a signed CRX3 package and managed force-install policy. The device's private signing key stays root-only, outside the served artifact directory. The update metadata and package are available only from the local scoreboard in kiosk mode. External URL blocking, extension blocking for all other IDs, and disabled DevTools remain enforced.

## Validation and deployment

Automated tests exercise idle health checks, policy blocks retaining the local URL, existing error pages, extra tabs, ignored download/subframe failures, bounded retries, custom ports, and navigation input handling. HTTP integration checks public artifact serving and rejects unrelated files and foreign origins. Optional native browser packaging tests verify the CRX3 signature, package contents, stable device ID, and increasing versions when the configured port changes.

Run the native packaging test with an installed Chromium/Chrome executable:

```bash
SFTS_TEST_CHROMIUM=/usr/bin/chromium npm test
```

After copying the reviewed changes to the Pi checkout, apply during maintenance, outside a bout:

```bash
sudo bash deployment/scripts/restart-stack.sh
```

This command restarts the services and graphical session; a live match is paused by the existing server-restart recovery behavior. Source edits alone do not update the installed browser policy or install the guard.

Pi acceptance still requires verification under its installed Chromium version and effective managed policies: confirm the guard is force-installed/enabled, leave each screen idle, exercise navigation keys/mouse controls, confirm that opening a blocked URL in an extra kiosk tab preserves the working dashboard and a draft entry, and check downloads/USB exports. A maintenance-only forced navigation of the primary tab should return to the local launch page while backend match state remains intact. These hardware checks were not performed from this Windows workspace.

Relevant Chromium documentation: [URL policy filtering](https://support.google.com/chrome/a/answer/9942583), [Linux extension hosting](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux), [webNavigation events](https://developer.chrome.com/docs/extensions/reference/api/webNavigation), and [unpacked extension restrictions](https://chromium.googlesource.com/chromium/src/+/refs/tags/141.0.7390.74/chrome/browser/extensions/unpacked_installer.cc#308).
