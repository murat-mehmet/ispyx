// Tray icon thread (see tray.js). A window belongs to the thread that created it, so this worker owns the hidden
// window and blocks in GetMessageW: no polling, 0 % CPU while idle, and the modal context menu blocks only this
// thread, never the main event loop. Talks to the main thread with parentPort messages (out) and a SharedArrayBuffer
// plus PostMessageW to the window (in), because a thread blocked in GetMessageW cannot run its own JS events.
import koffi from 'koffi';
import { workerData, parentPort } from 'node:worker_threads';

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
koffi.struct('TR_MSG', { hwnd: 'intptr_t', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', ptx: 'int32', pty: 'int32', lPrivate: 'uint32' });
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
  GetMessageW: user32.func('int GetMessageW(_Out_ TR_MSG *m, intptr_t h, uint32 min, uint32 max)'),
  DispatchMessageW: user32.func('intptr_t DispatchMessageW(TR_MSG *m)'),
  PostQuitMessage: user32.func('void PostQuitMessage(int code)'),
};

const NIM_ADD = 0, NIM_MODIFY = 1, NIM_DELETE = 2;
const NIF_MESSAGE = 1, NIF_ICON = 2, NIF_TIP = 4;
const WM_APP_TRAY = 0x8001, WM_APP_DESTROY = 0x8002, WM_APP_TIP = 0x8003;
const WM_LBUTTONUP = 0x202, WM_RBUTTONUP = 0x205, WM_CONTEXTMENU = 0x7b, WM_NULL = 0;
const ID_OPEN = 1, ID_QUIT = 3;
const MF_GRAYED = 1, MF_SEPARATOR = 0x800;
const TPM_RIGHTBUTTON = 2, TPM_NONOTIFY = 0x80, TPM_RETURNCMD = 0x100, TPM_BOTTOMALIGN = 0x20;

function createEyeIcon() {
  const n = 32;
  const screen = f.GetDC(0);
  const out = [null];
  const color = f.CreateDIBSection(screen, { biSize: 40, biWidth: n, biHeight: -n, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPels: 0, biYPels: 0, biClrUsed: 0, biClrImportant: 0, bmiColors: 0 }, 0, out, 0, 0);
  f.ReleaseDC(0, screen);
  if (!color || !out[0]) throw new Error('CreateDIBSection failed');
  new Uint8Array(koffi.view(out[0], n * n * 4)).set(workerData.pixels);
  const mask = f.CreateBitmap(n, n, 1, 1, null);
  const icon = f.CreateIconIndirect({ fIcon: 1, xHotspot: 0, yHotspot: 0, hbmMask: mask, hbmColor: color });
  f.DeleteObject(color);
  f.DeleteObject(mask);
  if (!icon) throw new Error('CreateIconIndirect failed');
  return icon;
}

// ---- window + message loop (this thread only does this) ----
// Shared buffer layout: Int32 [0] = status length, [1] = tooltip length; UTF-16 text areas at unit 8 (status) and 264 (tooltip).
const SHARED = new Int32Array(workerData.sab);
const U16 = new Uint16Array(workerData.sab);
const STATUS_AT = 8, TIP_AT = 264;
const readText = (at, lenSlot) => String.fromCharCode(...U16.subarray(at, at + Math.min(Atomics.load(SHARED, lenSlot), 255)));

let hwnd = 0, icon = 0, tooltip = 'Ispyx', visible = false;
const CLASS = 'IspyxTrayWindow';
const send = (m) => parentPort.postMessage(m);

const data = (flags) => ({
  cbSize: koffi.sizeof(NOTIFYICONDATAW), hWnd: hwnd, uID: 1, uFlags: flags, uCallbackMessage: WM_APP_TRAY, hIcon: icon,
  szTip: Array.from((tooltip || '').slice(0, 127), (ch) => ch.charCodeAt(0)), dwState: 0, dwStateMask: 0, szInfo: [],
  uVersion: 0, szInfoTitle: [], dwInfoFlags: 0, guidItem: { a: 0, b: 0, c: 0, d: [0, 0, 0, 0, 0, 0, 0, 0] }, hBalloonIcon: 0,
});

function add() {
  visible = !!f.Shell_NotifyIconW(NIM_ADD, data(NIF_MESSAGE | NIF_ICON | NIF_TIP));
  send({ type: 'visible', visible });
}

function menu() {
  const status = readText(STATUS_AT, 0);
  const m = f.CreatePopupMenu();
  if (!m) return;
  try {
    if (status) f.AppendMenuW(m, MF_GRAYED, 0, status.replace(/\s+/g, ' ').slice(0, 100));
    f.AppendMenuW(m, 0, ID_OPEN, 'Open');
    f.AppendMenuW(m, MF_SEPARATOR, 0, null);
    f.AppendMenuW(m, 0, ID_QUIT, 'Quit');
    f.SetMenuDefaultItem(m, ID_OPEN, 0);
    const pt = {};
    f.GetCursorPos(pt);
    f.SetForegroundWindow(hwnd); // required so the menu closes when clicking elsewhere
    const cmd = f.TrackPopupMenu(m, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, pt.x, pt.y, 0, hwnd, null);
    f.PostMessageW(hwnd, WM_NULL, 0, 0);
    if (cmd === ID_OPEN) send({ type: 'open' });
    else if (cmd === ID_QUIT) send({ type: 'quit' });
  } finally {
    f.DestroyMenu(m);
  }
}

const taskbarCreated = f.RegisterWindowMessageW('TaskbarCreated');
const proc = koffi.register((h, msg, wp, lp) => {
  try {
    if (msg === WM_APP_TRAY) {
      const ev = Number(lp) & 0xffff;
      if (ev === WM_LBUTTONUP) send({ type: 'open' });
      else if (ev === WM_RBUTTONUP || ev === WM_CONTEXTMENU) menu();
      return 0;
    }
    if (msg === taskbarCreated) { add(); return 0; }
    if (msg === WM_APP_TIP) { tooltip = readText(TIP_AT, 1); f.Shell_NotifyIconW(NIM_MODIFY, data(NIF_TIP)); return 0; }
    if (msg === WM_APP_DESTROY) { f.PostQuitMessage(0); return 0; }
  } catch { /* never throw into native code */ }
  return f.DefWindowProcW(h, msg, wp, lp);
}, koffi.pointer(WndProc));

try {
  f.RegisterClassExW({
    cbSize: koffi.sizeof(WNDCLASSEXW), style: 0, lpfnWndProc: proc, cbClsExtra: 0, cbWndExtra: 0, hInstance: f.GetModuleHandleW(null),
    hIcon: 0, hCursor: 0, hbrBackground: 0, lpszMenuName: null, lpszClassName: CLASS, hIconSm: 0,
  });
  tooltip = workerData.tooltip || tooltip;
  // Hidden top-level popup (not message-only: those do not receive the TaskbarCreated broadcast).
  hwnd = f.CreateWindowExW(0x80 /* TOOLWINDOW */, CLASS, 'Ispyx tray', 0x80000000 /* WS_POPUP */, 0, 0, 0, 0, 0, 0, f.GetModuleHandleW(null), 0);
  if (!hwnd) throw new Error('CreateWindowEx failed');
  icon = createEyeIcon();
  send({ type: 'ready', hwnd, icon });
  add();
  // Block until a message arrives: 0 % CPU while idle.
  const msg = {};
  while (f.GetMessageW(msg, 0, 0, 0) > 0) f.DispatchMessageW(msg);
} catch (e) {
  send({ type: 'error', message: String(e?.message ?? e) });
} finally {
  try { f.Shell_NotifyIconW(NIM_DELETE, data(0)); } catch { /* already gone */ }
  try { if (hwnd) f.DestroyWindow(hwnd); } catch { /* already gone */ }
  try { if (icon) f.DestroyIcon(icon); } catch { /* already gone */ }
  Atomics.store(SHARED, 2, 1); // lets destroy() on the main thread wait for the icon to be removed
  Atomics.notify(SHARED, 2);
  send({ type: 'closed' });
}
