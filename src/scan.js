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
  present(x, y, alpha, height = this.height) {
    f.UpdateLayeredWindow(this.hwnd, 0, { x: Math.round(x), y: Math.round(y) }, { cx: this.width, cy: Math.max(1, Math.min(this.height, Math.round(height))) }, this.dc, { x: 0, y: 0 }, 0,
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
export function renderBand(px, width, height) {
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
      const i = (y * width + x) * 4;
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

/** The laser: a thin vertical beam, white-hot core with a green glow, brighter along its length as it pulses. */
export function renderBeam(px, width, height, phase = 0) {
  for (let y = 0; y < height; y++) {
    const pulse = 0.82 + 0.18 * Math.sin(y * 0.45 - phase);
    for (let x = 0; x < width; x++) {
      const dx = Math.abs(x + 0.5 - width / 2);
      const core = Math.exp(-((dx / 1.6) ** 2));
      const glow = 0.5 * Math.exp(-((dx / 6) ** 2));
      const a = clamp((core + glow) * pulse);
      const k = clamp(core * 1.2);
      const r = mix(40, 255, k), g = mix(235, 255, k), b = mix(110, 255, k);
      const i = (y * width + x) * 4;
      px[i] = b * a; px[i + 1] = g * a; px[i + 2] = r * a; px[i + 3] = a * 255;
    }
  }
}

const ease = (t) => t * t * (3 - 2 * t);
const T_OPEN = 280, T_SCAN = 900, T_CLOSE = 320;
export const SCAN_TOTAL_MS = T_OPEN + T_SCAN + T_CLOSE;

export class ScanAnimation {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
  }

  /**
   * Plays the animation over `rect` (desktop pixels) and resolves when it is over. `cancelled()` is polled each
   * frame; the windows are always removed. Never throws: a failed animation must not break a screenshot.
   */
  async play(rect, cancelled = () => false) {
    if (!this.enabled) return;
    let band = null, beam = null, eye = null;
    try {
      ensurePump();
      const size = Math.round(clamp(Math.min(rect.width, rect.height) * 0.4, 56, 170));
      const bandH = 70, beamW = 26;
      band = new Layer(Math.max(40, rect.width), bandH);
      renderBand(band.px, band.width, band.height);
      beam = new Layer(beamW, Math.max(2, rect.height));
      eye = new Layer(size, size);
      // the eye sits on the top edge of the region (pushed down when the region touches the screen top)
      const ex = rect.left + (rect.width - size) / 2;
      const ey = Math.max(w.virtualScreen().y, rect.top - size * 0.55);
      const gy = 0.95;
      const pupil = pupilPos(size, 0, gy);
      const cx = ex + pupil.x, cy = ey + pupil.y; // laser origin
      const scanTop = Math.max(rect.top, cy);
      const t0 = performance.now();
      for (;;) {
        const t = performance.now() - t0;
        if (t >= SCAN_TOTAL_MS || cancelled()) break;
        let open, fade, p = 0;
        if (t < T_OPEN) { open = ease(t / T_OPEN); fade = open; }
        else if (t < T_OPEN + T_SCAN) { open = 1; fade = 1; p = ease((t - T_OPEN) / T_SCAN); }
        else { const k = (t - T_OPEN - T_SCAN) / T_CLOSE; open = 1 - ease(k); fade = 1 - k; p = 1; }
        const charge = p > 0 ? 1 : clamp((t - T_OPEN * 0.6) / (T_OPEN * 0.4)); // pupil glows just before firing
        renderEye(eye.px, size, open, 0, mix(0.5, gy, clamp(t / T_OPEN)), charge);
        const edge = scanTop + p * (rect.top + rect.height - scanTop);
        if (p > 0 && p < 1) {
          const len = Math.round(edge - cy);
          if (len > 1) {
            renderBeam(beam.px, beamW, len, t * 0.05);
            beam.present(cx - beamW / 2, cy, 255, len);
          }
          band.present(rect.left + (rect.width - band.width) / 2, edge - bandH, 255 * Math.min(1, p * 8, (1 - p) * 8));
        } else if (beam.shown) {
          beam.present(cx - beamW / 2, cy, 0, 1); // fully transparent: the laser is off
        }
        eye.present(ex, ey, 255 * fade);
        await new Promise((r) => setTimeout(r, 16));
      }
    } catch (e) {
      process.stderr.write(`win-input-mcp: scan animation failed (${e.message})\n`);
    } finally {
      band?.destroy();
      beam?.destroy();
      eye?.destroy();
    }
  }
}
