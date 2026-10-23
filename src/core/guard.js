// Safety layer: config, process denylist, emergency stop, action log.
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import w from '../platform/index.js';
const { chordDown, parseChord } = w;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export class ToolError extends Error {}

const DEFAULTS = {
  // acts anywhere on the desktop; only the denylist (password managers) is refused
  denylist: ['keepass.exe', 'keepassxc.exe', '1password.exe', 'bitwarden.exe'],
  logPath: path.join(ROOT, 'logs', 'actions.jsonl'),
  stopChord: 'alt+esc', // emergency stop keys (env WIN_INPUT_STOP_CHORD, meant for tests)
  overlay: true, // banner on screen while a tool runs
  animations: true, // eye + scan line after a screenshot (the next call waits for it)
  typeSpeed: 1, // default speed multiplier for typing waits (2 = half the waits, 0 = fixed 8 ms); env WIN_INPUT_TYPE_SPEED
  typeMinMs: 40,
  typeMaxMs: 120,
  typeCapMs: 60000, // longer texts are sped up to finish within this
  moveMinMs: 300,
  moveMaxMs: 1000,
  maxTypeLength: 10000,
  auth: false, // ask for a password (src/auth.js) before the first tool call; env WIN_INPUT_AUTH
  authFile: '', // where the password hash and unlock time live; default %APPDATA%\ispyx\auth.json
};

/**
 * Reads a setting from the environment: ISPYX_<NAME> wins, the old WIN_INPUT_<NAME> is the fallback.
 * (The old config variable was WIN_INPUT_MCP_CONFIG; ISPYX_CONFIG falls back to it.)
 */
export function env(name, source = process.env) {
  const v = source[`ISPYX_${name}`];
  if (v !== undefined && v !== '') return v;
  const old = source[`WIN_INPUT_${name}`] ?? (name === 'CONFIG' ? source.WIN_INPUT_MCP_CONFIG : undefined);
  return old === '' ? undefined : old;
}

export function loadConfig(source = process.env) {
  const e = (name) => env(name, source);
  let cfg = { ...DEFAULTS };
  const file = e('CONFIG') || path.join(ROOT, 'config.json');
  if (fs.existsSync(file)) {
    try {
      cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (e) {
      throw new Error(`Config file ${file} is not valid JSON: ${e.message}`);
    }
  }
  if (e('DENYLIST')) cfg.denylist = e('DENYLIST').split(',');
  // test-only knob: lets a test server use its own stop chord, so tests never press Alt+Esc,
  // which would also stop every other running server
  if (e('STOP_CHORD')) cfg.stopChord = e('STOP_CHORD');
  if (e('AUTH')) cfg.auth = !/^(0|false|no)$/i.test(e('AUTH'));
  if (e('AUTH_FILE')) cfg.authFile = e('AUTH_FILE');
  if (e('TYPE_SPEED')) cfg.typeSpeed = Number(e('TYPE_SPEED'));
  if (e('OVERLAY')) cfg.overlay = !/^(0|false|no)$/i.test(e('OVERLAY'));
  if (e('ANIMATIONS')) cfg.animations = !/^(0|false|no)$/i.test(e('ANIMATIONS'));
  cfg.denylist = cfg.denylist.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (e('LOG')) cfg.logPath = e('LOG');
  cfg.logPath = path.resolve(ROOT, cfg.logPath);
  return cfg;
}

export const callContext = new AsyncLocalStorage(); // { epoch } of the tool call being served
const SHUTDOWN_WINDOW_MS = 5000;

export class Guard {
  constructor(config) {
    this.config = config;
    this.epoch = 0; // bumped by every stop press; a call that started under an older epoch is cancelled
    this.lastStopAt = 0;
    this.chordSeen = false;
    this.onShutdown = () => process.exit(0);
    this.stopVks = parseChord(config.stopChord);
    this.stopLabel = config.stopChord.split('+').map((s) => s[0].toUpperCase() + s.slice(1)).join('+');
    this.stopIsDefault = config.stopChord === 'alt+esc';
    this.overlay = null;
    this.lastWindow = 0;
    this.shots = new Map(); // hwnd -> { scale, ox, oy } of the last window screenshot (ox/oy: crop origin in window pixels)
    this.lastShot = null; // { rect, scale } of the last global screenshot
    this.heldKeys = new Set();
    this.heldButtons = new Set();
    fs.mkdirSync(path.dirname(config.logPath), { recursive: true });
  }

  /** Poll the stop chord, as a fallback for moments when the keyboard hook is not serviced. */
  startWatching() {
    const t = setInterval(() => this.pollChord(), 15);
    t.unref();
  }

  /** One physical press of the chord seen by polling (edge only, so holding the keys counts once). */
  pollChord() {
    const down = chordDown(this.stopVks) && !this.heldKeys.has(this.stopVks[this.stopVks.length - 1]);
    if (down && !this.chordSeen) this.trigger(this.stopLabel);
    this.chordSeen = down;
  }

  /**
   * The user pressed the stop chord. First press: cancel every running or queued call (the next call works
   * normally). A second press within SHUTDOWN_WINDOW_MS: release everything and shut this server down.
   */
  trigger(reason) {
    const now = Date.now();
    if (now - this.lastStopAt < 250) return; // hook and polling saw the same press
    const second = this.lastStopAt && now - this.lastStopAt < SHUTDOWN_WINDOW_MS;
    this.lastStopAt = now;
    this.chordSeen = true;
    this.epoch++;
    this.releaseAll();
    if (second) {
      this.log({ tool: 'kill_switch', note: reason + ' twice: shutting down' });
      this.overlay?.stop('shutting down');
      setTimeout(() => this.onShutdown(), 1200);
    } else {
      this.log({ tool: 'kill_switch', note: reason + ': cancelled' });
      this.overlay?.cancel(reason, SHUTDOWN_WINDOW_MS);
    }
  }

  /** Throws when the user pressed the stop chord since the current call was received. */
  checkKill() {
    this.pollChord();
    const ctx = callContext.getStore();
    if (ctx && ctx.epoch !== this.epoch) {
      throw new ToolError(`CANCELLED BY THE USER (${this.stopLabel}). The action was interrupted. Stop what you were doing and tell the user; carry on only if they ask. ` +
        `(Pressing ${this.stopLabel} again within ${SHUTDOWN_WINDOW_MS / 1000} s shuts the server down.)`);
    }
  }

  checkSession() {
    if (w.isScreenLocked()) throw new ToolError('The screen is locked (or a secure prompt is showing), so no input can be sent or captured. Unlock it and try again.');
  }

  denied(win) {
    return !!win.process && this.config.denylist.includes(win.process);
  }

  /** Release anything this server still holds down (kill switch, shutdown, errors). */
  releaseAll() {
    try {
      if (this.heldKeys.size) w.keysUp([...this.heldKeys]);
      for (const b of this.heldButtons) w.mouseUp(b);
    } catch { /* nothing more to do */ }
    this.heldKeys.clear();
    this.heldButtons.clear();
  }

  /** Throws a plain error unless the window may be acted on. */
  assertUsable(win, { needVisible = true } = {}) {
    if (!win.process) {
      throw new ToolError(`Cannot identify the program that owns "${win.title}"; it may be elevated. Refused.`);
    }
    if (this.denied(win)) {
      throw new ToolError(`Refused: "${win.title}" belongs to ${win.process}, which is on the denylist.`);
    }
    if (win.elevated && !w.selfIsElevated()) {
      throw new ToolError(`"${win.title}" is running as administrator, and Windows blocks input from a normal program to an elevated window. Run it without elevation, or start this server elevated.`);
    }
    if (needVisible && win.minimized) {
      throw new ToolError(`"${win.title}" is minimized. Use focus_window first.`);
    }
  }

  /** Resolve {hwnd,title} (or the last used window) to a described window. */
  resolve({ hwnd, title } = {}) {
    if (hwnd) {
      if (!w.windowExists(hwnd)) throw new ToolError(`Window ${hwnd} no longer exists.`);
      return w.describeWindow(hwnd);
    }
    if (title) {
      const q = title.toLowerCase();
      const hits = w.listWindows().filter((x) => x.title.toLowerCase().includes(q));
      if (!hits.length) throw new ToolError(`No visible window title contains "${title}". Call list_windows to see what is open.`);
      return hits.find((x) => !this.denied(x)) || hits[0];
    }
    if (this.lastWindow && w.windowExists(this.lastWindow)) return w.describeWindow(this.lastWindow);
    const fg = w.foregroundWindow();
    if (fg) return w.describeWindow(fg);
    throw new ToolError('No window given. Pass hwnd or title, or use list_windows first.');
  }

  /** Window-relative screenshot pixels -> absolute screen pixels, with safety checks. */
  toScreen(win, x, y, { scale } = {}) {
    const rect = w.getRect(win.hwnd);
    if (!rect) throw new ToolError(`Cannot read the position of "${win.title}".`);
    const shot = this.shots.get(win.hwnd) || { scale: 1, ox: 0, oy: 0 };
    const s = scale || shot.scale;
    const sx = Math.round(rect.left + shot.ox + x / s);
    const sy = Math.round(rect.top + shot.oy + y / s);
    if (sx < rect.left || sy < rect.top || sx >= rect.left + rect.width || sy >= rect.top + rect.height) {
      throw new ToolError(`Point (${x}, ${y}) is outside "${win.title}" (window is ${Math.round(rect.width)}x${Math.round(rect.height)} px).`);
    }
    return { sx, sy, rect, scale: s };
  }

  /** Absolute / last-screenshot coordinates -> virtual-desktop pixels, with safety checks. */
  toScreenGlobal(x, y, space) {
    let sx = x;
    let sy = y;
    if (space === 'shot') {
      if (!this.lastShot) throw new ToolError('No screenshot_screen taken yet, so there is nothing to map "shot" coordinates from.');
      sx = this.lastShot.rect.left + x / this.lastShot.scale;
      sy = this.lastShot.rect.top + y / this.lastShot.scale;
    }
    sx = Math.round(sx);
    sy = Math.round(sy);
    const v = w.virtualScreen();
    if (sx < v.x || sy < v.y || sx >= v.x + v.width || sy >= v.y + v.height) {
      throw new ToolError(`Point (${sx}, ${sy}) is outside the desktop (${v.x},${v.y} to ${v.x + v.width - 1},${v.y + v.height - 1}).`);
    }
    return { sx, sy };
  }

  /** Whatever window sits under a screen point must be usable (denylist, elevation). */
  assertPointUsable(sx, sy) {
    const top = w.rootWindowAt(sx, sy);
    if (!top) return null;
    const o = w.describeWindow(top);
    this.assertUsable(o, { needVisible: false });
    return o;
  }

  /** The point must really belong to the target window, not to something covering it. */
  assertPointOwned(win, sx, sy) {
    const top = w.rootWindowAt(sx, sy);
    if (top !== win.hwnd) {
      const o = top ? w.describeWindow(top) : null;
      throw new ToolError(`At that point another window is in front ("${o ? o.title : 'unknown'}"). Focus "${win.title}" or move the covering window first.`);
    }
  }

  async focus(win) {
    if (this.denied(win)) this.assertUsable(win, { needVisible: false });
    const ok = await w.bringToForeground(win.hwnd);
    if (!ok) {
      throw new ToolError(`Windows refused to bring "${win.title}" to the front (foreground lock). Click the window yourself once, then retry.`);
    }
    this.lastWindow = win.hwnd;
  }

  /** Make `win` the foreground window and verify the denylist against what is really in front. */
  async prepareKeyboard(win) {
    await this.focus(win);
    const fg = w.describeWindow(w.foregroundWindow());
    this.assertUsable(fg);
  }

  log(entry) {
    try {
      fs.appendFileSync(this.config.logPath, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
    } catch (e) {
      process.stderr.write(`ispyx: could not write action log: ${e.message}\n`);
    }
  }
}

export const winSummary = (x) => (x ? { hwnd: x.hwnd, title: x.title, process: x.process } : null);
