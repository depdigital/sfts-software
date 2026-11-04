// Install before the dashboard so browser navigation remains blocked on every
// screen, including while another script is starting or has thrown an error.
(() => {
  document.addEventListener('keydown', event => {
    const key = event.key.toLowerCase();
    const modifier = event.ctrlKey || event.metaKey;
    const browserKey = ['F1', 'F5', 'F6', 'F7', 'F10', 'F11', 'F12',
      'BrowserBack', 'BrowserForward', 'BrowserHome', 'BrowserSearch', 'BrowserFavorites'].includes(event.key);
    const browserShortcut = modifier && ['r', 'l', 't', 'n', 'w', 'o', 'p', 's', 'h', 'j', 'u',
      'k', 'e', 'tab', 'pageup', 'pagedown', 'f4', '1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(key);
    const altNavigation = event.altKey && ['arrowleft', 'arrowright', 'home', 'd'].includes(key);
    if (browserKey || browserShortcut || altNavigation) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener('auxclick', event => event.preventDefault(), true);
  document.addEventListener('submit', event => event.preventDefault(), true);
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    // The application downloads authenticated responses through local blobs.
    // No dashboard action needs to replace the top-level document with a link.
    if (link.hasAttribute('download') && link.href.startsWith(`blob:${location.origin}/`)) return;
    event.preventDefault();
  }, true);
})();
