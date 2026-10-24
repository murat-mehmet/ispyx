<p align="center"><img src="https://raw.githubusercontent.com/murat-mehmet/ispyx/master/docs/banner.png" alt="ispyx: an eye on a window, scanning it" width="100%"></p>

# ispyx

A local desktop-control [MCP](https://modelcontextprotocol.io) server. It lets an AI assistant use your computer the way a person does: look at the screen or at one window, move the mouse, click, drag, scroll, type, press hotkeys and use the clipboard.

- Runs on your machine, talks to the MCP client over **stdio**, opens **no network port**.
- Node 22+, `koffi` for the Windows API, `@modelcontextprotocol/sdk` for MCP.
- Windows today; macOS is in development and experimental (see [Platform status](#platform-status)).

## Features

- **Tools** for windows, monitors, screenshots (screen, monitor, region or a single window), mouse (click, move, drag, scroll, press/release), keyboard (typing, hotkeys, hold/release) and clipboard (text, image, files).
- **Human-paced input.** The pointer glides along a gently curved path to each target, scrolling is smoothed, and typing goes one character at a time with natural pauses.
- **On-screen feedback.** An eye opens and a scan line sweeps the captured area after a screenshot; clicks, drags, scrolls, key presses, typing and waits each get a small animation; `list_windows` sends out a sonar ping that lights up window frames. A banner shows while a tool runs. All of it is click-through and can be turned off.
- **Safety.**
  - **Alt+Esc** (Option+Esc on macOS) stops everything: one press cancels all running and queued calls, a second press within 5 s shuts the server down.
  - A **denylist** of programs that are never driven (password managers by default).
  - Refuses to type into **password fields**.
  - An optional **password gate** that asks you before the first tool call.
  - An action log of everything the server did.
  - **Single shared instance:** many MCP clients can start ispyx, but only one process does the work, so there is one stop key, one banner and one unlock state.

## Install and run

No installation is needed, the client starts it with `npx`.

Claude Code:

```
claude mcp add ispyx --scope user -- npx -y ispyx
```

Claude Desktop and other MCP clients (JSON form; on Windows some clients need `cmd /c` around `npx`):

```json
{
  "mcpServers": {
    "ispyx": {
      "command": "npx",
      "args": ["-y", "ispyx"]
    }
  }
}
```

Requires Node.js 22 or newer.

macOS (experimental): install `Ispyx.app` instead, which carries its own Node and needs nothing else. See [native/macos/README.md](native/macos/README.md).

## Configuration

Settings are applied in this order, later wins: built-in defaults, `config.json` (in the package folder, or the file named by `ISPYX_CONFIG`), environment variables. See `config.example.json`.

| `config.json` key | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| (the file itself) | `ISPYX_CONFIG` | `config.json` in the package root | Path of a config file. |
| `denylist` | `ISPYX_DENYLIST` (comma separated) | `keepass.exe`, `keepassxc.exe`, `1password.exe`, `bitwarden.exe`; macOS: `1Password`, `Bitwarden`, `KeePassXC`, `Keychain Access`, `Enpass` (app names, case-insensitive) | Programs that are never driven or focused. |
| `logPath` | `ISPYX_LOG` | `logs/actions.jsonl` (macOS: `~/Library/Application Support/Ispyx/logs/actions.jsonl`) | Action log (JSON lines). |
| `auth` | `ISPYX_AUTH` (`0`/`1`) | `false` | Ask for a password before the first tool call. |
| `authFile` | `ISPYX_AUTH_FILE` | `%APPDATA%\ispyx\auth.json` (macOS: `~/Library/Application Support/Ispyx/auth.json`) | Where the password hash is stored. |
| `overlay` | `ISPYX_OVERLAY` (`0`/`1`) | `true` | The "ispyx is working" banner. |
| `animations` | `ISPYX_ANIMATIONS` (`0`/`1`) | `true` | The eye, scan and other effects. |
| `typeSpeed` | `ISPYX_TYPE_SPEED` | `1` | Typing speed multiplier (2 = twice as fast, 0 = fixed 8 ms per character). |
| `stopChord` | `ISPYX_STOP_CHORD` | `alt+esc` | Emergency stop keys (mainly for tests). |
| `maxTypeLength` | | `10000` | Longest text one `type_text` call accepts. |
| `moveMinMs`, `moveMaxMs` | | `300`, `1000` | Duration range of pointer glides. |
| `typeMinMs`, `typeMaxMs`, `typeCapMs` | | `40`, `120`, `60000` | Pause range per typed character; a text is sped up to finish within the cap. |

The older `WIN_INPUT_*` names (and `WIN_INPUT_MCP_CONFIG`) still work as fallbacks; an `ISPYX_*` variable wins when both are set.

## Tools

| Tool | What it does |
| --- | --- |
| `list_windows` | Visible top-level windows with handle, title, class, process, rectangle, whether allowed (not denylisted) and whether elevated. |
| `list_monitors` | Monitor rectangles and the virtual desktop bounds. |
| `cursor_position` | Current pointer position. |
| `focus_window` | Restore and bring a window to the front. |
| `screenshot_screen` | PNG of one monitor, all monitors, or a region. |
| `screenshot_window` | PNG of one window (also GPU-rendered content), optionally cropped to a region. |
| `click` | Left, right or middle click; double or triple; with held modifiers. |
| `move` | Move the pointer. |
| `mouse_down`, `mouse_up` | Press and release a mouse button. |
| `drag` | Press at one point, glide to another, release. |
| `scroll` | Smooth vertical and/or horizontal wheel, with optional modifiers. |
| `type_text` | Type Unicode text into the focused control at a human pace; refused in password fields. |
| `press_keys` | Key chords such as `ctrl+v`, `alt+tab`, `win+r`. |
| `key_down`, `key_up` | Hold and release keys. |
| `wait` | Pause up to 60 s. |
| `get_clipboard`, `set_clipboard` | Read clipboard text; write text, an image or a file. |

Typical flow: `screenshot_screen`, read coordinates off the image, `click` (with `space: "shot"`) or `type_text`, then `screenshot_screen` to check. Details on coordinates and per-tool behaviour are in [docs/behavior.md](docs/behavior.md).

## Safety notes

- **Alt+Esc** (Option+Esc on macOS) is the emergency stop. It is caught by a low-level keyboard hook, so it does not also cycle windows.
- **Elevated (administrator) windows cannot be controlled**: Windows ignores input from a normal process (UIPI). The server refuses with a plain message; it works if the server itself runs elevated. UAC prompts, the lock screen and Ctrl+Alt+Del run on the secure desktop where no input or capture is possible.
- **Denylist.** Programs on the denylist are never focused, clicked or typed into, and show up as not allowed in `list_windows`. The default covers common password managers.
- **No credentials.** The server never reads, stores or types saved passwords. Typing into password fields is refused.
- **Action log.** Every action, refusal and error is logged locally, including typed text (except text aimed at a password field). Clipboard reads log the length only.
- This tool gives an AI control of your computer. Only connect it to clients you trust, and consider turning on the password gate.

## Platform status

| Platform | Status |
| --- | --- |
| Windows | Supported. |
| macOS | In development, experimental. A signed menu-bar app (`native/macos`, `Ispyx.app`) does the OS work and bundles Node and this server; it has not been verified on a real Mac yet. There is no elevation concept; the stop key is Option+Esc. |
| Linux | Not planned yet. |

## Development

```
git clone https://github.com/murat-mehmet/ispyx
cd ispyx
npm install
node src/server.js
```

Layout:

- `src/core/` shared, platform independent: MCP server and tools, safety guard, input motion, image encoding, password gate, single-instance IPC.
- `src/platform/` the platform layer behind `src/platform/index.js`; the contract is in `src/platform/CONTRACT.md`. `win32/` is the Windows implementation (Win32 through `koffi`, PowerShell helpers).
- `src/effects/` the on-screen animations.
- `native/macos/` the macOS app (Swift).
- `src/server.js` is the entry point (`bin`) and only loads `src/core/server.js`.
- `test/` tests; most drive the real desktop of the machine they run on.

```
npm test              # unit checks (no desktop needed for most)
npm run smoke         # drives the real server against Notepad
npm run motion-test   # pointer glide duration, curvature, exact arrival
npm run typing-test   # typing pace and accuracy
npm run instances-test
npm run shutdown-test
```

See [docs/testing.md](docs/testing.md) for all test scripts. Tests use their own `ISPYX_*`/`WIN_INPUT_*` settings (own stop chord, own pipe) so they never interfere with a server you are using.

## License

Not yet decided. `package.json` currently says `UNLICENSED`.
