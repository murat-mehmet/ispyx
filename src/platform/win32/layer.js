// Windows effect window: a layered, click-through window backed by a DIB section, plus GDI text masks.
// Pixels are drawn in software (src/effects) into `layer.px`; nothing here depends on GDI+.
import koffi from 'koffi';

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
export class Layer {
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

  /** Shows the `width` x `height` part of the buffer starting at row `srcY` at (x, y) with constant opacity `alpha` (0-255). */
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
