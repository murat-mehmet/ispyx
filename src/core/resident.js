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
//                   stopLabel, effectsEnabled, passwordSet, denylist, autostart }
//   actions    -> { quit(), setAutostart(bool), setEffects(bool), clearRecent() }
//
// Control calls over the pipe (names start with "__", handled here, never reach the tools):
//   __ping -> 'pong'      __panel -> panel url ('' if none)      __quit -> 'bye' and the resident shuts down.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_RECENT = 50;
const MAX_LOG = 256 * 1024;
export const recent = [];

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

function openUrl(url) {
  const c = spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, stdio: 'ignore', detached: true });
  c.on('error', () => {});
  c.unref();
}

/**
 * Starts tray, panel and the idle watchdog. ctx: { w (platform), config, owner, guard, auth, scan, shutdown(), log }.
 * Returns { panelUrl(), stop() }.
 */
export async function startResident(ctx) {
  const { w, config, owner, guard, auth, scan, shutdown, log } = ctx;
  const t0 = Date.now();
  let lastActive = Date.now();
  const autostart = w.autostart ?? (w.name === 'win32' ? (await import('../platform/win32/autostart.js').catch(() => null))?.autostart ?? null : null);

  const safe = (fn, dflt) => { try { return fn(); } catch { return dflt; } };
  const getState = () => ({
    version: VERSION,
    platform: w.name,
    pid: process.pid,
    uptimeMs: Date.now() - t0,
    clients: owner.watchers(),
    recent: recent.slice(),
    stopLabel: guard.stopLabel,
    effectsEnabled: !!scan.enabled,
    passwordSet: safe(() => !!auth.read().hash, false),
    denylist: config.denylist.slice(),
    autostart: safe(() => !!autostart?.get(), false),
  });
  const actions = {
    quit: () => shutdown(),
    setAutostart: (on) => { autostart?.set(!!on); return safe(() => !!autostart?.get(), false); },
    setEffects: (on) => { scan.enabled = !!on; config.animations = !!on; return !!on; },
    clearRecent: () => { recent.length = 0; },
  };

  let panel = null;
  try {
    const mod = await import('./panel/index.js').catch(() => null);
    panel = (await mod?.startPanel?.({ getState, actions })) ?? null;
  } catch (e) { log?.write('error', ['panel failed:', e]); }
  const openPanel = () => { if (panel?.url) openUrl(panel.url); };

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
    touch: () => { lastActive = Date.now(); },
    stop: () => {
      if (timer) clearInterval(timer);
      try { tray?.destroy(); } catch { /* ignore */ }
      try { panel?.close(); } catch { /* ignore */ }
    },
  };
}
