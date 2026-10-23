// Screenshot animation: after a capture an eye opens at the top of the captured region, looks down and follows
// a glowing green scan line that sweeps the region from top to bottom. Two click-through, per-pixel-alpha windows;
// pixels are drawn in software into DIB sections, so nothing here depends on GDI+.
import koffi from 'koffi';
import { ensurePump } from './pump.js';
import * as w from './win32.js';

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

const POINT = koffi.struct('SC_POINT', { x: 'int32', y: 'int32' });
const SIZE = koffi.struct('SC_SIZE', { cx: 'int32', cy: 'int32' });
const BLEND = koffi.struct('SC_BLEND', { op: 'uint8', flags: 'uint8', alpha: 'uint8', format: 'uint8' });
const BITMAPINFO = koffi.struct('SC_BITMAPINFO', {
  biSize: 'uint32', biWidth: 'int32', biHeight: 'int32', biPlanes: 'uint16', biBitCount: 'uint16', biCompression: 'uint32',
  biSizeImage: 'uint32', biXPels: 'int32', biYPels: 'int32', biClrUsed: 'uint32', biClrImportant: 'uint32', bmiColors: 'uint32',
});
const WndProc = koffi.proto('intptr_t ScWndProc(intptr_t h, uint32 msg, uintptr_t wp, intptr_t lp)');
const WNDCLASSEXW = koffi.struct('SC_WNDCLASSEXW', {
  cbSize: 'uint32', style: 'uint32', lpfnWndProc: koffi.pointer(WndProc), cbClsExtra: 'int32', cbWndExtra: 'int32',
  hInstance: 'intptr_t', hIcon: 'intptr_t', hCursor: 'intptr_t', hbrBackground: 'intptr_t',
  lpszMenuName: 'str16', lpszClassName: 'str16', hIconSm: 'intptr_t',
});

const f = {
  RegisterClassExW: user32.func('uint16 RegisterClassExW(SC_WNDCLASSEXW *c)'),
  CreateWindowExW: user32.func('intptr_t CreateWindowExW(uint32 ex, str16 cls, str16 title, uint32 style, int x, int y, int w, int h, intptr_t parent, intptr_t menu, intptr_t inst, intptr_t param)'),
  DefWindowProcW: user32.func('intptr_t DefWindowProcW(intptr_t h, uint32 msg, uintptr_t wp, intptr_t lp)'),
  DestroyWindow: user32.func('bool DestroyWindow(intptr_t h)'),
  ShowWindow: user32.func('bool ShowWindow(intptr_t h, int cmd)'),
  UpdateLayeredWindow: user32.func('bool UpdateLayeredWindow(intptr_t h, intptr_t dst, SC_POINT *pos, SC_SIZE *size, intptr_t src, SC_POINT *from, uint32 key, SC_BLEND *blend, uint32 flags)'),
  GetDC: user32.func('intptr_t GetDC(intptr_t h)'),
  ReleaseDC: user32.func('int ReleaseDC(intptr_t h, intptr_t dc)'),
  CreateCompatibleDC: gdi32.func('intptr_t CreateCompatibleDC(intptr_t dc)'),
  DeleteDC: gdi32.func('bool DeleteDC(intptr_t dc)'),
  CreateDIBSection: gdi32.func('intptr_t CreateDIBSection(intptr_t dc, SC_BITMAPINFO *bi, uint32 usage, _Out_ void **bits, intptr_t section, uint32 offset)'),
  SelectObject: gdi32.func('intptr_t SelectObject(intptr_t dc, intptr_t o)'),
  DeleteObject: gdi32.func('bool DeleteObject(intptr_t o)'),
  GetModuleHandleW: kernel32.func('intptr_t GetModuleHandleW(str16 n)'),
  CreateFontW: gdi32.func('intptr_t CreateFontW(int h, int w, int esc, int ori, int weight, uint32 it, uint32 ul, uint32 so, uint32 cs, uint32 op, uint32 clip, uint32 q, uint32 pf, str16 face)'),
  TextOutW: gdi32.func('bool TextOutW(intptr_t dc, int x, int y, str16 text, int n)'),
  GetTextExtentPoint32W: gdi32.func('bool GetTextExtentPoint32W(intptr_t dc, str16 text, int n, _Out_ SC_SIZE *size)'),
  SetBkMode: gdi32.func('int SetBkMode(intptr_t dc, int m)'),
  SetTextColor: gdi32.func('uint32 SetTextColor(intptr_t dc, uint32 c)'),
};

const CLASS = 'WinInputMcpScan';
let proc = null;
function registerClass() {
  if (proc) return;
  proc = koffi.register((h, msg, wp, lp) => (msg === 0x84 ? -1 : f.DefWindowProcW(h, msg, wp, lp)), koffi.pointer(WndProc));
  f.RegisterClassExW({
    cbSize: koffi.sizeof(WNDCLASSEXW), style: 0, lpfnWndProc: proc, cbClsExtra: 0, cbWndExtra: 0, hInstance: f.GetModuleHandleW(null),
    hIcon: 0, hCursor: 0, hbrBackground: 0, lpszMenuName: null, lpszClassName: CLASS, hIconSm: 0,
  });
}

/** One layered window with a premultiplied-BGRA pixel buffer. */
class Layer {
  constructor(width, height) {
    registerClass();
    this.width = width;
    this.height = height;
    // TOPMOST | TOOLWINDOW | LAYERED | TRANSPARENT (click-through) | NOACTIVATE ; WS_POPUP
    this.hwnd = f.CreateWindowExW(0x08 | 0x80 | 0x80000 | 0x20 | 0x08000000, CLASS, '', 0x80000000, 0, 0, width, height, 0, 0, f.GetModuleHandleW(null), 0);
    if (!this.hwnd) throw new Error('CreateWindowEx failed');
    const screen = f.GetDC(0);
    this.dc = f.CreateCompatibleDC(screen);
    const out = [null];
    this.bmp = f.CreateDIBSection(screen, { biSize: 40, biWidth: width, biHeight: -height, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPels: 0, biYPels: 0, biClrUsed: 0, biClrImportant: 0, bmiColors: 0 }, 0, out, 0, 0);
    f.ReleaseDC(0, screen);
    if (!this.bmp || !out[0]) throw new Error('CreateDIBSection failed');
    this.old = f.SelectObject(this.dc, this.bmp);
    this.px = new Uint8Array(koffi.view(out[0], width * height * 4));
    this.shown = false;
  }

  /** Moves the window to (x, y) and shows the current pixels at constant opacity `alpha` (0-255). */
  /** Shows the top-left `width` x `height` part of the buffer at (x, y) with constant opacity `alpha` (0-255). */
  present(x, y, alpha, height = this.height, width = this.width, srcY = 0) {
    f.UpdateLayeredWindow(this.hwnd, 0, { x: Math.round(x), y: Math.round(y) }, { cx: Math.max(1, Math.min(this.width, Math.round(width))), cy: Math.max(1, Math.min(this.height, Math.round(height))) }, this.dc, { x: 0, y: Math.max(0, Math.round(srcY)) }, 0,
      { op: 0, flags: 0, alpha: Math.max(0, Math.min(255, Math.round(alpha))), format: 1 }, 2); // ULW_ALPHA, AC_SRC_ALPHA
    if (!this.shown) {
      f.ShowWindow(this.hwnd, 4); // SW_SHOWNOACTIVATE
      this.shown = true;
    }
  }

  destroy() {
    try {
      f.ShowWindow(this.hwnd, 0);
      f.SelectObject(this.dc, this.old);
      f.DeleteObject(this.bmp);
      f.DeleteDC(this.dc);
      f.DestroyWindow(this.hwnd);
    } catch { /* already gone */ }
  }
}

/** Anti-aliased text as a coverage mask (0-255 per pixel), drawn by GDI white on black and read back. */
export function textMask(text, heightPx = 22, weight = 600) {
  const screen = f.GetDC(0);
  const dc = f.CreateCompatibleDC(screen);
  const font = f.CreateFontW(-heightPx, 0, 0, 0, weight, 0, 0, 0, 1, 0, 0, 4, 0, 'Segoe UI'); // ANTIALIASED_QUALITY
  const oldFont = f.SelectObject(dc, font);
  const size = {};
  f.GetTextExtentPoint32W(dc, text, text.length, size);
  const width = Math.max(1, size.cx + 2), height = Math.max(1, size.cy + 2);
  const out = [null];
  const bmp = f.CreateDIBSection(screen, { biSize: 40, biWidth: width, biHeight: -height, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPels: 0, biYPels: 0, biClrUsed: 0, biClrImportant: 0, bmiColors: 0 }, 0, out, 0, 0);
  const old = f.SelectObject(dc, bmp);
  const px = new Uint8Array(koffi.view(out[0], width * height * 4));
  px.fill(0);
  f.SetBkMode(dc, 1);
  f.SetTextColor(dc, 0xffffff);
  f.TextOutW(dc, 1, 1, text, text.length);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = Math.max(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
  f.SelectObject(dc, old); f.DeleteObject(bmp);
  f.SelectObject(dc, oldFont); f.DeleteObject(font);
  f.DeleteDC(dc); f.ReleaseDC(0, screen);
  return { width, height, mask };
}

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

/** The scan line: a bright green edge at the bottom with a glow trailing above it. */
export function renderBand(px, width, height, stride = width) {
  const edgeFade = Math.max(8, width * 0.06);
  for (let y = 0; y < height; y++) {
    const d = height - 1 - y; // distance above the leading edge
    const k = d < 3 ? 1 : 0.6 * Math.exp(-d / 16);
    for (let x = 0; x < width; x++) {
      const e = smooth(clamp(Math.min(x, width - 1 - x) / edgeFade));
      const hit = Math.exp(-(((x - width / 2) / (width * 0.035)) ** 2)) * Math.exp(-d / 6); // where the laser lands
      const a = clamp(k * e + 0.9 * hit);
      const core = clamp((d < 3 ? 0.75 : 0) + hit);
      let r = mix(40, 255, core), g = mix(230, 255, core), b = mix(110, 255, core);
      if (d < 1.2) { r = 14; g = 70; b = 40; } // dark leading edge, so the line also shows on white
      const i = (y * stride + x) * 4;
      px[i] = b * a; px[i + 1] = g * a; px[i + 2] = r * a; px[i + 3] = a * 255;
    }
  }
}

/**
 * The eye: white eyeball, green iris, dark pupil, a soft highlight. `open` 0..1 is the lid (0 = closed),
 * (gx, gy) in -1..1 is where it looks.
 */
/** Where the pupil centre is inside the eye sprite (sprite pixels). */
const eyeR = (size) => size / 2 - 7; // the rest of the sprite holds the outline ring and its glow
export function pupilPos(size, gx, gy) {
  const R = eyeR(size);
  return { x: size / 2 + gx * 0.36 * R + gx * 0.07 * R, y: size / 2 + gy * 0.40 * R + gy * 0.09 * R };
}

export function renderEye(px, size, open, gx, gy, glow = 0) {
  const c = size / 2;
  const R = eyeR(size);
  const lid = Math.max(open, 0.02);
  const ix = c + gx * 0.36 * R, iy = c + gy * 0.40 * R;
  const rxI = 0.46 * R * (1 - 0.2 * Math.abs(gx)), ryI = 0.46 * R * (1 - 0.2 * Math.abs(gy));
  const px0 = ix + gx * 0.07 * R, py0 = iy + gy * 0.09 * R;
  const rxP = rxI * 0.56, ryP = ryI * 0.56;
  const hx = ix + 0.5 * rxI, hy = iy - 0.38 * ryI, hr = 0.55 * rxI;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c, dy = y + 0.5 - c;
      const sd = Math.hypot(dx, dy / lid) - R;
      const a = clamp(0.5 - sd);
      const i = (y * size + x) * 4;
      // outline ring (dark, so the white eyeball shows on a white screen) with a soft green glow outside it
      const darkA = clamp(2.5 + 0.5 - sd) * 0.92;
      const glowA = 0.7 * Math.exp(-(((sd - 3.5) / 1.6) ** 2));
      if (a <= 0) {
        if (sd > 7 || (darkA <= 0 && glowA < 0.01)) { px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0; continue; }
        // glow under dark, both over transparent (premultiplied)
        const ga = glowA * (1 - darkA);
        px[i] = (110 * ga + 22 * darkA); px[i + 1] = (255 * ga + 70 * darkA); px[i + 2] = (60 * ga + 40 * darkA); px[i + 3] = (ga + darkA) * 255;
        continue;
      }
      const n = Math.hypot(dx, dy) / R;
      const low = smooth(clamp((dy / R - 0.1) / 0.7));
      let r = 254 - 30 * n ** 3 - 22 * low, g = 255 - 24 * n ** 3 - 4 * low, b = 254 - 30 * n ** 3 - 20 * low;
      const di = Math.hypot((x + 0.5 - ix) / rxI, (y + 0.5 - iy) / ryI);
      const ai = clamp((1 - di) * rxI);
      if (ai > 0) {
        const light = 0.22 * (((x + 0.5 - ix) / rxI) * 0.6 - ((y + 0.5 - iy) / ryI) * 0.6);
        const t = clamp(1 - di + light);
        r = mix(r, mix(8, 120, t), ai); g = mix(g, mix(120, 245, t), ai); b = mix(b, mix(30, 110, t), ai);
        const dp = Math.hypot((x + 0.5 - px0) / rxP, (y + 0.5 - py0) / ryP);
        const ap = clamp((1 - dp) * rxP);
        if (ap > 0) {
          const t2 = clamp(dp);
          r = mix(r, mix(2, 10, t2), ap); g = mix(g, mix(18, 60, t2), ap); b = mix(b, mix(6, 24, t2), ap);
          if (glow > 0) { // the laser charges in the pupil
            const h = glow * (1 - t2) ** 1.5 * ap;
            r = mix(r, 150, h); g = mix(g, 255, h); b = mix(b, 190, h);
          }
        }
      }
      const ah = clamp((1 - Math.hypot(x + 0.5 - hx, y + 0.5 - hy) / hr) * hr * 0.5) * 0.42;
      if (ah > 0) { r = mix(r, 255, ah); g = mix(g, 255, ah); b = mix(b, 255, ah); }
      // eye over its dark outline: at the rim (a < 1) the ring shows through
      const ra = a + darkA * (1 - a);
      px[i] = b * a + 40 * darkA * (1 - a); px[i + 1] = g * a + 70 * darkA * (1 - a); px[i + 2] = r * a + 22 * darkA * (1 - a); px[i + 3] = ra * 255;
    }
  }
}

/**
 * The scanner light: a triangle from the pupil (ax, ay) to the scan line, which runs from x1 to x2 at height ey
 * (all in buffer pixels). Brighter towards the line, bright rims along the two edges, faint horizontal striations.
 * The buffer is cleared first.
 */
export function drawWedge(px, width, height, ax, ay, x1, x2, ey) {
  px.fill(0, 0, width * height * 4);
  const span = ey - ay;
  if (Math.abs(span) < 2) return;
  const y0 = Math.max(0, Math.ceil(Math.min(ay, ey))), y1 = Math.min(height - 1, Math.floor(Math.max(ay, ey)));
  for (let y = y0; y <= y1; y++) {
    const sn = (y + 0.5 - ay) / span; // 0 at the pupil, 1 at the line
    if (sn <= 0) continue;
    const xl = ax + (x1 - ax) * sn, xr = ax + (x2 - ax) * sn;
    const wd = xr - xl;
    if (wd < 1) continue;
    const stripe = 0.86 + 0.14 * Math.sin(y * 0.7);
    const gain = 0.08 + 0.2 * sn;
    const xs = Math.max(0, Math.floor(xl - 1)), xe = Math.min(width - 1, Math.ceil(xr + 1));
    for (let x = xs; x <= xe; x++) {
      const e = Math.min(x + 0.5 - xl, xr - (x + 0.5)); // distance to the nearest rim
      const inside = clamp(e + 0.5);
      if (inside <= 0) continue;
      const rim = 0.55 * Math.exp(-((e / 2.2) ** 2)) * (0.4 + 0.6 * sn);
      const a = clamp((gain * stripe + rim) * inside);
      const i = (y * width + x) * 4;
      px[i] = 60 * a; px[i + 1] = 255 * a; px[i + 2] = 110 * a; px[i + 3] = a * 255;
    }
  }
}

/** A green frame on the rectangle's edges: dark outer line (shows on white), bright core, glow inward, thick corner brackets. */
export function renderFrame(px, width, height) {
  const reach = 34, arm = Math.min(60, Math.floor(Math.min(width, height) / 3));
  px.fill(0, 0, width * height * 4);
  for (let y = 0; y < height; y++) {
    const dy = Math.min(y, height - 1 - y);
    const full = dy < reach;
    for (let x = 0; x < width; x++) {
      const dx = Math.min(x, width - 1 - x);
      if (!full && dx >= reach && width - reach - 1 > x) { x = width - reach - 1; continue; } // skip the empty middle
      const d = Math.min(dx, dy);
      const nearCorner = (dx < arm && dy < reach) || (dy < arm && dx < reach);
      const thick = nearCorner ? 9 : 5; // corner brackets are thicker
      let r, g, bl, a;
      if (d < 2.5) { r = 14; g = 50; bl = 28; a = 0.95; } // dark outline
      else if (d < 2.5 + thick) { const t = (d - 2.5) / thick; r = mix(150, 60, t); g = 255; bl = mix(190, 110, t); a = 1; } // bright core
      else { const k = Math.exp(-(d - 2.5 - thick) / 10); r = 60; g = 255; bl = 110; a = 0.5 * k; }
      if (a < 0.01) continue;
      const i = (y * width + x) * 4;
      px[i] = bl * a; px[i + 1] = g * a; px[i + 2] = r * a; px[i + 3] = a * 255;
    }
  }
}

const RIPPLE_COLORS = { left: [60, 255, 110], right: [40, 200, 255], middle: [255, 190, 40] }; // RGB
export const RIPPLE_MS = 430, RIPPLE_GAP_MS = 120;
const RIPPLE_SIZE = 132;

/** Expanding rings (one per click of a multi-click) with a dark outline, plus a dot where the button went down. */
export function renderRipple(px, size, t, rings, rgb) {
  px.fill(0, 0, size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      let pr = 0, pg = 0, pb = 0, pa = 0; // premultiplied accumulator
      const add = (cr, cg, cb, a) => { if (a <= 0) return; pr = cr * a + pr * (1 - a); pg = cg * a + pg * (1 - a); pb = cb * a + pb * (1 - a); pa = a + pa * (1 - a); };
      for (let k = 0; k < rings; k++) {
        const u = (t - k * RIPPLE_GAP_MS) / RIPPLE_MS;
        if (u <= 0 || u >= 1) continue;
        const radius = 6 + 52 * (1 - (1 - u) ** 3);
        const fade = (1 - u) ** 1.2;
        const d = Math.abs(r - radius);
        add(14, 50, 28, clamp(2.6 - Math.abs(d - 2.6)) * 0.7 * fade); // dark outline hugging the ring
        add(rgb[0], rgb[1], rgb[2], clamp(2.2 - d) * fade); // bright ring
        add(rgb[0], rgb[1], rgb[2], 0.18 * clamp(radius - r) * fade * 0.07); // faint fill
      }
      const u0 = t / 260;
      if (u0 < 1) { // the press point
        add(14, 50, 28, clamp(5.5 - r) * 0.8 * (1 - u0));
        add(255, 255, 255, clamp(3.6 - r) * (1 - u0));
      }
      if (pa <= 0) continue;
      const i = (y * size + x) * 4;
      px[i] = pb; px[i + 1] = pg; px[i + 2] = pr; px[i + 3] = pa * 255;
    }
  }
}

/** A rectangle outline (dark line outside, bright line inside) with alpha `a`; coordinates are inclusive pixel edges. */
function drawBorder(px, W, H, x0, y0, x1, y1, rgb, a, thick) {
  const set = (x, y, r, g, b, al) => {
    if (x < 0 || y < 0 || x >= W || y >= H || al <= 0) return;
    const i = (y * W + x) * 4;
    if (al * 255 <= px[i + 3]) return;
    px[i] = b * al; px[i + 1] = g * al; px[i + 2] = r * al; px[i + 3] = al * 255;
  };
  const ring = (inset, width, c, al) => {
    const a0 = x0 + inset, b0 = y0 + inset, a1 = x1 - inset, b1 = y1 - inset;
    for (let k = 0; k < width; k++) {
      for (let x = a0 + k; x <= a1 - k; x++) { set(x, b0 + k, c[0], c[1], c[2], al); set(x, b1 - k, c[0], c[1], c[2], al); }
      for (let y = b0 + k; y <= b1 - k; y++) { set(a0 + k, y, c[0], c[1], c[2], al); set(a1 - k, y, c[0], c[1], c[2], al); }
    }
  };
  ring(0, 2, [14, 50, 28], 0.85 * a);
  ring(2, thick, rgb, a);
}

const easeOut = (t) => 1 - (1 - t) ** 1.5;

/**
 * A sonar ring of radius `r` around (cx, cy): bright thin front with a dark outer edge (so it shows on white) and a
 * glow trailing `trail` px inward. Only the annulus is visited. `k` scales the strength (0..1).
 */
function drawRing(px, W, H, cx, cy, r, trail, k) {
  if (k <= 0.01) return;
  const rout = r + 3.5, rin = Math.max(0, r - trail);
  const y0 = Math.max(0, Math.floor(cy - rout)), y1 = Math.min(H - 1, Math.ceil(cy + rout));
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    if (Math.abs(dy) > rout) continue;
    const xo = Math.sqrt(rout * rout - dy * dy);
    const xi = Math.abs(dy) < rin ? Math.sqrt(rin * rin - dy * dy) : 0;
    for (const [xa, xb] of [[cx + xi, cx + xo], [cx - xo, cx - xi]]) {
      for (let x = Math.max(0, Math.floor(xa)); x <= Math.min(W - 1, Math.ceil(xb)); x++) {
        const d = r - Math.hypot(x + 0.5 - cx, dy); // > 0 behind the front
        let al, red, grn, blu;
        if (d < -3.2) continue;
        if (d < 0) { al = 0.7 * clamp(1.6 - Math.abs(d + 1.7)) * k; red = 14; grn = 50; blu = 28; } // dark outer edge
        else {
          const core = clamp(2.2 - d);
          al = Math.max(core, 0.5 * Math.exp(-d / 20)) * k;
          red = mix(60, 255, core); grn = 255; blu = mix(110, 255, core);
        }
        if (al <= 0.01) continue;
        const i = (y * W + x) * 4;
        if (al * 255 <= px[i + 3]) continue;
        px[i] = blu * al; px[i + 1] = grn * al; px[i + 2] = red * al; px[i + 3] = al * 255;
      }
    }
  }
}

const KEY_LABELS = { ctrl: 'Ctrl', control: 'Ctrl', shift: 'Shift', alt: 'Alt', win: 'Win', windows: 'Win', meta: 'Win', cmd: 'Win', super: 'Win', enter: 'Enter', return: 'Enter', esc: 'Esc', escape: 'Esc', tab: 'Tab', space: 'Space', backspace: 'Backspace', delete: 'Del', del: 'Del', insert: 'Ins', ins: 'Ins', home: 'Home', end: 'End', pageup: 'PgUp', pgup: 'PgUp', pagedown: 'PgDn', pgdn: 'PgDn', left: '\u2190', up: '\u2191', right: '\u2192', down: '\u2193' };
/** "ctrl+a ctrl+c" -> [['Ctrl', 'A'], ['Ctrl', 'C']] */
export const keyLabels = (keys) => keys.trim().split(/\s+/).filter(Boolean).map((chord) => chord.split('+').filter(Boolean).map((k) => KEY_LABELS[k.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))));

const TRAIL_LIFE_MS = 750, TRAIL_FADE_MS = 320;

/** Draws a thick soft line segment into a premultiplied buffer, keeping the stronger alpha where strokes overlap. */
function stroke(px, width, height, x0, y0, x1, y1, radius, rgb, alpha) {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  const R = Math.ceil(radius + 1);
  for (let s = 0; s <= n; s++) {
    const cx = x0 + ((x1 - x0) * s) / n, cy = y0 + ((y1 - y0) * s) / n;
    const xa = Math.max(0, Math.floor(cx - R)), xb = Math.min(width - 1, Math.ceil(cx + R));
    const ya = Math.max(0, Math.floor(cy - R)), yb = Math.min(height - 1, Math.ceil(cy + R));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const a = clamp(radius + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)) * alpha;
        const i = (y * width + x) * 4;
        if (a * 255 <= px[i + 3]) continue;
        px[i] = rgb[2] * a; px[i + 1] = rgb[1] * a; px[i + 2] = rgb[0] * a; px[i + 3] = a * 255;
      }
    }
  }
}

/** The start marker of a drag: dark ring, bright ring and a dot. */
function marker(px, width, height, cx, cy, rgb) {
  for (let y = Math.max(0, Math.floor(cy - 16)); y <= Math.min(height - 1, Math.ceil(cy + 16)); y++) {
    for (let x = Math.max(0, Math.floor(cx - 16)); x <= Math.min(width - 1, Math.ceil(cx + 16)); x++) {
      const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const dark = clamp(2.2 - Math.abs(r - 12.5)) * 0.85, bright = clamp(1.6 - Math.abs(r - 11)), dot = clamp(4 - r);
      const a = Math.max(dark, bright, dot);
      if (a <= 0) continue;
      const k = bright >= dark * 0.9 || dot > 0.5 ? 1 : 0;
      const i = (y * width + x) * 4;
      const c = k ? rgb : [14, 50, 28];
      px[i] = c[2] * a; px[i + 1] = c[1] * a; px[i + 2] = c[0] * a; px[i + 3] = a * 255;
    }
  }
}

const ease = (t) => t * t * (3 - 2 * t);
const T_OPEN = 280, T_SCAN = 1100, T_CLOSE = 320;
export const SCAN_TOTAL_MS = T_OPEN + T_SCAN + T_CLOSE;

let flip = false; // alternates the side of the eye between screenshots

export const FLASH_TOTAL_MS = 760;


export class ScanAnimation {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
  }

  /**
   * drag: a ring where the button went down and a glowing trail that follows the pointer (sampled every frame),
   * fading with age. When `stopped` resolves (button released) the trail fades out and rings mark the end.
   * `bounds` {left, top, right, bottom}: where the drag can go. Never throws.
   */
  async trail(start, bounds, stopped, cancelled = () => false, button = 'left', { marker: showMarker = true, life = TRAIL_LIFE_MS, ring = true } = {}) {
    if (!this.enabled) return;
    let layer = null;
    let ended = false;
    stopped.then(() => { ended = true; });
    try {
      ensurePump();
      const v = w.virtualScreen();
      const pad = 330;
      const left = Math.max(v.x, Math.floor(Math.min(bounds.left, start.x) - pad)), top = Math.max(v.y, Math.floor(Math.min(bounds.top, start.y) - pad));
      const right = Math.min(v.x + v.width, Math.ceil(Math.max(bounds.right, start.x) + pad)), bottom = Math.min(v.y + v.height, Math.ceil(Math.max(bounds.bottom, start.y) + pad));
      layer = new Layer(Math.max(40, right - left), Math.max(40, bottom - top));
      const rgb = RIPPLE_COLORS[button] ?? RIPPLE_COLORS.left;
      const pts = [{ x: start.x, y: start.y, t: 0 }];
      const t0 = performance.now();
      let endAt = 0, endPoint = null;
      for (;;) {
        const t = performance.now() - t0;
        if (cancelled()) break;
        if (ended && !endAt) { endAt = t; const c = w.cursorPos(); endPoint = { x: c.x, y: c.y }; pts.push({ ...endPoint, t }); }
        if (endAt && t - endAt > TRAIL_FADE_MS) break;
        if (!endAt) {
          const c = w.cursorPos();
          const last = pts[pts.length - 1];
          if (Math.hypot(c.x - last.x, c.y - last.y) >= 1) pts.push({ x: c.x, y: c.y, t });
        }
        layer.px.fill(0);
        const fade = endAt ? 1 - clamp((t - endAt) / TRAIL_FADE_MS) : 1;
        for (let pass = 0; pass < 2; pass++) {
          for (let k = 1; k < pts.length; k++) {
            const age = (endAt ? Math.min(t, endAt) : t) - pts[k].t;
            const a = clamp(1 - age / life) * fade;
            if (a <= 0.02) continue;
            const A = pts[k - 1], B = pts[k];
            if (pass === 0) stroke(layer.px, layer.width, layer.height, A.x - left, A.y - top, B.x - left, B.y - top, 5.2, [14, 50, 28], a * 0.75);
            else stroke(layer.px, layer.width, layer.height, A.x - left, A.y - top, B.x - left, B.y - top, 3, k % 6 < 5 ? rgb : [255, 255, 255], a);
          }
        }
        if (showMarker) marker(layer.px, layer.width, layer.height, start.x - left, start.y - top, rgb);
        layer.present(left, top, 255 * fade);
        await new Promise((r) => setTimeout(r, 16));
      }
      layer.destroy();
      layer = null;
      if (endPoint && ring && !cancelled()) await this.ripple(endPoint, button, 1, cancelled);
    } catch (e) {
      process.stderr.write(`win-input-mcp: drag effect failed (${e.message})
`);
    } finally {
      layer?.destroy();
    }
  }

  /**
   * scroll: chevrons beside the pointer travel in the scroll direction while the wheel turns (until `stopped`
   * resolves, at least 380 ms, then a short fade). dirV: +1 up / -1 down / 0, dirH: +1 right / -1 left / 0. Never throws.
   */
  async wheelCue(point, dirV, dirH, speed, stopped, cancelled = () => false) {
    if (!this.enabled || (!dirV && !dirH)) return;
    let layer = null;
    let ended = false;
    stopped.then(() => { ended = true; });
    try {
      ensurePump();
      const S = 180, c = S / 2;
      layer = new Layer(S, S);
      const SP = 24, L = SP * 3, arm = 13;
      const t0 = performance.now();
      let endAt = 0;
      for (;;) {
        const t = performance.now() - t0;
        if (cancelled()) break;
        if (ended && t >= 380 && !endAt) endAt = t;
        if (endAt && t - endAt > 220) break;
        const fade = endAt ? 1 - clamp((t - endAt) / 220) : clamp(t / 90);
        layer.px.fill(0);
        const phase = (t * 0.09 * clamp(speed, 0.6, 3)) % SP;
        for (let pass = 0; pass < 2; pass++) {
          for (let k = 0; k < 4; k++) {
            const pos = k * SP + phase; // 0..L+SP along the travel direction
            const a = Math.sin(Math.PI * clamp(pos / L)) * fade;
            if (a < 0.03) continue;
            for (const [dir, horiz] of [[dirV, false], [dirH, true]]) {
              if (!dir) continue;
              const along = (pos - L / 2) * dir, anchor = horiz ? { x: c + along, y: c + 40 } : { x: c + 40, y: c - along };
              // chevron: tip leads in the travel direction
              const tip = horiz ? { x: anchor.x + 6 * dir, y: anchor.y } : { x: anchor.x, y: anchor.y - 6 * dir };
              const e1 = horiz ? { x: anchor.x - 6 * dir, y: anchor.y - arm } : { x: anchor.x - arm, y: anchor.y + 6 * dir };
              const e2 = horiz ? { x: anchor.x - 6 * dir, y: anchor.y + arm } : { x: anchor.x + arm, y: anchor.y + 6 * dir };
              if (pass === 0) {
                stroke(layer.px, S, S, e1.x, e1.y, tip.x, tip.y, 4.6, [14, 50, 28], a * 0.8);
                stroke(layer.px, S, S, tip.x, tip.y, e2.x, e2.y, 4.6, [14, 50, 28], a * 0.8);
              } else {
                stroke(layer.px, S, S, e1.x, e1.y, tip.x, tip.y, 2.6, [60, 255, 110], a);
                stroke(layer.px, S, S, tip.x, tip.y, e2.x, e2.y, 2.6, [60, 255, 110], a);
              }
            }
          }
        }
        layer.present(point.x - c, point.y - c, 255);
        await new Promise((r) => setTimeout(r, 16));
      }
    } catch (e) {
      process.stderr.write(`win-input-mcp: scroll effect failed (${e.message})
`);
    } finally {
      layer?.destroy();
    }
  }

  /**
   * press_keys: key caps ("Ctrl" + "C") appear near the bottom of the screen the keys go to, hold, fade.
   * `area` is the rectangle (desktop pixels) to centre them in. Never throws.
   */
  async keycaps(chords, area, cancelled = () => false) {
    if (!this.enabled || !chords.length) return;
    let layer = null;
    try {
      ensurePump();
      const pad = 16, capH = 46, gapPlus = 26, gapChord = 38;
      const items = chords.map((chord) => chord.map((label) => ({ label, t: textMask(label, 22, 600) })));
      const plus = textMask('+', 22, 600);
      const capW = (it) => Math.max(capH, it.t.width + 30);
      const widths = items.map((chord) => chord.reduce((sum, it) => sum + capW(it), 0) + gapPlus * (chord.length - 1));
      const total = widths.reduce((a, b) => a + b, 0) + gapChord * (items.length - 1);
      const W = Math.min(Math.round(total + pad * 2), Math.max(200, area.width - 20)), H = capH + pad * 2;
      layer = new Layer(W, H);
      const px = layer.px;
      const put = (x, y, r, g, b, a) => { // premultiplied "over"
        if (a <= 0 || x < 0 || y < 0 || x >= W || y >= H) return;
        const i = (y * W + x) * 4, k = 1 - a;
        px[i] = b * a + px[i] * k; px[i + 1] = g * a + px[i + 1] * k; px[i + 2] = r * a + px[i + 2] * k; px[i + 3] = a * 255 + px[i + 3] * k;
      };
      const drawMask = (m, x0, y0, rgb, alpha = 1) => { for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) put(x0 + x, y0 + y, rgb[0], rgb[1], rgb[2], (m.mask[y * m.width + x] / 255) * alpha); };
      let x = Math.round((W - total) / 2);
      const y0 = pad;
      items.forEach((chord, ci) => {
        chord.forEach((it, ki) => {
          const cw = capW(it);
          for (let yy = 0; yy < capH; yy++) {
            for (let xx = 0; xx < cw; xx++) {
              const dx = Math.min(xx, cw - 1 - xx), dy = Math.min(yy, capH - 1 - yy);
              const rr = 10, cx = Math.max(0, rr - dx), cy = Math.max(0, rr - dy);
              const dist = Math.hypot(cx, cy) - rr; // < 0 inside the rounded rectangle
              const inside = clamp(0.5 - dist);
              const edge = clamp(0.5 - (Math.abs(dist + 1.2) - 1.2));
              const top = clamp(1 - yy / capH);
              put(x + xx, y0 + yy, mix(26, 52, top * 0.5), mix(30, 56, top * 0.5), mix(36, 62, top * 0.5), inside * 0.94);
              put(x + xx, y0 + yy, 60, 255, 110, edge * inside);
            }
          }
          drawMask(it.t, x + Math.round((cw - it.t.width) / 2), y0 + Math.round((capH - it.t.height) / 2), [245, 250, 247]);
          x += cw;
          if (ki < chord.length - 1) { drawMask(plus, x + Math.round((gapPlus - plus.width) / 2), y0 + Math.round((capH - plus.height) / 2), [150, 255, 180]); x += gapPlus; }
        });
        if (ci < items.length - 1) x += gapChord;
      });
      const left = Math.round(area.left + (area.width - W) / 2), top = Math.round(area.top + area.height - H - 90);
      const hold = 420 + 140 * chords.length;
      const t0 = performance.now();
      for (;;) {
        const t = performance.now() - t0;
        if (t >= hold + 260 || cancelled()) break;
        const a = t < 110 ? ease(t / 110) : t < hold ? 1 : 1 - ease((t - hold) / 260);
        layer.present(left, top + (1 - Math.min(1, t / 110)) * 14, 255 * a);
        await new Promise((r) => setTimeout(r, 16));
      }
    } catch (e) {
      process.stderr.write(`win-input-mcp: key effect failed (${e.message})\n`);
    } finally {
      layer?.destroy();
    }
  }

  /**
   * type_text: a small pill near the bottom of the screen with a keyboard icon, a progress bar and "37 / 120".
   * It never shows the text. `progress.n` is the characters sent so far; the pill ends when `stopped` resolves.
   */
  async typing(total, progress, area, stopped, cancelled = () => false) {
    if (!this.enabled || total < 1) return;
    let layer = null;
    let ended = false;
    stopped.then(() => { ended = true; });
    try {
      ensurePump();
      const W = 300, H = 64;
      layer = new Layer(W, H);
      const px = layer.px;
      const glyphs = {};
      for (const g of '0123456789/') glyphs[g] = textMask(g, 17, 600);
      const adv = Math.max(...'0123456789'.split('').map((g) => glyphs[g].width)) + 1;
      const put = (x, y, r, g, b, a) => {
        if (a <= 0 || x < 0 || y < 0 || x >= W || y >= H) return;
        const i = (y * W + x) * 4, k = 1 - a;
        px[i] = b * a + px[i] * k; px[i + 1] = g * a + px[i + 1] * k; px[i + 2] = r * a + px[i + 2] * k; px[i + 3] = a * 255 + px[i + 3] * k;
      };
      const roundRect = (x0, y0, w0, h0, rad, fill, alpha, border) => {
        for (let y = 0; y < h0; y++) for (let x = 0; x < w0; x++) {
          const dx = Math.min(x, w0 - 1 - x), dy = Math.min(y, h0 - 1 - y);
          const dist = Math.hypot(Math.max(0, rad - dx), Math.max(0, rad - dy)) - rad;
          const inside = clamp(0.5 - dist);
          if (fill) put(x0 + x, y0 + y, fill[0], fill[1], fill[2], inside * alpha);
          if (border) put(x0 + x, y0 + y, border[0], border[1], border[2], clamp(0.5 - (Math.abs(dist + 1.2) - 1.2)) * inside);
        }
      };
      const draw = (n) => {
        px.fill(0);
        roundRect(0, 0, W, H, 14, [26, 30, 36], 0.94, [60, 255, 110]);
        // keyboard icon
        roundRect(16, 20, 32, 24, 5, null, 0, [60, 255, 110]);
        for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) roundRect(21 + c * 6, 25 + r * 6, 4, 4, 1, [150, 255, 180], 1, null);
        roundRect(24, 37, 16, 3, 1, [150, 255, 180], 1, null);
        // counter "37 / 120" (glyph by glyph; fixed advance for digits)
        let x = 66;
        for (const ch of String(n) + ' / ' + String(total)) {
          if (ch === ' ') { x += 5; continue; }
          const g = glyphs[ch]; if (!g) continue;
          const dx = ch === '/' ? 0 : Math.round((adv - g.width) / 2);
          for (let yy = 0; yy < g.height; yy++) for (let xx = 0; xx < g.width; xx++) put(x + dx + xx, 10 + yy, 245, 250, 247, g.mask[yy * g.width + xx] / 255);
          x += ch === '/' ? g.width : adv;
        }
        // progress bar
        const bx = 66, bw = W - 66 - 18, by = 40;
        roundRect(bx, by, bw, 8, 4, [58, 64, 72], 1, null);
        const fw = Math.max(0, Math.round(bw * clamp(n / total)));
        if (fw >= 2) roundRect(bx, by, fw, 8, 4, [60, 255, 110], 1, null);
      };
      const left = Math.round(area.left + (area.width - W) / 2), top = Math.round(area.top + area.height - H - 90);
      const t0 = performance.now();
      let endAt = 0;
      for (;;) {
        const t = performance.now() - t0;
        if (cancelled()) break;
        if (ended && t >= 500 && !endAt) endAt = t;
        if (endAt && t - endAt > 260) break;
        draw(Math.min(progress.n, total));
        const a = endAt ? 1 - ease(clamp((t - endAt) / 260)) : ease(clamp(t / 110));
        layer.present(left, top + (1 - Math.min(1, t / 110)) * 14, 255 * a);
        await new Promise((r) => setTimeout(r, 33));
      }
    } catch (e) {
      process.stderr.write(`win-input-mcp: typing effect failed (${e.message})\n`);
    } finally {
      layer?.destroy();
    }
  }

  /**
   * list_windows: an eye opens in the middle of the monitor and sends out two sonar pings. Each ping is a ring
   * that expands to the corners; a window's frame lights when the first ring reaches its nearest edge (so the
   * windows light nearest first) and flashes again when the echo ring passes. Then everything fades. Green =
   * usable, red = on the denylist, amber = elevated (cannot be controlled).
   * `wins`: [{ rect, allowed, elevated }] in desktop pixels.
   */
  async radar(wins, area, cancelled = () => false) {
    if (!this.enabled) return;
    let frames = null, eye = null;
    try {
      const W = area.width, H = area.height;
      const cx = W / 2, cy = H / 2;
      const list = wins
        .map((x) => {
          const l = Math.max(area.left, x.rect.left), t = Math.max(area.top, x.rect.top);
          const r = Math.min(area.left + W, x.rect.left + x.rect.width), bt = Math.min(area.top + H, x.rect.top + x.rect.height);
          const q = { x0: l - area.left, y0: t - area.top, x1: r - area.left - 1, y1: bt - area.top - 1, rgb: x.allowed === false ? [255, 80, 80] : x.elevated ? [255, 190, 40] : [60, 255, 110] };
          q.dist = Math.hypot(Math.max(q.x0 - cx, 0, cx - q.x1), Math.max(q.y0 - cy, 0, cy - q.y1)); // eye to the nearest edge
          return q;
        })
        .filter((q) => q.x1 - q.x0 >= 60 && q.y1 - q.y0 >= 40)
        .slice(0, 14);
      if (!list.length) return;
      ensurePump();
      const esize = Math.round(clamp(Math.min(W, H) * 0.11, 72, 124));
      const reach = Math.hypot(cx, cy) + 60; // the rings run past the farthest corner
      frames = new Layer(W, H);
      eye = new Layer(esize, esize);
      const OPEN = 300, PING = 1150, ECHO = 560, FADE = 420;
      const END = OPEN + ECHO + PING;
      const front = (t, start) => (t < start ? -1 : easeOut(clamp((t - start) / PING)) * reach); // ring radius, -1 = not yet
      const t0 = performance.now();
      for (;;) {
        const t = performance.now() - t0;
        if (t >= END + FADE || cancelled()) break;
        const out = t > END ? 1 - ease(clamp((t - END) / FADE)) : 1;
        const r1 = front(t, OPEN), r2 = front(t, OPEN + ECHO);
        frames.px.fill(0);
        for (const [r, strength] of [[r1, 1], [r2, 0.75]]) {
          if (r > 2 && r < reach) drawRing(frames.px, W, H, cx, cy, r, 70, strength * out * (1 - 0.55 * (r / reach)));
        }
        for (const q of list) {
          if (r1 < q.dist) continue; // the first ring has not got there
          const since1 = (r1 - q.dist) / reach * PING; // roughly how long ago the first ring passed
          const echo = r2 >= q.dist ? (r2 - q.dist) / reach * PING : -1;
          const flash = (since1 < 160) || (echo >= 0 && echo < 160);
          const a = out * (echo >= 0 ? 1 : 0.78);
          drawBorder(frames.px, W, H, q.x0, q.y0, q.x1, q.y1, q.rgb, a, flash ? 5 : 3);
        }
        frames.present(area.left, area.top, 255);
        const open = t < OPEN ? ease(t / OPEN) : t > END ? 1 - ease(clamp((t - END) / FADE)) : 1;
        const pulse = Math.max(0, 1 - Math.abs(t - OPEN - 80) / 260, 1 - Math.abs(t - OPEN - ECHO - 80) / 260); // the pupil flares at each ping
        renderEye(eye.px, esize, open, 0, 0.15, pulse);
        eye.present(area.left + cx - esize / 2, area.top + cy - esize / 2, 255 * Math.min(ease(clamp(t / OPEN)), out));
        await new Promise((r) => setTimeout(r, 24));
      }
    } catch (e) {
      process.stderr.write(`win-input-mcp: window scan effect failed (${e.message})\n`);
    } finally {
      eye?.destroy();
      frames?.destroy();
    }
  }

  /** click: expanding rings at the pressed point (colour by button, one ring per click). Never throws. */
  async ripple(point, button = 'left', rings = 1, cancelled = () => false) {
    if (!this.enabled) return;
    let layer = null;
    try {
      ensurePump();
      layer = new Layer(RIPPLE_SIZE, RIPPLE_SIZE);
      const rgb = RIPPLE_COLORS[button] ?? RIPPLE_COLORS.left;
      const total = RIPPLE_MS + (rings - 1) * RIPPLE_GAP_MS;
      const t0 = performance.now();
      for (;;) {
        const t = performance.now() - t0;
        if (t >= total || cancelled()) break;
        renderRipple(layer.px, RIPPLE_SIZE, t, rings, rgb);
        layer.present(point.x - RIPPLE_SIZE / 2, point.y - RIPPLE_SIZE / 2, 255);
        await new Promise((r) => setTimeout(r, 16));
      }
    } catch (e) {
      process.stderr.write(`win-input-mcp: click effect failed (${e.message})
`);
    } finally {
      layer?.destroy();
    }
  }

  /** focus_window: a green frame lights up around the window (clipped to the desktop) and fades. Never throws. */
  async flash(rect, cancelled = () => false) {
    if (!this.enabled) return;
    let layer = null;
    try {
      const v = w.virtualScreen();
      const left = Math.max(rect.left, v.x), top = Math.max(rect.top, v.y);
      const right = Math.min(rect.left + rect.width, v.x + v.width), bottom = Math.min(rect.top + rect.height, v.y + v.height);
      if (right - left < 20 || bottom - top < 20) return;
      ensurePump();
      layer = new Layer(right - left, bottom - top);
      renderFrame(layer.px, layer.width, layer.height);
      const t0 = performance.now();
      for (;;) {
        const t = performance.now() - t0;
        if (t >= FLASH_TOTAL_MS || cancelled()) break;
        // on, a short dip, on again (a double blink catches the eye), then fade
        const a = t < 80 ? t / 80 : t < 280 ? 1 : t < 380 ? 1 - 0.65 * Math.sin(((t - 280) / 100) * Math.PI) : t < 480 ? 1 : 1 - ease((t - 480) / (FLASH_TOTAL_MS - 480));
        layer.present(left, top, 255 * a);
        await new Promise((r) => setTimeout(r, 16));
      }
    } catch (e) {
      process.stderr.write(`win-input-mcp: focus effect failed (${e.message})
`);
    } finally {
      layer?.destroy();
    }
  }

  /**
   * Plays the animation over `rect` (desktop pixels) and resolves when it is over. `cancelled()` is polled each
   * frame; the windows are always removed. Never throws: a failed animation must not break a screenshot.
   */
  async play(rect, cancelled = () => false) {
    if (!this.enabled) return;
    let wedge = null, band = null, eye = null;
    try {
      ensurePump();
      const size = Math.round(clamp(Math.min(rect.width, rect.height) * 0.3, 56, 150));
      const bandH = 56;
      // the eye floats beside the region (alternating sides; the side with more room if only one fits) and looks at it
      // (room is measured on the monitor holding the region's centre; with no room, as for a full-screen scan,
      // the eye sits inside the region, inset from its left or right edge)
      const cxr = rect.left + rect.width / 2, cyr = rect.top + rect.height / 2;
      const mon = w.listMonitors().find((m) => cxr >= m.left && cxr < m.left + m.width && cyr >= m.top && cyr < m.top + m.height) ?? w.virtualScreen();
      const m = { x: mon.left ?? mon.x, y: mon.top ?? mon.y, width: mon.width, height: mon.height };
      const gap = 18;
      const roomL = rect.left - m.x, roomR = m.x + m.width - (rect.left + rect.width);
      const fitsL = roomL >= size + gap, fitsR = roomR >= size + gap;
      const left = fitsL && fitsR ? (flip = !flip) : fitsL ? true : fitsR ? false : (flip = !flip);
      const ex = fitsL || fitsR
        ? (left ? rect.left - size - gap : rect.left + rect.width + gap)
        : (left ? rect.left + gap * 2 : rect.left + rect.width - size - gap * 2); // inside the region
      const ey = clamp(rect.top + (rect.height - size) / 2, m.y, m.y + m.height - size);
      const gx = left ? 0.95 : -0.95; // pupil towards the region
      const pad = 4;
      const lx = Math.floor(Math.min(ex, rect.left) - pad), rx = Math.ceil(Math.max(ex + size, rect.left + rect.width) + pad);
      const ty = Math.floor(Math.min(ey, rect.top) - pad), by = Math.ceil(Math.max(ey + size, rect.top + rect.height) + pad);
      wedge = new Layer(rx - lx, by - ty);
      band = new Layer(Math.max(40, rect.width), bandH);
      renderBand(band.px, band.width, bandH);
      eye = new Layer(size, size);
      const midY = rect.top + rect.height / 2;
      const t0 = performance.now();
      for (;;) {
        const t = performance.now() - t0;
        if (t >= SCAN_TOTAL_MS || cancelled()) break;
        let open, fade, p = 0;
        if (t < T_OPEN) { open = ease(t / T_OPEN); fade = open; }
        else if (t < T_OPEN + T_SCAN) { open = 1; fade = 1; p = ease((t - T_OPEN) / T_SCAN); }
        else { const k = (t - T_OPEN - T_SCAN) / T_CLOSE; open = 1 - ease(k); fade = 1 - k; p = 1; }
        const edge = rect.top + p * rect.height; // the scan line (its leading edge is the bottom)
        // the pupil goes from upper right to lower right (mirrored when the eye is on the right) with the line
        const gy = (p > 0 ? clamp((edge - midY) / (rect.height / 2), -1, 1) : -1) * 0.85;
        const charge = p > 0 ? 1 : clamp((t - T_OPEN * 0.6) / (T_OPEN * 0.4)); // pupil glows just before the scan
        renderEye(eye.px, size, open, gx, gy, charge);
        const live = Math.min(1, p * 10, (1 - p) * 6);
        if (p > 0 && p < 1) {
          const pupil = pupilPos(size, gx, gy);
          drawWedge(wedge.px, wedge.width, wedge.height, ex + pupil.x - lx, ey + pupil.y - ty, rect.left - lx, rect.left + rect.width - lx, edge - ty);
          wedge.present(lx, ty, 255 * live);
          band.present(rect.left + (rect.width - band.width) / 2, edge - bandH, 255 * live);
        } else if (wedge.shown) {
          wedge.present(lx, ty, 0, 1);
          band.present(rect.left, rect.top, 0, 1);
        }
        eye.present(ex, ey, 255 * fade);
        await new Promise((r) => setTimeout(r, 16));
      }
    } catch (e) {
      process.stderr.write(`win-input-mcp: scan animation failed (${e.message})\n`);
    } finally {
      wedge?.destroy();
      band?.destroy();
      eye?.destroy();
    }
  }
}
