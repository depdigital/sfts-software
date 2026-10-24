import os from 'node:os';

export function normalizeAddress(value = '') {
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

export function isLoopback(value) {
  return ['127.0.0.1', '::1'].includes(normalizeAddress(value));
}

// Fixed-size, expiring token buckets: client-supplied headers never select the key.
export function createRateLimiter({ capacity, refillPerSecond, maxKeys = 256, ttlMs = 120_000, now = Date.now }) {
  const entries = new Map();
  return {
    take(key, cost = 1) {
      const time = now();
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= maxKeys) {
          for (const [id, item] of entries) {
            if (time - item.updatedAt > ttlMs) entries.delete(id);
          }
          if (entries.size >= maxKeys) return false;
        }
        entry = { tokens: capacity, updatedAt: time };
        entries.set(key, entry);
      }
      entry.tokens = Math.min(capacity, entry.tokens + Math.max(0, time - entry.updatedAt) * refillPerSecond / 1000);
      entry.updatedAt = time;
      if (cost > entry.tokens) return false;
      entry.tokens -= cost;
      return true;
    }
  };
}

export function createNetworkGuard({ port }) {
  const requests = createRateLimiter({ capacity: 180, refillPerSecond: 20 });
  const apiRequests = createRateLimiter({ capacity: 40, refillPerSecond: 4 });
  const upgrades = createRateLimiter({ capacity: 30, refillPerSecond: 1 });
  const authentications = createRateLimiter({ capacity: 40, refillPerSecond: 2 });
  const hostname = os.hostname().toLowerCase();

  function trustedRequest(req, { websocket = false } = {}) {
    try {
      const host = req.headers.host;
      if (typeof host !== 'string' || !host || /[\s/@\\]/.test(host)) return false;
      const target = new URL(`http://${host}`);
      const hostName = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      const local = normalizeAddress(req.socket.localAddress || '');
      if (Number(target.port || 80) !== port || target.pathname !== '/') return false;
      if (![local, '127.0.0.1', '::1', 'localhost', hostname, `${hostname}.local`].includes(hostName)) return false;
      const origin = req.headers.origin;
      // Browsers must use the same origin as the endpoint. Native ESP32 clients
      // normally omit Origin. Links2004 WebSockets 2.7.2 instead defaults to
      // Origin: file:// and the arduino subprotocol. Admit only that exact
      // WebSocket transport combination; server.js confines it to token-
      // authenticated remote roles. HTTP and opaque browser origins stay denied.
      const arduinoOrigin = websocket && origin === 'file://' &&
        String(req.headers['sec-websocket-protocol'] || '').split(',').some(value => value.trim() === 'arduino');
      if (origin !== undefined && origin !== target.origin && !arduinoOrigin) return false;
      return true;
    } catch {
      return false;
    }
  }

  function httpMiddleware(req, res, next) {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    });
    if (!trustedRequest(req)) return res.status(403).json({ ok: false, message: 'Request origin or host is not allowed' });
    const peer = normalizeAddress(req.socket.remoteAddress || '');
    if (!requests.take(peer) || (req.path.startsWith('/api/') && !apiRequests.take(peer))) {
      res.set('Retry-After', '1');
      return res.status(429).json({ ok: false, message: 'Too many requests; retry shortly' });
    }
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  }

  return { trustedRequest, httpMiddleware, upgrades, authentications };
}
