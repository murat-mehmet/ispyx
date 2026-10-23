// A mock of Ispyx.app for the darwin client tests: a subset of PROTOCOL.md over TCP (127.0.0.1, free port).
// Run as a process: prints "PORT <n>" on stdout when listening. Test-only functions: echo, slow, fail, emit, log,
// reset, dropAll, big.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ispyx-mock-'));
const calls = [];
const sockets = new Set();
let fileN = 0;

const writeFile = (name, bytes) => {
  const f = path.join(dir, `${name}-${fileN++}.bin`);
  fs.writeFileSync(f, bytes);
  return f;
};

/** BGRA test pattern: pixel (x, y) = [x, y, w, 255]. */
const pattern = (w, h) => {
  const b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.set([x & 255, y & 255, w & 255, 255], (y * w + x) * 4);
  return b;
};

const handlers = {
  echo: (v) => v,
  slow: (ms, v) => new Promise((r) => setTimeout(() => r(v), ms)),
  fail: (msg) => { throw new Error(msg ?? 'boom'); },
  big: (mb) => 'x'.repeat(mb * 1024 * 1024),
  log: () => calls.slice(),
  reset: () => { calls.length = 0; return true; },
  dropAll: () => { setTimeout(() => sockets.forEach((s) => s.destroy()), 10); return true; },
  foregroundWindow: () => 4242,
  bringToForeground: () => true,
  listMonitors: () => [{ left: 0, top: 0, width: 1440, height: 900, primary: true }],
  cursorPos: () => ({ x: 10, y: 20 }),
  mouseMoveTo: () => true,
  keysState: (codes) => codes.every((c) => c !== 999),
  typeChar: () => true,
  hookTouch: () => true,
  hookStop: () => true,
  overlayShow: () => true,
  overlayHide: () => true,
  overlayVisible: () => false,
  layerCreate: ({ width, height }) => ({ layer: 1, file: writeFile('layer', Buffer.alloc(width * height * 4)) }),
  layerPresent: () => true,
  layerDestroy: () => true,
  textMask: ({ text }) => {
    const width = 3 * text.length + 2, height = 12;
    const m = Buffer.alloc(width * height);
    for (let i = 0; i < m.length; i++) m[i] = i & 255;
    return { width, height, file: writeFile('mask', m) };
  },
  captureScreenRect: (rect) => ({ file: writeFile('cap', pattern(rect.width, rect.height)), width: rect.width, height: rect.height, rect }),
  captureWindow: (id) => {
    const rect = { left: 5, top: 6, width: 7, height: 4 };
    return { file: writeFile('win', pattern(7, 4)), width: 7, height: 4, rect, method: `mock-${id}` };
  },
  getClipboardText: () => ({ text: 'hello', formats: ['text'] }),
};

// emit(name, payload): answer first, then send an event line to every client.
const send = (s, obj) => { if (!s.destroyed) s.write(JSON.stringify(obj) + '\n'); };

const server = net.createServer((s) => {
  sockets.add(s);
  s.setEncoding('utf8');
  s.on('close', () => sockets.delete(s));
  s.on('error', () => {});
  let rest = '';
  const handle = async (req) => {
    if (req.fn === 'emit') {
      send(s, { id: req.id, ok: true, result: true });
      for (const c of sockets) send(c, { event: req.args[0], ...req.args[1] });
      return;
    }
    if (!['log', 'reset', 'dropAll'].includes(req.fn)) calls.push({ fn: req.fn, args: req.args });
    try {
      const h = handlers[req.fn];
      if (!h) throw new Error(`mock: unknown function ${req.fn}`);
      const result = await h(...req.args);
      send(s, { id: req.id, ok: true, result });
    } catch (e) {
      send(s, { id: req.id, ok: false, error: e.message });
    }
  };
  s.on('data', (chunk) => {
    rest += chunk;
    let nl;
    while ((nl = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (line) handle(JSON.parse(line));
    }
  });
});

server.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${server.address().port}\n`));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
process.stdin.resume();
process.stdin.on('end', () => process.exit(0)); // parent gone / closed stdin: quit
