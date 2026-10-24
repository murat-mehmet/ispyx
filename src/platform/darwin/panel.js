// The server side of the Ispyx window on macOS. The app shows the shared panel page (src/core/panel/page.html) and
// owns what it knows itself (permissions, start at login, connect info); activity, effects, password and denylist
// live in the server, so the app asks the owner for them:
//   app -> client  event  { event: 'panelRequest', req, kind: 'state' | 'action', name, value }
//   client -> app  call   panelReply({ req, ok, result } | { req, ok: false, error })
// (`req`, not `id`: a line with an id is taken for the answer to a call, see rpc-worker.js)
// Only the owner serves (it is the one process that runs the tools); the app takes the first reply.
import { onEvent, post } from './rpc.js';

/** model: { getState(), actions: { name(value) } } from core/resident.js panelModel. Returns an unsubscribe function. */
export function servePanel(model) {
  return onEvent('panelRequest', async (m) => {
    const { req, kind, name, value } = m ?? {};
    if (req === undefined) return;
    try {
      let result;
      if (kind === 'state') result = model.getState();
      else if (kind === 'action' && Object.hasOwn(model.actions, name)) result = await model.actions[name](value ?? undefined);
      else throw new Error(`Unknown panel action ${name}`);
      post('panelReply', { req, ok: true, result: result ?? null });
    } catch (e) {
      post('panelReply', { req, ok: false, error: e.message });
    }
  });
}
