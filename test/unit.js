// Unit checks that need no foreign window: PNG round trip, key parsing, password-field detection
// (against an Edit control this test creates itself).
import koffi from 'koffi';
import * as w from '../src/win32.js';
import { encodePng, decodePng, toRgbaScaled } from '../src/image.js';
import { parseSequence, insertsContent } from '../src/keys.js';

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

// keys
check('parse ctrl+shift+t', JSON.stringify(parseSequence('ctrl+shift+t')[0]) === JSON.stringify([0x11, 0x10, 0x54]));
check('parse two chords', parseSequence('ctrl+a ctrl+c').length === 2);
check('win key parses', parseSequence('win+r')[0][0] === 0x5b);
check('ctrl+v counts as content insertion', insertsContent(parseSequence('ctrl+v')[0]) && !insertsContent(parseSequence('ctrl+a')[0]));

// password gate (fake prompt and clock, temp file; no window)
{
  const { Auth, toMinutes, fromMinutes } = await import('../src/auth.js');
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
  answers.push({ password: 'abc', confirm: 'abc', value: 24, unit: 'saat' }, { password: 'abcdef', confirm: 'abcxyz', value: 24, unit: 'saat' },
    { password: 'abcdef', confirm: 'abcdef', value: 2, unit: 'saat', makeDefault: true });
  await a.ensure();
  check('first run asks to set a password (setup mode), retries short/mismatched ones', seen.length === 3 && seen.every((s) => s.mode === 'setup') && /6/.test(seen[1].message) && /ayni/.test(seen[2].message));
  const stored = fs.readFileSync(file, 'utf8');
  check('only a hash is stored, never the password', !stored.includes('abcdef') && JSON.parse(stored).hash.length === 64);
  check('unlock lasts the chosen time', JSON.parse(stored).unlockedUntil === t + 120 * 60000 && JSON.parse(stored).defaultMinutes === 120, stored.slice(0, 0));

  seen.length = 0;
  await a.ensure();
  await mk().ensure(); // another server instance reads the same file
  check('no prompt while unlocked (also across instances)', seen.length === 0);

  t += 121 * 60000;
  answers.push({ password: 'nope', value: 1, unit: 'gun' }, { password: 'abcdef', value: 10, unit: 'dakika' });
  await a.ensure();
  check('after expiry asks again (unlock mode), wrong password retried, default duration offered', seen.length === 2 && seen[0].mode === 'unlock' && /Yanlis/.test(seen[1].message) && seen[0].value === 2 && seen[0].unit === 'saat');
  check('"make default" was not ticked, so the default stays', JSON.parse(fs.readFileSync(file, 'utf8')).defaultMinutes === 120);

  seen.length = 0;
  t += 11 * 60000;
  answers.push({ cancel: true });
  check('closing the window refuses the tool', await fails(a) && seen.length === 1);

  seen.length = 0;
  const slow = mk({ prompt: async (o) => { seen.push(o); t += 40000; return { password: 'nope', value: 1, unit: 'saat' }; } });
  check('wrong passwords until the 30 s window ends refuse the tool', await fails(slow) && seen.length === 1);

  seen.length = 0;
  let calls = 0;
  const gate = mk({ prompt: async () => { calls++; await new Promise((r) => setTimeout(r, 50)); return { password: 'abcdef', value: 1, unit: 'gun' }; } });
  await Promise.all([gate.ensure(), gate.ensure(), gate.ensure()]);
  check('parallel calls share one window', calls === 1);
  check('unit maths', toMinutes(30, 'gun') === 43200 && toMinutes(10, 'dakika') === 10 && toMinutes(9999, 'gun') === 525600 && fromMinutes(1440).unit === 'saat' && fromMinutes(1440).value === 24 && fromMinutes(43200).unit === 'gun' && fromMinutes(90).unit === 'dakika');
  fs.rmSync(file, { force: true });
}

// password detection against our own Edit controls
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

console.log(failed ? `\n${failed} check(s) FAILED` : '\nUNIT TESTS PASSED');
process.exit(failed ? 1 : 0);
