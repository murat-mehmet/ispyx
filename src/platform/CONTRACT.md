# Platform contract

`src/platform/index.js` loads one folder (`win32/`, `darwin/`, `linux/`, or `fake/` when `ISPYX_PLATFORM=fake`) and
exports its module namespace as the default export. Everything under `src/core/` and `src/effects/` talks to the OS
only through that namespace (`import platform from '../platform/index.js'`). A platform folder's `index.js` must
export everything below. The Windows implementation (`win32/`) is the reference: when this document is unclear,
read it.

## Conventions

- **Calls are synchronous** unless marked `async`. (`darwin/` reaches a native helper process, see
  `darwin/PROTOCOL.md`; it makes the calls look synchronous.)
- **Coordinates** are integers in the platform's *logical desktop space*, origin top-left of the primary monitor,
  y down; other monitors may have negative values. On Windows they are physical pixels (the process is
  per-monitor DPI aware). On macOS they are **points** (not Retina pixels); captures are returned at that logical
  size too (downscaled from the physical image), so `rect.width` always equals `bits` width.
- **Window ids** (`hwnd` in the tool API) are positive integers, opaque to the core: Windows `HWND`, macOS
  `CGWindowID`. `0` means "none".
- **Key codes** are opaque to the core. `parseChord` turns `"ctrl+shift+t"` into an array of platform key codes and
  the core only hands that array back to `keysDown`, `keysUp`, `pressVirtualKeys`, `chordDown`, `insertsContent`.
- **Errors**: throw `Error` with a message meant for the AI caller (plain sentence, says what to do). The core
  turns it into a tool error.
- **Pixel buffers** are `Uint8Array`, BGRA, premultiplied alpha, top-down, `width * height * 4` bytes.

## Lifecycle

| Export | Signature | Notes |
|---|---|---|
| `name` | `'win32' \| 'darwin' \| 'linux' \| 'fake'` | |
| `capabilities` | `{ elevation: boolean }` | `elevation:false` removes the "elevated window" concept (macOS). |
| `stopLabel` | `string` | Shown to the user: `'Alt+Esc'` on Windows, `'Option+Esc'` on macOS. |
| `init()` | `() => void` | Idempotent. Windows: per-monitor DPI awareness, 1 ms timer. macOS: connect to the helper and check permissions; throw a helpful error naming the missing permission. |
| `dataDir()` | `() => string` | Per-user writable directory (password hash). |
| `sleep(ms)` | `=> Promise` | |

## Windows, monitors, pointer

| Export | Returns |
|---|---|
| `listWindows({ includeUntitled })` | `describeWindow` objects of visible, on-screen windows, front to back where the OS gives an order. |
| `describeWindow(id)` | `{ hwnd, title, className, pid, process, elevated, minimized, rect }`. `className` may be `''`. `process` is the executable name (Windows `notepad.exe`; macOS the app's executable name, e.g. `Notes`) and is what the denylist matches. `elevated` is `false` where the concept does not exist. |
| `getRect(id)` | `{ left, top, width, height } \| null` |
| `getTitle(id)`, `getClass(id)`, `getPid(id)` | strings / number |
| `processInfo(pid)` | `{ name, elevated }` |
| `windowExists(id)` | boolean |
| `rootWindowAt(x, y)` | id of the top-level window under the point, `0` if none |
| `foregroundWindow()` | id of the focused top-level window, `0` if none |
| `bringToForeground(id)` | `async`, resolves true when the window is in front (un-minimises first) |
| `windowDpi(id)` | number (96 = 100 %); macOS returns 96 |
| `selfIsElevated()` | boolean (`false` on macOS) |
| `isScreenLocked()` | boolean: no input possible (lock screen, secure desktop) |
| `focusIsPassword()` | boolean: the focused control is a password field |
| `foregroundLayout()` | number identifying the active keyboard layout (reported as hex; `0` if unknown) |
| `virtualScreen()` | `{ x, y, width, height }` bounding box of all monitors |
| `listMonitors()` | `[{ left, top, width, height, primary }]` |
| `cursorPos()` | `{ x, y }` |

## Input

| Export | Notes |
|---|---|
| `mouseMoveTo(x, y)` | Absolute, instant (smoothing is done by the core). |
| `mouseDown(button)`, `mouseUp(button)` | `'left' \| 'right' \| 'middle'`. |
| `mouseWheel(notches)` | Positive = scroll up. Fractions allowed (smooth scrolling). |
| `mouseHWheel(notches)` | Positive = scroll right. |
| `typeUnicode(text, check, delays)` | `async`. Types `text` one character at a time as Unicode (layout independent). Before each character call `check()` (it may throw to cancel); after it wait `delays[i]` ms. Returns when done. |
| `keysDown(codes)`, `keysUp(codes)` | Hold / release key codes (array). |
| `pressVirtualKeys(codes)` | Press the chord (down in order, up in reverse). |
| `parseChord(str)` | `"ctrl+a"` -> codes. Names: `ctrl shift alt enter esc tab space backspace delete home end pageup pagedown left up right down f1..f24 a-z 0-9` and punctuation `, . - = / ; ' [ ] \ \``. `win`, `cmd`, `meta`, `super` mean the OS key (Windows key / Command). `alt` is Alt / Option. |
| `parseSequence(str)` | `"ctrl+a ctrl+c"` -> array of code arrays. |
| `insertsContent(codes)` | True for chords that paste (must not go into a password field). |

## Screen capture

| Export | Returns |
|---|---|
| `captureScreenRect({ left, top, width, height })` | `{ bits, width, height, rect }`; `rect` is the area actually captured. |
| `captureWindow(id)` | `{ bits, width, height, rect, method }`; works for covered windows where the OS allows it, otherwise requires the window to be in front and throws a message saying so. |

## Clipboard

`getClipboardText()` -> `{ text: string \| null, formats: string[] }`; `setClipboardText(text)`;
`setClipboardFile(path)` (puts a file reference, as if copied in the file manager).

## Stop hotkey

| Export | Notes |
|---|---|
| `chordDown(codes)` | True while every key of the chord is physically down (used for polling). |
| `installStopHotkey(onStop, lingerMs)` | Returns `{ touch(), active, stop() }`. A keyboard hook for the stop chord (`Alt+Esc`; macOS `Option+Esc`) that exists only while `touch()` was called in the last `lingerMs` (default 30 000 ms): no hook while idle. The hook swallows the chord and calls `onStop('Alt+Esc')` once per press (auto-repeat counts as one). Injected (synthetic) key events must be ignored. |

## UI

| Export | Notes |
|---|---|
| `Overlay` | The "working / stopped / cancelled" banner. `new Overlay({ enabled, hideAfterMs, stopLabel })` with `begin(label)`, `done()`, `stop(reason)`, `cancel(reason, windowMs)`, `active`, `async hiddenDuring(fn)` (hides the banner while `fn` runs, e.g. during a screenshot). Always-on-top, click-through, never takes focus, covers no more than a thin bar. |
| `showDialog(opts, ms)` | `async`. The native password window for the auth gate. `opts = { mode: 'setup' \| 'unlock', message, value, unit }`; resolves to `{ password, confirm, value, unit, makeDefault }` or `{ cancel: true, reason }` where reason is `'timed out'`, `'closed by the user'` or `'dialog failed: ...'`. Must come to the front and close itself after `ms`. |
| `Layer` | Effect window: see below. |
| `textMask(text, heightPx, weight)` | `{ width, height, mask }`: anti-aliased coverage mask (0-255 per pixel) of `text` in the platform UI font. |
| `ensurePump()` | Windows only (message pump); other platforms export a no-op. |

### `Layer`

A borderless, click-through, never-focused, always-on-top window showing a pixel buffer with per-pixel alpha. Used by
all effects (`src/effects/`).

```js
const layer = new Layer(width, height);   // not visible yet
layer.px                                  // Uint8Array(width*height*4), BGRA premultiplied; draw into it
layer.present(x, y, alpha, height?, width?, srcY?) // move to (x,y), show the top-left width x height part of the
                                          // buffer starting at row srcY, with constant opacity alpha 0..255
layer.shown                               // true after the first present()
layer.destroy()                           // hide and free
```

`present` is called up to 60 times a second per layer; layers can be as large as the whole desktop (5760 x 1080).

## Effects renderer is shared

`src/effects/` holds all drawing code (eye, scan line, rings, pills, radar) as pure JavaScript writing into
`layer.px`. A platform only provides `Layer` and `textMask`. Do not add effect-specific code to a platform folder.

## win32-only optional exports

Other platforms may lack these; callers must feature-test (`if (platform.Tray)`).

- `Tray({ tooltip, onOpen, onQuit, getStatus })`: notification-area eye icon on the shared message pump. Menu: status line
  (from `getStatus()`, refreshed on each open), Open (default; also left click),
  Quit. Methods: `setTooltip(s)`, `destroy()`. Re-adds itself when Explorer restarts. Callbacks never throw into the host.
- `autostart` `{ get(), set(on), command() }`: per-user HKCU Run entry `Ispyx` that starts `src/server.js` hidden
  via `wscript.exe` + `%APPDATA%\ispyx\start.vbs`. `ISPYX_AUTOSTART_VALUE` overrides the value name (tests).
- `unlock` (`src/platform/win32/unlock.js`): `{ isEnabled(), checkAccount(), enable({password}), disable(), signal() }`.
  "Let the AI unlock this PC" (see `docs/unlock-windows.md`). Only ever unlocks the account the resident itself
  runs as, so `enable` asks for just the password. `enable`/`disable` run an
  elevated `.ps1` in `native/win32-unlock/provider/` (one UAC prompt each); `signal()` never needs elevation.
  `checkAccount()` refuses PIN/Microsoft-account and passwordless sign-ins (no replayable secret exists for
  those). The `unlock` MCP tool (`src/core/server.js`) calls `signal()` then polls `isScreenLocked()`.
