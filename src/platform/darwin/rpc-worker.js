// Worker thread of rpc.js: owns the socket to Ispyx.app. See rpc.js for the shared-memory layout.
import { parentPort, workerData } from 'node:worker_threads';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

const { sab, bigPort, endpoint, autostart, waitMs, notRunningMessage } = workerData;
const i32 = new Int32Array(sab, 0, 8);
const bytes = new Uint8Array(sab);
const DATA = 64; // byte offset of the payload area
const CAP = sab.byteLength - DATA;
// header (Int32 index): 0 state (0 waiting, 1 ready), 1 id answered, 2 byte length, 3 status, 4 id the main thread waits for
const OK = 0, ERR = 1, BIG = 2;

let sock = null;
let connecting = null;
let launched = false;
let rest = '';
const pending = new Map(); // id -> 'sync' | 'async' | 'quiet'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseEndpoint(ep) {
  const m = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(ep);
  return m ? { host: m[1], port: Number(m[2]) } : { path: ep };
}

function connectOnce() {
  return new Promise((resolve, reject) => {
    const s = net.connect(parseEndpoint(endpoint));
    const onErr = (e) => { s.destroy(); reject(e); };
    s.once('error', onErr);
    s.once('connect', () => {
      s.off('error', onErr);
      s.setNoDelay(true);
      s.setEncoding('utf8');
      s.on('data', onData);
      s.on('error', () => {});
      s.on('close', () => {
        if (sock === s) { sock = null; failAll('Ispyx closed the connection (the app quit or restarted). Try the call again.'); }
      });
      resolve(s);
    });
  });
}

async function connect() {
  const deadline = Date.now() + waitMs;
  let last;
  for (;;) {
    try {
      return await connectOnce();
    } catch (e) {
      last = e;
    }
    if (autostart && !launched) {
      launched = true;
      try { spawnSync('open', ['-g', '-a', 'Ispyx'], { stdio: 'ignore', timeout: 5000 }); } catch { /* reported below */ }
    }
    if (Date.now() >= deadline) break;
    await sleep(150);
  }
  throw new Error(`${notRunningMessage} (${last?.code ?? last?.message ?? 'cannot connect'})`);
}

function ensureConnected() {
  if (sock) return null;
  connecting ??= connect().then((s) => { sock = s; }).finally(() => { connecting = null; });
  return connecting;
}

function reply(id, mode, ok, line, errText) {
  if (mode === 'quiet') return;
  if (mode === 'async') {
    parentPort.postMessage(ok ? { id, line } : { id, error: errText });
    return;
  }
  if (Atomics.load(i32, 4) !== id) return; // the main thread gave up on this call
  let status = ok ? OK : ERR;
  const payload = Buffer.from(ok ? line : errText, 'utf8');
  if (payload.length > CAP) {
    bigPort.postMessage({ id, status, text: payload.toString('utf8') });
    status = BIG;
    i32[2] = 0;
  } else {
    // (the shared area is only touched for the call the main thread currently waits for, checked above)
    bytes.set(payload, DATA);
    i32[2] = payload.length;
  }
  i32[1] = id;
  i32[3] = status;
  Atomics.store(i32, 0, 1);
  Atomics.notify(i32, 0);
}

function failAll(text) {
  for (const [id, mode] of pending) reply(id, mode, false, null, text);
  pending.clear();
}

function onData(chunk) {
  rest += chunk;
  let nl;
  while ((nl = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.event !== undefined && msg.id === undefined) {
      parentPort.postMessage({ event: msg.event, data: msg });
      continue;
    }
    const mode = pending.get(msg.id);
    if (!mode) continue;
    pending.delete(msg.id);
    reply(msg.id, mode, msg.ok !== false, line, String(msg.error ?? 'Ispyx reported an error.'));
  }
}

function send(req) {
  pending.set(req.id, req.mode);
  sock.write(JSON.stringify({ id: req.id, fn: req.fn, args: req.args }) + '\n');
}

parentPort.on('message', (req) => {
  if (sock) {
    send(req);
    return;
  }
  rest = '';
  ensureConnected().then(() => send(req), (e) => reply(req.id, req.mode, false, null, e.message));
});
