// Notification-area (tray) icon with a context menu. Runs on the shared message pump (pump.js): the hidden owner
// window's WNDPROC is called from pumpOnce() on the main thread, so there is no extra thread and the event loop is
// never blocked, except while the context menu is open (Windows menus are modal by design).
import koffi from 'koffi';
import { ensurePump } from './pump.js';
import { autostart } from './autostart.js';

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');
const shell32 = koffi.load('shell32.dll');

const POINT = koffi.struct('TR_POINT', { x: 'int32', y: 'int32' });
const RECT = koffi.struct('TR_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const GUID = koffi.struct('TR_GUID', { a: 'uint32', b: 'uint16', c: 'uint16', d: koffi.array('uint8', 8) });
const NOTIFYICONDATAW = koffi.struct('TR_NID', {
  cbSize: 'uint32', hWnd: 'intptr_t', uID: 'uint32', uFlags: 'uint32', uCallbackMessage: 'uint32', hIcon: 'intptr_t',
  szTip: koffi.array('char16', 128), dwState: 'uint32', dwStateMask: 'uint32', szInfo: koffi.array('char16', 256),
  uVersion: 'uint32', szInfoTitle: koffi.array('char16', 64), dwInfoFlags: 'uint32', guidItem: GUID, hBalloonIcon: 'intptr_t',
});
const NOTIFYICONIDENTIFIER = koffi.struct('TR_NII', { cbSize: 'uint32', hWnd: 'intptr_t', uID: 'uint32', guidItem: GUID });
const BITMAPINFO = koffi.struct('TR_BITMAPINFO', {
  biSize: 'uint32', biWidth: 'int32', biHeight: 'int32', biPlanes: 'uint16', biBitCount: 'uint16', biCompression: 'uint32',
  biSizeImage: 'uint32', biXPels: 'int32', biYPels: 'int32', biClrUsed: 'uint32', biClrImportant: 'uint32', bmiColors: 'uint32',
});
const ICONINFO = koffi.struct('TR_ICONINFO', { fIcon: 'int32', xHotspot: 'uint32', yHotspot: 'uint32', hbmMask: 'intptr_t', hbmColor: 'intptr_t' });
const WndProc = koffi.proto('intptr_t TrWndProc(intptr_t h, uint32 msg, uintptr_t wp, intptr_t lp)');
const WNDCLASSEXW = koffi.struct('TR_WNDCLASSEXW', {
  cbSize: 'uint32', style: 'uint32', lpfnWndProc: koffi.pointer(WndProc), cbClsExtra: 'int32', cbWndExtra: 'int32',
  hInstance: 'intptr_t', hIcon: 'intptr_t', hCursor: 'intptr_t', hbrBackground: 'intptr_t',
  lpszMenuName: 'str16', lpszClassName: 'str16', hIconSm: 'intptr_t',
});

const f = {
  RegisterClassExW: user32.func('uint16 RegisterClassExW(TR_WNDCLASSEXW *c)'),
  CreateWindowExW: user32.func('intptr_t CreateWindowExW(uint32 ex, str16 cls, str16 title, uint32 style, int x, int y, int w, int h, intptr_t parent, intptr_t menu, intptr_t inst, intptr_t param)'),
  DefWindowProcW: user32.func('intptr_t DefWindowProcW(intptr_t h, uint32 msg, uintptr_t wp, intptr_t lp)'),
  DestroyWindow: user32.func('bool DestroyWindow(intptr_t h)'),
  RegisterWindowMessageW: user32.func('uint32 RegisterWindowMessageW(str16 s)'),
  CreatePopupMenu: user32.func('intptr_t CreatePopupMenu()'),
  AppendMenuW: user32.func('bool AppendMenuW(intptr_t m, uint32 flags, uintptr_t id, str16 text)'),
  DestroyMenu: user32.func('bool DestroyMenu(intptr_t m)'),
  SetMenuDefaultItem: user32.func('bool SetMenuDefaultItem(intptr_t m, uint32 item, uint32 byPos)'),
  TrackPopupMenu: user32.func('int TrackPopupMenu(intptr_t m, uint32 flags, int x, int y, int reserved, intptr_t h, void *rc)'),
  SetForegroundWindow: user32.func('bool SetForegroundWindow(intptr_t h)'),
  PostMessageW: user32.func('bool PostMessageW(intptr_t h, uint32 msg, uintptr_t wp, intptr_t lp)'),
  GetCursorPos: user32.func('bool GetCursorPos(_Out_ TR_POINT *p)'),
  CreateIconIndirect: user32.func('intptr_t CreateIconIndirect(TR_ICONINFO *i)'),
  DestroyIcon: user32.func('bool DestroyIcon(intptr_t i)'),
  GetDC: user32.func('intptr_t GetDC(intptr_t h)'),
  ReleaseDC: user32.func('int ReleaseDC(intptr_t h, intptr_t dc)'),
  CreateDIBSection: gdi32.func('intptr_t CreateDIBSection(intptr_t dc, TR_BITMAPINFO *bi, uint32 usage, _Out_ void **bits, intptr_t section, uint32 offset)'),
  CreateBitmap: gdi32.func('intptr_t CreateBitmap(int w, int h, uint32 planes, uint32 bpp, void *bits)'),
  DeleteObject: gdi32.func('bool DeleteObject(intptr_t o)'),
  GetModuleHandleW: kernel32.func('intptr_t GetModuleHandleW(str16 n)'),
  Shell_NotifyIconW: shell32.func('bool Shell_NotifyIconW(uint32 msg, TR_NID *d)'),
  Shell_NotifyIconGetRect: shell32.func('int32 Shell_NotifyIconGetRect(TR_NII *id, _Out_ TR_RECT *rc)'),
};

const NIM_ADD = 0, NIM_MODIFY = 1, NIM_DELETE = 2;
const NIF_MESSAGE = 1, NIF_ICON = 2, NIF_TIP = 4;
const WM_APP_TRAY = 0x8001;
const WM_LBUTTONUP = 0x202, WM_RBUTTONUP = 0x205, WM_CONTEXTMENU = 0x7b, WM_NULL = 0;
const ID_OPEN = 1, ID_AUTOSTART = 2, ID_QUIT = 3;
const MF_GRAYED = 1, MF_CHECKED = 8, MF_SEPARATOR = 0x800;
const TPM_RIGHTBUTTON = 2, TPM_NONOTIFY = 0x80, TPM_RETURNCMD = 0x100, TPM_BOTTOMALIGN = 0x20;

/** A 32x32 straight-alpha BGRA eye in the colours of the radar eye: white eyeball, green iris, dark pupil, dark rim. */
function eyePixels(n = 32) {
  const px = new Uint8Array(n * n * 4);
  const c = (n - 1) / 2;
  const put = (i, r, g, b, a) => { px[i] = b; px[i + 1] = g; px[i + 2] = r; px[i + 3] = a; };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x - c) / (n / 2 - 1), dy = (y - c) / (n / 2 - 1);
      // almond: |dy| below a lens curve of dx
      const lid = 0.62 * (1 - Math.pow(Math.abs(dx), 1.6));
      const d = lid - Math.abs(dy); // > 0 inside
      const i = (y * n + x) * 4;
      if (d < -0.04) continue;
      const aa = Math.max(0, Math.min(1, (d + 0.04) / 0.08));
      if (d < 0.1) { put(i, 22, 60, 36, Math.round(255 * aa)); continue; } // dark rim
      const r = Math.hypot(x - c, y - c);
      if (r < 3.4) put(i, 12, 24, 16, 255);              // pupil
      else if (r < 7.6) put(i, 40, 205, 90, 255);        // iris
      else if (r < 8.6) put(i, 20, 140, 60, 255);        // iris edge
      else put(i, 245, 250, 245, 255);                   // eyeball
      if (r < 7.6 && x - c < -1 && y - c < -1 && Math.hypot(x - (c - 3), y - (c - 3)) < 1.6) put(i, 255, 255, 255, 255); // glint
    }
  }
  return px;
}

function createEyeIcon() {
  const n = 32;
  const screen = f.GetDC(0);
  const out = [null];
  const color = f.CreateDIBSection(screen, { biSize: 40, biWidth: n, biHeight: -n, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPels: 0, biYPels: 0, biClrUsed: 0, biClrImportant: 0, bmiColors: 0 }, 0, out, 0, 0);
  f.ReleaseDC(0, screen);
  if (!color || !out[0]) throw new Error('CreateDIBSection failed');
  new Uint8Array(koffi.view(out[0], n * n * 4)).set(eyePixels(n));
  const mask = f.CreateBitmap(n, n, 1, 1, null);
  const icon = f.CreateIconIndirect({ fIcon: 1, xHotspot: 0, yHotspot: 0, hbmMask: mask, hbmColor: color });
  f.DeleteObject(color);
  f.DeleteObject(mask);
  if (!icon) throw new Error('CreateIconIndirect failed');
  return icon;
}

const trays = new Map(); // hwnd -> Tray
let proc = null, taskbarCreated = 0, classId = 0;
const CLASS = 'IspyxTrayWindow';

function registerClass() {
  if (proc) return;
  taskbarCreated = f.RegisterWindowMessageW('TaskbarCreated');
  proc = koffi.register((h, msg, wp, lp) => {
    try {
      const t = trays.get(h);
      if (t) {
        if (msg === WM_APP_TRAY) {
          const ev = Number(lp) & 0xffff;
          if (ev === WM_LBUTTONUP) t._fire('onOpen');
          else if (ev === WM_RBUTTONUP || ev === WM_CONTEXTMENU) t._menu();
          return 0;
        }
        if (msg === taskbarCreated) { t._add(); return 0; }
      }
    } catch { /* never throw into native code */ }
    return f.DefWindowProcW(h, msg, wp, lp);
  }, koffi.pointer(WndProc));
  classId = f.RegisterClassExW({
    cbSize: koffi.sizeof(WNDCLASSEXW), style: 0, lpfnWndProc: proc, cbClsExtra: 0, cbWndExtra: 0, hInstance: f.GetModuleHandleW(null),
    hIcon: 0, hCursor: 0, hbrBackground: 0, lpszMenuName: null, lpszClassName: CLASS, hIconSm: 0,
  });
}

export class Tray {
  constructor({ tooltip = 'Ispyx', onOpen, onQuit, getStatus } = {}) {
    this.onOpen = onOpen; this.onQuit = onQuit; this.getStatus = getStatus;
    this.tooltip = tooltip;
    this.visible = false; // whether the last NIM_ADD succeeded
    this.destroyed = false;
    registerClass();
    // Hidden top-level popup (not message-only: those do not receive the TaskbarCreated broadcast).
    this.hwnd = f.CreateWindowExW(0x80 /* TOOLWINDOW */, CLASS, 'Ispyx tray', 0x80000000 /* WS_POPUP */, 0, 0, 0, 0, 0, 0, f.GetModuleHandleW(null), 0);
    if (!this.hwnd) throw new Error('CreateWindowEx failed');
    this.icon = createEyeIcon();
    trays.set(this.hwnd, this);
    ensurePump(0); // the icon is happy with the idle pace
    this._add();
  }

  _data(flags) {
    return {
      cbSize: koffi.sizeof(NOTIFYICONDATAW), hWnd: this.hwnd, uID: 1, uFlags: flags, uCallbackMessage: WM_APP_TRAY, hIcon: this.icon,
      szTip: Array.from((this.tooltip || '').slice(0, 127), (ch) => ch.charCodeAt(0)), dwState: 0, dwStateMask: 0, szInfo: [],
      uVersion: 0, szInfoTitle: [], dwInfoFlags: 0, guidItem: { a: 0, b: 0, c: 0, d: [0, 0, 0, 0, 0, 0, 0, 0] }, hBalloonIcon: 0,
    };
  }

  /** (Re-)adds the icon; called at start and when Explorer restarts (TaskbarCreated). */
  _add() {
    if (this.destroyed) return false;
    this.visible = !!f.Shell_NotifyIconW(NIM_ADD, this._data(NIF_MESSAGE | NIF_ICON | NIF_TIP));
    return this.visible;
  }

  setTooltip(s) {
    this.tooltip = String(s ?? '');
    if (this.destroyed) return false;
    return !!f.Shell_NotifyIconW(NIM_MODIFY, this._data(NIF_TIP));
  }

  /** Screen rect of the icon in the notification area, or null (e.g. hidden in the overflow). */
  rect() {
    const rc = {};
    const hr = f.Shell_NotifyIconGetRect({ cbSize: koffi.sizeof(NOTIFYICONIDENTIFIER), hWnd: this.hwnd, uID: 1, guidItem: { a: 0, b: 0, c: 0, d: [0, 0, 0, 0, 0, 0, 0, 0] } }, rc);
    return hr === 0 ? rc : null;
  }

  _fire(name) {
    const fn = this[name];
    if (!fn) return;
    setImmediate(() => { try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch { /* callbacks must not crash the process */ } });
  }

  _menu() {
    let status = '';
    try { status = String((this.getStatus && this.getStatus()) ?? ''); } catch { /* no status line text */ }
    const on = autostart.get();
    const m = f.CreatePopupMenu();
    if (!m) return;
    try {
      if (status) f.AppendMenuW(m, MF_GRAYED, 0, status.replace(/\s+/g, ' ').slice(0, 100));
      f.AppendMenuW(m, 0, ID_OPEN, 'Open');
      f.AppendMenuW(m, on ? MF_CHECKED : 0, ID_AUTOSTART, 'Open at Windows start');
      f.AppendMenuW(m, MF_SEPARATOR, 0, null);
      f.AppendMenuW(m, 0, ID_QUIT, 'Quit');
      f.SetMenuDefaultItem(m, ID_OPEN, 0);
      const pt = {};
      f.GetCursorPos(pt);
      f.SetForegroundWindow(this.hwnd); // required so the menu closes when clicking elsewhere
      const cmd = f.TrackPopupMenu(m, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, pt.x, pt.y, 0, this.hwnd, null);
      f.PostMessageW(this.hwnd, WM_NULL, 0, 0);
      if (cmd === ID_OPEN) this._fire('onOpen');
      else if (cmd === ID_QUIT) this._fire('onQuit');
      else if (cmd === ID_AUTOSTART) { try { autostart.set(!on); } catch { /* registry not writable */ } }
    } finally {
      f.DestroyMenu(m);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    try { f.Shell_NotifyIconW(NIM_DELETE, this._data(0)); } catch { /* already gone */ }
    trays.delete(this.hwnd);
    try { f.DestroyWindow(this.hwnd); } catch { /* already gone */ }
    try { f.DestroyIcon(this.icon); } catch { /* already gone */ }
    this.visible = false;
  }
}
