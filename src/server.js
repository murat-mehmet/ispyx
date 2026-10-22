#!/usr/bin/env node
// win-input-mcp: local Windows desktop-control MCP server. stdio only; opens no network port.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as w from './win32.js';
import { Guard, ToolError, loadConfig, winSummary } from './guard.js';
import { shrinkToPng, cropCapture } from './image.js';
import { parseSequence, insertsContent } from './keys.js';
import { curvedPath, ease, randomDuration, typingDelays } from './motion.js';
import { Overlay } from './overlay.js';
import { installStopHotkey } from './hotkey.js';
import { Auth } from './auth.js';
import { pipeName, listenOwner, callOwner, OwnerGone } from './ipc.js';

if (process.platform !== 'win32') {
  process.stderr.write('win-input-mcp only runs on Windows.\n');
  process.exit(1);
}

const config = loadConfig();
// Only the process that owns the pipe (see ipc.js) does the work; the others forward their tool calls to it.
let guard, overlay, auth, stopHook = null;
let owner = null;
const pipe = pipeName();

function initCore() {
  w.init();
  guard = new Guard(config);
  overlay = new Overlay({ enabled: config.overlay, stopLabel: guard.stopLabel });
  guard.overlay = overlay;
  auth = new Auth({ enabled: config.auth, ...(config.authFile ? { file: config.authFile } : {}) });
  guard.startWatching();
  if (guard.stopIsDefault) stopHook = installStopHotkey((reason) => guard.trigger(reason)); // Alt+Esc only; installed while working
  guard.log({ tool: 'server_start', auth: config.auth, denylist: config.denylist, pid: process.pid });
}

async function tryBecomeOwner() {
  if (owner) return true;
  owner = await listenOwner(pipe, runTool);
  if (owner) initCore();
  return !!owner;
}

const handlers = new Map();
let chain = Promise.resolve();
const UNQUEUED = new Set(['wait', 'resume']);
/** Runs a tool here. Calls from all Claude instances take turns, so two of them never fight over the pointer. */
function runTool(name, args) {
  const h = handlers.get(name);
  if (!h) throw new Error(`Unknown tool ${name}`);
  if (UNQUEUED.has(name)) return h(args);
  const p = chain.then(() => h(args));
  chain = p.catch(() => {});
  return p;
}

async function dispatch(name, args) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (owner) return runTool(name, args);
    try {
      return await callOwner(pipe, name, args);
    } catch (e) {
      if (!(e instanceof OwnerGone)) return { isError: true, content: [{ type: 'text', text: e.message }] };
      await tryBecomeOwner(); // the owner is gone: take over
    }
  }
  return { isError: true, content: [{ type: 'text', text: 'Could not reach or become the win-input-mcp server. Try again.' }] };
}

const target = {
  hwnd: z.number().int().optional().describe('Window handle from list_windows. Window-relative mode and focusing use it.'),
  title: z.string().optional().describe('Part of a window title (case-insensitive). Ignored when hwnd is given.'),
};
const space = z.enum(['window', 'screen', 'shot']).optional().describe(
  'Coordinate space. "screen": absolute desktop pixels (virtual-desktop space, may be negative on monitors left of / above the primary). ' +
  '"window": screenshot pixels inside the window given by hwnd/title (see screenshot_window). ' +
  '"shot": pixels of the last screenshot_screen image. Default: "window" when hwnd/title is given, otherwise "screen".');
const xy = {
  x: z.number().describe('X in the chosen coordinate space.'),
  y: z.number().describe('Y in the chosen coordinate space.'),
};
const buttons = z.enum(['left', 'right', 'middle']).default('left');
const modifiers = z.array(z.enum(['ctrl', 'shift', 'alt', 'win'])).optional().describe('Keys held down during the action, e.g. ["ctrl"] for ctrl+click.');
const MIN_GLIDE_MS = 120; // the pointer never teleports, whatever durationMs says
const motion = {
  durationMs: z.number().int().min(0).max(5000).optional().describe(`Glide time, at least ${MIN_GLIDE_MS} ms; default random 300-1000 ms. The pointer never jumps.`),
};
const MOD_VK = { ctrl: 0x11, shift: 0x10, alt: 0x12, win: 0x5b };

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (o) => text(JSON.stringify(o));

const server = new McpServer({ name: 'win-input-mcp', version: '2.0.0' });
{
  const register = server.registerTool.bind(server);
  server.registerTool = (name, cfg, handler) => {
    handlers.set(name, handler);
    return register(name, cfg, (...a) => dispatch(name, cfg.inputSchema ? a[0] : {}));
  };
}

/** Wraps a tool: kill switch + lock check before, JSONL log after, plain errors out. */
function action(name, handler, { session = true } = {}) {
  return async (args) => {
    const entry = { tool: name, args: redact(name, args) };
    const shown = !QUIET.has(name);
    stopHook?.touch(); // keeps the Alt+Esc hook installed while working and for 30 s after the last call
    const keepHook = stopHook && setInterval(() => stopHook.touch(), 10000);
    try {
      guard.checkKill();
      await auth.ensure();
      guard.checkKill();
      if (session) guard.checkSession();
      if (shown) overlay.begin(name);
      const res = await handler(args, entry);
      guard.checkKill(); // stopped while the tool was finishing: report it, do not claim success
      entry.ok = true;
      guard.log(entry);
      return res;
    } catch (e) {
      entry.ok = false;
      entry.error = e.message;
      guard.log(entry);
      const msg = e instanceof ToolError ? e.message : `Unexpected error: ${e.message}`;
      return { isError: true, content: [{ type: 'text', text: msg }] };
    } finally {
      if (keepHook) { clearInterval(keepHook); stopHook.touch(); }
      if (shown && overlay.active) overlay.done();
    }
  };
}
const QUIET = new Set(['list_windows', 'list_monitors', 'cursor_position', 'get_clipboard']);

// The log keeps the typed text, except where it could be a secret.
function redact(name, args) {
  const a = { ...args };
  if (name === 'type_text' && typeof a.text === 'string') a.text = a.text.slice(0, 2000);
  if (name === 'set_clipboard' && typeof a.text === 'string') {
    a.textLength = a.text.length;
    a.text = a.text.slice(0, 200);
  }
  return a;
}

/**
 * Returns map(x, y) -> { sx, sy } in desktop pixels for the chosen space. In window space the window is
 * focused first and each point must belong to it; otherwise the window under the point must be usable.
 */
async function pointMapper(args, entry) {
  const sp = args.space ?? (args.hwnd || args.title ? 'window' : 'screen');
  entry.space = sp;
  if (sp === 'window') {
    if (!args.hwnd && !args.title) throw new ToolError('Window space needs hwnd or title.');
    const win = guard.resolve(args);
    guard.assertUsable(win, { needVisible: false });
    await guard.focus(win);
    guard.assertUsable(w.describeWindow(win.hwnd));
    entry.window = winSummary(win);
    return (x, y) => {
      const p = guard.toScreen(w.describeWindow(win.hwnd), x, y);
      guard.assertPointOwned(win, p.sx, p.sy);
      return p;
    };
  }
  return (x, y) => {
    const p = guard.toScreenGlobal(x, y, sp);
    const under = guard.assertPointUsable(p.sx, p.sy);
    if (under) entry.window = winSummary(under);
    return p;
  };
}


/**
 * Move the pointer to p like a hand would: a curved path with a smooth speed profile, taking a random
 * 300-1000 ms (config moveMinMs/moveMaxMs, or durationMs).
 */
async function glide(p, args = {}) {
  const from = w.cursorPos();
  const dist = Math.hypot(p.sx - from.x, p.sy - from.y);
  if (dist < 4) {
    w.mouseMoveTo(p.sx, p.sy);
    return;
  }
  const ms = Math.max(MIN_GLIDE_MS, args.durationMs ?? randomDuration(config.moveMinMs, config.moveMaxMs));
  const path = curvedPath(from, { x: p.sx, y: p.sy });
  const v = w.virtualScreen();
  const t0 = performance.now();
  for (let n = 0; ; n++) {
    const t = Math.min(1, (performance.now() - t0) / ms);
    const q = path(ease(t));
    // a bend must never drag the pointer off the desktop
    const x = Math.min(v.x + v.width - 1, Math.max(v.x, Math.round(q.x)));
    const y = Math.min(v.y + v.height - 1, Math.max(v.y, Math.round(q.y)));
    w.mouseMoveTo(x, y);
    if (t >= 1) break;
    if (n % 4 === 0) guard.checkKill();
    await w.sleep(8);
  }
  w.mouseMoveTo(p.sx, p.sy);
}

/**
 * Wheel like a hand on a smooth-scrolling mouse: the total is spread over many small wheel events
 * (a fraction of a notch each) following the same smooth speed curve as the pointer glide, so pages
 * scroll continuously instead of jumping. Duration: random 300-1000 ms, longer for big scrolls
 * (or durationMs).
 */
async function smoothWheel(vert, horiz, args) {
  const big = Math.max(Math.abs(vert), Math.abs(horiz));
  const ms = Math.max(MIN_GLIDE_MS, args.durationMs ?? Math.min(2500, randomDuration(config.moveMinMs, config.moveMaxMs) + Math.round(big * 40)));
  const totalV = Math.round(vert * 120);
  const totalH = Math.round(horiz * 120);
  let sentV = 0, sentH = 0, events = 0;
  const t0 = performance.now();
  for (let n = 0; ; n++) {
    const t = Math.min(1, (performance.now() - t0) / ms);
    const e = ease(t);
    const dv = Math.round(totalV * e) - sentV;
    const dh = Math.round(totalH * e) - sentH;
    if (dv) { w.mouseWheel(dv / 120); sentV += dv; events++; }
    if (dh) { w.mouseHWheel(dh / 120); sentH += dh; events++; }
    if (t >= 1) break;
    if (n % 4 === 0) guard.checkKill();
    await w.sleep(8);
  }
  return { events, ms: Math.round(performance.now() - t0) };
}

/** Hold modifier keys for the duration of fn. */
async function withModifiers(mods, fn) {
  const vks = (mods ?? []).map((m) => MOD_VK[m]);
  if (vks.length) w.keysDown(vks);
  try {
    return await fn();
  } finally {
    if (vks.length) w.keysUp(vks);
  }
}

// ---------------------------------------------------------------- tools

server.registerTool('list_windows', {
  description: 'List visible top-level windows with handle, title, process and screen rectangle, including the taskbar (Shell_TrayWnd). Use includeUntitled for every visible top-level window.',
  inputSchema: { includeUntitled: z.boolean().default(false) },
}, action('list_windows', async (args) => {
  const list = w.listWindows({ includeUntitled: !!args.includeUntitled }).map((x) => ({
    hwnd: x.hwnd, title: x.title, className: x.className, process: x.process, rect: x.rect,
    minimized: x.minimized, allowed: !guard.denied(x), elevated: x.elevated,
  }));
  return json({ denylist: config.denylist, foreground: w.foregroundWindow(), windows: list });
}, { session: false }));

server.registerTool('list_monitors', {
  description: 'Monitors with their desktop rectangles and the virtual desktop bounds (physical pixels).',
}, action('list_monitors', async () => {
  const mons = w.listMonitors().sort((a, b) => Number(b.primary) - Number(a.primary)).map((m, index) => ({ index, ...m }));
  return json({ virtualScreen: w.virtualScreen(), monitors: mons });
}, { session: false }));

server.registerTool('cursor_position', {
  description: 'Current mouse pointer position in desktop pixels.',
}, action('cursor_position', async () => json(w.cursorPos()), { session: false }));

server.registerTool('focus_window', {
  description: 'Restore the window if minimized and bring it to the foreground. Works for any window outside the denylist.',
  inputSchema: target,
}, action('focus_window', async (args, entry) => {
  const win = guard.resolve(args);
  entry.window = winSummary(win);
  await guard.focus(win);
  return json({ ok: true, window: winSummary(w.describeWindow(win.hwnd)) });
}));

server.registerTool('screenshot_window', {
  description: 'PNG of one window only (works for Chrome and GPU-rendered content). Returns the image plus `scale` and `rect` (and the clamped `region` when one was given). With space "window", click/move/drag/scroll take coordinates in the pixels of the LAST screenshot_window of that hwnd, also when it was cropped: the server remembers the crop origin and scale per window, so a point in the cropped image maps back correctly. Optional `region` {x, y, width, height} crops inside the window (window pixels from its top-left, before maxWidth scaling; clamped to the window, error if fully outside); maxWidth then applies to the crop. Without `region` nothing changes.',
  inputSchema: { ...target, region: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).optional().describe('Crop inside the window, window pixels from its top-left.'), maxWidth: z.number().int().min(100).max(8000).default(1280).describe('Maximum image width in pixels.') },
}, action('screenshot_window', async (args, entry) => {
  if (!args.hwnd && !args.title) throw new ToolError('Give hwnd or title, or use screenshot_screen for the whole desktop.');
  const win = guard.resolve(args);
  guard.assertUsable(win, { needVisible: false });
  entry.window = winSummary(win);
  if (win.minimized) throw new ToolError(`"${win.title}" is minimized and cannot be captured. Use focus_window first.`);
  let cap = await overlay.hiddenDuring(() => w.captureWindow(win.hwnd));
  if (args.region) {
    const cropped = cropCapture(cap, args.region);
    if (!cropped) throw new ToolError(`Region is outside the window (the window is ${cap.width}x${cap.height} px, region starts at ${args.region.x},${args.region.y}).`);
    cap = cropped;
  }
  const img = shrinkToPng(cap, args.maxWidth ?? 1280);
  guard.shots.set(win.hwnd, { scale: img.scale, ox: cap.region?.x ?? 0, oy: cap.region?.y ?? 0 });
  guard.lastWindow = win.hwnd;
  return {
    content: [
      { type: 'image', data: img.png.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify({ hwnd: win.hwnd, scale: img.scale, rect: cap.rect, ...(cap.region ? { region: cap.region } : {}), width: img.width, height: img.height, method: cap.method }) },
    ],
  };
}));

server.registerTool('screenshot_screen', {
  description: 'PNG of the desktop: one monitor (default: primary), all monitors together (all: true), or a rectangle (region, in desktop pixels). Returns `rect` (desktop pixels) and `scale`; a point (x, y) in the image is desktop pixel (rect.left + x/scale, rect.top + y/scale), or use space "shot" in the pointer tools.',
  inputSchema: {
    monitor: z.number().int().min(0).optional().describe('Monitor index from list_monitors (0 = primary).'),
    all: z.boolean().optional().describe('Capture the whole virtual desktop (all monitors).'),
    region: z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().min(1), height: z.number().int().min(1) }).optional(),
    maxWidth: z.number().int().min(100).max(8000).default(1280),
  },
}, action('screenshot_screen', async (args, entry) => {
  const v = w.virtualScreen();
  let rect;
  if (args.region) {
    const r = args.region;
    const left = Math.max(r.x, v.x), top = Math.max(r.y, v.y);
    const right = Math.min(r.x + r.width, v.x + v.width), bottom = Math.min(r.y + r.height, v.y + v.height);
    if (right <= left || bottom <= top) throw new ToolError('That region is outside the desktop.');
    rect = { left, top, width: right - left, height: bottom - top };
  } else if (args.all) {
    rect = { left: v.x, top: v.y, width: v.width, height: v.height };
  } else {
    const mons = w.listMonitors().sort((a, b) => Number(b.primary) - Number(a.primary));
    const m = mons[args.monitor ?? 0];
    if (!m) throw new ToolError(`No monitor ${args.monitor}; there are ${mons.length}.`);
    rect = { left: m.left, top: m.top, width: m.width, height: m.height };
  }
  entry.rect = rect;
  const cap = await overlay.hiddenDuring(() => w.captureScreenRect(rect));
  const img = shrinkToPng(cap, args.maxWidth ?? 1280);
  guard.lastShot = { rect, scale: img.scale };
  return {
    content: [
      { type: 'image', data: img.png.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify({ scale: img.scale, rect, width: img.width, height: img.height, cursor: w.cursorPos() }) },
    ],
  };
}));

server.registerTool('click', {
  description: 'Click at a point: left/right/middle button, double or triple (clicks), optional held modifiers (ctrl/shift/alt/win). In window space the window is focused first.',
  inputSchema: { ...motion, ...target, space, ...xy, button: buttons, double: z.boolean().default(false), clicks: z.number().int().min(1).max(3).optional(), modifiers },
}, action('click', async (args, entry) => {
  const map = await pointMapper(args, entry);
  const p = map(args.x, args.y);
  entry.coords = { x: args.x, y: args.y, screen: { x: p.sx, y: p.sy } };
  const b = args.button ?? 'left';
  const n = args.clicks ?? (args.double ? 2 : 1);
  await glide(p, args);
  await w.sleep(30);
  guard.checkKill();
  await withModifiers(args.modifiers, async () => {
    for (let i = 0; i < n; i++) {
      w.mouseDown(b);
      w.mouseUp(b);
      if (i < n - 1) await w.sleep(40);
    }
  });
  return json({ ok: true, screen: { x: p.sx, y: p.sy } });
}));

server.registerTool('move', {
  description: 'Move the mouse pointer.',
  inputSchema: { ...motion, ...target, space, ...xy },
}, action('move', async (args, entry) => {
  const map = await pointMapper(args, entry);
  const p = map(args.x, args.y);
  entry.coords = { x: args.x, y: args.y, screen: { x: p.sx, y: p.sy } };
  await glide(p, args);
  return json({ ok: true, screen: { x: p.sx, y: p.sy } });
}));

server.registerTool('mouse_down', {
  description: 'Press and keep holding a mouse button (optionally after moving to x, y). Release with mouse_up. Held buttons are released automatically on the kill switch or shutdown.',
  inputSchema: { ...motion, ...target, space, x: z.number().optional(), y: z.number().optional(), button: buttons },
}, action('mouse_down', async (args, entry) => {
  const map = await pointMapper(args, entry);
  if (args.x !== undefined && args.y !== undefined) {
    const p = map(args.x, args.y);
    entry.coords = { x: args.x, y: args.y, screen: { x: p.sx, y: p.sy } };
    await glide(p, args);
    await w.sleep(30);
  }
  const b = args.button ?? 'left';
  w.mouseDown(b);
  guard.heldButtons.add(b);
  return json({ ok: true, held: [...guard.heldButtons] });
}));

server.registerTool('mouse_up', {
  description: 'Release a mouse button held with mouse_down (optionally after moving to x, y).',
  inputSchema: { ...motion, ...target, space, x: z.number().optional(), y: z.number().optional(), button: buttons },
}, action('mouse_up', async (args, entry) => {
  const map = await pointMapper(args, entry);
  if (args.x !== undefined && args.y !== undefined) {
    const p = map(args.x, args.y);
    entry.coords = { x: args.x, y: args.y, screen: { x: p.sx, y: p.sy } };
    await glide(p, args);
    await w.sleep(30);
  }
  const b = args.button ?? 'left';
  w.mouseUp(b);
  guard.heldButtons.delete(b);
  return json({ ok: true, held: [...guard.heldButtons] });
}));

server.registerTool('drag', {
  description: 'Glide to the start point, press the button, glide to the end point (many small moves, as HTML5 drag-and-drop needs), release. Optional held modifiers.',
  inputSchema: { ...motion,
    ...target, space,
    fromX: z.number(), fromY: z.number(), toX: z.number(), toY: z.number(),
    button: buttons,
    modifiers,
  },
}, action('drag', async (args, entry) => {
  const map = await pointMapper(args, entry);
  const a = map(args.fromX, args.fromY);
  const z2 = map(args.toX, args.toY);
  entry.coords = { from: { x: args.fromX, y: args.fromY, screen: { x: a.sx, y: a.sy } }, to: { x: args.toX, y: args.toY, screen: { x: z2.sx, y: z2.sy } } };
  const b = args.button ?? 'left';
  await withModifiers(args.modifiers, async () => {
    await glide(a, args);
    await w.sleep(40);
    w.mouseDown(b);
    guard.heldButtons.add(b);
    try {
      await w.sleep(40);
      await glide(z2, args);
      await w.sleep(40);
    } finally {
      w.mouseUp(b);
      guard.heldButtons.delete(b);
    }
  });
  return json({ ok: true, from: { x: a.sx, y: a.sy }, to: { x: z2.sx, y: z2.sy } });
}));

server.registerTool('scroll', {
  description: 'Smooth mouse wheel at a point (spread over 300-1000+ ms). `amount`: vertical notches, positive up, negative down. `horizontal`: horizontal notches, positive right, negative left. Either or both.',
  inputSchema: { ...motion,
    ...target, space, ...xy,
    amount: z.number().min(-100).max(100).optional(),
    horizontal: z.number().min(-100).max(100).optional(),
    modifiers,
  },
}, action('scroll', async (args, entry) => {
  if (!args.amount && !args.horizontal) throw new ToolError('Give amount (vertical) and/or horizontal.');
  const map = await pointMapper(args, entry);
  const p = map(args.x, args.y);
  entry.coords = { x: args.x, y: args.y, screen: { x: p.sx, y: p.sy }, amount: args.amount, horizontal: args.horizontal };
  await glide(p, args);
  await w.sleep(30);
  guard.checkKill();
  let stats = { events: 1, ms: 0 };
  await withModifiers(args.modifiers, async () => {
    stats = await smoothWheel(args.amount ?? 0, args.horizontal ?? 0, args);
  });
  entry.events = stats.events;
  return json({ ok: true, screen: { x: p.sx, y: p.sy }, wheelEvents: stats.events, ms: stats.ms });
}));

function assertNotPassword() {
  let isPw;
  try {
    isPw = w.focusIsPassword();
  } catch (e) {
    throw new ToolError(`Refused: could not verify that the focused field is not a password field (${e.message}).`);
  }
  if (isPw) throw new ToolError('Refused: the focused field is a password field. Log in yourself; this server never types into password fields.');
}

/** Keyboard target: focus hwnd/title when given, otherwise whatever is in front. Verifies the foreground window. */
async function keyboardTarget(args, entry) {
  if (args.hwnd || args.title) {
    const win = guard.resolve(args);
    entry.window = winSummary(win);
    await guard.prepareKeyboard(win);
    return;
  }
  const fg = w.foregroundWindow();
  if (!fg) throw new ToolError('No window has the keyboard focus. Use focus_window first.');
  const d = w.describeWindow(fg);
  entry.window = winSummary(d);
  guard.assertUsable(d);
}

server.registerTool('type_text', {
  description: 'Type text into the focused control using Unicode key events, one character at a time at a human pace (random 60-200 ms per character; very long text is sped up to finish within 60 s, use set_clipboard + ctrl+v for bulk text). `speed` divides the waits: 1 = normal, 2 = twice as fast, 0.5 = half as fast, 0 = a fixed 8 ms after every character (the fastest allowed; no wait is ever shorter, and text is never sent in one batch). The 60 s cap applies after `speed`. (Turkish and other non-ASCII characters work). Refused when the focused control is a password field. Pass hwnd/title to focus a window first; otherwise the current foreground window gets the text.',
  inputSchema: { ...target, text: z.string().min(1), speed: z.number().min(0).max(100).optional().describe('Typing speed multiplier for the waits between characters. Default 1; 2 halves the waits, 0.5 doubles them, 0 = fixed 8 ms per character (fastest).') },
}, action('type_text', async (args, entry) => {
  if (args.text.length > config.maxTypeLength) throw new ToolError(`Text is longer than ${config.maxTypeLength} characters. Use set_clipboard and ctrl+v for long text.`);
  await keyboardTarget(args, entry);
  try {
    assertNotPassword();
  } catch (e) {
    delete entry.args.text; // never keep text aimed at a password field
    entry.args.refusedChars = args.text.length;
    throw e;
  }
  guard.checkKill();
  const speed = args.speed ?? config.typeSpeed;
  const delays = typingDelays(args.text, { min: config.typeMinMs, max: config.typeMaxMs, capMs: config.typeCapMs, speed });
  const t0 = performance.now();
  await w.typeUnicode(args.text, () => guard.checkKill(), delays);
  return json({ ok: true, typed: args.text.length, ms: Math.round(performance.now() - t0), speed, keyboardLayout: '0x' + w.foregroundLayout().toString(16) });
}));

function parseKeys(keys) {
  try {
    return parseSequence(keys);
  } catch (e) {
    throw new ToolError(e.message);
  }
}

server.registerTool('press_keys', {
  description: 'Press key chords, e.g. "ctrl+v", "enter", "alt+tab", "win+r", "win+d". Separate several chords with spaces ("ctrl+a ctrl+c"). Names: ctrl shift alt win enter tab esc space backspace delete home end pageup pagedown arrows f1-f24 a-z 0-9. Pass hwnd/title to focus a window first; otherwise the foreground window gets the keys.',
  inputSchema: { ...target, keys: z.string().min(1) },
}, action('press_keys', async (args, entry) => {
  const chords = parseKeys(args.keys);
  await keyboardTarget(args, entry);
  if (chords.some(insertsContent)) assertNotPassword();
  for (const c of chords) {
    guard.checkKill();
    w.pressVirtualKeys(c);
    await w.sleep(30);
  }
  return json({ ok: true, chords: chords.length });
}));

server.registerTool('key_down', {
  description: 'Press and hold keys (e.g. "shift" or "ctrl+shift") until key_up. Held keys are released automatically on the kill switch or shutdown.',
  inputSchema: { ...target, keys: z.string().min(1) },
}, action('key_down', async (args, entry) => {
  const vks = parseKeys(args.keys).flat();
  await keyboardTarget(args, entry);
  w.keysDown(vks);
  vks.forEach((k) => guard.heldKeys.add(k));
  return json({ ok: true, held: guard.heldKeys.size });
}));

server.registerTool('key_up', {
  description: 'Release keys held with key_down.',
  inputSchema: { keys: z.string().min(1) },
}, action('key_up', async (args) => {
  const vks = parseKeys(args.keys).flat();
  w.keysUp(vks);
  vks.forEach((k) => guard.heldKeys.delete(k));
  return json({ ok: true, held: guard.heldKeys.size });
}));

server.registerTool('resume', {
  description: 'Clear an emergency stop (the user pressed Alt+Esc). Call it ONLY after the user has told you to continue; until then every other tool refuses. Does nothing if no stop is active.',
}, async () => {
  try {
    const cleared = guard.resume();
    return json({ ok: true, resumed: cleared });
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
});

server.registerTool('wait', {
  description: 'Pause (milliseconds, up to 60000), for page loads and animations. The kill switch is checked while waiting.',
  inputSchema: { ms: z.number().int().min(0).max(60000) },
}, action('wait', async (args) => {
  let left = args.ms;
  while (left > 0) {
    const step = Math.min(left, 250);
    await w.sleep(step);
    left -= step;
    guard.checkKill();
  }
  return json({ ok: true, waited: args.ms });
}, { session: false }));

server.registerTool('get_clipboard', {
  description: 'Read the clipboard text. Also reports whether it holds an image or files. The text is returned to the caller but not written to the action log (only its length).',
}, action('get_clipboard', async (args, entry) => {
  const c = w.getClipboardText();
  entry.length = c.text === null ? null : c.text.length;
  entry.formats = c.formats;
  return json(c);
}, { session: false }));

function setImageClipboard(imagePath) {
  return new Promise((resolve, reject) => {
    const script = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;$i=[System.Drawing.Image]::FromFile($env:WIN_INPUT_IMG);[System.Windows.Forms.Clipboard]::SetImage($i);$i.Dispose()";
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
      env: { ...process.env, WIN_INPUT_IMG: imagePath }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    ps.stderr.on('data', (d) => (err += d));
    ps.on('error', reject);
    ps.on('exit', (code) => (code === 0 ? resolve() : reject(new ToolError(`Could not load that image onto the clipboard: ${err.trim().split('\n')[0] || 'unsupported file'}`))));
  });
}

server.registerTool('set_clipboard', {
  description: 'Put text, an image, or a file on the clipboard so it can be pasted with ctrl+v (long captions, uploads). Give exactly one of text, imagePath (pastes as a picture) or filePath (pastes as a file, as copied in Explorer).',
  inputSchema: { text: z.string().optional(), imagePath: z.string().optional(), filePath: z.string().optional() },
}, action('set_clipboard', async (args, entry) => {
  const given = ['text', 'imagePath', 'filePath'].filter((k) => args[k] !== undefined);
  if (given.length !== 1) throw new ToolError('Give exactly one of text, imagePath or filePath.');
  if (args.text !== undefined) {
    w.setClipboardText(args.text);
    return json({ ok: true, kind: 'text', length: args.text.length });
  }
  const p = args.imagePath ?? args.filePath;
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new ToolError(`File not found: ${p}`);
  if (args.imagePath) {
    await setImageClipboard(p);
    return json({ ok: true, kind: 'image', path: p });
  }
  w.setClipboardFile(p);
  return json({ ok: true, kind: 'file', path: p });
}, { session: false }));

// ---------------------------------------------------------------- run

await tryBecomeOwner();
await server.connect(new StdioServerTransport());
process.on('exit', () => guard?.releaseAll());
// When this Claude goes away, an owner that still serves other instances keeps running until the last one is gone.
process.stdin.on('close', () => {
  if (!owner || owner.clients() === 0) process.exit(0);
  const t = setInterval(() => { if (owner.clients() === 0) process.exit(0); }, 2000);
  t.unref?.();
  guard.releaseAll();
});
