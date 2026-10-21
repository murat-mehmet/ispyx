// A small always-on-top banner that shows while the server works. It is click-through (mouse input goes to
// whatever is underneath), never takes focus, and has no title so list_windows skips it.
import koffi from 'koffi';
import * as w from './win32.js';
import { ensurePump, pumpOnce } from './pump.js';

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

const RECT = koffi.struct('OV_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const PAINTSTRUCT = koffi.struct('OV_PAINTSTRUCT', {
  hdc: 'intptr_t', fErase: 'int32', rcPaint: RECT, fRestore: 'int32', fIncUpdate: 'int32', rgbReserved: koffi.array('uint8_t', 32),
});
const WndProc = koffi.proto('intptr_t OvWndProc(intptr_t h, uint32 msg, uintptr_t wp, intptr_t lp)');
const WNDCLASSEXW = koffi.struct('OV_WNDCLASSEXW', {
  cbSize: 'uint32', style: 'uint32', lpfnWndProc: koffi.pointer(WndProc), cbClsExtra: 'int32', cbWndExtra: 'int32',
  hInstance: 'intptr_t', hIcon: 'intptr_t', hCursor: 'intptr_t', hbrBackground: 'intptr_t',
  lpszMenuName: 'str16', lpszClassName: 'str16', hIconSm: 'intptr_t',
});

const f = {
  RegisterClassExW: user32.func('uint16 RegisterClassExW(OV_WNDCLASSEXW *c)'),
  CreateWindowExW: user32.func('intptr_t CreateWindowExW(uint32 ex, str16 cls, str16 title, uint32 style, int x, int y, int w, int h, intptr_t parent, intptr_t menu, intptr_t inst, intptr_t param)'),
  DefWindowProcW: user32.func('intptr_t DefWindowProcW(intptr_t h, uint32 msg, uintptr_t wp, intptr_t lp)'),
  DestroyWindow: user32.func('bool DestroyWindow(intptr_t h)'),
  ShowWindow: user32.func('bool ShowWindow(intptr_t h, int cmd)'),
  SetWindowPos: user32.func('bool SetWindowPos(intptr_t h, intptr_t after, int x, int y, int cx, int cy, uint32 flags)'),
  SetLayeredWindowAttributes: user32.func('bool SetLayeredWindowAttributes(intptr_t h, uint32 key, uint8_t alpha, uint32 flags)'),
  InvalidateRect: user32.func('bool InvalidateRect(intptr_t h, void *r, bool erase)'),
  UpdateWindow: user32.func('bool UpdateWindow(intptr_t h)'),
  BeginPaint: user32.func('intptr_t BeginPaint(intptr_t h, _Out_ OV_PAINTSTRUCT *ps)'),
  EndPaint: user32.func('bool EndPaint(intptr_t h, OV_PAINTSTRUCT *ps)'),
  GetClientRect: user32.func('bool GetClientRect(intptr_t h, _Out_ OV_RECT *r)'),
  FillRect: user32.func('int FillRect(intptr_t dc, OV_RECT *r, intptr_t brush)'),
  DrawTextW: user32.func('int DrawTextW(intptr_t dc, str16 text, int n, OV_RECT *r, uint32 flags)'),
  CreateSolidBrush: gdi32.func('intptr_t CreateSolidBrush(uint32 color)'),
  CreateFontW: gdi32.func('intptr_t CreateFontW(int h, int w, int esc, int ori, int weight, uint32 it, uint32 ul, uint32 so, uint32 cs, uint32 op, uint32 clip, uint32 q, uint32 pf, str16 face)'),
  SelectObject: gdi32.func('intptr_t SelectObject(intptr_t dc, intptr_t o)'),
  SetBkMode: gdi32.func('int SetBkMode(intptr_t dc, int m)'),
  SetTextColor: gdi32.func('uint32 SetTextColor(intptr_t dc, uint32 c)'),
  GetModuleHandleW: kernel32.func('intptr_t GetModuleHandleW(str16 n)'),
};

export const OVERLAY_CLASS = 'WinInputMcpOverlay';
const COLORS = { running: 0x241814, stopped: 0x1e1eb4 }; // COLORREF = 0x00BBGGRR
const WIDTH = 600;
const HEIGHT = 40;

export class Overlay {
  constructor({ enabled = true, hideAfterMs = 1500, stopLabel = 'Alt+Esc' } = {}) {
    this.stopLabel = stopLabel;
    this.enabled = enabled;
    this.hideAfterMs = hideAfterMs;
    this.active = 0;
    this.stopped = false;
    this.hwnd = 0;
    this.text = '';
    this.timer = null;
  }

  _create() {
    if (this.hwnd || !this.enabled) return;
    try {
      this.brushes = { running: f.CreateSolidBrush(COLORS.running), stopped: f.CreateSolidBrush(COLORS.stopped) };
      this.font = f.CreateFontW(-19, 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 5, 0, 'Segoe UI');
      this.proc = koffi.register((h, msg, wp, lp) => this._wndProc(h, msg, wp, lp), koffi.pointer(WndProc));
      const inst = f.GetModuleHandleW(null);
      f.RegisterClassExW({
        cbSize: koffi.sizeof(WNDCLASSEXW), style: 0, lpfnWndProc: this.proc, cbClsExtra: 0, cbWndExtra: 0, hInstance: inst,
        hIcon: 0, hCursor: 0, hbrBackground: 0, lpszMenuName: null, lpszClassName: OVERLAY_CLASS, hIconSm: 0,
      });
      const mon = w.listMonitors().find((m) => m.primary) ?? { left: 0, top: 0, width: 1280 };
      // WS_EX_TOPMOST | TOOLWINDOW | LAYERED | TRANSPARENT (click-through) | NOACTIVATE ; WS_POPUP
      this.hwnd = f.CreateWindowExW(0x08 | 0x80 | 0x80000 | 0x20 | 0x08000000, OVERLAY_CLASS, '', 0x80000000,
        mon.left + Math.round((mon.width - WIDTH) / 2), mon.top + 6, WIDTH, HEIGHT, 0, 0, inst, 0);
      if (!this.hwnd) throw new Error('CreateWindowEx failed');
      f.SetLayeredWindowAttributes(this.hwnd, 0, 235, 2); // LWA_ALPHA
      // Windows only delivers paint/hit-test messages while someone pumps; do it here, on this thread.
      ensurePump();
    } catch (e) {
      process.stderr.write(`win-input-mcp: overlay disabled (${e.message})\n`);
      this.enabled = false;
      this.hwnd = 0;
    }
  }

  _wndProc(h, msg, wp, lp) {
    switch (msg) {
      case 0x84: return -1; // WM_NCHITTEST -> HTTRANSPARENT: never catch a click
      case 0x14: return 1; // WM_ERASEBKGND
      case 0xf: { // WM_PAINT
        const ps = {};
        const dc = f.BeginPaint(h, ps);
        const r = {};
        f.GetClientRect(h, r);
        f.FillRect(dc, r, this.stopped ? this.brushes.stopped : this.brushes.running);
        f.SelectObject(dc, this.font);
        f.SetBkMode(dc, 1);
        f.SetTextColor(dc, 0xffffff);
        f.DrawTextW(dc, this.text, -1, r, 0x1 | 0x4 | 0x20); // DT_CENTER | DT_VCENTER | DT_SINGLELINE
        f.EndPaint(h, ps);
        return 0;
      }
      default: return f.DefWindowProcW(h, msg, wp, lp);
    }
  }

  _show(text) {
    this._create();
    if (!this.hwnd) return;
    this.text = text;
    f.SetWindowPos(this.hwnd, -1, 0, 0, 0, 0, 0x1 | 0x2 | 0x10); // HWND_TOPMOST, NOSIZE|NOMOVE|NOACTIVATE
    f.ShowWindow(this.hwnd, 4); // SW_SHOWNOACTIVATE
    f.InvalidateRect(this.hwnd, null, true);
    f.UpdateWindow(this.hwnd);
  }

  _hide() {
    if (this.hwnd) f.ShowWindow(this.hwnd, 0);
  }

  /** A tool started: show the banner. Call done() when it ends. */
  begin(label) {
    if (!this.enabled || this.stopped) return;
    this.active++;
    clearTimeout(this.timer);
    this._show(`win-input-mcp is working: ${label}   |   To stop press ${this.stopLabel}`);
  }

  done() {
    if (!this.enabled || this.stopped) return;
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
    this.stopped = true;
    clearTimeout(this.timer);
    this._show(`win-input-mcp STOPPED (${reason})`);
    this.timer = setTimeout(() => this._hide(), 5000);
    this.timer.unref();
  }

  /** The stop was cleared (resume tool): back to normal. */
  resume() {
    this.stopped = false;
    this.active = 0;
    clearTimeout(this.timer);
    this._hide();
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
