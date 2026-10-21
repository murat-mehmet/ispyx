#!/usr/bin/env node
// win-input-mcp: local Windows desktop-control MCP server. stdio only; opens no network port.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as w from './win32.js';
import { Guard, ToolError, loadConfig, winSummary } from './guard.js';
import { shrinkToPng } from './image.js';
import { parseSequence, insertsContent } from './keys.js';

if (process.platform !== 'win32') {
  process.stderr.write('win-input-mcp only runs on Windows.\n');
  process.exit(1);
}

w.init();
const config = loadConfig();
const guard = new Guard(config);
guard.startWatching();

const target = {
  hwnd: z.number().int().optional().describe('Window handle from list_windows.'),
  title: z.string().optional().describe('Part of the window title (case-insensitive). Ignored when hwnd is given. If both are omitted the last window used is targeted.'),
};
const xy = {
  x: z.number().describe('X in screenshot pixels, relative to the window (top-left of the screenshot is 0,0).'),
  y: z.number().describe('Y in screenshot pixels, relative to the window.'),
};
const buttons = z.enum(['left', 'right', 'middle']).default('left');

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (o) => text(JSON.stringify(o));

const server = new McpServer({ name: 'win-input-mcp', version: '1.0.0' });

/** Wraps a tool: kill switch + lock check before, JSONL log after, plain errors out. */
function action(name, handler, { session = true } = {}) {
  return async (args) => {
    const entry = { tool: name, args: redact(name, args) };
    try {
      guard.checkKill();
      if (session) guard.checkSession();
      const res = await handler(args, entry);
      entry.ok = true;
      guard.log(entry);
      return res;
    } catch (e) {
      entry.ok = false;
      entry.error = e.message;
      guard.log(entry);
      const msg = e instanceof ToolError ? e.message : `Unexpected error: ${e.message}`;
      return { isError: true, content: [{ type: 'text', text: msg }] };
    }
  };
}

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

async function pointerTarget(args, entry, { focus = true } = {}) {
  const win = guard.resolve(args);
  guard.assertUsable(win, { needVisible: false });
  if (focus) await guard.focus(win);
  guard.assertUsable(w.describeWindow(win.hwnd));
  entry.window = winSummary(win);
  return w.describeWindow(win.hwnd);
}

// ---------------------------------------------------------------- tools

server.registerTool('list_windows', {
  description: 'List visible top-level windows with handle, title, process and screen rectangle. Windows from programs outside the allowlist are shown but cannot be acted on.',
}, action('list_windows', async () => {
  const list = w.listWindows().map((x) => ({
    hwnd: x.hwnd, title: x.title, process: x.process, rect: x.rect,
    minimized: x.minimized, allowed: guard.allowed(x), elevated: x.elevated,
  }));
  return json({ allowlist: config.allowlist, windows: list });
}, { session: false }));

server.registerTool('focus_window', {
  description: 'Restore the window if minimized and bring it to the foreground.',
  inputSchema: target,
}, action('focus_window', async (args, entry) => {
  const win = guard.resolve(args);
  entry.window = winSummary(win);
  await guard.focus(win);
  return json({ ok: true, window: winSummary(w.describeWindow(win.hwnd)) });
}));

server.registerTool('screenshot_window', {
  description: 'PNG of one window only (works for Chrome and GPU-rendered content). Returns the image plus `scale` and `rect`; click/move/drag/scroll take coordinates in these screenshot pixels.',
  inputSchema: { ...target, maxWidth: z.number().int().min(100).max(8000).default(1280).describe('Maximum image width in pixels.') },
}, action('screenshot_window', async (args, entry) => {
  const win = guard.resolve(args);
  guard.assertUsable(win, { needVisible: false });
  entry.window = winSummary(win);
  if (win.minimized) throw new ToolError(`"${win.title}" is minimized and cannot be captured. Use focus_window first.`);
  const cap = w.captureWindow(win.hwnd);
  const img = shrinkToPng(cap, args.maxWidth ?? 1280);
  guard.shots.set(win.hwnd, img.scale);
  guard.lastWindow = win.hwnd;
  return {
    content: [
      { type: 'image', data: img.png.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify({ hwnd: win.hwnd, scale: img.scale, rect: cap.rect, width: img.width, height: img.height, method: cap.method }) },
    ],
  };
}));

server.registerTool('screenshot_screen', {
  description: 'PNG of a whole monitor, for checking the overall state. Not tied to any window; clicks still go through window-relative coordinates.',
  inputSchema: {
    monitor: z.number().int().min(0).default(0).describe('Monitor index (0 = primary).'),
    maxWidth: z.number().int().min(100).max(8000).default(1280),
  },
}, action('screenshot_screen', async (args, entry) => {
  const mons = w.listMonitors().sort((a, b) => Number(b.primary) - Number(a.primary));
  const m = mons[args.monitor ?? 0];
  if (!m) throw new ToolError(`No monitor ${args.monitor}; there are ${mons.length}.`);
  entry.monitor = args.monitor ?? 0;
  const cap = w.captureScreenRect(m);
  const img = shrinkToPng(cap, args.maxWidth ?? 1280);
  return {
    content: [
      { type: 'image', data: img.png.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify({ monitor: args.monitor ?? 0, scale: img.scale, rect: m, width: img.width, height: img.height }) },
    ],
  };
}));

server.registerTool('click', {
  description: 'Click at window-relative screenshot coordinates. Focuses the window first.',
  inputSchema: { ...target, ...xy, button: buttons, double: z.boolean().default(false) },
}, action('click', async (args, entry) => {
  const win = await pointerTarget(args, entry);
  const p = guard.toScreen(win, args.x, args.y);
  guard.assertPointOwned(win, p.sx, p.sy);
  entry.coords = { x: args.x, y: args.y, screen: { x: p.sx, y: p.sy } };
  const b = args.button ?? 'left';
  w.mouseMoveTo(p.sx, p.sy);
  await w.sleep(30);
  guard.checkKill();
  for (let i = 0; i < (args.double ? 2 : 1); i++) {
    w.mouseDown(b);
    w.mouseUp(b);
    if (args.double) await w.sleep(40);
  }
  return json({ ok: true, screen: { x: p.sx, y: p.sy } });
}));

server.registerTool('move', {
  description: 'Move the mouse pointer to window-relative screenshot coordinates.',
  inputSchema: { ...target, ...xy },
}, action('move', async (args, entry) => {
  const win = await pointerTarget(args, entry);
  const p = guard.toScreen(win, args.x, args.y);
  guard.assertPointOwned(win, p.sx, p.sy);
  entry.coords = { x: args.x, y: args.y, screen: { x: p.sx, y: p.sy } };
  w.mouseMoveTo(p.sx, p.sy);
  return json({ ok: true, screen: { x: p.sx, y: p.sy } });
}));

server.registerTool('drag', {
  description: 'Press the left button at the start point, move to the end point in steps (needed for HTML5 drag-and-drop), release.',
  inputSchema: {
    ...target,
    fromX: z.number(), fromY: z.number(), toX: z.number(), toY: z.number(),
    steps: z.number().int().min(1).max(500).default(20),
    delayMs: z.number().int().min(0).max(1000).default(10).describe('Pause between steps.'),
    button: buttons,
  },
}, action('drag', async (args, entry) => {
  const win = await pointerTarget(args, entry);
  const a = guard.toScreen(win, args.fromX, args.fromY);
  const z2 = guard.toScreen(win, args.toX, args.toY);
  guard.assertPointOwned(win, a.sx, a.sy);
  guard.assertPointOwned(win, z2.sx, z2.sy);
  entry.coords = { from: { x: args.fromX, y: args.fromY, screen: { x: a.sx, y: a.sy } }, to: { x: args.toX, y: args.toY, screen: { x: z2.sx, y: z2.sy } } };
  const steps = args.steps ?? 20;
  const delay = args.delayMs ?? 10;
  const b = args.button ?? 'left';
  w.mouseMoveTo(a.sx, a.sy);
  await w.sleep(40);
  w.mouseDown(b);
  try {
    await w.sleep(40);
    for (let i = 1; i <= steps; i++) {
      guard.checkKill();
      w.mouseMoveTo(Math.round(a.sx + ((z2.sx - a.sx) * i) / steps), Math.round(a.sy + ((z2.sy - a.sy) * i) / steps));
      if (delay) await w.sleep(delay);
    }
    await w.sleep(40);
  } finally {
    w.mouseUp(b);
  }
  return json({ ok: true, from: { x: a.sx, y: a.sy }, to: { x: z2.sx, y: z2.sy } });
}));

server.registerTool('scroll', {
  description: 'Mouse wheel at a point. Positive amount scrolls up, negative down (in wheel notches).',
  inputSchema: { ...target, ...xy, amount: z.number().min(-100).max(100) },
}, action('scroll', async (args, entry) => {
  const win = await pointerTarget(args, entry);
  const p = guard.toScreen(win, args.x, args.y);
  guard.assertPointOwned(win, p.sx, p.sy);
  entry.coords = { x: args.x, y: args.y, screen: { x: p.sx, y: p.sy }, amount: args.amount };
  w.mouseMoveTo(p.sx, p.sy);
  await w.sleep(30);
  guard.checkKill();
  w.mouseWheel(args.amount);
  return json({ ok: true });
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

server.registerTool('type_text', {
  description: 'Type text into the focused control using Unicode key events (Turkish and other non-ASCII characters work). Refused when the focused control is a password field. Pass hwnd/title to focus a window first; otherwise the current foreground window is used.',
  inputSchema: { ...target, text: z.string().min(1) },
}, action('type_text', async (args, entry) => {
  if (args.text.length > config.maxTypeLength) throw new ToolError(`Text is longer than ${config.maxTypeLength} characters. Use set_clipboard and ctrl+v for long text.`);
  const win = args.hwnd || args.title || guard.lastWindow ? guard.resolve(args) : w.describeWindow(w.foregroundWindow());
  entry.window = winSummary(win);
  await guard.prepareKeyboard(win);
  try {
    assertNotPassword();
  } catch (e) {
    delete entry.args.text; // never keep text aimed at a password field
    entry.args.refusedChars = args.text.length;
    throw e;
  }
  guard.checkKill();
  await w.typeUnicode(args.text);
  return json({ ok: true, typed: args.text.length, keyboardLayout: '0x' + w.foregroundLayout().toString(16) });
}));

server.registerTool('press_keys', {
  description: 'Press key chords, e.g. "ctrl+v", "enter", "ctrl+a", "alt+tab". Separate several chords with spaces ("ctrl+a ctrl+c"). The Windows key is not allowed.',
  inputSchema: { ...target, keys: z.string().min(1) },
}, action('press_keys', async (args, entry) => {
  let chords;
  try {
    chords = parseSequence(args.keys);
  } catch (e) {
    throw new ToolError(e.message);
  }
  const win = args.hwnd || args.title || guard.lastWindow ? guard.resolve(args) : w.describeWindow(w.foregroundWindow());
  entry.window = winSummary(win);
  await guard.prepareKeyboard(win);
  if (chords.some(insertsContent)) assertNotPassword();
  for (const c of chords) {
    guard.checkKill();
    w.pressVirtualKeys(c);
    await w.sleep(30);
  }
  return json({ ok: true, chords: chords.length });
}));

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

await server.connect(new StdioServerTransport());
guard.log({ tool: 'server_start', allowlist: config.allowlist, pid: process.pid });
