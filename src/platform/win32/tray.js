// Notification-area (tray) icon with a context menu. The icon lives on its own thread (tray-worker.js) that blocks in
// GetMessageW, so it costs no CPU while idle and the modal context menu never blocks the main event loop.
import koffi from 'koffi';
import { Worker } from 'node:worker_threads';

const user32 = koffi.load('user32.dll');
const PostMessageW = user32.func('bool PostMessageW(intptr_t h, uint32 msg, uintptr_t wp, intptr_t lp)');
const GUID = koffi.struct('TRF_GUID', { a: 'uint32', b: 'uint16', c: 'uint16', d: koffi.array('uint8', 8) });
const NII = koffi.struct('TRF_NII', { cbSize: 'uint32', hWnd: 'intptr_t', uID: 'uint32', guidItem: GUID });
const RECT = koffi.struct('TRF_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const Shell_NotifyIconGetRect = koffi.load('shell32.dll').func('int32 Shell_NotifyIconGetRect(TRF_NII *id, _Out_ TRF_RECT *rc)');
const WM_APP_DESTROY = 0x8002, WM_APP_TIP = 0x8003;
const STATUS_AT = 8, TIP_AT = 264;
const STATUS_REFRESH_MS = 5000;

export class Tray {
  constructor({ tooltip = 'Ispyx', onOpen, onQuit, getStatus } = {}) {
    this.onOpen = onOpen; this.onQuit = onQuit; this.getStatus = getStatus;
    this.tooltip = tooltip;
    this.visible = false; // whether the icon is in the notification area
    this.destroyed = false;
    this.hwnd = 0;
    this._sab = new SharedArrayBuffer(1040);
    this._shared = new Int32Array(this._sab);
    this._text = new Uint16Array(this._sab);
    this._setText(TIP_AT, 1, tooltip);
    this._worker = new Worker(new URL('./tray-worker.js', import.meta.url), { workerData: { sab: this._sab, tooltip } });
    this._worker.unref();
    this.ready = new Promise((resolve) => {
      this._worker.on('message', (m) => {
        if (m.type === 'ready') { this.hwnd = m.hwnd; resolve(true); }
        else if (m.type === 'visible') this.visible = m.visible;
        else if (m.type === 'open') this._fire('onOpen');
        else if (m.type === 'quit') this._fire('onQuit');
        else if (m.type === 'error') { resolve(false); }
      });
      this._worker.on('error', () => resolve(false));
      this._worker.on('exit', () => { this.visible = false; resolve(false); });
    });
    this._refreshStatus();
    if (getStatus) {
      this._timer = setInterval(() => this._refreshStatus(), STATUS_REFRESH_MS);
      this._timer.unref();
    }
  }

  _setText(at, lenSlot, s) {
    const t = String(s ?? '').slice(0, 255);
    for (let i = 0; i < t.length; i++) this._text[at + i] = t.charCodeAt(i);
    Atomics.store(this._shared, lenSlot, t.length);
  }

  _refreshStatus() {
    try { this._setText(STATUS_AT, 0, this.getStatus ? this.getStatus() : ''); } catch { /* no status line text */ }
  }

  setTooltip(s) {
    this.tooltip = String(s ?? '');
    if (this.destroyed) return false;
    this._setText(TIP_AT, 1, this.tooltip);
    return this.hwnd ? !!PostMessageW(this.hwnd, WM_APP_TIP, 0, 0) : true;
  }

  /** Screen rect of the icon in the notification area, or null (e.g. hidden in the overflow). */
  rect() {
    if (!this.hwnd || this.destroyed) return null;
    const rc = {};
    const hr = Shell_NotifyIconGetRect({ cbSize: koffi.sizeof(NII), hWnd: this.hwnd, uID: 1, guidItem: { a: 0, b: 0, c: 0, d: [0, 0, 0, 0, 0, 0, 0, 0] } }, rc);
    return hr === 0 ? rc : null;
  }

  _fire(name) {
    const fn = this[name];
    if (!fn) return;
    setImmediate(() => { try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch { /* callbacks must not crash the process */ } });
  }

  /** Removes the icon and ends the thread; waits briefly so the icon is gone before the process exits. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this._timer);
    if (this.hwnd) PostMessageW(this.hwnd, WM_APP_DESTROY, 0, 0);
    Atomics.wait(this._shared, 2, 0, 500);
    this.visible = false;
  }
}
