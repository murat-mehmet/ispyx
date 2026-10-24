// The resident app (`ispyx --resident`): the one process per user that owns the pipe and does the work.
// Windows model; also runnable on the fake platform for tests. See RESIDENT.md for the whole picture.
//
// Hooks into sibling modules (all optional; a missing one is skipped, never fatal):
//
//   platform.Tray        class, from src/platform/win32/tray.js:
//                          new Tray({ tooltip, onOpen, onQuit, getStatus })   .destroy()
//                        onOpen(): user clicked the icon -> we open the panel. onQuit(): menu "Quit" -> shutdown.
//                        getStatus(): { text, clients, uptimeMs, stopLabel, effectsEnabled }, polled for the menu.
//   platform.autostart   { get(): boolean, set(bool): void }, from src/platform/win32/autostart.js
//   ./panel/index.js     startPanel({ getState, actions }) -> { url, close() }   (local web panel)
//
//   getState() -> { version, platform, pid, uptimeMs, clients, recent: [{ time, tool, summary }],
//                   stopLabel, effectsEnabled, passwordSet, denylist, autostart, connect (win32) }
//   actions    -> { quit(), setAutostart(bool), setEffects(bool), clearRecent(), showConfigFile() }
//
// Control calls over the pipe (names start with "__", handled here, never reach the tools):
//   __ping -> 'pong'      __panel -> panel url ('' if none)      __quit -> 'bye' and the resident shuts down.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { saveUserConfig } from './guard.js';
import { PasswordError } from './auth.js';

/** A refusal whose message goes to the person at the panel. */
class PanelError extends PasswordError {}

const MAX_RECENT = 200; // older calls are only in the action log
const MAX_LOG = 256 * 1024;
export const recent = [];
let totalCalls = 0; // since this resident started

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).version; } catch { return '0.0.0'; }
})();

/** Short, secret-free description of a call for the panel (typed text only as a length). */
export function summarize(name, args = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') parts.push(`${k}=${(name === 'type_text' || name === 'set_clipboard') ? v.length + ' chars' : JSON.stringify(v.slice(0, 40))}`);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${v}`);
  }
  return parts.join(' ').slice(0, 100);
}

export function recordCall(name, args) {
  totalCalls++;
  recent.unshift({ time: Date.now(), tool: name, summary: summarize(name, args) });
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
}

/** Sends stdout/stderr/uncaught errors to the log file (the resident has no console). Small rotation: .log -> .log.1 */
export function setupLogging(dir) {
  let file;
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'ispyx.log');
    try { if (fs.statSync(file).size > MAX_LOG) fs.renameSync(file, file + '.1'); } catch { /* none yet */ }
  } catch { return null; }
  const write = (level, parts) => {
    const msg = parts.map((p) => (p instanceof Error ? p.stack : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    try { fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${msg}\n`); } catch { /* nowhere to report */ }
  };
  for (const [fn, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) console[fn] = (...a) => write(level, a);
  process.stdout.write = (s) => { write('out', [String(s).trimEnd()]); return true; };
  process.stderr.write = (s) => { write('err', [String(s).trimEnd()]); return true; };
  process.on('uncaughtException', (e) => write('fatal', [e]));
  process.on('unhandledRejection', (e) => write('rejection', [e]));
  write('info', [`resident start pid=${process.pid} v${VERSION}`]);
  return { file, write };
}

/** Windows: how to connect an AI app (shown in the panel). Claude Desktop reads %APPDATA%\Claude\claude_desktop_config.json. */
function connectInfo() {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  return {
    claudeCodeCommand: 'claude mcp add ispyx --scope user -- ispyx mcp',
    desktopConfigJson: JSON.stringify({ mcpServers: { ispyx: { command: 'ispyx', args: ['mcp'] } } }, null, 2),
    desktopConfigPath: path.join(appData, 'Claude', 'claude_desktop_config.json'),
  };
}

/** Explorer with the file selected, or its folder when the file is not there yet. */
function revealFile(file) {
  const exists = (f) => { try { return fs.existsSync(f); } catch { return false; } };
  const args = exists(file) ? [`/select,${file}`] : exists(path.dirname(file)) ? [path.dirname(file)] : null;
  if (!args) return false;
  const c = spawn('explorer.exe', args, { stdio: 'ignore', detached: true });
  c.on('error', () => {});
  c.unref();
  return true;
}

const PANEL_IDLE_MS = 120000; // the open page polls every second (a hidden window is throttled to ~1/min); longer than that: gone

/** Shows the panel as an app-style window (no tabs or address bar) when Edge is there, else in the default browser. */
function openUrl(url) {
  const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)
    .map((d) => `${d}\\Microsoft\\Edge\\Application\\msedge.exe`).find((p) => fs.existsSync(p));
  const c = edge
    ? spawn(edge, [`--app=${url}`], { windowsHide: false, stdio: 'ignore', detached: true })
    : spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, stdio: 'ignore', detached: true });
  c.on('error', () => {});
  c.unref();
}

const safe = (fn, dflt) => { try { return fn(); } catch { return dflt; } };

/**
 * The part of the panel that lives in the server, the same on every platform: activity, effects, password and
 * denylist. ctx: { w (platform), config, owner, guard, auth, scan, clients() }. Windows wraps it in startResident
 * (tray, autostart, connect info); on macOS Ispyx.app shows the panel and asks the owner for this part over its
 * socket (platform/darwin servePanel), adding permissions, autostart and connect info itself.
 */
export function panelModel(ctx) {
  const { w, config, guard, auth, scan, clients } = ctx;
  const t0 = Date.now();
  const save = (patch) => {
    try { saveUserConfig(patch); } catch (e) { throw new PanelError(`Could not save the setting: ${e.message}`); }
  };
  const getState = () => ({
    version: VERSION,
    platform: w.name,
    pid: process.pid,
    uptimeMs: Date.now() - t0,
    clients: clients(),
    recent: recent.slice(),
    recentTotal: totalCalls,
    stopLabel: guard.stopLabel,
    effectsEnabled: !!scan.enabled,
    passwordSet: safe(() => auth.passwordSet(), false),
    authRequired: !!config.auth,
    denylist: config.denylist.slice(),
  });
  const actions = {
    setEffects: (on) => { scan.enabled = !!on; config.animations = !!on; save({ animations: !!on }); return !!on; },
    setPassword: ({ current, next } = {}) => { auth.setPassword(next, current); },
    // Turning the requirement on needs a password to exist; turning it off needs the current one.
    setAuthRequired: ({ on, current } = {}) => {
      if (on) {
        if (!auth.passwordSet()) throw new PanelError('Set a password first.');
      } else if (auth.passwordSet() && !auth.verify(current)) throw new PanelError('The password is wrong.');
      auth.enabled = config.auth = !!on;
      save({ auth: !!on });
    },
    addDeny: (value) => {
      const name = String(value ?? '').trim().toLowerCase();
      if (!/^[\w][\w .()+-]{0,79}$/.test(name)) throw new PanelError(w.name === 'darwin' ? 'Use an app name such as KeePassXC.' : 'Use a process name such as keepass.exe.');
      if (config.denylist.includes(name)) throw new PanelError('Already on the list.');
      config.denylist.push(name);
      save({ denylist: config.denylist.slice() });
    },
    // Taking a program off the list lowers protection, so it asks for the password when one is set.
    removeDeny: ({ name, current } = {}) => {
      if (auth.passwordSet() && !auth.verify(current)) throw new PanelError('The password is wrong.');
      const i = config.denylist.indexOf(String(name ?? '').toLowerCase());
      if (i < 0) return;
      config.denylist.splice(i, 1);
      save({ denylist: config.denylist.slice() });
    },
    clearRecent: () => { recent.length = 0; },
  };
  return { getState, actions };
}

/**
 * Starts tray, panel and the idle watchdog. ctx: { w (platform), config, owner, guard, auth, scan, shutdown(), log }.
 * Returns { panelUrl(), stop() }.
 */
export async function startResident(ctx) {
  const { w, owner, shutdown, log } = ctx;
  let lastActive = Date.now();
  const autostart = w.autostart ?? (w.name === 'win32' ? (await import('../platform/win32/autostart.js').catch(() => null))?.autostart ?? null : null);

  const model = panelModel({ ...ctx, clients: () => owner.watchers() });
  const getState = () => ({
    ...model.getState(),
    autostart: safe(() => !!autostart?.get(), false),
    ...(w.name === 'win32' ? { connect: connectInfo() } : {}),
  });
  const actions = {
    ...model.actions,
    quit: () => shutdown(),
    setAutostart: (on) => { autostart?.set(!!on); return safe(() => !!autostart?.get(), false); },
    showConfigFile: () => revealFile(connectInfo().desktopConfigPath),
    openLog: () => { if (log?.file) { const c = spawn('notepad.exe', [log.file], { stdio: 'ignore', detached: true }); c.on('error', () => {}); c.unref(); } },
  };

  // The panel (a loopback web page) exists only while its window is open: started on "Open", closed when the page
  // stops polling (window closed), so the resident normally holds no listening port.
  let panel = null, starting = null, lastPoll = 0, panelTimer = null;
  const closePanel = () => {
    if (panelTimer) { clearInterval(panelTimer); panelTimer = null; }
    try { panel?.close(); } catch { /* ignore */ }
    panel = null;
  };
  // Quitting must not leave an orphaned window behind: ask the app-style Edge window (class Chrome_WidgetWin_1,
  // titled "Ispyx") to close. The page also tries window.close() itself when it loses the connection.
  const panelWindows = () => {
    if (w.name !== 'win32') return [];
    try { return w.listWindows().filter((x) => x.title === 'Ispyx' && /^(msedge|chrome|brave)\.exe$/i.test(x.process)); } catch { return []; }
  };
  const closePanelWindow = () => {
    for (const x of panelWindows()) w._raw?.PostMessageW?.(x.hwnd, 0x10 /* WM_CLOSE */, 0, 0);
  };
  const openPanel = async () => {
    try {
      if (!panel) {
        starting ??= (async () => {
          const mod = await import('./panel/index.js').catch(() => null);
          lastPoll = Date.now();
          panel = (await mod?.startPanel?.({ getState: () => { lastPoll = Date.now(); return getState(); }, actions })) ?? null;
          if (panel) {
            panelTimer = setInterval(() => { if (Date.now() - lastPoll > PANEL_IDLE_MS) closePanel(); }, 5000);
            panelTimer.unref?.();
          }
        })().finally(() => { starting = null; });
        await starting;
      }
      lastPoll = Date.now();
      // already open: bring that window to the front instead of opening another one
      const open = panelWindows();
      if (open.length && w.bringToForeground) { await w.bringToForeground(open[0].hwnd); return; }
      if (panel?.url) openUrl(panel.url);
    } catch (e) { log?.write('error', ['panel failed:', e]); }
  };

  // macOS: Ispyx.app shows the panel and asks for this state (it adds permissions, start at login, connect info)
  const stopServing = w.servePanel?.({ getState, actions });

  let tray = null;
  try {
    const Tray = w.Tray ?? (w.name === 'win32' ? (await import('../platform/win32/tray.js').catch(() => null))?.Tray : null);
    if (Tray) {
      tray = new Tray({
        tooltip: 'ispyx',
        onOpen: openPanel,
        onQuit: () => shutdown(),
        getStatus: () => { const s = getState(); return { text: `ispyx - ${s.clients} client${s.clients === 1 ? '' : 's'}`, clients: s.clients, uptimeMs: s.uptimeMs, stopLabel: s.stopLabel, effectsEnabled: s.effectsEnabled }; },
      });
    }
  } catch (e) { log?.write('error', ['tray failed:', e]); }

  // test/cleanup aid: with ISPYX_IDLE_EXIT_MS the resident leaves once no `ispyx mcp` is connected for that long
  const idleMs = Number(process.env.ISPYX_IDLE_EXIT_MS) || 0;
  let timer = null;
  if (idleMs > 0) {
    timer = setInterval(() => {
      if (owner.watchers() > 0 || owner.clients() > 0) lastActive = Date.now();
      else if (Date.now() - lastActive > idleMs) shutdown();
    }, 500);
    timer.unref?.();
  }

  return {
    panelUrl: () => panel?.url ?? '',
    openPanel,
    touch: () => { lastActive = Date.now(); },
    stop: () => {
      if (timer) clearInterval(timer);
      stopServing?.();
      try { tray?.destroy(); } catch { /* ignore */ }
      closePanel();
      closePanelWindow();
    },
  };
}
