# win-input-mcp

Local Windows desktop-control MCP server. Lets an agent see one chosen window and click, drag, scroll and type into it. Node 22+, stdio only (opens no network port), `koffi` for Win32 calls, `@modelcontextprotocol/sdk` for MCP.

## Install

```
cd G:\win-input-mcp
npm install
```

## Register it

Launch command (stdio):

```
node G:\win-input-mcp\src\server.js
```

Claude Code:

```
claude mcp add win-input --scope user -- node G:\win-input-mcp\src\server.js
```

Any MCP client (JSON form):

```json
{
  "mcpServers": {
    "win-input": {
      "command": "node",
      "args": ["G:\\win-input-mcp\\src\\server.js"],
      "env": { "WIN_INPUT_ALLOWLIST": "chrome.exe,msedge.exe" }
    }
  }
}
```

## Allowlist and config

An action runs only on a window whose process is on the allowlist; any other window is refused with an error (`list_windows` still shows it). Default: `chrome.exe`, `msedge.exe`.

Change it in one of three ways (later wins):

1. `config.json` in the project root (see `config.example.json`): `{ "allowlist": ["chrome.exe"], "logPath": "logs/actions.jsonl" }`
2. A config file elsewhere, via env `WIN_INPUT_MCP_CONFIG=<path>`
3. Env `WIN_INPUT_ALLOWLIST=chrome.exe,msedge.exe,notepad.exe` (comma separated) and `WIN_INPUT_LOG=<path>`

Other config keys: `killCornerPx` (default 2), `maxTypeLength` (default 10000).

## Action log

Every action, refusal and error is appended as one JSON line to `G:\win-input-mcp\logs\actions.jsonl` (override with `logPath` or `WIN_INPUT_LOG`). Fields: `time`, `tool`, `window` (hwnd, title, process), `coords` (window-relative and screen), `args` (including typed text), `ok`, `error`. Text aimed at a password field is never logged.

## Tools

| Tool | Notes |
| --- | --- |
| `list_windows` | Visible top-level windows: hwnd, title, process, rect, allowed. |
| `focus_window` | Restores if minimized, brings to front (AttachThreadInput and Alt-key workarounds for the foreground lock). |
| `screenshot_window` | That window only, via `PrintWindow(PW_RENDERFULLCONTENT)`. Returns PNG + `scale` + `rect`. |
| `screenshot_screen` | A whole monitor. |
| `click`, `move`, `drag`, `scroll` | Coordinates are **screenshot pixels relative to the window**; the server maps them back with the window's current rect and the scale of the last screenshot of that window. Refused if another window covers the point. |
| `type_text` | Unicode key events (Turkish and other non-ASCII). Refused in password fields. |
| `press_keys` | `ctrl+v`, `enter`, `ctrl+a ctrl+c`, `f5`... No Windows key. |
| `set_clipboard` | `text`, `imagePath` (pastes as a picture) or `filePath` (pastes as a file). |

All window tools take `hwnd` or `title` (substring); if omitted, the last used window is targeted.

Typical flow: `list_windows` → `screenshot_window` → read coordinates off the image → `click`/`type_text` → `screenshot_window` to check.

## Safety

- **Kill switch:** move the mouse into the top-left screen corner. Every action is refused until the server restarts. A background watcher catches quick flicks between actions.
- **DPI:** the process sets per-monitor-aware v2 at start, so screenshots, clicks and cursor positions share one physical-pixel space.
- **Password fields:** `type_text` (and paste chords) are refused when the focused control is a password field (Win32 `ES_PASSWORD` and UI Automation `IsPassword`, which covers browser fields). If the check cannot run, the action is refused.
- **No credentials:** the server never reads, stores or types saved passwords. Log in yourself.
- **Plain errors** for: foreground lock refused, window minimized / not capturable, elevated target (UIPI), locked screen, kill switch, not allowlisted.

## Limits

- `SendInput` reaches only the foreground window; the server focuses first and verifies.
- Elevated (admin) windows cannot be driven unless the server is elevated too.
- A locked screen or a minimized RDP session takes no input.
- Notepad (WinUI) mangles a single input batch that mixes ASCII and non-ASCII characters; `type_text` therefore sends same-kind runs separately. Other apps were not tested.
- Keyboard layout: Unicode input does not depend on the active layout. `type_text` returns the foreground layout id (`keyboardLayout`, e.g. `0x41f` Turkish, `0x409` US) for diagnosis. `press_keys` uses virtual keys, so letters in chords are layout-independent but punctuation keys (`,` `.` `;`...) follow the US virtual-key codes.

## Tests

```
npm test        # unit checks (PNG, key parsing, password-field detection)
npm run smoke   # drives the real server over stdio against a fresh Notepad tab
npm run chrome-test   # Chrome end-to-end: Google search through the server (see below)
```

The smoke test opens Notepad, opens a **new tab** (Notepad restores your earlier tabs, which must stay untouched), types `Merhaba ğüşıöç`, `ctrl+a`, checks the text by copying it back, takes a screenshot, verifies that `move` lands on the mapped screen pixel, drags across the text and checks the selection is a prefix of it, checks that a non-allowlisted window is refused, empties and closes the tab and the window, then checks the kill switch with a second server instance. Notepad is added to the allowlist for the test only. Screenshots are written to `test/out/`.

### Chrome end-to-end test (`npm run chrome-test`)

Opens Chrome the way a person does: it middle-clicks the pinned Chrome button on the taskbar (found read-only through UI Automation by `test/taskbar-button.ps1`, clicked through the server's `click` on the taskbar window). A middle-click starts a **new window** and does not focus or minimise the windows you already have open. The test then targets only that new window (the hwnd that was not there before), types `https://www.google.com/?hl=en` in the address bar, types `Merhaba dunya hava durumu Istanbul` into the search box, presses Enter, and checks:

- window title contains the query, and the URL (read with `ctrl+l`, `ctrl+c`) is `google.*/search?q=...hava+durumu...`
- a screenshot of the results window is returned (`test/out/chrome-results.png`)
- the page text, copied with `ctrl+a`, `ctrl+c` and read back from the clipboard (no OCR), is non-empty and contains the query terms (`test/out/chrome-results.txt`); result titles are guessed from the lines that sit just above a URL/breadcrumb line and printed

At the end only that window is closed (`WM_CLOSE`). The test server allows `chrome.exe` and `explorer.exe` (for the taskbar click) for this run only.

Limits found:

- The new window uses your normal Chrome profile (a taskbar launch cannot choose another), so the search lands in your history and your cookies decide whether a Google consent screen shows. The test fails with a clear message if it detects one (`Before you continue` / `Reject all` / Turkish equivalents) instead of clicking blindly.
- Language: the URL pins `hl=en`, so labels are English; result text can still be Turkish.
- Result titles are heuristic: Google's layout changes, and AI Overview / site-name lines may be picked up instead of page titles. The title/URL/text checks are the real assertions.
- Needs the taskbar Chrome button to be pinned or running, an unlocked screen, and Chrome not elevated.
