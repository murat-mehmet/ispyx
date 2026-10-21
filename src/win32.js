// Thin koffi bindings over the Win32 calls the server needs. Windows only.
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const gdi32 = koffi.load('gdi32.dll');
const advapi32 = koffi.load('advapi32.dll');
const dwmapi = koffi.load('dwmapi.dll');
const ole32 = koffi.load('ole32.dll');
const winmm = koffi.load('winmm.dll');
const timeBeginPeriod = winmm.func('uint32 timeBeginPeriod(uint32 ms)');

export const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
export const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
const MONITORINFO = koffi.struct('MONITORINFO', {
  cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32',
});
const GUITHREADINFO = koffi.struct('GUITHREADINFO', {
  cbSize: 'uint32', flags: 'uint32', hwndActive: 'intptr_t', hwndFocus: 'intptr_t',
  hwndCapture: 'intptr_t', hwndMenuOwner: 'intptr_t', hwndMoveSize: 'intptr_t',
  hwndCaret: 'intptr_t', rcCaret: RECT,
});
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32', biWidth: 'int32', biHeight: 'int32', biPlanes: 'uint16', biBitCount: 'uint16',
  biCompression: 'uint32', biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32', biClrImportant: 'uint32',
});
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const INPUT_U = koffi.union('INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT });
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_U });

const EnumWindowsProc = koffi.proto('bool EnumWindowsProc(intptr_t hwnd, intptr_t lparam)');
const MonitorEnumProc = koffi.proto('bool MonitorEnumProc(intptr_t hmon, intptr_t hdc, RECT *rc, intptr_t lparam)');

const f = {
  SetProcessDpiAwarenessContext: user32.func('bool SetProcessDpiAwarenessContext(intptr_t ctx)'),
  EnumWindows: user32.func('bool EnumWindows(EnumWindowsProc *cb, intptr_t lparam)'),
  IsWindow: user32.func('bool IsWindow(intptr_t h)'),
  IsWindowVisible: user32.func('bool IsWindowVisible(intptr_t h)'),
  IsIconic: user32.func('bool IsIconic(intptr_t h)'),
  GetWindowTextW: user32.func('int GetWindowTextW(intptr_t h, _Out_ uint16_t *buf, int n)'),
  GetClassNameW: user32.func('int GetClassNameW(intptr_t h, _Out_ uint16_t *buf, int n)'),
  GetWindowRect: user32.func('bool GetWindowRect(intptr_t h, _Out_ RECT *r)'),
  FindWindowW: user32.func('intptr_t FindWindowW(str16 cls, str16 title)'),
  GetWindowThreadProcessId: user32.func('uint32 GetWindowThreadProcessId(intptr_t h, _Out_ uint32_t *pid)'),
  GetKeyboardLayout: user32.func('intptr_t GetKeyboardLayout(uint32 tid)'),
  GetWindowLongPtrW: user32.func('intptr_t GetWindowLongPtrW(intptr_t h, int idx)'),
  GetAncestor: user32.func('intptr_t GetAncestor(intptr_t h, uint32 flags)'),
  WindowFromPoint: user32.func('intptr_t WindowFromPoint(POINT p)'),
  GetForegroundWindow: user32.func('intptr_t GetForegroundWindow()'),
  SetForegroundWindow: user32.func('bool SetForegroundWindow(intptr_t h)'),
  BringWindowToTop: user32.func('bool BringWindowToTop(intptr_t h)'),
  ShowWindow: user32.func('bool ShowWindow(intptr_t h, int cmd)'),
  AttachThreadInput: user32.func('bool AttachThreadInput(uint32 from, uint32 to, bool attach)'),
  GetGUIThreadInfo: user32.func('bool GetGUIThreadInfo(uint32 tid, _Inout_ GUITHREADINFO *i)'),
  PostMessageW: user32.func('bool PostMessageW(intptr_t h, uint32 msg, uintptr_t w, intptr_t l)'),
  GetCursorPos: user32.func('bool GetCursorPos(_Out_ POINT *p)'),
  SetCursorPos: user32.func('bool SetCursorPos(int x, int y)'),
  GetSystemMetrics: user32.func('int GetSystemMetrics(int i)'),
  GetDpiForWindow: user32.func('uint32 GetDpiForWindow(intptr_t h)'),
  SendInput: user32.func('uint32 SendInput(uint32 n, INPUT *inputs, int cb)'),
  keybd_event: user32.func('void keybd_event(uint8_t vk, uint8_t scan, uint32 flags, uintptr_t extra)'),
  MapVirtualKeyW: user32.func('uint32 MapVirtualKeyW(uint32 code, uint32 type)'),
  GetDC: user32.func('intptr_t GetDC(intptr_t h)'),
  GetWindowDC: user32.func('intptr_t GetWindowDC(intptr_t h)'),
  ReleaseDC: user32.func('int ReleaseDC(intptr_t h, intptr_t dc)'),
  PrintWindow: user32.func('bool PrintWindow(intptr_t h, intptr_t dc, uint32 flags)'),
  OpenInputDesktop: user32.func('intptr_t OpenInputDesktop(uint32 flags, bool inherit, uint32 access)'),
  CloseDesktop: user32.func('bool CloseDesktop(intptr_t d)'),
  EnumDisplayMonitors: user32.func('bool EnumDisplayMonitors(intptr_t dc, RECT *clip, MonitorEnumProc *cb, intptr_t lparam)'),
  GetMonitorInfoW: user32.func('bool GetMonitorInfoW(intptr_t m, _Inout_ MONITORINFO *i)'),
  GetClipboardData: user32.func('intptr_t GetClipboardData(uint32 fmt)'),
  IsClipboardFormatAvailable: user32.func('bool IsClipboardFormatAvailable(uint32 fmt)'),
  OpenClipboard: user32.func('bool OpenClipboard(intptr_t owner)'),
  CloseClipboard: user32.func('bool CloseClipboard()'),
  EmptyClipboard: user32.func('bool EmptyClipboard()'),
  SetClipboardData: user32.func('intptr_t SetClipboardData(uint32 fmt, intptr_t mem)'),
  // gdi32
  CreateCompatibleDC: gdi32.func('intptr_t CreateCompatibleDC(intptr_t dc)'),
  CreateCompatibleBitmap: gdi32.func('intptr_t CreateCompatibleBitmap(intptr_t dc, int w, int h)'),
  SelectObject: gdi32.func('intptr_t SelectObject(intptr_t dc, intptr_t obj)'),
  DeleteObject: gdi32.func('bool DeleteObject(intptr_t obj)'),
  DeleteDC: gdi32.func('bool DeleteDC(intptr_t dc)'),
  BitBlt: gdi32.func('bool BitBlt(intptr_t dst, int x, int y, int w, int h, intptr_t src, int sx, int sy, uint32 rop)'),
  GetDIBits: gdi32.func('int GetDIBits(intptr_t dc, intptr_t bmp, uint32 start, uint32 lines, _Out_ uint8_t *bits, _Inout_ BITMAPINFOHEADER *bi, uint32 usage)'),
  // kernel32
  OpenProcess: kernel32.func('intptr_t OpenProcess(uint32 access, bool inherit, uint32 pid)'),
  CloseHandle: kernel32.func('bool CloseHandle(intptr_t h)'),
  QueryFullProcessImageNameW: kernel32.func('bool QueryFullProcessImageNameW(intptr_t h, uint32 flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)'),
  GetCurrentProcess: kernel32.func('intptr_t GetCurrentProcess()'),
  GetCurrentThreadId: kernel32.func('uint32 GetCurrentThreadId()'),
  GlobalAlloc: kernel32.func('intptr_t GlobalAlloc(uint32 flags, size_t n)'),
  GlobalLock: kernel32.func('intptr_t GlobalLock(intptr_t h)'),
  GlobalSize: kernel32.func('size_t GlobalSize(intptr_t h)'),
  GlobalUnlock: kernel32.func('bool GlobalUnlock(intptr_t h)'),
  GlobalFree: kernel32.func('intptr_t GlobalFree(intptr_t h)'),
  CopyToMem: kernel32.func('RtlMoveMemory', 'void', ['intptr_t', 'uint8_t *', 'size_t']),
  CopyFromMem: kernel32.func('RtlMoveMemory', 'void', ['_Out_ uint8_t *', 'intptr_t', 'size_t']),
  // advapi32
  OpenProcessToken: advapi32.func('bool OpenProcessToken(intptr_t p, uint32 access, _Out_ intptr_t *tok)'),
  GetTokenInformation: advapi32.func('bool GetTokenInformation(intptr_t tok, int cls, _Out_ uint32_t *info, uint32 len, _Out_ uint32_t *ret)'),
  // dwmapi
  DwmGetWindowAttribute: dwmapi.func('int32 DwmGetWindowAttribute(intptr_t h, uint32 attr, _Out_ uint32_t *v, uint32 n)'),
  // ole32
  CoInitializeEx: ole32.func('int32 CoInitializeEx(intptr_t reserved, uint32 flags)'),
  CoCreateInstance: ole32.func('int32 CoCreateInstance(uint8_t *clsid, intptr_t outer, uint32 ctx, uint8_t *iid, _Out_ intptr_t *out)'),
};

const MOUSE = { MOVE: 0x1, LEFTDOWN: 0x2, LEFTUP: 0x4, RIGHTDOWN: 0x8, RIGHTUP: 0x10, MIDDLEDOWN: 0x20, MIDDLEUP: 0x40, WHEEL: 0x800, VIRTUALDESK: 0x4000, ABSOLUTE: 0x8000 };
const BUTTONS = {
  left: [MOUSE.LEFTDOWN, MOUSE.LEFTUP],
  right: [MOUSE.RIGHTDOWN, MOUSE.RIGHTUP],
  middle: [MOUSE.MIDDLEDOWN, MOUSE.MIDDLEUP],
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let initialised = false;
export function init() {
  if (initialised) return;
  initialised = true;
  // PER_MONITOR_AWARE_V2 = -4. Every coordinate in this process is a physical pixel.
  if (!f.SetProcessDpiAwarenessContext(-4)) {
    throw new Error('Could not switch the process to per-monitor DPI awareness (v2); coordinates would be wrong.');
  }
  timeBeginPeriod(1); // 1 ms timer ticks, so pointer glides update ~100+ times a second instead of ~64
  f.CoInitializeEx(0, 2); // apartment threaded, needed for UI Automation
}

// ---------- strings / windows ----------

function readW(fn, hwnd) {
  const buf = new Uint16Array(512);
  const n = fn(hwnd, buf, 512);
  return n > 0 ? Buffer.from(buf.buffer, 0, n * 2).toString('utf16le') : '';
}
export const getTitle = (h) => readW(f.GetWindowTextW, h);
export const getClass = (h) => readW(f.GetClassNameW, h);

export function getRect(hwnd) {
  const r = {};
  if (!f.GetWindowRect(hwnd, r)) return null;
  return { left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top };
}

export function getPid(hwnd) {
  const out = [0];
  f.GetWindowThreadProcessId(hwnd, out);
  return out[0];
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const processCache = new Map();
export function processInfo(pid) {
  if (!pid) return { name: '', path: '', elevated: false, unknown: true };
  const h = f.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!h) return { name: '', path: '', elevated: true, unknown: true };
  try {
    const buf = new Uint16Array(1024);
    const size = [1024];
    let path = '';
    if (f.QueryFullProcessImageNameW(h, 0, buf, size)) path = Buffer.from(buf.buffer, 0, size[0] * 2).toString('utf16le');
    const name = path.split('\\').pop().toLowerCase();
    return { name, path, elevated: isElevated(h) };
  } finally {
    f.CloseHandle(h);
  }
}

let selfElevated;
function isElevated(hProcess) {
  const tok = [0];
  if (!f.OpenProcessToken(hProcess, 0x8, tok)) return true; // denied to a non-elevated caller means a higher integrity level
  try {
    const info = [0];
    const ret = [0];
    if (!f.GetTokenInformation(tok[0], 20, info, 4, ret)) return false;
    return info[0] !== 0;
  } finally {
    f.CloseHandle(tok[0]);
  }
}
export function selfIsElevated() {
  if (selfElevated === undefined) selfElevated = isElevated(f.GetCurrentProcess());
  return selfElevated;
}

export function describeWindow(hwnd) {
  const pid = getPid(hwnd);
  const p = processInfo(pid);
  return {
    hwnd,
    title: getTitle(hwnd),
    className: getClass(hwnd),
    pid,
    process: p.name,
    elevated: p.elevated,
    minimized: f.IsIconic(hwnd),
    rect: getRect(hwnd),
  };
}

function isCloaked(hwnd) {
  const v = [0];
  return f.DwmGetWindowAttribute(hwnd, 14, v, 4) === 0 && v[0] !== 0;
}

export function listWindows({ includeUntitled = false } = {}) {
  const out = [];
  const cb = koffi.register((hwnd) => {
    try {
      if (!f.IsWindowVisible(hwnd) || isCloaked(hwnd)) return true;
      const title = getTitle(hwnd);
      if (!title && !includeUntitled && !/^Shell_(Secondary)?TrayWnd$/.test(getClass(hwnd))) return true;
      out.push(describeWindow(hwnd));
    } catch { /* skip a window that vanished mid-enumeration */ }
    return true;
  }, koffi.pointer(EnumWindowsProc));
  try {
    f.EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  return out;
}

export const windowExists = (h) => !!h && f.IsWindow(h);
export const rootWindowAt = (x, y) => {
  const h = f.WindowFromPoint({ x, y });
  return h ? f.GetAncestor(h, 2) : 0;
};
export const foregroundWindow = () => f.GetForegroundWindow();

export function isScreenLocked() {
  // The input desktop cannot be opened while the secure (lock / UAC) desktop is active.
  const d = f.OpenInputDesktop(0, false, 0x100);
  if (!d) return true;
  f.CloseDesktop(d);
  return false;
}

export function windowDpi(hwnd) {
  return f.GetDpiForWindow(hwnd);
}

// ---------- focus ----------

export async function bringToForeground(hwnd) {
  if (f.IsIconic(hwnd)) {
    f.ShowWindow(hwnd, 9); // SW_RESTORE
    await sleep(150);
  }
  const ok = () => f.GetForegroundWindow() === hwnd;
  if (ok()) return true;
  f.SetForegroundWindow(hwnd);
  await sleep(80);
  if (ok()) return true;

  // Workaround 1: join the input queue of the current foreground thread.
  const fg = f.GetForegroundWindow();
  const fgThread = fg ? f.GetWindowThreadProcessId(fg, [0]) : 0;
  const me = f.GetCurrentThreadId();
  if (fgThread && fgThread !== me && f.AttachThreadInput(me, fgThread, true)) {
    try {
      f.BringWindowToTop(hwnd);
      f.SetForegroundWindow(hwnd);
    } finally {
      f.AttachThreadInput(me, fgThread, false);
    }
    await sleep(80);
    if (ok()) return true;
  }
  // Workaround 2: a synthetic Alt press lifts the foreground lock for this process.
  f.keybd_event(0x12, 0, 0, 0);
  f.keybd_event(0x12, 0, 2, 0);
  f.SetForegroundWindow(hwnd);
  await sleep(120);
  return ok();
}

// ---------- screen geometry ----------

export function virtualScreen() {
  return {
    x: f.GetSystemMetrics(76), y: f.GetSystemMetrics(77),
    width: f.GetSystemMetrics(78), height: f.GetSystemMetrics(79),
  };
}

export function listMonitors() {
  const out = [];
  const cb = koffi.register((hmon) => {
    const mi = { cbSize: 40, rcMonitor: {}, rcWork: {}, dwFlags: 0 };
    f.GetMonitorInfoW(hmon, mi);
    const r = mi.rcMonitor;
    out.push({ left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top, primary: (mi.dwFlags & 1) === 1 });
    return true;
  }, koffi.pointer(MonitorEnumProc));
  try {
    f.EnumDisplayMonitors(0, null, cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  return out;
}

export function cursorPos() {
  const p = {};
  f.GetCursorPos(p);
  return { x: p.x, y: p.y };
}

// ---------- capture ----------

function grab(w, h, draw) {
  const screenDc = f.GetDC(0);
  const memDc = f.CreateCompatibleDC(screenDc);
  const bmp = f.CreateCompatibleBitmap(screenDc, w, h);
  const old = f.SelectObject(memDc, bmp);
  try {
    draw(memDc, screenDc);
    const bi = {
      biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0,
      biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
    };
    const bits = Buffer.alloc(w * h * 4);
    if (!f.GetDIBits(memDc, bmp, 0, h, bits, bi, 0)) throw new Error('Could not read the captured pixels.');
    return bits; // BGRA, top-down
  } finally {
    f.SelectObject(memDc, old);
    f.DeleteObject(bmp);
    f.DeleteDC(memDc);
    f.ReleaseDC(0, screenDc);
  }
}

const isBlank = (bits) => {
  for (let i = 0; i < bits.length; i += 4 * 61) if (bits[i] | bits[i + 1] | bits[i + 2]) return false;
  return true;
};

/** Window-only capture through PrintWindow(PW_RENDERFULLCONTENT). Falls back to a screen copy if that returns black. */
export function captureWindow(hwnd) {
  const r = getRect(hwnd);
  if (!r || r.width <= 0 || r.height <= 0) throw new Error('The window has no visible area, so it cannot be captured.');
  let bits = grab(r.width, r.height, (memDc) => {
    f.PrintWindow(hwnd, memDc, 2);
  });
  let method = 'PrintWindow';
  if (isBlank(bits)) {
    if (foregroundWindow() !== hwnd) throw new Error('The window rendered nothing through PrintWindow and is not in front, so it cannot be captured. Focus it first.');
    bits = grab(r.width, r.height, (memDc, screenDc) => {
      f.BitBlt(memDc, 0, 0, r.width, r.height, screenDc, r.left, r.top, 0x00CC0020 | 0x40000000);
    });
    method = 'BitBlt';
  }
  return { bits, width: r.width, height: r.height, rect: r, method };
}

export function captureScreenRect(rect) {
  const bits = grab(rect.width, rect.height, (memDc, screenDc) => {
    f.BitBlt(memDc, 0, 0, rect.width, rect.height, screenDc, rect.left, rect.top, 0x00CC0020 | 0x40000000);
  });
  return { bits, width: rect.width, height: rect.height, rect };
}

// ---------- input ----------

function send(inputs) {
  const sent = f.SendInput(inputs.length, inputs, 40);
  if (sent !== inputs.length) {
    throw new Error('Windows refused the input (blocked by another process, a higher-privilege window, or a locked screen).');
  }
}

const mouseInput = (flags, data = 0, dx = 0, dy = 0) => ({
  type: 0, u: { mi: { dx, dy, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
});
const keyInput = (vk, scan, flags) => ({
  type: 1, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
});

export function mouseMoveTo(x, y) {
  const v = virtualScreen();
  const nx = Math.round(((x - v.x) * 65535) / (v.width - 1));
  const ny = Math.round(((y - v.y) * 65535) / (v.height - 1));
  send([mouseInput(MOUSE.MOVE | MOUSE.ABSOLUTE | MOUSE.VIRTUALDESK, 0, nx, ny)]);
}
export const mouseDown = (button = 'left') => send([mouseInput(BUTTONS[button][0])]);
export const mouseUp = (button = 'left') => send([mouseInput(BUTTONS[button][1])]);
export const mouseWheel = (notches) => send([mouseInput(MOUSE.WHEEL, Math.round(notches * 120))]);
export const mouseHWheel = (notches) => send([mouseInput(0x1000, Math.round(notches * 120))]); // positive = right

// Notepad (and likely other XAML apps) mangle a single SendInput batch that mixes ASCII and non-ASCII
// packets: the whole batch comes out as one repeated character. So each run of same-kind characters is
// sent as its own batch with a short pause. Unicode packets do not depend on the keyboard layout.
export async function typeUnicode(text, check) {
  const runs = [];
  for (const ch of text) {
    if (ch === String.fromCharCode(13)) continue;
    const kind = ch.charCodeAt(0) < 128 ? 'a' : 'u';
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.chars.push(ch);
    else runs.push({ kind, chars: [ch] });
  }
  for (let r = 0; r < runs.length; r++) {
    const inputs = [];
    for (const ch of runs[r].chars) {
      if (ch === '\n') {
        inputs.push(keyInput(0x0d, 0, 0), keyInput(0x0d, 0, 2));
        continue;
      }
      for (let i = 0; i < ch.length; i++) {
        const unit = ch.charCodeAt(i);
        inputs.push(keyInput(0, unit, 0x4), keyInput(0, unit, 0x4 | 0x2));
      }
    }
    for (let i = 0; i < inputs.length; i += 200) {
      check?.(); // lets the stop hotkey abort a long text between batches
      send(inputs.slice(i, i + 200));
    }
    if (r < runs.length - 1) await sleep(30);
  }
}

const EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x6f, 0x5b, 0x5c, 0x5d]);
const kflag = (vk) => (EXTENDED.has(vk) ? 1 : 0);
export function keysDown(vks) {
  send(vks.map((vk) => keyInput(vk, f.MapVirtualKeyW(vk, 0), kflag(vk))));
}
export function keysUp(vks) {
  send([...vks].reverse().map((vk) => keyInput(vk, f.MapVirtualKeyW(vk, 0), kflag(vk) | 2)));
}
export function pressVirtualKeys(vks) {
  const flag = (vk) => (EXTENDED.has(vk) ? 1 : 0);
  const scan = (vk) => f.MapVirtualKeyW(vk, 0);
  const down = vks.map((vk) => keyInput(vk, scan(vk), flag(vk)));
  const up = [...vks].reverse().map((vk) => keyInput(vk, scan(vk), flag(vk) | 2));
  send([...down, ...up]);
}

// ---------- clipboard ----------

function withClipboard(fn) {
  let opened = false;
  for (let i = 0; i < 10 && !opened; i++) {
    opened = f.OpenClipboard(0);
    if (!opened) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  }
  if (!opened) throw new Error('The clipboard is locked by another program. Try again in a moment.');
  try {
    f.EmptyClipboard();
    fn();
  } finally {
    f.CloseClipboard();
  }
}

function putGlobal(fmt, bytes) {
  const h = f.GlobalAlloc(0x2, bytes.length); // GMEM_MOVEABLE
  if (!h) throw new Error('Out of memory while preparing the clipboard.');
  const p = f.GlobalLock(h);
  f.CopyToMem(p, bytes, bytes.length);
  f.GlobalUnlock(h);
  if (!f.SetClipboardData(fmt, h)) {
    f.GlobalFree(h);
    throw new Error('Windows refused the clipboard data.');
  }
}

export function getClipboardText() {
  let opened = false;
  for (let i = 0; i < 10 && !opened; i++) {
    opened = f.OpenClipboard(0);
    if (!opened) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  }
  if (!opened) throw new Error('The clipboard is locked by another program. Try again in a moment.');
  try {
    const formats = { text: f.IsClipboardFormatAvailable(13), image: f.IsClipboardFormatAvailable(2) || f.IsClipboardFormatAvailable(8), files: f.IsClipboardFormatAvailable(15) };
    let text = null;
    if (formats.text) {
      const h = f.GetClipboardData(13);
      if (h) {
        const size = Number(f.GlobalSize(h));
        const p = f.GlobalLock(h);
        const buf = Buffer.alloc(size);
        f.CopyFromMem(buf, p, size);
        f.GlobalUnlock(h);
        text = buf.toString('utf16le').replace(/ .*$/s, '');
      }
    }
    return { text, formats };
  } finally {
    f.CloseClipboard();
  }
}

export function setClipboardText(text) {
  const bytes = Buffer.from(text + '\0', 'utf16le');
  withClipboard(() => putGlobal(13, bytes)); // CF_UNICODETEXT
}

export function setClipboardFile(path) {
  const head = Buffer.alloc(20);
  head.writeUInt32LE(20, 0); // pFiles
  head.writeUInt32LE(1, 16); // fWide
  const bytes = Buffer.concat([head, Buffer.from(path + '\0\0', 'utf16le')]);
  withClipboard(() => putGlobal(15, bytes)); // CF_HDROP
}

// ---------- password-field detection ----------

const guid = (s) => {
  const h = s.replace(/[{}-]/g, '');
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(h.slice(0, 8), 16), 0);
  b.writeUInt16LE(parseInt(h.slice(8, 12), 16), 4);
  b.writeUInt16LE(parseInt(h.slice(12, 16), 16), 6);
  Buffer.from(h.slice(16), 'hex').copy(b, 8);
  return b;
};

const ComFn = {
  getFocused: koffi.proto('int32 UiaGetFocused(intptr_t self, _Out_ intptr_t *el)'),
  getBool: koffi.proto('int32 UiaGetBool(intptr_t self, _Out_ int32_t *v)'),
  release: koffi.proto('uint32 UiaRelease(intptr_t self)'),
};
function vtableFn(obj, index, proto) {
  const head = Buffer.alloc(8);
  f.CopyFromMem(head, obj, 8);
  const slot = Buffer.alloc(8);
  f.CopyFromMem(slot, head.readBigUInt64LE(0) + BigInt(index * 8), 8);
  const fn = koffi.decode(slot, 'void *');
  return (...args) => koffi.call(fn, proto, ...args);
}

let uia = 0;
function uiaFocusedIsPassword() {
  if (!uia) {
    const out = [0];
    // CLSID_CUIAutomation, IID_IUIAutomation; CLSCTX_INPROC_SERVER
    const hr = f.CoCreateInstance(guid('ff48dba4-60ef-4201-aa87-54103eef594e'), 0, 1, guid('30cbe57d-d9d0-452a-ab13-7ac5ac4825ee'), out);
    if (hr !== 0) throw new Error('UI Automation is unavailable.');
    uia = out[0];
  }
  const el = [0];
  const hr = vtableFn(uia, 8, ComFn.getFocused)(uia, el); // IUIAutomation::GetFocusedElement
  if (hr !== 0 || !el[0]) return false;
  try {
    const v = [0];
    const r2 = vtableFn(el[0], 35, ComFn.getBool)(el[0], v); // IUIAutomationElement::get_CurrentIsPassword
    if (r2 !== 0) throw new Error('UI Automation could not read the focused field.');
    return v[0] !== 0;
  } finally {
    vtableFn(el[0], 2, ComFn.release)(el[0]);
  }
}

/** True when the keyboard focus sits in a password field. Throws when that cannot be determined. */
export function focusIsPassword() {
  const fg = f.GetForegroundWindow();
  if (fg) {
    const tid = f.GetWindowThreadProcessId(fg, [0]);
    const gti = { cbSize: 72, flags: 0, hwndActive: 0, hwndFocus: 0, hwndCapture: 0, hwndMenuOwner: 0, hwndMoveSize: 0, hwndCaret: 0, rcCaret: {} };
    if (f.GetGUIThreadInfo(tid, gti) && gti.hwndFocus) {
      const style = Number(f.GetWindowLongPtrW(gti.hwndFocus, -16)) >>> 0;
      if (/edit/i.test(getClass(gti.hwndFocus)) && (style & 0x20) !== 0) return true; // ES_PASSWORD
    }
  }
  return uiaFocusedIsPassword();
}

/** Language id (e.g. 0x41f = Turkish) of the keyboard layout active in the foreground window. */
export function foregroundLayout() {
  const fg = f.GetForegroundWindow();
  const tid = fg ? f.GetWindowThreadProcessId(fg, [0]) : 0;
  return Number(BigInt.asUintN(16, BigInt(f.GetKeyboardLayout(tid))));
}

export const _raw = f;
