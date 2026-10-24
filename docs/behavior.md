# Behaviour details

Detailed notes on how ispyx behaves on Windows. On macOS the stop key is Option+Esc, there is no elevated-window concept, the denylist matches app names case-insensitively (default `1Password`, `Bitwarden`, `KeePassXC`, `Keychain Access`, `Enpass`), and state (password hash, action log, optional `config.json`) lives in `~/Library/Application Support/Ispyx/`. See [native/macos/README.md](../native/macos/README.md). For install and configuration see the [README](../README.md).

## Scope

The server works like a person at the computer: any window, the taskbar, any monitor, in absolute desktop coordinates. There is no per-window allowlist. The only refusal list is `denylist` (default: `keepass.exe`, `keepassxc.exe`, `1password.exe`, `bitwarden.exe`).

## Password gate (optional)

`auth` is **false** by default. Set `"auth": true` (or `ISPYX_AUTH=1`) and the first tool call opens a small password window (always on top):

- **First time:** you choose a password (at least 6 characters, typed twice). Only a salted PBKDF2 hash is stored, in `%APPDATA%\ispyx\auth.json` (not in the project). An existing `%APPDATA%\win-input-mcp\auth.json` from the old name is copied there once.
- **Every time it is locked:** enter the password and pick **how long to stay unlocked**: a number plus minutes / hours / days (default 24 hours, up to 365 days). Tick **"make this the new default"** to remember the choice. A wrong password reopens the window (your picked duration kept) without answering the tool, up to 3 tries; the third wrong one returns an error.
- **No answer in 30 seconds (fixed; each window gets its own 30 s):** the window closes by itself and the tool returns a plain error ("Password was not entered ..."). The next call asks again.
- **Unlocked:** no window, no questions, until the time runs out. The unlock is kept **in memory only**: every server start, including every client reconnect, asks again. Parallel tool calls share one window.
- **Forgot the password / want to reset:** delete `%APPDATA%\ispyx\auth.json` (the next start asks you to choose a new one).
- `npm run auth-test` drives the real window (temp file only); the unit tests cover the logic.

## Human-like pointer motion

By default the pointer **glides** to every target (`click`, `move`, `mouse_down`/`mouse_up`, `scroll`, and the travel part of `drag`): a gently curved path (cubic Bezier, random bend side and size) with a smooth minimum-jerk speed profile (slow start, fast middle, soft landing), taking a **random 300-1000 ms**, updated about every 8 ms. It always lands exactly on the target. The path is kept on the desktop, and the stop key is checked while moving.

- Typing is human-paced too: `type_text` sends one character at a time, pausing a random 40-120 ms after each (longer after spaces and punctuation, now and then a short thinking pause). Texts that would take over 60 s are sped up to fit; use `set_clipboard` + `ctrl+v` for bulk text. Typing is always human-paced (there is no `instant`). `speed` divides the waits: default `1`; `2` = twice as fast (half the waits), `0.5` = twice as slow, `0` = a fixed 8 ms after every character (the fastest; text is never sent as one batch, because apps drop and repeat characters then). No wait is ever under 8 ms, and the 60 s cap is applied after `speed`. Per call: `type_text { speed }`; default: config `typeSpeed` or env `ISPYX_TYPE_SPEED`. Other config: `typeMinMs`, `typeMaxMs`, `typeCapMs`.
- Scrolling is smoothed the same way: the amount is spread over ~80-120 small wheel events along the same speed curve, so pages scroll continuously.
- Per call: `durationMs` fixes the travel time (minimum 120 ms). There is no jump mode: the pointer never teleports.
- Config: `moveMinMs` (300), `moveMaxMs` (1000).
- Moves under 4 px are instant. `npm run motion-test` checks duration, curvature, smoothness and exact arrival.

## Running banner and emergency stop

- **Banner:** while a tool runs, a small dark banner (`ispyx is working: <tool>   |   To stop press Alt+Esc`) shows at the top centre of the primary monitor and hides 1.5 s after the last tool call. It is click-through (WS_EX_TRANSPARENT, `WM_NCHITTEST` returns transparent, never takes focus), so it catches no click and does not count as a window under the pointer. It stays visible in screen recordings, but is hidden for a moment while the agent takes a screenshot so it never covers what the agent needs to see. Turn it off with config `overlay: false` or `ISPYX_OVERLAY=0`.
- **Alt+Esc** (pressed by you): one press cancels everything running or queued (the tool returns an error saying `CANCELLED BY THE USER`, held keys and buttons are released, the banner turns red for 5 s) and the next call works normally; a second press within 5 s shuts the server down. Alt+Esc is caught by a low-level keyboard hook that swallows the Esc, so Windows does not also cycle windows (an Alt tap may still focus the menu bar of the active window). The hook is installed only while a tool runs and for 30 s after the last call. Keys injected by this server never trigger it; a polling fallback covers moments when the hook is not serviced. There is no mouse-corner switch.
- After a shutdown (Windows: the resident app and every `ispyx mcp` exit) the client shows ispyx as disconnected until it reconnects; the next `ispyx mcp` starts the resident again.
- Why not Ctrl+Esc: Windows opens the Start menu on it before an app can react.

### Testing safely next to other servers

The stop chord reads global keyboard state, so a test that presses Alt+Esc would stop every other ispyx server on the machine. The stop test therefore sets `ISPYX_STOP_CHORD=alt+f24` on its own server and presses that. The real default (Alt+Esc with its swallowing hook) is unchanged; the hook is only installed for the default chord.

## Action log

Every action, refusal and error is appended as one JSON line, with a timestamp, to `logs/actions.jsonl` in the package folder (override with `logPath` or `ISPYX_LOG`). Fields: `time`, `tool`, `window` (hwnd, title, process; in global mode the window under the pointer), `coords` (as given and in screen pixels), `args` (including typed text), `ok`, `error`. Text aimed at a password field is never logged (only the character count of the refused text). `get_clipboard` logs the length only. Kill-switch trips are logged.

## Coordinates

The server runs per-monitor DPI aware (v2): screenshots, clicks and cursor readings share one physical-pixel space, the **virtual desktop** (origin at the primary monitor's top-left; monitors to the left or above have negative coordinates).

`click`, `move`, `mouse_down`, `mouse_up`, `drag` and `scroll` take a `space`:

- `screen`: absolute desktop pixels. Default when no `hwnd`/`title` is given.
- `window`: pixels of the window's own screenshot (`screenshot_window`); the server maps them back with the window's current position and the screenshot scale, focuses the window first, and refuses points covered by another window. Default when `hwnd`/`title` is given.
- `shot`: pixels of the last `screenshot_screen` image (the server applies that image's `rect` and `scale`).

## Tool notes

| Tool | Notes |
| --- | --- |
| `list_windows` | Visible top-level windows including the taskbar (`Shell_TrayWnd`): hwnd, title, class, process, rect, allowed (false = denylisted), elevated; `includeUntitled` for all. |
| `list_monitors`, `cursor_position` | Monitor rectangles + virtual desktop bounds; pointer position. |
| `focus_window` | Any window outside the denylist: restores if minimized, brings to front (AttachThreadInput and Alt-key workarounds for the foreground lock). |
| `screenshot_window` | One window via `PrintWindow(PW_RENDERFULLCONTENT)`. Returns PNG + `scale` + `rect`. Optional `region` {x, y, width, height} crops inside the window (window pixels from its top-left, before `maxWidth` scaling; clamped to the window, error if fully outside; `maxWidth` applies to the crop) and is echoed back clamped. **Mapping back:** the server remembers the crop origin and scale of the last `screenshot_window` per hwnd, so pointer tools with `space: "window"` and that hwnd take coordinates in the cropped image directly (no `region` on the pointer tools). A later uncropped shot resets it. |
| `screenshot_screen` | One monitor (`monitor`), everything (`all: true`) or a `region` in desktop pixels. Returns `rect` + `scale`. |
| `click` | left/right/middle, `double` or `clicks` up to 3, `modifiers` (`ctrl`, `shift`, `alt`, `win`) held during the click. |
| `move`, `mouse_down`, `mouse_up`, `drag` | Pointer control. `drag` glides to the start and to the end (many small moves, as HTML5 drag-and-drop needs) and takes `modifiers`. Held buttons are released on kill switch or shutdown. |
| `scroll` | **Smooth** wheel at a point (spread over many small wheel events, 300-1000 ms plus ~40 ms per notch; `durationMs` to fix it): `amount` vertical notches (+ up), `horizontal` notches (+ right), optional `modifiers` (e.g. ctrl+wheel to zoom). |
| `type_text` | Unicode key events (Turkish and other non-ASCII), one character at a time at a human pace; `speed` multiplier. Refused in password fields. Goes to the foreground window, or to `hwnd`/`title` after focusing it. |
| `press_keys` | Chords such as `ctrl+v`, `alt+tab`, `win+r`, `win+d`, `f5`; several separated by spaces. Windows key allowed. |
| `key_down`, `key_up` | Hold and release keys (e.g. shift for a multi-select). Released automatically on kill switch or shutdown. |
| `wait` | Pause up to 60 s (stop key checked while waiting). |
| `set_clipboard`, `get_clipboard` | Write text / image / file; read text (reports whether an image or files are present). |

## Safety details

- **Password fields:** `type_text` (and paste chords) are refused when the focused control is a password field (Win32 `ES_PASSWORD` and UI Automation `IsPassword`, which covers browser fields). If the check cannot run, the action is refused.
- **No credentials:** the server never reads, stores or types saved passwords, and drives no password manager (default denylist). Log in yourself.
- **Plain errors** for: foreground lock refused, window minimized / not capturable, elevated target (UIPI), locked screen, emergency stop, password not entered, denylisted program.

## What is impossible (Windows rules)

- **UAC prompts, the lock screen and the Ctrl+Alt+Del screen** run on the secure desktop. No input or capture is possible there; the server reports "screen is locked (or a secure prompt is showing)". Neither can `SendInput` produce Ctrl+Alt+Del.
- **Elevated (administrator) windows** ignore input from a normal process (UIPI). The server refuses with a plain message; it works if the server itself is started elevated.
- A **minimized RDP session** or locked workstation takes no input.
- `SendInput` reaches only the foreground window; the server focuses first and verifies. Windows may refuse focus (foreground lock); the error says so.
- Some games and apps with exclusive or protected rendering return black screenshots.

## Notes

- Notepad (WinUI) mangles a single input batch that mixes ASCII and non-ASCII characters; `type_text` therefore sends same-kind runs separately. Other apps were not tested.
- Keyboard layout: Unicode input does not depend on the active layout. `type_text` returns the foreground layout id (`keyboardLayout`, e.g. `0x41f` Turkish, `0x409` US). `press_keys` uses virtual keys, so letters in chords are layout-independent but punctuation keys (`,` `.` `;`...) follow the US virtual-key codes.
- Alt+Tab through `SendInput` works for a quick switch; focus the target with `focus_window` when you need a specific window.

## Several clients, one worker

**Windows (resident model).** One resident process (`ispyx --resident`, started hidden by `ispyx` or on demand by `ispyx mcp`) owns the pipe, keyboard hook, banner, stop state and password unlock. Every MCP client runs a thin `ispyx mcp` that forwards each call to it; a second resident exits at once; if the resident dies mid-call the call returns an error and the next call restarts it. Details in `src/core/RESIDENT.md`; `npm run instances-test` and `npm run resident-test` check it. The rest of this section describes the classic model, still used on macOS and other systems: every MCP client starts its own `server.js`, but only one process does the work. The first one listens on a named pipe (`\\.\pipe\ispyx-<user>-<hash of the ISPYX_*/WIN_INPUT_* env>`) and owns the keyboard hook, banner, stop state and password unlock. The others stay normal MCP servers toward their own client and forward each tool call over the pipe, so nothing disconnects. Calls from all instances take turns (`wait` excepted). If the owner dies, the next call from another instance takes over; if the owner's client closes, it keeps serving the others until they are gone. Servers started with different `ISPYX_*` settings (tests) get their own pipe. `npm run instances-test` checks this. On macOS (and other non-Windows systems) the endpoint is a unix socket `ispyx-<user>-<hash>.sock` in the temp directory, mode 0600; a socket file left by a crashed owner is removed when nothing answers on it. `npm run ipc-test` covers the election, forwarding and shutdown broadcast over a unix socket.

## Animations

Switch: `"animations": false` in `config.json` or `ISPYX_ANIMATIONS=0`.

After `screenshot_screen` / `screenshot_window` the result is returned at once, while an eye opens beside the captured region (left or right, alternating; the side with room on that monitor) or, for a full-screen capture, inside it near the left or right edge, its pupil charges, and a bright scan line sweeps the region from top to bottom. A green wedge of light runs from the pupil to the line, and the pupil looks at the region, moving from upper to lower as the line descends. About 1.7 s; click-through layered windows drawn in software. The next tool call, from any instance, waits until it is over, so it never shows up in a later screenshot. Alt+Esc ends it early.

`focus_window` lights a green frame (dark outline so it shows on white, bright core, corner brackets, soft inner glow, one blink) around the focused window for about 0.8 s; the next call waits for it.

`click` draws expanding rings at the pressed point (green left, cyan right, amber middle; one ring per click of a double/triple click, dark outline so it shows on white). It does not delay the next call; only a screenshot waits for running rings to end, so they never show up in an image.

`drag` marks the start with a ring and leaves a glowing trail behind the pointer (it fades with age and when the button is released, then a ring marks the end). Like `click`, it holds up only screenshots.

`move` leaves a short fading trail behind the pointer and a ring where it arrives (no start ring); like `click` and `drag` it holds up only screenshots.

`scroll` shows green chevrons beside the pointer that travel in the scroll direction (up, down, left or right) while the wheel turns, for at least 0.4 s. Like `click`, it holds up only screenshots.

Every pointer glide (the approach of `click`, `scroll`, `mouse_down`, `mouse_up`, `drag`, and `move` itself) leaves the short fading trail; the glide that carries a drag has the drag trail instead.

`press_keys` shows the chords as key caps ("Ctrl" + "C") near the bottom of the monitor the keys go to, for about half a second plus 0.14 s per chord. Like `click`, it holds up only screenshots.

`type_text` (6 characters or more) shows a small pill near the bottom of the monitor the keys go to: keyboard icon, progress bar and "37 / 120". It never shows the typed text. Like `click`, it holds up only screenshots.

`list_windows` opens an eye in the middle of the monitor the keys go to and sends out one sonar ping: a ring that expands to the corners. A window's frame lights when the ring reaches its nearest edge (nearest windows first; green usable, red denylisted, amber elevated), then everything fades. About 2 s at roughly 60 frames per second, at most once every 8 s; like `click`, it holds up only screenshots.

`wait` (1 second or longer) shows a small pill near the bottom of the monitor the keys go to: an hourglass, the time left ("4.2 s") and a bar that runs down. Shorter waits show nothing. Like `click`, it holds up only screenshots.
