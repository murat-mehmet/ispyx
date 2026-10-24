// "Open at Windows start": a per-user Run entry (HKCU, no admin).
//
// Design choice: the Run value does not start node.exe directly, because node.exe is a console-subsystem
// program and Windows would flash a console window at every logon. Instead the value is
//     "<SystemRoot>\System32\wscript.exe" "%APPDATA%\ispyx\start.vbs"
// and start.vbs runs `"<node.exe>" "<src/server.js>"` with window style 0 (hidden, not waited for). Started with no
// arguments, server.js turns into the detached hidden resident process by itself (the launcher semantics), so
// nothing visible appears. The registry is written through reg.exe (always present, per-user, no native glue).
//
// Tests can redirect everything with ISPYX_AUTOSTART_VALUE (value name; also names the .vbs), so the real entry is
// never touched.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const valueName = () => process.env.ISPYX_AUTOSTART_VALUE || 'Ispyx';
const roaming = () => process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming');
const vbsPath = () => path.join(roaming(), 'ispyx', valueName() === 'Ispyx' ? 'start.vbs' : `start-${valueName()}.vbs`);
const serverJs = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server.js');

const reg = (args) => execFileSync('reg.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

export const autostart = {
  /** The command line stored in the Run value. */
  command() {
    const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
    return `"${wscript}" "${vbsPath()}"`;
  },

  /** Whether the Run value exists. */
  get() {
    try {
      return reg(['query', RUN_KEY, '/v', valueName()]).includes('REG_');
    } catch { return false; }
  },

  /** Turns the entry on or off; returns the resulting state. Throws if the registry cannot be written. */
  set(on) {
    if (on) {
      const vbs = vbsPath();
      fs.mkdirSync(path.dirname(vbs), { recursive: true });
      const q = (s) => `"${s.replace(/"/g, '""')}"`; // VBScript string literal
      const cmd = `"${process.execPath}" "${serverJs()}"`;
      fs.writeFileSync(vbs, `CreateObject("WScript.Shell").Run ${q(cmd)}, 0, False\r\n`, 'utf8');
      reg(['add', RUN_KEY, '/v', valueName(), '/t', 'REG_SZ', '/d', this.command(), '/f']);
    } else {
      try { reg(['delete', RUN_KEY, '/v', valueName(), '/f']); } catch { /* not there */ }
      try { fs.rmSync(vbsPath(), { force: true }); } catch { /* best effort */ }
    }
    return this.get();
  },
};
