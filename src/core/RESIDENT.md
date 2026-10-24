# Resident model (Windows)

On Windows ispyx is one resident app per user, like `Ispyx.app` on macOS. macOS, Linux and the fake platform keep the
classic model (every process is an MCP server, one of them owns the pipe); nothing below applies to them unless a
process is started with an explicit `--resident` / `mcp` argument (used by tests with `ISPYX_PLATFORM=fake`).

| Command | Role |
|---|---|
| `ispyx` (console / shortcut) | Launcher. If a resident answers on the pipe: open the panel and exit. Otherwise start `ispyx --resident` detached and hidden, wait up to 10 s, open the panel, exit. |
| `ispyx --resident` | The single owner of the pipe (`ipc.listenOwner`). Runs the guard, stop hotkey, effects, tool queue, tray and panel. No stdio. A second resident finds the pipe taken and exits at once (code 0). |
| `ispyx mcp` | Thin stdio MCP server: same tool list and schemas, every call forwarded with `callOwner`. If no resident runs it starts one first (up to 10 s). If the resident dies mid-call the call returns a tool error. Keeps a watch connection so the resident's shutdown (second stop press, tray Quit) also ends it. |
| `ispyx quit` | Ask the resident to exit. |
| `ispyx` without a console on stdin | Old MCP registration pointing at `src/server.js`: behaves as `mcp`. |

Mode selection is `src/core/mode.js`. Start/reach helpers are `src/core/launcher.js`; resident extras are
`src/core/resident.js`.

Logging: the resident writes nothing to stdout; stdout, stderr, `console.*` and uncaught errors go to
`%APPDATA%\ispyx\ispyx.log` (rotated to `ispyx.log.1` at start when over 256 KB). The action log is unchanged.

## Contracts with sibling modules

All optional: a missing module is skipped.

- `platform.Tray` (`src/platform/win32/tray.js`): `new Tray({ tooltip, onOpen, onQuit, getStatus })`, `.destroy()`.
  `onOpen()` opens the panel in the default browser; `onQuit()` runs the shutdown-all path (tell every `mcp`
  process to exit, release held keys, exit). `getStatus()` returns `{ text, clients, uptimeMs, stopLabel, effectsEnabled }`.
- `platform.autostart` (`src/platform/win32/autostart.js`): `{ get(): boolean, set(bool): void }`.
- `src/core/panel/index.js`: `startPanel({ getState, actions })` returns `{ url, close() }` (may be a promise).
- `getState()` returns `{ version, platform, pid, uptimeMs, clients, recent: [{ time, tool, summary }], stopLabel,
  effectsEnabled, passwordSet, denylist, autostart }`. `clients` is the number of connected `ispyx mcp` processes;
  `recent` is the last 50 tool calls, newest first (typed text appears only as a length).
- `actions` is `{ quit(), setAutostart(bool), setEffects(bool), clearRecent() }`.

## Control calls

Over the pipe, names starting with `__` are handled by the resident and never reach tools: `__ping` (`'pong'`),
`__panel` (opens the panel window; it is started on demand and closed again two minutes after its window is gone), `__quit` (shuts down).

## Environment

`ISPYX_IDLE_EXIT_MS`: the resident exits when no `mcp` process has been connected for that many ms. Unset (default)
means it never does; tests set it so an auto-started resident does not outlive them.
