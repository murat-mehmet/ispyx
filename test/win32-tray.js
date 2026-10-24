// Tray icon + autostart round trip. Uses a throwaway Run value name so the real "Ispyx" entry is never touched.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'win32') { console.log('skipped: Windows only'); process.exit(0); }
process.env.ISPYX_AUTOSTART_VALUE = `IspyxTest${process.pid}`;
const { Tray, autostart, pumpOnce } = await import('../src/platform/win32/index.js');

let failed = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ', name); } catch (e) { failed++; console.log('FAIL ', name, '-', e.message); } };

try {
  // autostart
  assert.equal(autostart.get(), false);
  check('autostart.command quotes wscript + vbs', () => assert.match(autostart.command(), /^"[^"]*wscript\.exe" "[^"]*start-IspyxTest\d+\.vbs"$/i));
  check('autostart.set(true)', () => assert.equal(autostart.set(true), true));
  check('autostart.get after set', () => assert.equal(autostart.get(), true));
  check('registry holds the command', () => {
    const out = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', process.env.ISPYX_AUTOSTART_VALUE], { encoding: 'utf8' });
    assert.ok(out.toLowerCase().includes('wscript.exe'));
  });
  check('autostart.set(false)', () => assert.equal(autostart.set(false), false));

  // tray
  let opened = 0;
  const tray = new Tray({ tooltip: 'Ispyx test', onOpen: () => opened++, onQuit: () => {}, getStatus: () => 'test status' });
  check('NIM_ADD succeeded', () => assert.equal(tray.visible, true));
  check('NIM_MODIFY (setTooltip)', () => assert.equal(tray.setTooltip('Ispyx test 2'), true));
  await new Promise((r) => setTimeout(r, 300));
  pumpOnce();
  check('icon rect (informational)', () => { const r = tray.rect(); console.log('     rect', JSON.stringify(r)); });
  check('re-add on TaskbarCreated path', () => assert.equal(tray._add(), false)); // already present: NIM_ADD fails, no throw
  tray.destroy();
  check('destroyed', () => assert.equal(tray.setTooltip('x'), false));
} finally {
  try { autostart.set(false); } catch { /* nothing left to remove */ }
}
assert.equal(autostart.get(), false, 'test entry left behind');
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
