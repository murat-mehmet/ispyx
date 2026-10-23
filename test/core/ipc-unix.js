// Owner election, call forwarding and shutdown broadcast over a unix socket path (src/core/ipc.js).
// Node supports AF_UNIX on Windows 10+ too; if it does not work here the test prints SKIP.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { listenOwner, callOwner, watchOwner, OwnerGone, pipeName } from '../../src/core/ipc.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ispyx-ipc-'));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failed++; };
const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };

// can this OS listen on a unix socket at all?
const canUnix = await new Promise((resolve) => {
  const s = net.createServer();
  s.on('error', () => resolve(false));
  s.listen(path.join(dir, 'probe.sock'), () => s.close(() => resolve(true)));
});
if (!canUnix) {
  console.log('SKIP: unix sockets are not available here (stale-socket and path checks not run)');
  if (process.platform !== 'win32') { cleanup(); process.exit(0); }
}
// without AF_UNIX on Windows the election/forward/broadcast checks still run, over a named pipe
const sock = canUnix ? path.join(dir, 's.sock') : `\\\\.\\pipe\\ispyx-ipc-test-${process.pid}`;

if (process.platform !== 'win32') {
  const n = pipeName();
  ok(n.endsWith('.sock') && n.length < 100, `pipeName() is a short unix socket path (${n})`);
}

const run = async (name, args) => { if (name === 'boom') throw new Error('bad'); return { name, args }; };

if (canUnix) {
  // a stale socket file (owner killed) must be replaced
  const child = spawn(process.execPath, ['-e', `
    import(${JSON.stringify(new URL('../../src/core/ipc.js', import.meta.url).href)})
      .then((m) => m.listenOwner(process.argv[1], async () => 1)).then(() => console.log('up'));`, sock], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => child.stdout.once('data', r));
  let gone = false;
  try { await callOwner(sock, 'x', {}); } catch { gone = true; }
  ok(!gone, 'child owner answers');
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await exited;
  ok(fs.existsSync(sock) || process.platform === 'win32', 'killed owner leaves a socket file (or the OS cleaned it)');
  try { await callOwner(sock, 'x', {}); ok(false, 'dead owner'); } catch (e) { ok(e instanceof OwnerGone, 'callOwner on a dead socket throws OwnerGone'); }
}

// election
const a = await listenOwner(sock, run);
ok(!!a, 'first process becomes owner (stale file removed)');
const b = await listenOwner(sock, run);
ok(b === null, 'second process is not the owner');

// forwarding
const r = await callOwner(sock, 'echo', { x: 1 });
ok(r.name === 'echo' && r.args.x === 1, 'call is forwarded and answered');
try { await callOwner(sock, 'boom', {}); ok(false, 'error is propagated'); } catch (e) { ok(e.message === 'bad', 'owner error comes back as an Error'); }

// shutdown broadcast
let shut = 0;
watchOwner(sock, () => { shut++; }, () => false);
await new Promise((r2) => setTimeout(r2, 300));
ok(a.clients() >= 1, 'watcher is connected');
a.broadcastShutdown();
await new Promise((r2) => setTimeout(r2, 300));
ok(shut === 1, 'watcher received the shutdown order');

// owner leaves -> socket gone -> a new owner can take over
a.close();
await new Promise((r2) => setTimeout(r2, 200));
try { await callOwner(sock, 'x', {}); ok(false, 'closed owner'); } catch (e) { ok(e instanceof OwnerGone, 'closed owner: OwnerGone'); }
const c = await listenOwner(sock, run);
ok(!!c, 'a new owner can take over');
c.close();

cleanup();
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
