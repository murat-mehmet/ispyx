// Entry point used by Ispyx.app: the app starts it as the resident (`--resident`), and the MCP launcher
// (Contents/Resources/ispyx) as the thin forwarder (`mcp`), or for `update` / `quit`. Picks the platform
// automatically (darwin), whatever the environment of the MCP client says, then runs the normal entry point.
import fs from 'node:fs';
import path from 'node:path';
import { macAppPipe } from './core/launcher.js';

delete process.env.ISPYX_PLATFORM;
// The app's resident and every forwarder meet on one socket in the app's data folder, whatever their environment
// (an MCP client may give its children another temp directory). npm copies on this Mac use it too (launcher.js).
if (!process.env.ISPYX_PIPE) {
  const sock = macAppPipe();
  try { fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 }); } catch { /* reported when listening fails */ }
  process.env.ISPYX_PIPE = sock;
}
await import('./server.js'); // the entry point: picks resident / mcp / update / quit
