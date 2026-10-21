// Safety layer: config, process allowlist, kill switch, action log.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as w from './win32.js';
import { chordDown } from './hotkey.js';
import { parseChord } from './keys.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class ToolError extends Error {}

const DEFAULTS = {
  // global: true  -> act anywhere on the desktop (denylist still applies)
  // global: false -> act only inside windows of the allowlisted programs
  global: true,
  allowlist: ['chrome.exe', 'msedge.exe'],
  denylist: ['keepass.exe', 'keepassxc.exe', '1password.exe', 'bitwarden.exe'],
  logPath: path.join(ROOT, 'logs', 'actions.jsonl'),
  killCornerPx: 2,
  stopChord: 'alt+esc', // emergency stop keys (env WIN_INPUT_STOP_CHORD, meant for tests)
  overlay: true, // banner on screen while a tool runs
  humanMotion: true, // pointer glides along a curve instead of jumping
  humanTyping: true, // type one character at a time at a human pace
  typeMinMs: 60,
  typeMaxMs: 200,
  typeCapMs: 60000, // longer texts are sped up to finish within this
  moveMinMs: 300,
  moveMaxMs: 1000,
  maxTypeLength: 10000,
};

export function loadConfig(env = process.env) {
  let cfg = { ...DEFAULTS };
  const file = env.WIN_INPUT_MCP_CONFIG || path.join(ROOT, 'config.json');
  if (fs.existsSync(file)) {
    try {
      cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (e) {
      throw new Error(`Config file ${file} is not valid JSON: ${e.message}`);
    }
  }
  if (env.WIN_INPUT_ALLOWLIST) {
    cfg.allowlist = env.WIN_INPUT_ALLOWLIST.split(',');
    cfg.global = false; // naming an allowlist in the environment means "restrict to these"
  }
  if (env.WIN_INPUT_DENYLIST) cfg.denylist = env.WIN_INPUT_DENYLIST.split(',');
  if (env.WIN_INPUT_GLOBAL) cfg.global = !/^(0|false|no)$/i.test(env.WIN_INPUT_GLOBAL);
  cfg.global = !!cfg.global;
  // test-only knobs: let a test server use a different corner size / stop chord, so tests never have to
  // move the real pointer to (0,0) or press Alt+Esc, which would also trip every other running server
  if (env.WIN_INPUT_KILL_CORNER_PX) cfg.killCornerPx = Number(env.WIN_INPUT_KILL_CORNER_PX);
  if (env.WIN_INPUT_STOP_CHORD) cfg.stopChord = env.WIN_INPUT_STOP_CHORD;
  if (env.WIN_INPUT_HUMAN_TYPING) cfg.humanTyping = !/^(0|false|no)$/i.test(env.WIN_INPUT_HUMAN_TYPING);
  if (env.WIN_INPUT_OVERLAY) cfg.overlay = !/^(0|false|no)$/i.test(env.WIN_INPUT_OVERLAY);
  if (env.WIN_INPUT_HUMAN_MOTION) cfg.humanMotion = !/^(0|false|no)$/i.test(env.WIN_INPUT_HUMAN_MOTION);
  cfg.denylist = cfg.denylist.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (env.WIN_INPUT_LOG) cfg.logPath = env.WIN_INPUT_LOG;
  cfg.allowlist = cfg.allowlist.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  cfg.logPath = path.resolve(ROOT, cfg.logPath);
  return cfg;
}

export class Guard {
  constructor(config) {
    this.config = config;
    this.killed = false;
    this.killReason = '';
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

  /** Watch the pointer so a quick flick into the corner between two actions is not missed. */
  startWatching() {
    const t = setInterval(() => {
      try { this.checkKill(); } catch { /* latched */ }
    }, 15);
    t.unref();
  }

  inCorner(x, y) {
    const n = this.config.killCornerPx;
    return x <= n && y <= n;
  }

  /** Latch the kill switch: everything stops, held keys/buttons are released, later calls fail. */
  trigger(reason) {
    if (this.killed) return;
    this.killed = true;
    this.killReason = reason;
    this.log({ tool: 'kill_switch', note: reason });
    this.releaseAll();
    this.overlay?.stop(reason);
  }

  checkKill() {
    if (!this.killed) {
      const p = w.cursorPos();
      if (this.inCorner(p.x, p.y)) this.trigger('mouse in top-left corner');
      else if (!this.heldKeys.has(this.stopVks[this.stopVks.length - 1]) && chordDown(this.stopVks)) this.trigger(this.stopLabel);
    }
    if (this.killed) {
      throw new ToolError(this.killReason === this.stopLabel
        ? `STOPPED BY THE USER (${this.stopLabel}). Stop all work now and do not retry; tell the user you were stopped. Every action is refused until the server is restarted.`
        : 'STOPPED BY THE USER (mouse moved into the top-left screen corner). Stop all work now and do not retry; tell the user you were stopped. Every action is refused until the server is restarted.');
    }
  }

  checkSession() {
    if (w.isScreenLocked()) throw new ToolError('The screen is locked (or a secure prompt is showing), so no input can be sent or captured. Unlock it and try again.');
  }

  denied(win) {
    return !!win.process && this.config.denylist.includes(win.process);
  }

  allowed(win) {
    if (this.denied(win)) return false;
    if (this.config.global) return true;
    return !!win.process && this.config.allowlist.includes(win.process);
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
    if (!this.allowed(win)) {
      throw new ToolError(`Refused: "${win.title}" belongs to ${win.process}, which is not on the allowlist (${this.config.allowlist.join(', ')}).`);
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
      return hits.find((x) => this.allowed(x)) || hits[0];
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
    if (this.inCorner(sx, sy)) throw new ToolError('That point is inside the top-left kill-switch corner; refused.');
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
    if (this.inCorner(sx, sy)) throw new ToolError('That point is inside the top-left kill-switch corner; refused.');
    return { sx, sy };
  }

  /** Whatever window sits under a screen point must be usable (allow/deny lists, elevation). */
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
    if (!this.config.global) this.assertUsable(win, { needVisible: false });
    const ok = await w.bringToForeground(win.hwnd);
    if (!ok) {
      throw new ToolError(`Windows refused to bring "${win.title}" to the front (foreground lock). Click the window yourself once, then retry.`);
    }
    this.lastWindow = win.hwnd;
  }

  /** Make `win` the foreground window and verify the allowlist against what is really in front. */
  async prepareKeyboard(win) {
    await this.focus(win);
    const fg = w.describeWindow(w.foregroundWindow());
    this.assertUsable(fg);
  }

  log(entry) {
    try {
      fs.appendFileSync(this.config.logPath, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
    } catch (e) {
      process.stderr.write(`win-input-mcp: could not write action log: ${e.message}\n`);
    }
  }
}

export const winSummary = (x) => (x ? { hwnd: x.hwnd, title: x.title, process: x.process } : null);
