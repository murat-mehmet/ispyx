// Unit checks that need no foreign window: PNG round trip, key parsing, password-field detection
// (against an Edit control this test creates itself).
import koffi from 'koffi';
import w from '../src/platform/index.js';
import { encodePng, decodePng, toRgbaScaled, cropCapture } from '../src/core/image.js';
import { parseSequence, insertsContent } from '../src/platform/win32/keys.js';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

w.init();

// image
const bgra = Buffer.alloc(4 * 4 * 4, 0);
for (let i = 0; i < 16; i++) { bgra[i * 4] = 10; bgra[i * 4 + 1] = 20; bgra[i * 4 + 2] = 30; }
const small = toRgbaScaled(bgra, 4, 4, 2, 2);
const back = decodePng(encodePng(small, 2, 2));
check('png round trip', back.width === 2 && back.rgba[0] === 30 && back.rgba[1] === 20 && back.rgba[2] === 10 && back.rgba[3] === 255);
// macOS hands captures over as a plain Uint8Array, not a Buffer
const grid = new Uint8Array(4 * 4 * 4);
for (let i = 0; i < 16; i++) grid[i * 4] = i;
const crop = cropCapture({ bits: grid, width: 4, height: 4 }, { x: 1, y: 2, width: 2, height: 2 });
check('crop a Uint8Array capture', crop.width === 2 && crop.height === 2 && [0, 4, 8, 12].map((o) => crop.bits[o]).join() === '9,10,13,14');

// keys
check('parse ctrl+shift+t', JSON.stringify(parseSequence('ctrl+shift+t')[0]) === JSON.stringify([0x11, 0x10, 0x54]));
check('parse two chords', parseSequence('ctrl+a ctrl+c').length === 2);
check('win key parses', parseSequence('win+r')[0][0] === 0x5b);
check('ctrl+v counts as content insertion', insertsContent(parseSequence('ctrl+v')[0]) && !insertsContent(parseSequence('ctrl+a')[0]));

// password gate (fake prompt and clock, temp file; no window)
{
  const { Auth, toMinutes, fromMinutes } = await import('../src/core/auth.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const file = pathMod.join(os.tmpdir(), `win-input-auth-${Date.now()}.json`);
  let t = 1_000_000;
  const answers = [];
  const seen = [];
  const prompt = async (opts, ms) => { seen.push({ ...opts, ms }); t += 1000; return answers.shift() ?? { cancel: true }; };
  const mk = (extra = {}) => new Auth({ enabled: true, file, timeoutMs: 30000, prompt, now: () => t, ...extra });
  const fails = async (a) => { try { await a.ensure(); return false; } catch { return true; } };

  await new Auth({ enabled: false, file, prompt, now: () => t }).ensure();
  check('auth off: no prompt', seen.length === 0);

  const a = mk();
  answers.push({ password: 'abc', confirm: 'abc', value: 24, unit: 'hours' }, { password: 'abcdef', confirm: 'abcxyz', value: 24, unit: 'hours' },
    { password: 'abcdef', confirm: 'abcdef', value: 2, unit: 'hours', makeDefault: true });
  await a.ensure();
  check('first run asks to set a password (setup mode), retries short/mismatched ones', seen.length === 3 && seen.every((s) => s.mode === 'setup') && /6/.test(seen[1].message) && /do not match/.test(seen[2].message));
  const stored = fs.readFileSync(file, 'utf8');
  check('only a hash is stored, never the password', !stored.includes('abcdef') && JSON.parse(stored).hash.length === 64);
  check('unlock lasts the chosen time (in memory, not on disk)', a.until === t + 120 * 60000 && JSON.parse(stored).defaultMinutes === 120 && !('unlockedUntil' in JSON.parse(stored)));

  seen.length = 0;
  await a.ensure();
  check('no prompt while unlocked', seen.length === 0);
  answers.push({ password: 'abcdef', value: 1, unit: 'days' });
  await mk().ensure(); // a new server start (e.g. /mcp reconnect) always asks again
  check('a new instance asks again', seen.length === 1 && seen[0].mode === 'unlock');

  seen.length = 0;
  t += 121 * 60000;
  answers.push({ password: 'nope', value: 1, unit: 'days' }, { password: 'abcdef', value: 10, unit: 'minutes' });
  await a.ensure();
  check('after expiry asks again (unlock mode), wrong password retried, default duration offered', seen.length === 2 && seen[0].mode === 'unlock' && /Wrong password/.test(seen[1].message) && seen[0].value === 2 && seen[0].unit === 'hours' && seen[1].value === 1 && seen[1].unit === 'days' && /2 tries left/.test(seen[1].message) && seen.every((s) => s.ms === 30000));
  check('"make default" was not ticked, so the default stays', JSON.parse(fs.readFileSync(file, 'utf8')).defaultMinutes === 120);

  seen.length = 0;
  t += 11 * 60000;
  answers.push({ cancel: true });
  check('closing the window refuses the tool', await fails(a) && seen.length === 1);

  seen.length = 0;
  const bad = mk({ prompt: async (o) => { seen.push(o); return { password: 'nope', value: 1, unit: 'hours' }; } });
  let msg = '';
  try { await bad.ensure(); } catch (e) { msg = e.message; }
  check('three wrong passwords in a row refuse the tool (windows reopen without answering it)', seen.length === 3 && /3 times/.test(msg) && /1 try left/.test(seen[2].message), msg.slice(0, 60));

  // the default duration saved with "make default" is what the next window offers
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...d, defaultMinutes: 10 }));
  seen.length = 0;
  answers.push({ password: 'abcdef', value: 10, unit: 'minutes' });
  await mk().ensure();
  check('next window offers the saved default (10 minutes)', seen[0].value === 10 && seen[0].unit === 'minutes', JSON.stringify(seen[0]));
  fs.writeFileSync(file, JSON.stringify({ ...d, defaultMinutes: 120 }));

  seen.length = 0;
  let calls = 0;
  const gate = mk({ prompt: async () => { calls++; await new Promise((r) => setTimeout(r, 50)); return { password: 'abcdef', value: 1, unit: 'days' }; } });
  await Promise.all([gate.ensure(), gate.ensure(), gate.ensure()]);
  check('parallel calls share one window', calls === 1);
  check('unit maths', toMinutes(30, 'days') === 43200 && toMinutes(10, 'minutes') === 10 && toMinutes(9999, 'days') === 525600 && fromMinutes(1440).unit === 'hours' && fromMinutes(1440).value === 24 && fromMinutes(43200).unit === 'days' && fromMinutes(90).unit === 'minutes');
  fs.rmSync(file, { force: true });
}

// password detection against our own Edit controls (Windows only: the window is made with user32)
if (process.platform === 'win32') {
  const user32 = koffi.load('user32.dll');
  const CreateWindowExW = user32.func('intptr_t CreateWindowExW(uint32, str16, str16, uint32, int, int, int, int, intptr_t, intptr_t, intptr_t, intptr_t)');
  const SetFocus = user32.func('intptr_t SetFocus(intptr_t)');
  const DestroyWindow = user32.func('bool DestroyWindow(intptr_t)');
  for (const [label, style, expected] of [['plain edit', 0, false], ['ES_PASSWORD edit', 0x20, true]]) {
    const h = CreateWindowExW(0, 'EDIT', 'x', 0x10000000 | 0x80000000 | 0x00C00000 | style, 200, 200, 300, 80, 0, 0, 0, 0); // WS_VISIBLE|WS_POPUP|WS_CAPTION
    const ok = await w.bringToForeground(h);
    SetFocus(h);
    await w.sleep(200);
    let got;
    try { got = w.focusIsPassword(); } catch (e) { got = 'error: ' + e.message; }
    check(`focusIsPassword: ${label}`, ok && got === expected, `foreground=${ok} got=${got}`);
    DestroyWindow(h);
  }
} else {
  console.log('SKIP  focusIsPassword (Windows only)');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nUNIT TESTS PASSED');
process.exit(failed ? 1 : 0);
