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

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

/** The scan line: a bright green edge at the bottom with a glow trailing above it. */
export function renderBand(px, width, height, stride = width) {
  const edgeFade = Math.max(8, width * 0.06);
  for (let y = 0; y < height; y++) {
    const d = height - 1 - y; // distance above the leading edge
    const k = d < 2 ? 1 : 0.6 * Math.exp(-d / 16);
    for (let x = 0; x < width; x++) {
      const e = smooth(clamp(Math.min(x, width - 1 - x) / edgeFade));
      const hit = Math.exp(-(((x - width / 2) / (width * 0.035)) ** 2)) * Math.exp(-d / 6); // where the laser lands
      const a = clamp(k * e + 0.9 * hit);
      const core = clamp((d < 2 ? 0.75 : 0) + hit);
      const r = mix(40, 255, core), g = mix(230, 255, core), b = mix(110, 255, core);
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
export function pupilPos(size, gx, gy) {
  const R = size / 2 - 2;
  return { x: size / 2 + gx * 0.36 * R + gx * 0.07 * R, y: size / 2 + gy * 0.40 * R + gy * 0.09 * R };
}

export function renderEye(px, size, open, gx, gy, glow = 0) {
  const c = size / 2;
  const R = size / 2 - 2;
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
      if (a <= 0) { px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0; continue; }
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
      px[i] = b * a; px[i + 1] = g * a; px[i + 2] = r * a; px[i + 3] = a * 255;
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

/** A glowing green frame just inside the rectangle's edges, with brighter corner brackets. Only the border strip is touched. */
export function renderFrame(px, width, height) {
  const reach = 40, arm = Math.min(34, Math.floor(Math.min(width, height) / 3));
  px.fill(0, 0, width * height * 4);
  for (let y = 0; y < height; y++) {
    const dy = Math.min(y, height - 1 - y);
    const full = dy < reach;
    for (let x = 0; x < width; x++) {
      const dx = Math.min(x, width - 1 - x);
      if (!full && dx >= reach && width - reach - 1 > x) { x = width - reach - 1; continue; } // skip the empty middle
      const d = Math.min(dx, dy);
      const corner = dx < arm && dy < arm ? 1 : 0; // inside a corner square: the bracket is the edge pair there
      const bracket = (dx < 3 && (y < arm || y >= height - arm)) || (dy < 3 && (x < arm || x >= width - arm)) ? 1 : 0;
      let a = 0.5 * Math.exp(-d / 7) + (d < 1.5 ? 0.5 : 0) + (bracket ? 0.5 : 0) + corner * 0 ;
      a = clamp(a);
      if (a <= 0.002) continue;
      const k = clamp((d < 1.5 ? 0.6 : 0) + bracket * 0.5);
      const i = (y * width + x) * 4;
      px[i] = mix(110, 255, k) * a; px[i + 1] = 255 * a; px[i + 2] = mix(60, 255, k) * a; px[i + 3] = a * 255;
    }
  }
}

const ease = (t) => t * t * (3 - 2 * t);
const T_OPEN = 280, T_SCAN = 1100, T_CLOSE = 320;
export const SCAN_TOTAL_MS = T_OPEN + T_SCAN + T_CLOSE;

let flip = false; // alternates the side of the eye between screenshots

export const FLASH_TOTAL_MS = 520;

export class ScanAnimation {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
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
        const a = t < 90 ? t / 90 : t < 250 ? 1 : 1 - ease((t - 250) / (FLASH_TOTAL_MS - 250));
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
