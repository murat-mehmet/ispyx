// macOS platform layer: the API every platform exports (see ../CONTRACT.md), implemented by forwarding to
// Ispyx.app over its unix socket (see PROTOCOL.md). Nothing here touches the OS directly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callSync, callAsync } from './rpc.js';

export { chordDown, installStopHotkey, HOOK_LINGER_MS } from './hotkey.js';
export { Overlay } from './overlay.js';
export { parseChord, parseSequence, insertsContent } from './keys.js';
export { Layer, textMask } from './layer.js';
export { onEvent } from './rpc.js';
export { servePanel } from './panel.js';

export const name = 'darwin';
export const capabilities = { elevation: false };
export const stopLabel = 'Option+Esc';

export const dataDir = () => path.join(os.homedir(), 'Library', 'Application Support', 'Ispyx');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const ensurePump = () => {};
export const pumpOnce = () => {};

let initialised = false;
/** Connects to the app (starting it if needed). foregroundWindow needs Accessibility, so a missing permission surfaces here. */
export function init() {
  if (initialised) return;
  callSync('foregroundWindow');
  initialised = true;
}

// ---------- windows, monitors, pointer ----------

export const listWindows = (opts = {}) => callSync('listWindows', { includeUntitled: false, ...opts });
export const describeWindow = (id) => callSync('describeWindow', id);
export const getRect = (id) => callSync('getRect', id);
export const getTitle = (id) => callSync('getTitle', id);
export const getClass = (id) => callSync('getClass', id);
export const getPid = (id) => callSync('getPid', id);
export const processInfo = (pid) => callSync('processInfo', pid);
export const windowExists = (id) => !!id && callSync('windowExists', id) === true;
export const rootWindowAt = (x, y) => callSync('rootWindowAt', x, y);
export const foregroundWindow = () => callSync('foregroundWindow');
export const bringToForeground = (id) => callAsync('bringToForeground', id);
export const windowDpi = (id) => callSync('windowDpi', id);
export const selfIsElevated = () => false;
export const isScreenLocked = () => callSync('isScreenLocked') === true;
export const focusIsPassword = () => callSync('focusIsPassword') === true;
export const foregroundLayout = () => callSync('foregroundLayout');
export const virtualScreen = () => callSync('virtualScreen');
export const listMonitors = () => callSync('listMonitors');
export const cursorPos = () => callSync('cursorPos');

// ---------- input ----------

export const mouseMoveTo = (x, y) => { callSync('mouseMoveTo', x, y); };
export const mouseDown = (button = 'left') => { callSync('mouseDown', button); };
export const mouseUp = (button = 'left') => { callSync('mouseUp', button); };
export const mouseWheel = (notches) => { callSync('mouseWheel', notches); };
export const mouseHWheel = (notches) => { callSync('mouseHWheel', notches); };
export const keysDown = (codes) => { callSync('keysDown', codes); };
export const keysUp = (codes) => { callSync('keysUp', codes); };
export const pressVirtualKeys = (codes) => { callSync('pressVirtualKeys', codes); };

/**
 * One character at a time with a pause after each (delays[i] ms, never under 8 ms), like a person typing; the
 * same loop as the Windows one. The app types each code point with typeChar (10 = Return; CR is skipped).
 */
export async function typeUnicode(text, check, delays) {
  let i = 0;
  for (const ch of text) {
    if (ch === '\r') { i++; continue; }
    check?.();
    await callAsync('typeChar', ch.codePointAt(0));
    await sleep(Math.max(8, delays?.[i++] ?? 8));
  }
}

// ---------- capture ----------

function readCapture(r) {
  const need = r.width * r.height * 4;
  let data;
  try {
    data = fs.readFileSync(r.file);
  } catch (e) {
    throw new Error(`Could not read the capture file from Ispyx (${e.code ?? e.message}).`);
  }
  try { fs.unlinkSync(r.file); } catch { /* already gone */ }
  if (data.length < need) throw new Error(`The capture file is too short (${data.length} of ${need} bytes).`);
  return new Uint8Array(data.buffer, data.byteOffset, need);
}

export function captureScreenRect(rect) {
  const r = callSync('captureScreenRect', rect);
  return { bits: readCapture(r), width: r.width, height: r.height, rect: r.rect };
}

export function captureWindow(id) {
  const r = callSync('captureWindow', id);
  return { bits: readCapture(r), width: r.width, height: r.height, rect: r.rect, method: r.method };
}

// ---------- clipboard ----------

export const getClipboardText = () => callSync('getClipboardText');
export const setClipboardText = (text) => { callSync('setClipboardText', text); };
export const setClipboardFile = (file) => { callSync('setClipboardFile', file); };

// ---------- dialog ----------

export async function showDialog(opts, ms) {
  try {
    return await callAsync('showDialog', opts, ms);
  } catch (e) {
    return { cancel: true, reason: `dialog failed: ${e.message}` };
  }
}
