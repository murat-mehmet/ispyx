# macOS helper protocol

On macOS the platform calls are made by **Ispyx.app** (`native/macos/`), a signed menu-bar app that holds the
Accessibility and Screen Recording permissions. The Node side (`src/platform/darwin/`) is a thin client. The
contract it implements is `../CONTRACT.md`.

## Process model

```
Claude / MCP client --stdio--> `ispyx mcp` (Contents/Resources/ispyx: thin forwarder, one per client)
                                   |  ispyx.sock (src/core/ipc.js pipe, pinned by macos-entry.js)
                                   v
              resident Node core (`--resident`, started and watched by Ispyx.app) --helper.sock--> Ispyx.app (Swift,
                                                                               the only process that touches the OS)
```

- Ispyx.app runs once per user (menu-bar agent, `LSUIElement`). At launch it starts the bundled Node core as the
  resident (`ResidentService.swift`), the one process that does the work (like the tray app on Windows, see
  `src/core/RESIDENT.md`), and starts it again if it dies. The panel's activity and settings come from it, so they
  work without any AI app connected.
- `ispyx mcp` forwards every call to the resident; when none answers it opens the app (`open -g <the app>`), which
  starts one, and waits.
- Quitting the app stops the resident with SIGTERM, which tells the forwarders to exit first. A resident whose app is
  gone (`ISPYX_APP_PID`) leaves by itself and never opens the app again.
- Socket: `~/Library/Application Support/Ispyx/helper.sock` (unix domain socket, mode 0600).
- The app never listens on a network port.

## Wire format

UTF-8 JSON lines (`\n`-terminated), one object per line, both directions. Binary payloads (pixels, masks) are
**not** in JSON: they travel in shared files, see "Shared pixel buffers".

Request: `{ "id": 17, "fn": "listWindows", "args": [ { "includeUntitled": false } ] }`
Response: `{ "id": 17, "ok": true, "result": ... }` or `{ "id": 17, "ok": false, "error": "message for the AI" }`.

Responses may come out of order; `id` pairs them. Events from the app (no `id`):
`{ "event": "stop", "reason": "Option+Esc" }` (stop hotkey pressed), `{ "event": "permissions", "missing": ["accessibility"] }`.

The Ispyx window asks the server for its part of the panel (activity, effects, password, denylist):
`{ "event": "panelRequest", "req": 3, "kind": "state" | "action", "name": "setEffects", "value": false }`. The owner
answers with the call `panelReply({ "req": 3, "ok": true, "result": ... })` or `{ "req": 3, "ok": false, "error": "..." }`
(`panel.js`); the app takes the first answer and gives up after a timeout. Events never carry an `id` key.

### Functions

Every function of `../CONTRACT.md` that is not pure JavaScript has the same name here, with `args` = the call's
arguments and `result` = the return value, JSON-encoded. Differences:

- `captureScreenRect(rect)` / `captureWindow(id)`: result is `{ file, width, height, rect, method }` where `file` is
  a path to a raw BGRA file (`width*height*4` bytes) in `$TMPDIR/ispyx/`; the client reads it, then the app
  deletes it. (Files stay small: captured at logical size.)
- `typeUnicode`: the client loops, calling `typeChar(codePoint)` per character (the delays and `check()` stay in JS). `codePoint` 10 (newline) means the Return key; carriage
  returns are dropped by the client.
- `parseChord`, `parseSequence`, `insertsContent`, `chordDown` (keys table): client side; `chordDown(codes)` calls
  `keysState(codes)` -> `boolean` (all down).
- `installStopHotkey`: the client calls `hookTouch(lingerMs)` / `hookStop()`; the app installs a `CGEventTap`
  (active, to swallow the chord) only while touched and emits the `stop` event.
- Overlay: `overlayShow({ text, kind })`, `overlayHide()`, `overlayVisible()`; the JS `Overlay` class holds the timers
  and texts exactly like the Windows one.
- `showDialog(opts, ms)`: runs the native dialog in the app, result as in the contract.
- Unlock (`unlock.js`): `unlockEnabled()` -> boolean (a Keychain item exists), `unlockStore(password)`, `unlockClear()`,
  `unlockRun()` -> boolean (false when the screen is not locked; otherwise starts ONE attempt on a background queue and
  returns at once; the caller polls `isScreenLocked`). The password never leaves the app except from the Keychain into key events.

### Layers (effect windows)

`layerCreate({ width, height })` -> `{ layer: <int>, file: <path> }`. The app creates a file
`$TMPDIR/ispyx/layer-<n>.bgra` of `width*height*4` bytes and memory-maps it; the client maps the same file
(`mmap` through `koffi`) and exposes it as `layer.px`. No pixel data goes over the socket.
`layerPresent({ layer, x, y, alpha, height, width, srcY })` -> `true`: show that part of the buffer in the layer's
window (`NSPanel`, `.screenSaver` level, `ignoresMouseEvents`, not key, not main, joins all spaces). Coordinates are
the contract's logical desktop space; convert to AppKit's bottom-left origin inside the app.
`layerDestroy({ layer })`. `textMask({ text, heightPx, weight })` -> `{ width, height, file }` (one byte per pixel).

## Latency budget

The client makes calls look synchronous (`Atomics.wait` on a worker that owns the socket). A round trip must stay
under 1 ms for `mouseMoveTo`, `cursorPos` and `layerPresent`: the core calls them 60-100 times a second.

## Permissions

On the first call the app checks `AXIsProcessTrusted()` and `CGPreflightScreenCaptureAccess()`. When one is
missing, every function that needs it fails with a message such as `Ispyx needs the Accessibility permission. Open
System Settings > Privacy & Security > Accessibility and switch Ispyx on, then try again.` and the app shows its
onboarding window.
