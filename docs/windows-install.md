# Installing ispyx on Windows

ispyx on Windows is a small resident app that lives in the system tray. It runs on Node.js (no .exe, no installer wizard, no administrator rights).

## One-line install

Open PowerShell (Start menu, type "PowerShell") and run:

```
irm https://raw.githubusercontent.com/murat-mehmet/ispyx/master/scripts/install.ps1 | iex
```

The script prints each step in plain language. It:

1. Looks for Node.js 22 or newer (on PATH, or in `%LOCALAPPDATA%\ispyx\node`). If missing, it installs it for your user only: with `winget` when the package supports a per-user install, otherwise by downloading the official zip from nodejs.org (the latest v22 LTS, checked against the published SHA256) into `%LOCALAPPDATA%\ispyx\node`.
2. Runs `npm install -g ispyx`. With the portable Node it uses `%LOCALAPPDATA%\ispyx\npm` as the npm prefix and adds it (and the Node folder) to your user PATH.
3. Creates an `Ispyx` shortcut on your Desktop (runs minimized).
4. Turns on "start at login" (a `Ispyx` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`) unless that value already exists or you pass `-NoAutostart`. After that, the tray menu controls it.
5. Starts ispyx once and prints how to connect it to your AI app.

It is safe to run again; it only updates what is needed.

### Options

Piping into `iex` cannot pass options. To use them:

```
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/murat-mehmet/ispyx/master/scripts/install.ps1))) -NoAutostart
```

| Switch | Effect |
| --- | --- |
| `-NoAutostart` | Do not enable start at login. |
| `-NoStart` | Do not start ispyx at the end. |
| `-DryRun` | Print what would happen, change nothing. |
| `-Uninstall` | Remove shortcut, start-at-login entry and the npm package. Keeps your data. |
| `-Purge` | With `-Uninstall`: also delete `%APPDATA%\ispyx` (settings, password hash, logs) and `%LOCALAPPDATA%\ispyx` (portable Node and npm folder). |

If you have a local copy: `powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun`.

## Daily use

- Start: double-click the Desktop `Ispyx` shortcut, or run `ispyx` in a terminal. If it is already running, the second start exits silently.
- Tray icon: right-click for the menu (open the panel, start at login on/off, quit).
- Connect an AI app:
  - Claude Code: `claude mcp add ispyx --scope user -- ispyx mcp`
  - Claude Desktop and others: command `ispyx`, args `["mcp"]` in `mcpServers`.
  - If `ispyx` is not found on PATH (for example in a terminal opened before the install), use the full path to `ispyx.cmd`, which the installer prints. On Windows some clients want `cmd /c` in front.
  - `ispyx mcp` starts the tray app automatically if it is not running.
- Update: `ispyx update`.
- Emergency stop: Alt+Esc.

## Uninstall

```
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/murat-mehmet/ispyx/master/scripts/install.ps1))) -Uninstall
```

Add `-Purge` to delete your settings and logs and the portable Node as well. Quit ispyx from the tray first. Manual way: delete the Desktop shortcut, remove the `Ispyx` value from the Run key (or turn off start at login in the tray menu), run `npm uninstall -g ispyx`.

## Manual install

1. Install Node.js 22 or newer from https://nodejs.org (LTS).
2. In a new terminal: `npm i -g ispyx`
3. Run `ispyx`.

## Troubleshooting

**"running scripts is disabled on this system".** `irm ... | iex` does not run a script file, so it is normally not affected. If you saved the file and run it, use `powershell -ExecutionPolicy Bypass -File install.ps1` (applies to that one run only), or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

**Antivirus or SmartScreen complains.** ispyx simulates keyboard and mouse input and captures the screen, which some security products flag as suspicious. The installer is plain text you can read first (`irm <url>` without `| iex` prints it), and everything is installed in your user profile. If your product blocks it, allow the `%LOCALAPPDATA%\ispyx` folder and the Node process, or install manually.

**winget is missing or fails.** The installer falls back to the portable Node download automatically. If the download is blocked (proxy, offline), install Node.js yourself from nodejs.org and run the installer again.

**`ispyx` is not recognized.** PATH changes only reach terminals opened after the install. Open a new terminal, or use the full path to `ispyx.cmd` printed at the end (usually `%APPDATA%\npm\ispyx.cmd`, or `%LOCALAPPDATA%\ispyx\npm\ispyx.cmd` with the portable Node).

**Nothing appears after starting.** Check the hidden-icons arrow next to the clock. Run `ispyx` in a terminal to see errors. Logs and settings are in `%APPDATA%\ispyx`.

**It cannot control some windows (administrator programs).** Windows blocks input from a normal process into an elevated window (UIPI), and the UAC prompt, lock screen and Ctrl+Alt+Del cannot be driven at all. ispyx tells the AI this in plain words. To control elevated windows, start ispyx itself as administrator (for example run `ispyx` from an elevated terminal); the installer deliberately never asks for admin rights.

**Corporate machines.** If policy blocks PowerShell downloads, `npm install`, or Run-key entries, use the manual install and ask IT to allow Node.js.
