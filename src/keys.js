// "ctrl+shift+t" style chords -> Windows virtual-key codes.
const NAMED = {
  win: 0x5b, windows: 0x5b, meta: 0x5b, cmd: 0x5b, super: 0x5b, lwin: 0x5b, rwin: 0x5c,
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, menu: 0x12,
  enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, tab: 0x09, space: 0x20,
  backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d,
  home: 0x24, end: 0x23, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  ',': 0xbc, '.': 0xbe, '-': 0xbd, '=': 0xbb, '/': 0xbf, ';': 0xba, "'": 0xde,
  '[': 0xdb, ']': 0xdd, '\\': 0xdc, '`': 0xc0,
};

export function parseChord(chord) {
  const parts = chord.trim().toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Empty key chord.');
  return parts.map((p) => {
    if (NAMED[p] !== undefined) return NAMED[p];
    if (/^f([1-9]|1\d|2[0-4])$/.test(p)) return 0x70 + Number(p.slice(1)) - 1;
    if (/^[a-z0-9]$/.test(p)) return p.toUpperCase().charCodeAt(0);
    throw new Error(`Unknown key "${p}". Use names like ctrl, shift, alt, enter, tab, esc, f5, a-z, 0-9.`);
  });
}

/** "ctrl+a ctrl+c" -> two chords. */
export const parseSequence = (s) => s.trim().split(/\s+/).filter(Boolean).map(parseChord);

/** Chords that would insert clipboard/other content, which must not go into a password field. */
export function insertsContent(vks) {
  const has = (k) => vks.includes(k);
  return (has(0x11) && has(0x56)) || (has(0x10) && has(0x2d));
}
