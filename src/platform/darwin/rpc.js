// Client for Ispyx.app's JSON-lines socket (see PROTOCOL.md).
//
// The socket lives in a worker thread (rpc-worker.js). The core wants synchronous platform calls, so callSync()
// posts the request to the worker and blocks the main thread in Atomics.wait until the worker has written the
// response into shared memory:
//
//   SharedArrayBuffer: [ header: 8 x Int32 | payload area (CAPACITY bytes) ]
//     header[0] state (0 waiting, 1 ready)   header[1] id answered   header[2] payload byte length
//     header[3] status (0 ok = the raw response line, 1 error = message text, 2 too big for the area)
//     header[4] id the main thread is waiting for (the worker drops answers for calls that timed out)
//   Responses larger than CAPACITY (rare: pixels travel in files) come over a MessagePort that the main thread
//   reads synchronously with receiveMessageOnPort().
//
// callAsync() is the same call answered through the worker's message port (does not block). post() sends and
// forgets (layerPresent, overlay updates): order is preserved because everything goes through one socket.
// Events from the app (`stop`, `permissions`) arrive through onEvent() on the main thread's event loop.
import os from 'node:os';
import path from 'node:path';
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';

const CAPACITY = 4 * 1024 * 1024;
const HEADER = 64;
const SYNC_TIMEOUT_MS = 30000;

export const defaultEndpoint = () => path.join(os.homedir(), 'Library', 'Application Support', 'Ispyx', 'helper.sock');
export const NOT_RUNNING = 'Cannot reach Ispyx.app. Install Ispyx.app (drag it to Applications) and start it once, then try again';

let worker = null;
let i32 = null;
let sab = null;
let bigPort = null;
let nextId = 1;
let refs = 0;
const asyncPending = new Map(); // id -> { resolve, reject }
const listeners = new Map(); // event name -> Set<cb>

function start() {
  if (worker) return;
  const override = process.env.ISPYX_HELPER_ENDPOINT;
  sab = new SharedArrayBuffer(HEADER + CAPACITY);
  i32 = new Int32Array(sab, 0, 8);
  const ch = new MessageChannel();
  bigPort = ch.port1;
  worker = new Worker(new URL('./rpc-worker.js', import.meta.url), {
    workerData: {
      sab,
      bigPort: ch.port2,
      endpoint: override || defaultEndpoint(),
      // a resident started by Ispyx.app never opens the app again: when it cannot reach the app, the app is gone
      autostart: !override && !process.env.ISPYX_APP_PID,
      // started by Ispyx.app: an app that does not answer is gone, so give up fast (the resident then leaves)
      waitMs: Number(process.env.ISPYX_HELPER_WAIT_MS) || (override ? 2000 : process.env.ISPYX_APP_PID ? 1000 : 10000),
      notRunningMessage: NOT_RUNNING,
    },
    transferList: [ch.port2],
  });
  worker.unref();
  worker.on('message', onWorkerMessage);
  worker.on('error', (e) => { process.stderr.write(`ispyx: helper client crashed: ${e.message}\n`); worker = null; failAsync(e.message); });
}

function ref() { if (refs++ === 0) worker?.ref(); }
function unref() { if (--refs === 0) worker?.unref(); }

function failAsync(text) {
  for (const p of asyncPending.values()) p.reject(new Error(text));
  asyncPending.clear();
  refs = 0;
}

function onWorkerMessage(m) {
  if (m.event !== undefined) {
    for (const cb of listeners.get(m.event) ?? []) {
      try { cb(m.data); } catch (e) { process.stderr.write(`ispyx: event handler failed: ${e.message}\n`); }
    }
    return;
  }
  const p = asyncPending.get(m.id);
  if (!p) return;
  asyncPending.delete(m.id);
  unref();
  if (m.error !== undefined) p.reject(new Error(m.error));
  else p.resolve(JSON.parse(m.line).result);
}

/** Blocking call: returns the result or throws Error(message from the app). */
export function callSync(fn, ...args) {
  start();
  const id = nextId++;
  Atomics.store(i32, 0, 0);
  Atomics.store(i32, 4, id);
  worker.postMessage({ id, fn, args, mode: 'sync' });
  for (;;) {
    if (Atomics.wait(i32, 0, 0, SYNC_TIMEOUT_MS) === 'timed-out') {
      Atomics.store(i32, 4, 0);
      throw new Error(`Ispyx did not answer ${fn} within ${SYNC_TIMEOUT_MS / 1000} s. Check that Ispyx.app is running and not waiting for a permission prompt.`);
    }
    if (Atomics.load(i32, 1) === id) break;
    Atomics.store(i32, 0, 0); // an answer to an older call that arrived late: keep waiting
  }
  let status = i32[3];
  let text;
  if (status === 2) { // too big for the shared area: the worker sent it through the port
    const m = receiveMessageOnPort(bigPort)?.message;
    if (!m) throw new Error('Internal error: a large response from Ispyx was lost.');
    ({ status, text } = m);
  } else {
    text = Buffer.from(sab, HEADER, i32[2]).toString('utf8');
  }
  if (status === 1) throw new Error(text);
  return JSON.parse(text).result;
}

/** Non-blocking call: Promise of the result. */
export function callAsync(fn, ...args) {
  start();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    asyncPending.set(id, { resolve, reject });
    ref();
    worker.postMessage({ id, fn, args, mode: 'async' });
  });
}

/** Fire and forget: the answer (and any error) is dropped. Ordered with every other call. */
export function post(fn, ...args) {
  start();
  worker.postMessage({ id: nextId++, fn, args, mode: 'quiet' });
}

/** Subscribe to an app event ('stop', 'permissions'). Returns an unsubscribe function. */
export function onEvent(name, cb) {
  start();
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(cb);
  return () => listeners.get(name)?.delete(cb);
}

/** Stop the worker (tests). */
export async function close() {
  if (!worker) return;
  const w = worker;
  worker = null;
  failAsync('closed');
  await w.terminate();
}
