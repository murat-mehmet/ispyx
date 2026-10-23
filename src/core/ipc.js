// One working server per desktop: the first ispyx process listens on a named pipe and does the work;
// every other process (one per Claude instance) stays a normal MCP server toward its own Claude and forwards
// the tool calls over the pipe. Protocol: one JSON line each way per call.
import net from 'node:net';
import os from 'node:os';
import crypto from 'node:crypto';

/** Same user + same ISPYX_* (or legacy WIN_INPUT_*) settings = same pipe, so test servers with their own env never meet the live one. */
export function pipeName() {
  const env = Object.entries(process.env).filter(([k]) => k.startsWith('ISPYX_') || k.startsWith('WIN_INPUT_')).sort().map(([k, v]) => `${k}=${v}`).join('\n');
  const user = os.userInfo().username.replace(/[^\w.-]/g, '_');
  return `\\\\.\\pipe\\ispyx-${user}-${crypto.createHash('sha1').update(env).digest('hex').slice(0, 8)}`;
}

/** Reads newline-delimited JSON from a stream. */
function lines(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (l) onLine(l);
    }
  });
}

/**
 * Tries to become the owner. Resolves with { close, clients() } when this process now listens,
 * or null when another process already owns the pipe.
 */
export function listenOwner(name, run) {
  return new Promise((resolve, reject) => {
    let clients = 0;
    const watchers = new Set(); // other servers waiting for a shutdown order
    const srv = net.createServer((sock) => {
      clients++;
      sock.on('close', () => { clients--; watchers.delete(sock); });
      sock.on('error', () => {});
      lines(sock, async (l) => {
        let req;
        try { req = JSON.parse(l); } catch { return; }
        if (req.watch) { watchers.add(sock); return; }
        let reply;
        try { reply = { id: req.id, result: await run(req.name, req.args ?? {}) }; }
        catch (e) { reply = { id: req.id, error: e.message }; }
        if (!sock.destroyed) sock.write(JSON.stringify(reply) + '\n');
      });
    });
    srv.once('error', (e) => (e.code === 'EADDRINUSE' ? resolve(null) : reject(e)));
    srv.listen(name, () => resolve({
      close: () => srv.close(),
      clients: () => clients,
      /** Tells every other server on this pipe to exit. */
      broadcastShutdown: () => { for (const s of watchers) { try { s.write(JSON.stringify({ shutdown: true }) + '\n'); } catch { /* gone */ } } },
    }));
  });
}

/**
 * Keeps a connection to the owner open so it can order this server to exit (the owner's second stop press).
 * Reconnects when the owner changes. Stops retrying once onShutdown ran or isOwner() is true.
 */
export function watchOwner(name, onShutdown, isOwner) {
  const attempt = () => {
    if (isOwner()) return;
    const sock = net.connect(name);
    sock.on('connect', () => sock.write(JSON.stringify({ watch: true }) + '\n'));
    sock.on('error', () => {});
    sock.on('close', () => { const t = setTimeout(attempt, 1000); t.unref(); });
    lines(sock, (l) => { try { if (JSON.parse(l).shutdown) onShutdown(); } catch { /* ignore */ } });
    sock.unref();
  };
  attempt();
}

export class OwnerGone extends Error {}

/** Forwards one call to the owner. Throws OwnerGone when nobody listens (so the caller can take over). */
export function callOwner(name, tool, args) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(name);
    let connected = false;
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; sock.destroy(); fn(v); } };
    sock.on('connect', () => {
      connected = true;
      sock.write(JSON.stringify({ id: 1, name: tool, args }) + '\n');
    });
    sock.on('error', (e) => finish(reject, connected ? new Error(`The ispyx server that was doing the work went away (${e.code ?? e.message}). Try the call again.`) : new OwnerGone(e.code)));
    sock.on('close', () => finish(reject, connected ? new Error('The ispyx server that was doing the work went away. Try the call again.') : new OwnerGone('closed')));
    lines(sock, (l) => {
      const r = JSON.parse(l);
      if (r.error !== undefined) finish(reject, new Error(r.error));
      else finish(resolve, r.result);
    });
  });
}
