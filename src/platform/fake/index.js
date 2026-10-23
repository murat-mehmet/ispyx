// Fake platform: no OS access, everything in memory. Selected with ISPYX_PLATFORM=fake (tests). It exports the
// whole surface of ../CONTRACT.md. Calls that change state are recorded in `calls`, so tests can assert on them.
import os from 'node:os';
import path from 'node:path';

export const name = 'fake';
export const capabilities = { elevation: true };
export const stopLabel = 'Alt+Esc';

/** Everything the core asked the fake to do: [{ fn, args }], oldest first. Tests may reset it with `calls.length = 0`. */
export const calls = [];
const record = (fn, ...args) => { calls.push({ fn, args }); };

/** Every Layer ever created (tests inspect `present` calls and `destroyed`). */
export const layers = [];

export const init = () => {};
export const dataDir = () => path.join(os.tmpdir(), 'ispyx-fake');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- windows, monitors, pointer ----
export const monitors = [
  { left: 0, top: 0, width: 1920, height: 1080, primary: true },
  { left: 1920, top: 0, width: 1920, height: 1080, primary: false },
];
export const windows = [
  { hwnd: 101, title: 'Fake Notepad', className: 'FakeNotepad', pid: 1001, process: 'notepad.exe', elevated: false, minimized: false, rect: { left: 100, top: 100, width: 800, height: 600 } },
  { hwnd: 102, title: 'Fake Browser', className: 'FakeBrowser', pid: 1002, process: 'browser.exe', elevated: false, minimized: false, rect: { left: 1000, top: 200, width: 900, height: 700 } },
  { hwnd: 103, title: 'Fake Second Screen', className: 'FakeApp', pid: 1003, process: 'app.exe', elevated: false, minimized: false, rect: { left: 2000, top: 100, width: 700, height: 500 } },
];
let foreground = 101;
let cursor = { x: 960, y: 540 };
let clipboard = { text: null, formats: [] };

const find = (id) => windows.find((x) => x.hwnd === id);
export const describeWindow = (id) => { const x = find(id); return x ? { ...x, rect: { ...x.rect } } : null; };
export const listWindows = ({ includeUntitled = false } = {}) => windows.filter((x) => includeUntitled || x.title).map((x) => describeWindow(x.hwnd));
export const getRect = (id) => { const x = find(id); return x ? { ...x.rect } : null; };
export const getTitle = (id) => find(id)?.title ?? '';
export const getClass = (id) => find(id)?.className ?? '';
export const getPid = (id) => find(id)?.pid ?? 0;
export const processInfo = (pid) => { const x = windows.find((w) => w.pid === pid); return { name: x?.process ?? '', elevated: x?.elevated ?? false }; };
export const windowExists = (id) => !!find(id);
export const rootWindowAt = (x, y) => windows.find((w) => !w.minimized && x >= w.rect.left && x < w.rect.left + w.rect.width && y >= w.rect.top && y < w.rect.top + w.rect.height)?.hwnd ?? 0;
export const foregroundWindow = () => foreground;
export const bringToForeground = async (id) => { record('bringToForeground', id); if (!find(id)) return false; find(id).minimized = false; foreground = id; return true; };
export const windowDpi = () => 96;
export const selfIsElevated = () => false;
export const isScreenLocked = () => false;
export const focusIsPassword = () => false;
export const foregroundLayout = () => 0x409;
export const listMonitors = () => monitors.map((m) => ({ ...m }));
export const virtualScreen = () => {
  const x = Math.min(...monitors.map((m) => m.left)), y = Math.min(...monitors.map((m) => m.top));
  return { x, y, width: Math.max(...monitors.map((m) => m.left + m.width)) - x, height: Math.max(...monitors.map((m) => m.top + m.height)) - y };
};
export const cursorPos = () => ({ ...cursor });

// ---- input ----
export const mouseMoveTo = (x, y) => { cursor = { x: Math.round(x), y: Math.round(y) }; record('mouseMoveTo', x, y); };
export const mouseDown = (button) => record('mouseDown', button);
export const mouseUp = (button) => record('mouseUp', button);
export const mouseWheel = (notches) => record('mouseWheel', notches);
export const mouseHWheel = (notches) => record('mouseHWheel', notches);
export const typeUnicode = async (text, check = () => {}, delays = []) => {
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    check();
    record('typeUnicode', chars[i]);
    const d = delays[i] ?? 0;
    if (d > 0) await sleep(d);
  }
};
export const keysDown = (codes) => record('keysDown', codes);
export const keysUp = (codes) => record('keysUp', codes);
export const pressVirtualKeys = (codes) => record('pressVirtualKeys', codes);

const NAMED = ['ctrl', 'shift', 'alt', 'enter', 'esc', 'tab', 'space', 'backspace', 'delete', 'home', 'end', 'pageup', 'pagedown', 'left', 'up', 'right', 'down'];
const OS_KEY = ['win', 'cmd', 'meta', 'super'];
export function parseChord(str) {
  return str.trim().split('+').filter(Boolean).map((k) => {
    const key = k.trim().toLowerCase();
    if (OS_KEY.includes(key)) return 'meta';
    if (NAMED.includes(key) || /^f([1-9]|1\d|2[0-4])$/.test(key) || /^[a-z0-9]$/.test(key) || ',.-=/;\'[]\\`'.includes(key) && key.length === 1) return key; // codes are opaque: the key name
    throw new Error(`Unknown key "${k}".`);
  });
}
export const parseSequence = (str) => str.trim().split(/\s+/).filter(Boolean).map(parseChord);
export const insertsContent = (codes) => (codes.includes('ctrl') && codes.includes('v')) || (codes.includes('shift') && codes.includes('insert'));

// ---- screen capture ----
function blank(rect) {
  const width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
  const bits = new Uint8Array(width * height * 4);
  for (let i = 3; i < bits.length; i += 4) bits[i] = 255; // opaque black
  return { bits, width, height, rect: { left: rect.left, top: rect.top, width, height } };
}
export const captureScreenRect = (rect) => blank(rect);
export function captureWindow(id) {
  const r = getRect(id);
  if (!r) throw new Error('That window no longer exists. Call list_windows again.');
  return { ...blank(r), method: 'fake' };
}

// ---- clipboard ----
export const getClipboardText = () => ({ text: clipboard.text, formats: [...clipboard.formats] });
export const setClipboardText = (text) => { clipboard = { text, formats: ['text'] }; record('setClipboardText', text); };
export const setClipboardFile = (file) => { clipboard = { text: null, formats: ['file'] }; record('setClipboardFile', file); };

// ---- stop hotkey ----
export const chordDown = () => false;
export function installStopHotkey(onStop, lingerMs = 30000) {
  let until = 0;
  return { touch() { until = Date.now() + lingerMs; }, get active() { return Date.now() < until; }, stop() { until = 0; }, trigger() { onStop(stopLabel); } };
}

// ---- UI ----
export class Overlay {
  constructor({ enabled = true, hideAfterMs = 0, stopLabel: label = stopLabel } = {}) { this.enabled = enabled; this.hideAfterMs = hideAfterMs; this.stopLabel = label; this.active = false; this.label = ''; }
  begin(label) { this.active = true; this.label = label; record('overlay.begin', label); }
  done() { this.active = false; record('overlay.done'); }
  stop(reason) { this.active = false; record('overlay.stop', reason); }
  cancel(reason) { this.active = false; record('overlay.cancel', reason); }
  async hiddenDuring(fn) { return await fn(); }
}
export const showDialog = async (opts) => { record('showDialog', opts); return { cancel: true, reason: 'closed by the user' }; };
export const ensurePump = () => {};

/** An effect window that only keeps its buffer and records what the effects did to it. */
export class Layer {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.px = new Uint8Array(width * height * 4);
    this.shown = false;
    this.destroyed = false;
    this.everDrawn = false;
    this.presents = []; // { x, y, alpha, height, width, srcY }
    layers.push(this);
  }

  present(x, y, alpha, height = this.height, width = this.width, srcY = 0) {
    if (this.destroyed) throw new Error('Layer was destroyed');
    if (!this.everDrawn && this.px.some((b) => b !== 0)) this.everDrawn = true; // some frame had pixels
    this.presents.push({ x, y, alpha, height, width, srcY });
    this.shown = true;
  }

  destroy() { this.destroyed = true; }
}

/** Deterministic mask: a solid box of 0.6 x height per character with a one pixel margin. */
export function textMask(text, heightPx = 22, weight = 600) {
  const cw = Math.max(1, Math.round(heightPx * 0.6));
  const width = Math.max(1, text.length * cw + 2), height = heightPx + 2;
  const mask = new Uint8Array(width * height);
  for (let c = 0; c < text.length; c++) {
    if (text[c] === ' ') continue;
    for (let y = 1; y < height - 1; y++) for (let x = 1 + c * cw; x < 1 + (c + 1) * cw - 1; x++) mask[y * width + x] = weight >= 600 ? 255 : 180;
  }
  return { width, height, mask };
}
