# Panel

The Ispyx window: one page, `page.html`, used on both platforms.

- Windows: served on loopback by `index.js` and shown in an Edge `--app` window.
- macOS: loaded in a WKWebView by the app, no server.

The page is a single self-contained file (inline CSS and JS, no CDN, no external hosts, only relative URLs). It follows the macOS status window: icon, headline, light/dark, green accent, about 480px wide.

## Host contract

The page talks to its host only through:

```js
window.ispyx = {
  getState(): Promise<State>,
  action(name: string, value?: any): Promise<any>,
}
```

If `window.ispyx` is undefined when the page script runs, the page installs a fetch-based one: `getState` is `GET api/state`, `action` is `POST api/action` with `{name, value}` (relative URLs). macOS injects its own `window.ispyx` before the page script runs. The page polls `getState()` every second (the Windows server closes itself when polling stops).

Icon: `<img src="icon.png">` and `<link rel="icon" href="icon.png">`, relative. The Windows server serves `/icon.png`; the macOS host must resolve `icon.png` next to the page.

### State

Only `version` and `platform` are required. Every other key is optional and the page hides the section whose data is absent.

```
{ version, platform: 'win32' | 'darwin', pid, uptimeMs, clients,
  recent: [{ time, tool, summary }],          // time = epoch ms
  stopLabel,                                  // e.g. "Esc x3" or "⌥ Option + Esc"
  effectsEnabled, passwordSet, denylist: [],
  unlockSupported, unlockEnabled,             // win32 only: "Let the AI unlock this PC"
  autostart: boolean, autostartLabel?,        // label defaults by platform
  permissions: [{ id: 'accessibility' | 'screen-recording', title, detail, granted }],
  connect: { claudeCodeCommand, desktopConfigJson, desktopConfigPath } }
```

Sections, top to bottom: header (icon, headline, status, version/uptime/pid), Permissions (`permissions`), Connect to your AI app (`connect`; "Show Config File" only with `desktopConfigPath`), usage note (uses `stopLabel`), General (`autostart`, `effectsEnabled`), Activity (`clients`, `recent`), Safety (`passwordSet`, `denylist`), footer button: Quit on `win32`, Close on `darwin`. The headline reads "Ispyx needs your permission" while any permission is not granted.

### Actions

| name | value | notes |
|---|---|---|
| `quit` | none | Windows footer button (after a confirm) |
| `close` | none | macOS footer button; closes the window. The Windows server accepts and ignores it |
| `setAutostart` | boolean | |
| `setEffects` | boolean | |
| `openLog` | none | Windows footer link |
| `requestPermission` | permission id | "Allow" |
| `openPermissionSettings` | permission id | "Open Settings" |
| `showConfigFile` | none | reveal `desktopConfigPath` (or its folder) |
| `copy` | text | clipboard fallback; the page tries `navigator.clipboard` first |
| `setUnlock` | `{on, password, current}` | win32 only; "Let the AI unlock this PC". Always the resident's own account. `current` is the ispyx panel password, asked for when one is set (same as `removeDeny`) |

## Windows server (`index.js`)

```js
import { startPanel } from './panel/index.js';
const panel = await startPanel({ getState, actions }); // { url, token, port, close() }
```

- `actions` is the host's object. The whitelist above is explicit; a name is callable only if `actions` defines it (except `close`, which is a no-op). `copy`, `requestPermission`, `openPermissionSettings` need a string value (permission ids are checked against `accessibility` / `screen-recording`).
- `resident.js` `getState()` adds `connect` on Windows (`claude mcp add ispyx --scope user -- ispyx mcp`, the `mcpServers` JSON, `%APPDATA%\Claude\claude_desktop_config.json`); its `showConfigFile` opens Explorer on the file or its folder.
- Any `password`/`passwordHash` field in state is stripped.

Security: bound to 127.0.0.1 on a random port; random 128-bit token. `panel.url` carries `?t=<token>` once; the server answers with an HttpOnly, SameSite=Strict cookie and redirects to `/`. Every request needs that cookie and a Host of `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard). POSTs additionally need a same-origin `Origin` and `application/json`. No CORS headers, `Cache-Control: no-store`, CSP `default-src 'self'`. Only `page.html` and the icon are served, so no path traversal.

Endpoints: `GET /`, `GET /icon.png`, `GET /api/state`, `POST /api/action {name, value}`.

Test: `npm run panel-test`.
