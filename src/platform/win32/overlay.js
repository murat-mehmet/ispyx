// A small always-on-top pill that shows while the server works, drawn like the macOS one: dark body with a tint of the
// accent colour (green working, amber cancelled, red stopped), accent outline and dot, white text. It is click-through
// (mouse input goes to whatever is underneath), never takes focus, and has no title so list_windows skips it.
// Rendered into a per-pixel-alpha bitmap so the rounded edge is smooth.
import koffi from 'koffi';
import * as w from './win32.js';
import { ensurePump, pumpOnce } from './pump.js';

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

const WndProc = koffi.proto('intptr_t OvWndProc(intptr_t h, uint32 msg, uintptr_t wp, intptr_t lp)');
const WNDCLASSEXW = koffi.struct('OV_WNDCLASSEXW', {
  cbSize: 'uint32', style: 'uint32', lpfnWndProc: koffi.pointer(WndProc), cbClsExtra: 'int32', cbWndExtra: 'int32',
  hInstance: 'intptr_t', hIcon: 'intptr_t', hCursor: 'intptr_t', hbrBackground: 'intptr_t',
  lpszMenuName: 'str16', lpszClassName: 'str16', hIconSm: 'intptr_t',
});
const POINT = koffi.struct('OV_POINT', { x: 'int32', y: 'int32' });
const SIZE = koffi.struct('OV_SIZE', { cx: 'int32', cy: 'int32' });
const RECT = koffi.struct('OV_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const BLEND = koffi.struct('OV_BLEND', { op: 'uint8', flags: 'uint8', alpha: 'uint8', format: 'uint8' });
const BITMAPINFO = koffi.struct('OV_BITMAPINFO', {
  size: 'uint32', width: 'int32', height: 'int32', planes: 'uint16', bitCount: 'uint16', compression: 'uint32',
  sizeImage: 'uint32', xPels: 'int32', yPels: 'int32', clrUsed: 'uint32', clrImportant: 'uint32',
});

const f = {
  RegisterClassExW: user32.func('uint16 RegisterClassExW(OV_WNDCLASSEXW *c)'),
  CreateWindowExW: user32.func('intptr_t CreateWindowExW(uint32 ex, str16 cls, str16 title, uint32 style, int x, int y, int w, int h, intptr_t parent, intptr_t menu, intptr_t inst, intptr_t param)'),
  DefWindowProcW: user32.func('intptr_t DefWindowProcW(intptr_t h, uint32 msg, uintptr_t wp, intptr_t lp)'),
  ShowWindow: user32.func('bool ShowWindow(intptr_t h, int cmd)'),
  SetWindowPos: user32.func('bool SetWindowPos(intptr_t h, intptr_t after, int x, int y, int cx, int cy, uint32 flags)'),
  GetDC: user32.func('intptr_t GetDC(intptr_t h)'),
  ReleaseDC: user32.func('int ReleaseDC(intptr_t h, intptr_t dc)'),
  DrawTextW: user32.func('int DrawTextW(intptr_t dc, str16 text, int n, OV_RECT *r, uint32 flags)'),
  UpdateLayeredWindow: user32.func('bool UpdateLayeredWindow(intptr_t h, intptr_t dst, OV_POINT *pos, OV_SIZE *size, intptr_t src, OV_POINT *srcPos, uint32 key, OV_BLEND *blend, uint32 flags)'),
  CreateCompatibleDC: gdi32.func('intptr_t CreateCompatibleDC(intptr_t dc)'),
  DeleteDC: gdi32.func('bool DeleteDC(intptr_t dc)'),
  CreateDIBSection: gdi32.func('intptr_t CreateDIBSection(intptr_t dc, OV_BITMAPINFO *bi, uint32 usage, _Out_ void **bits, intptr_t section, uint32 offset)'),
  CreateFontW: gdi32.func('intptr_t CreateFontW(int h, int w, int esc, int ori, int weight, uint32 it, uint32 ul, uint32 so, uint32 cs, uint32 op, uint32 clip, uint32 q, uint32 pf, str16 face)'),
  DeleteObject: gdi32.func('bool DeleteObject(intptr_t o)'),
  SelectObject: gdi32.func('intptr_t SelectObject(intptr_t dc, intptr_t o)'),
  SetBkMode: gdi32.func('int SetBkMode(intptr_t dc, int m)'),
  SetTextColor: gdi32.func('uint32 SetTextColor(intptr_t dc, uint32 c)'),
  GetTextExtentPoint32W: gdi32.func('bool GetTextExtentPoint32W(intptr_t dc, str16 text, int n, _Out_ OV_SIZE *size)'),
  GetModuleHandleW: kernel32.func('intptr_t GetModuleHandleW(str16 n)'),
};

export const OVERLAY_CLASS = 'WinInputMcpOverlay';
const HEIGHT = 40;
const LEFT_PAD = 38;
const RIGHT_PAD = 22;
const MIN_WIDTH = 300;
const SS = 3; // text is drawn SS times larger and averaged down: smooth grayscale edges like the macOS banner
const BODY_ALPHA = 0.92;
const BASE = [20, 23, 36]; // dark navy body (r, g, b)
const ACCENTS = { working: [51, 204, 107], cancelled: [250, 184, 38], stopped: [237, 66, 66] };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Overlay {
  constructor({ enabled = true, hideAfterMs = 1500, stopLabel = 'Alt+Esc' } = {}) {
    this.stopLabel = stopLabel;
    this.enabled = enabled;
    this.hideAfterMs = hideAfterMs;
    this.active = 0;
    this.hwnd = 0;
    this.timer = null;
    this.bitmap = 0;
  }

  _create() {
    if (this.hwnd || !this.enabled) return;
    try {
      this.font = f.CreateFontW(-18 * SS, 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 4, 0, 'Segoe UI');
      this.proc = koffi.register((h, msg, wp, lp) => (msg === 0x84 ? -1 : f.DefWindowProcW(h, msg, wp, lp)), koffi.pointer(WndProc)); // WM_NCHITTEST -> HTTRANSPARENT
      const inst = f.GetModuleHandleW(null);
      f.RegisterClassExW({
        cbSize: koffi.sizeof(WNDCLASSEXW), style: 0, lpfnWndProc: this.proc, cbClsExtra: 0, cbWndExtra: 0, hInstance: inst,
        hIcon: 0, hCursor: 0, hbrBackground: 0, lpszMenuName: null, lpszClassName: OVERLAY_CLASS, hIconSm: 0,
      });
      // WS_EX_TOPMOST | TOOLWINDOW | LAYERED | TRANSPARENT (click-through) | NOACTIVATE ; WS_POPUP
      this.hwnd = f.CreateWindowExW(0x08 | 0x80 | 0x80000 | 0x20 | 0x08000000, OVERLAY_CLASS, '', 0x80000000,
        0, 0, MIN_WIDTH, HEIGHT, 0, 0, inst, 0);
      if (!this.hwnd) throw new Error('CreateWindowEx failed');
      // Windows only delivers hit-test messages while someone pumps; do it here, on this thread.
      ensurePump();
    } catch (e) {
      process.stderr.write(`ispyx: overlay disabled (${e.message})\n`);
      this.enabled = false;
      this.hwnd = 0;
    }
  }

  /** Draw the pill into a bitmap and hand it to the layered window. */
  _paint(text, kind) {
    const screenDc = f.GetDC(0);
    const dc = f.CreateCompatibleDC(screenDc);
    const oldFont = f.SelectObject(dc, this.font);
    const ext = {};
    f.GetTextExtentPoint32W(dc, text, text.length, ext);
    ext.cx = Math.ceil(ext.cx / SS);
    const mon = w.listMonitors().find((m) => m.primary) ?? { left: 0, top: 0, width: 1280 };
    const W = Math.round(Math.min(Math.max(MIN_WIDTH, ext.cx + LEFT_PAD + RIGHT_PAD), Math.min(1400, mon.width - 40)));
    const H = HEIGHT;

    const bits = [null];
    const bmp = f.CreateDIBSection(dc, { size: 40, width: W, height: -H, planes: 1, bitCount: 32, compression: 0, sizeImage: 0, xPels: 0, yPels: 0, clrUsed: 0, clrImportant: 0 }, 0, bits, 0, 0);
    if (!bmp || !bits[0]) {
      f.SelectObject(dc, oldFont); f.DeleteDC(dc); f.ReleaseDC(0, screenDc);
      throw new Error('CreateDIBSection failed');
    }
    const old = f.SelectObject(dc, bmp);
    const px = new Uint8Array(koffi.view(bits[0], W * H * 4));
    const mask = new Float32Array(W * H);
    const accent = ACCENTS[kind] ?? ACCENTS.working;

    // Same geometry as the macOS banner: a capsule, outline 1.5 wide centred 1.5 in from the edge, dot at x=18..28.
    const cy = H / 2;
    const outer = H / 2 - 0.75;
    const inner = H / 2 - 2.25;
    const x0 = outer + 0.75;
    const x1 = W - outer - 0.75;
    const body = BASE.map((c, i) => c * 0.84 + accent[i] * 0.16);
    const line = BASE.map((c, i) => c * 0.15 + accent[i] * 0.85);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const qx = x + 0.5;
        const qy = y + 0.5;
        const d = Math.hypot(qx - Math.min(Math.max(qx, x0), x1), qy - cy);
        const fill = clamp01(outer - d + 0.5);
        const core = clamp01(inner - d + 0.5); // 1 inside the outline, 0 on it
        const dot = clamp01(5 - Math.hypot(qx - 23, qy - cy) + 0.5);
        const i = (y * W + x) * 4;
        mask[y * W + x] = fill * BODY_ALPHA;
        for (let k = 0; k < 3; k++) {
          const base = line[k] * (1 - core) + body[k] * core;
          px[i + (2 - k)] = Math.round(base * (1 - dot) + accent[k] * dot); // BGRA
        }
        px[i + 3] = 255;
      }
    }

    // Text: white on black at SS x size, then each SS x SS block becomes one coverage value.
    const tw = (W - LEFT_PAD - RIGHT_PAD) * SS;
    const th = H * SS;
    const tb = [null];
    const tbmp = f.CreateDIBSection(dc, { size: 40, width: tw, height: -th, planes: 1, bitCount: 32, compression: 0, sizeImage: 0, xPels: 0, yPels: 0, clrUsed: 0, clrImportant: 0 }, 0, tb, 0, 0);
    if (tbmp && tb[0]) {
      const tdc = f.CreateCompatibleDC(screenDc);
      const told = f.SelectObject(tdc, tbmp);
      const tf = f.SelectObject(tdc, this.font);
      const big = new Uint8Array(koffi.view(tb[0], tw * th * 4));
      big.fill(0);
      f.SetBkMode(tdc, 1);
      f.SetTextColor(tdc, 0xffffff);
      f.DrawTextW(tdc, text, -1, { left: 0, top: 0, right: tw, bottom: th }, 0x4 | 0x20 | 0x8000); // VCENTER | SINGLELINE | END_ELLIPSIS
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W - LEFT_PAD - RIGHT_PAD; x++) {
          let sum = 0;
          for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) sum += big[(((y * SS + dy) * tw) + x * SS + dx) * 4 + 1];
          const c = sum / (255 * SS * SS);
          if (c <= 0) continue;
          const i = (y * W + x + LEFT_PAD) * 4;
          for (let k = 0; k < 3; k++) px[i + k] = Math.round(px[i + k] * (1 - c) + 255 * c);
        }
      }
      f.SelectObject(tdc, tf); f.SelectObject(tdc, told); f.DeleteObject(tbmp); f.DeleteDC(tdc);
    }

    // Premultiply by the capsule coverage.
    for (let p = 0; p < W * H; p++) {
      const a = mask[p];
      const i = p * 4;
      px[i] = Math.round(px[i] * a);
      px[i + 1] = Math.round(px[i + 1] * a);
      px[i + 2] = Math.round(px[i + 2] * a);
      px[i + 3] = Math.round(a * 255);
    }

    const x = mon.left + Math.round((mon.width - W) / 2);
    const ok = f.UpdateLayeredWindow(this.hwnd, screenDc, { x, y: mon.top + 6 }, { cx: W, cy: H }, dc, { x: 0, y: 0 }, 0,
      { op: 0, flags: 0, alpha: 255, format: 1 }, 2); // AC_SRC_OVER, AC_SRC_ALPHA ; ULW_ALPHA

    f.SelectObject(dc, old);
    f.SelectObject(dc, oldFont);
    f.DeleteObject(bmp);
    f.DeleteDC(dc);
    f.ReleaseDC(0, screenDc);
    if (!ok) throw new Error('UpdateLayeredWindow failed');
  }

  _show(text, kind = 'working') {
    this._create();
    if (!this.hwnd) return;
    try {
      this._paint(text, kind);
    } catch (e) {
      process.stderr.write(`ispyx: overlay disabled (${e.message})\n`);
      this.enabled = false;
      return;
    }
    f.SetWindowPos(this.hwnd, -1, 0, 0, 0, 0, 0x1 | 0x2 | 0x10); // HWND_TOPMOST, NOSIZE|NOMOVE|NOACTIVATE
    f.ShowWindow(this.hwnd, 4); // SW_SHOWNOACTIVATE
  }

  _hide() {
    if (this.hwnd) f.ShowWindow(this.hwnd, 0);
  }

  /** A tool started: show the banner. Call done() when it ends. */
  begin(label) {
    if (!this.enabled) return;
    this.active++;
    clearTimeout(this.timer);
    this._show(`ispyx is working: ${label}   |   To stop press ${this.stopLabel}`, 'working');
  }

  done() {
    if (!this.enabled) return;
    this.active = Math.max(0, this.active - 1);
    if (this.active === 0) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this._hide(), this.hideAfterMs);
      this.timer.unref();
    }
  }

  /** The user stopped the server: turn the banner red and keep it for a few seconds. */
  stop(reason) {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this._show(`ispyx STOPPED (${reason})`, 'stopped');
    this.timer = setTimeout(() => this._hide(), 5000);
    this.timer.unref();
  }

  /** First stop press: the running tool was cancelled; a second press within the window shuts the server down. */
  cancel(reason, windowMs) {
    if (!this.enabled) return;
    this.active = 0;
    clearTimeout(this.timer);
    this._show(`ispyx CANCELLED (${reason})   |   press again to shut down`, 'cancelled');
    this.timer = setTimeout(() => this._hide(), windowMs);
    this.timer.unref();
  }

  /** Hide the banner while the agent takes a screenshot, so it never covers what the agent needs to see. */
  async hiddenDuring(fn) {
    const visible = this.hwnd && this.enabled && w._raw.IsWindowVisible(this.hwnd);
    if (visible) {
      this._hide();
      await w.sleep(60); // let the compositor drop it
    }
    try {
      return await fn();
    } finally {
      if (visible) {
        f.ShowWindow(this.hwnd, 4);
        pumpOnce();
      }
    }
  }
}
