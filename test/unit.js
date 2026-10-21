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

// kill corner: top-left of the whole virtual desktop (pure arithmetic, the pointer is never moved)
{
  const { Guard } = await import('../src/guard.js');
  const g = Object.create(Guard.prototype);
  g.config = { killCornerPx: 2 };
  const o = { x: -1920, y: 0 }; // monitor left of the primary
  check('corner: negative x on the top row is not the corner', !g.inCorner(-1000, 1, o) && !g.inCorner(-1900, 0, o));
  check('corner: virtual top-left is the corner', g.inCorner(-1920, 0, o) && g.inCorner(-1918, 2, o));
  check('corner: primary (0,0) is not the corner when a monitor is on the left', !g.inCorner(0, 0, o));
  check('corner: single monitor (0,0) is the corner', g.inCorner(0, 0, { x: 0, y: 0 }) && !g.inCorner(3, 0, { x: 0, y: 0 }));
  check('corner: monitor above the primary', !g.inCorner(100, -500, { x: 0, y: -1080 }) && g.inCorner(0, -1080, { x: 0, y: -1080 }));
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
