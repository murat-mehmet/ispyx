# Ispyx for macOS

`Ispyx.app` is a menu-bar app (no Dock icon) that does everything on the Mac that needs OS access: input events,
window lists, screenshots, the clipboard, the stop hotkey, and the on-screen effects, banner and password window.
The Node side (`src/platform/darwin/`) talks to it over a unix socket; the protocol is in
`src/platform/darwin/PROTOCOL.md`.

Requires macOS 13 or later, Apple Silicon, and the Xcode command line tools (Swift 5.9).

## Build and run

```sh
cd native/macos
./build.sh                 # -> build/Ispyx.app (ad-hoc signed) and build/Ispyx.dmg
open build/Ispyx.app       # or: open -g -a "$PWD/build/Ispyx.app"
```

Signed and notarised release build:

```sh
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
NOTARY_PROFILE=ispyx-notary \
./build.sh
```

`NOTARY_PROFILE` is a keychain profile made once with `xcrun notarytool store-credentials`. The signing,
notarisation and dmg steps are marked in `build.sh` (`SIGNING STEP`, `NOTARISATION STEP`, `DMG STEP`).
The bundle id `com.ispyx.app` in `Ispyx/Resources/Info.plist` is a placeholder. An app icon goes in
`Ispyx/Resources/Ispyx.icns` (optional for now).

For quick iteration you can also run the bare binary: `cd Ispyx && swift run`. Permissions are then granted to
your terminal, not to Ispyx, so prefer the bundle for anything beyond a smoke test.

Only one Ispyx runs per user: a second launch exits at once.

## Permissions

Ispyx needs two switches in System Settings > Privacy & Security:

- **Accessibility**: move the pointer, click, type, read window information.
- **Screen Recording**: screenshots.

At launch, if one is missing, an onboarding window explains why and has buttons that open the right panes. It
re-checks every second and closes itself when both are allowed. It also opens when a client call fails because of a
missing permission, and "Permissions..." in the menu-bar menu opens it any time. The app sends the `permissions`
event (`{"event":"permissions","missing":[...]}`) to connected clients whenever the missing set changes.

macOS often needs the app restarted before a newly allowed Screen Recording takes effect. Ad-hoc signed builds get a
new identity with every rebuild, so macOS asks again; remove the old Ispyx entry in the pane and add the new one.

## Socket

`~/Library/Application Support/Ispyx/helper.sock`, mode 0600, newline-delimited JSON. Set `ISPYX_SOCKET` to use
another path (tests). Shared pixel files are in `$TMPDIR/ispyx/` (`layer-<n>.bgra`, `mask-<n>.bin`, captures).

## Debugging

```sh
# the app's log output
log stream --predicate 'process == "Ispyx"' --level debug

# talk to it by hand
printf '{"id":1,"fn":"ping","args":[]}\n' | nc -U ~/Library/Application\ Support/Ispyx/helper.sock
printf '{"id":2,"fn":"version","args":[]}\n' | nc -U ~/Library/Application\ Support/Ispyx/helper.sock
printf '{"id":3,"fn":"overlayShow","args":[{"text":"hello","kind":"working"}]}\n' | nc -U ~/Library/Application\ Support/Ispyx/helper.sock

# is it running / stuck?
pgrep -lf Ispyx
rm -f ~/Library/Application\ Support/Ispyx/instance.lock   # only if a crashed instance blocks a new start
```

`nc -U` closes after sending; the answer line comes back before it exits. Requests are handled one at a time on the
app's main thread; while the password window is open the app answers nothing else.

## Layout

```
Ispyx/Package.swift
Ispyx/Resources/            Info.plist, Ispyx.entitlements
Ispyx/Sources/Ispyx/App/    main, AppDelegate, SocketServer, PermissionsWindow, OverlayService, DialogService, LayerService
Ispyx/Sources/Ispyx/Services/  OS services (input, windows, capture, pasteboard, hotkey)
Ispyx/Sources/Ispyx/Router.swift
```
