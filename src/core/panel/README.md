# Panel

The "Open" page of the resident app: a small status and settings page served on loopback.

```js
import { startPanel } from './panel/index.js';
const panel = await startPanel({ getState, actions }); // { url, token, port, close() }
// open panel.url in the default browser
```

- `getState()` returns `{version, platform, pid, uptimeMs, clients, recent:[{time,tool,summary}], stopLabel, effectsEnabled, passwordSet, denylist, autostart}`.
- `actions` is `{quit(), setAutostart(bool), setEffects(bool), openLog()}`. Only these four names are callable from the page.
- Password changes are not in the page; it only shows "Password set: yes/no". Any `password`/`passwordHash` field in state is stripped.

Security: bound to 127.0.0.1 on a random port; random 128-bit token. `panel.url` carries `?t=<token>` once; the server answers with an HttpOnly, SameSite=Strict cookie and redirects to `/`. Every request needs that cookie and a Host of `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard). POSTs additionally need a same-origin `Origin` and `application/json`. No CORS headers, `Cache-Control: no-store`, CSP `default-src 'self'`. Only one fixed file (`page.html`) is served, so no path traversal.

Endpoints: `GET /`, `GET /api/state` (page polls every second), `POST /api/action {name, value}`.

Test: `npm run panel-test`.
