// "cmd+shift+t" style chords -> macOS virtual key codes (kVK_* from Carbon's HIToolbox/Events.h).
//
// The one subtle thing: `ctrl` is the literal Control key (kVK_Control, 59), NOT Command. Chords written for
// Windows ("ctrl+c") therefore do not copy on a Mac; use "cmd" (also spelled win / meta / super) for that.
// `alt` is Option. Codes are physical-key (ANSI layout) codes, as the OS expects for key events.
export const KVK = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46,
  1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, 9: 25, 7: 26, 8: 28, 0: 29,
  '=': 24, '-': 27, ']': 30, '[': 33, "'": 39, ';': 41, '\\': 42, ',': 43, '/': 44, '.': 47, '`': 50,
  return: 36, tab: 48, space: 49, delete: 51 /* backspace */, escape: 53, command: 55, shift: 56, capslock: 57,
  option: 58, control: 59, rshift: 60, roption: 61, rcontrol: 62, rcommand: 54, fn: 63,
  forwarddelete: 117, home: 115, end: 119, pageup: 116, pagedown: 121, help: 114,
  left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
};

const NAMED = {
  win: 55, windows: 55, meta: 55, cmd: 55, command: 55, super: 55, lwin: 55, rwin: 54,
  ctrl: 59, control: 59, shift: 56, alt: 58, option: 58, opt: 58, menu: 58,
  enter: 36, return: 36, esc: 53, escape: 53, tab: 48, space: 49,
  backspace: 51, delete: 117, del: 117, insert: 114, ins: 114, // Mac "delete" is backspace; forward delete is the Windows Delete
  home: 115, end: 119, pageup: 116, pgup: 116, pagedown: 121, pgdn: 121,
  left: 123, up: 126, right: 124, down: 125,
  ',': 43, '.': 47, '-': 27, '=': 24, '/': 44, ';': 41, "'": 39, '[': 33, ']': 30, '\\': 42, '`': 50,
};

const CMD = new Set([55, 54]);
const V = 9;

export function parseChord(chord) {
  const parts = chord.trim().toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Empty key chord.');
  return parts.map((p) => {
    if (NAMED[p] !== undefined) return NAMED[p];
    if (/^f([1-9]|1\d|20)$/.test(p)) return KVK[p];
    if (/^[a-z0-9]$/.test(p)) return KVK[p];
    throw new Error(`Unknown key "${p}". Use names like cmd, ctrl, shift, alt, enter, tab, esc, f5, a-z, 0-9 (macOS has no f21-f24).`);
  });
}

/** "cmd+a cmd+c" -> two chords. */
export const parseSequence = (s) => s.trim().split(/\s+/).filter(Boolean).map(parseChord);

/** Chords that paste (Cmd+V, Cmd+Shift+V, Cmd+Option+Shift+V): must not go into a password field. */
export function insertsContent(codes) {
  return codes.some((k) => CMD.has(k)) && codes.includes(V) && !codes.includes(59);
}
