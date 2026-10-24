# macOS helper: desk review (nothing here has been compiled)

Every Swift file under `Ispyx/Sources/Ispyx/` was read as a compiler would, then each protocol function was
checked against what `src/platform/darwin/*.js` sends and expects. No definite compile error was found; the
fixes below are runtime or protocol problems.

## Fixes

| File | Fix | Why |
|---|---|---|
| `Services/WindowServices.swift` | `describeWindow` of an unknown id (0) returns an empty description with `rect: null` instead of throwing | The Windows client does this and `core/guard.js` calls `describeWindow(foregroundWindow())` where the id may be 0 |
| `Services/WindowServices.swift` | `foregroundWindow` calls `requirePermission("accessibility")` | `darwin/index.js init()` relies on it to surface a missing permission (CONTRACT: init throws naming the permission) |
| `Services/WindowServices.swift` | `bringToForeground` also sets `AXFrontmost` on the app | `NSRunningApplication.activate` from a background accessory app is ignored on macOS 14+ |
| `Services/CaptureServices.swift` | Semaphore wait now pumps the run loop | SCK completion handlers may be delivered on the main queue, which we block: deadlock until the 6 s timeout |
| `Services/CaptureServices.swift` | Null/empty clip check before `.integral` | `CGRect.null.integral` is not guaranteed to stay null |
| `src/platform/darwin/index.js` | Client deletes the capture file after reading | PROTOCOL says the file is removed, but nobody did; every screenshot leaked a full-size file |
| `App/LayerService.swift` | Stale-file cleanup at launch also removes `cap-*.bgra` | Leftovers from crashed runs |

## Protocol check (all functions)

All 46 registered names are unique and AppDelegate calls exactly the five Service register functions plus
`missingPermissions()` (via `PermissionsController`). Argument shapes (positional `args`, object keys) and result
shapes (`left/top/width/height`, `x/y/width/height`, `{text, formats}`, `{file,width,height,rect,method}`,
`{layer,file}`, `{width,height,file}`, dialog result) match the JS client. Package.swift: valid, target path
`Sources/Ispyx` contains `main.swift`.

## Remaining risks, most likely first

1. Swift concurrency diagnostics: AppKit types are `@MainActor` in the macOS 14 SDK and the non-isolated helper
   classes (`LayerRegistry`, `OverlayController`, handler closures) call them. Language mode 5 should only warn; if
   a newer Xcode reports errors, add `@MainActor` to those classes or wrap handlers in `MainActor.assumeIsolated`.
2. ScreenCaptureKit path: untested sourceRect semantics for non-primary displays, Retina downscale quality, and the
   permission flow (macOS asks to restart the app after Screen Recording is granted).
3. Synthetic input: events from a private `CGEventSource` posted to the HID tap; some apps ignore the unicode string
   (`typeChar`), `keysState` uses `.combinedSessionState` which may not see our own synthetic keys, wheel sign for
   horizontal scroll is unverified.
4. Stop hotkey: active `CGEventTap` needs Accessibility (and on some macOS versions Input Monitoring); Esc key-up
   swallowing logic is untested.
5. Layers: the CGImage is rebuilt on every present from the mapped file; at 60 fps on 5760 px wide layers this may be
   slow, and `CATransaction` timing with `.screenSaver`-level panels on multiple Spaces is unverified.
6. Nested event loops (password dialog, `bringToForeground`) run inside a socket handler; a second client call
   arriving meanwhile is handled re-entrantly.
7. `windowDpi` is always 96 and `getClass` empty by design; window titles need Screen Recording or Accessibility.
8. Ad-hoc signing: TCC grants are lost whenever the binary is rebuilt.

## Manual checks on a Mac (after `swift build` / build.sh)

1. `swift build` completes; note and fix any compile error (see risk 1).
2. Launch the app: a menu-bar eye appears, no Dock icon, second launch exits silently.
3. First run with no permissions: the permissions window opens and updates by itself when switches are flipped.
   The window is now the shared web page in a WKWebView (`App/PanelWindow.swift`, uncompiled like the rest): check
   it loads (not the "could not find its page" message), both permission rows flip to allowed after granting, the
   Copy buttons put the Claude Code command and the Claude Desktop snippet on the clipboard, Show Config File reveals
   `claude_desktop_config.json`, the open-at-login toggle follows System Settings > Login Items, Close closes,
   "Open Ispyx..." in the menu bar reopens it, and light/dark mode both look right.
4. `echo '{"id":1,"fn":"ping","args":[]}' | nc -U ~/Library/Application\ Support/Ispyx/helper.sock` answers `pong`.
5. `{"fn":"foregroundWindow"}` without Accessibility returns the permission message; with it, a window id.
6. `listWindows` and `describeWindow` show real titles, process names and point coordinates (check a second monitor).
7. `overlayShow` with kinds `running` and `stopped`: banner centred under the menu bar, click-through, hides on `overlayHide`.
8. `layerCreate` + write into the mapped file + `layerPresent` shows a translucent rectangle at the right place on all screens; `layerDestroy` removes it.
9. `showDialog` (setup and unlock): window comes to front, returns password/confirm/value/unit, times out and cancels correctly.
10. Input: `mouseMoveTo`, click in TextEdit, `typeChar` for `a`, `é`, an emoji and newline, `pressVirtualKeys` for cmd+a; `hookTouch` then Option+Esc emits a `stop` event; `captureScreenRect` and `captureWindow` produce non-empty files that the Node client deletes.
