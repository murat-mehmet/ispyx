// Entry point used by Ispyx.app: the app starts it as the resident (`--resident`), and the MCP launcher
// (Contents/Resources/ispyx) as the thin forwarder (`mcp`). Picks the platform automatically (darwin), whatever the
// environment of the MCP client says, then runs the normal server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

delete process.env.ISPYX_PLATFORM;
// The app's resident and every forwarder meet on one socket in the app's data folder, whatever their environment
// (an MCP client may give its children another temp directory).
if (!process.env.ISPYX_PIPE) {
  const dir = path.join(os.homedir(), 'Library', 'Application Support', 'Ispyx');
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* reported when listening fails */ }
  process.env.ISPYX_PIPE = path.join(dir, 'ispyx.sock');
}
await import('./core/server.js');
