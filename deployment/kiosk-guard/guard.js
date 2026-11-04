const ALARM = 'sfts-kiosk-health';
const TITLE = 'SFTS Dashboard';
const RETRY_MS = 3000;

// This runs in Chromium's extension process, outside the dashboard renderer.
// URL policy errors replace that renderer and cannot be fixed by app.js.
export function installKioskGuard(browser, kioskUrl, { now = Date.now, log = console.warn, schedule = setTimeout } = {}) {
  const root = new URL(kioskUrl);
  if (root.protocol !== 'http:' || root.hostname !== '127.0.0.1' || root.pathname !== '/' || root.search || root.hash) {
    throw new Error('Kiosk guard requires the local scoreboard root URL');
  }
  const failed = new Set();
  const lastRecovery = new Map();
  let primaryId = null;
  let queue = Promise.resolve();
  let retryPending = false;

  function isDashboard(value) {
    try {
      const url = new URL(value);
      return !url.username && !url.password && url.origin === root.origin &&
        (url.pathname === '/' || url.pathname === '/index.html') && !url.search;
    } catch { return false; }
  }

  async function reconcile(reason) {
    const tabs = await browser.tabs.query({});
    const healthy = tab => isDashboard(tab.url) && tab.title === TITLE && !failed.has(tab.id);
    // Prefer the existing working dashboard over an unwanted new tab/window.
    const primary = tabs.find(tab => tab.id === primaryId && healthy(tab)) ||
      tabs.find(healthy) || tabs.find(tab => tab.id === primaryId) ||
      tabs.find(tab => isDashboard(tab.pendingUrl || tab.url)) || tabs[0];
    if (!primary) {
      primaryId = (await browser.tabs.create({ url: root.href, active: true })).id;
      return;
    }
    primaryId = primary.id;
    for (const tab of tabs) {
      if (tab.id === primaryId) continue;
      log(`[sfts-kiosk] Closing extra tab ${tab.id}: ${tab.pendingUrl || tab.url || '(blank)'}`);
      await browser.tabs.remove(tab.id);
    }
    if (tabs.length > 1 && !primary.active) await browser.tabs.update(primaryId, { active: true });

    const unexpected = !isDashboard(primary.pendingUrl || primary.url);
    // Error documents can retain the requested local URL. Their title and the
    // webNavigation failure event distinguish them from a working scoreboard.
    const errorDocument = primary.status === 'complete' && primary.title !== TITLE;
    if (!unexpected && !errorDocument && !failed.has(primaryId)) return;
    const previous = lastRecovery.get(primaryId);
    if (previous !== undefined && now() - previous < RETRY_MS) {
      if (!retryPending) {
        retryPending = true;
        schedule(() => { retryPending = false; void check('navigation retry'); }, RETRY_MS - (now() - previous));
      }
      return;
    }
    lastRecovery.set(primaryId, now());
    failed.delete(primaryId);
    log(`[sfts-kiosk] Recovering dashboard (${reason}): ${primary.pendingUrl || primary.url || '(blank)'}`);
    // Only the browser view is recovered; the scoring server keeps running.
    await browser.tabs.update(primaryId, { url: root.href, active: true });
  }

  function check(reason) {
    queue = queue.then(() => reconcile(reason)).catch(error => {
      log(`[sfts-kiosk] Guard check failed: ${error.message}`);
    });
    return queue;
  }

  browser.tabs.onCreated.addListener(() => { void check('tab created'); });
  browser.tabs.onUpdated.addListener((id, change) => {
    if (change.url || change.status === 'complete' || change.title) void check('tab updated');
  });
  browser.tabs.onActivated.addListener(() => { void check('tab activated'); });
  browser.tabs.onRemoved.addListener(id => {
    failed.delete(id);
    lastRecovery.delete(id);
    if (primaryId === id) primaryId = null;
    void check('tab closed');
  });
  browser.webNavigation.onBeforeNavigate.addListener(details => {
    if (details.frameId === 0 && !isDashboard(details.url)) void check('unexpected navigation');
  });
  browser.webNavigation.onErrorOccurred.addListener(details => {
    // ERR_ABORTED is normal for an attachment/download and a cancelled request.
    if (details.frameId !== 0 || details.error === 'net::ERR_ABORTED') return;
    failed.add(details.tabId);
    log(`[sfts-kiosk] Navigation failed: ${details.error} ${details.url}`);
    void check(details.error);
  });
  browser.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) void check('health check');
  });
  // Alarms survive service-worker suspension; no renderer timer or open debug
  // port is needed. Navigation failures are handled immediately above.
  void browser.alarms.create(ALARM, { periodInMinutes: 0.5 });
  void check('guard startup');
  return { check };
}
