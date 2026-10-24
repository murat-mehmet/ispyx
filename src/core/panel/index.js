// Local "Open" panel: a tiny loopback-only HTTP server serving one page that shows
// resident status and flips a few settings. Zero deps (node:http).
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('./page.html', import.meta.url));
const COOKIE = 'ispyx_panel';
// Explicit whitelist; an action is also callable only if the host's `actions` object defines it.
const ACTIONS = ['quit', 'setAutostart', 'setEffects', 'openLog', 'copy', 'close', 'requestPermission', 'openPermissionSettings', 'showConfigFile'];
const BOOL_ACTIONS = new Set(['setAutostart', 'setEffects']);
const STRING_ACTIONS = new Set(['copy', 'requestPermission', 'openPermissionSettings']); // value must be a short string
const PERMISSION_IDS = new Set(['accessibility', 'screen-recording']);

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export async function startPanel({ getState, actions, port = 0 }) {
  const token = crypto.randomBytes(16).toString('hex'); // 128 bit
  let boundPort = 0;
  const hostOk = (h) => h === `127.0.0.1:${boundPort}` || h === `localhost:${boundPort}`;
  const authed = (req, url) => {
    if (safeEq(parseCookies(req.headers.cookie)[COOKIE] || '', token)) return true;
    return false;
  };

  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...extra,
    });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const deny = (res, code = 403, msg = 'forbidden') => send(res, code, { error: msg });

  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 4096) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });

  let iconPng = null;
  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req.headers.host)) return deny(res);
      const url = new URL(req.url, `http://127.0.0.1:${boundPort}`);

      // First load: ?t=<token> sets the cookie, then redirects to a clean URL.
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
        if (!safeEq(url.searchParams.get('t'), token)) return deny(res);
        return send(res, 302, '', 'text/plain', {
          Location: '/',
          'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }
      if (!authed(req, url)) return deny(res);

      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, await readFile(PAGE), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/icon.png') { // the app icon, same as the tray and the macOS app
        iconPng ??= (async () => {
          const [{ renderIcon }, { encodePng }] = await Promise.all([import('../../effects/appicon.js'), import('../image.js')]);
          return encodePng(renderIcon(128, { tight: true }), 128, 128);
        })();
        return send(res, 200, await iconPng, 'image/png');
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const s = { ...(await getState()) };
        delete s.password; delete s.passwordHash; // never expose
        s.passwordSet = !!s.passwordSet;
        return send(res, 200, s);
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        if (req.headers.origin !== `http://${req.headers.host}`) return deny(res);
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return deny(res, 415, 'json only');
        let body;
        try { body = await readJson(req); } catch { return deny(res, 400, 'bad json'); }
        const name = body && body.name;
        if (typeof name !== 'string' || !ACTIONS.includes(name) || (name !== 'close' && typeof actions?.[name] !== 'function')) {
          return deny(res, 400, 'unknown action');
        }
        if (BOOL_ACTIONS.has(name) && typeof body.value !== 'boolean') return deny(res, 400, 'boolean value required');
        if (STRING_ACTIONS.has(name) && (typeof body.value !== 'string' || body.value.length > 3000)) return deny(res, 400, 'string value required');
        if ((name === 'requestPermission' || name === 'openPermissionSettings') && !PERMISSION_IDS.has(body.value)) return deny(res, 400, 'unknown permission');
        if (name === 'close') return send(res, 200, { ok: true }); // macOS-only; nothing to close here
        // Reply first for quit, since it may tear this server down.
        if (name === 'quit') {
          send(res, 200, { ok: true });
          setTimeout(() => { Promise.resolve().then(() => actions.quit()).catch(() => {}); }, 50);
          return;
        }
        await actions[name](BOOL_ACTIONS.has(name) || STRING_ACTIONS.has(name) ? body.value : undefined);
        return send(res, 200, { ok: true });
      }
      return deny(res, 404, 'not found');
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  boundPort = server.address().port;

  return {
    url: `http://127.0.0.1:${boundPort}/?t=${token}`,
    token,
    port: boundPort,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
