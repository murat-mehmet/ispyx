// The "working / stopped / cancelled" banner. Timers and texts are the same as the Windows overlay; the app
// draws it (overlayShow / overlayHide). Calls are fire-and-forget so a banner can never stall a tool.
import { post, callAsync } from './rpc.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAME = 'ispyx';

export class Overlay {
  constructor({ enabled = true, hideAfterMs = 1500, stopLabel = 'Option+Esc' } = {}) {
    this.stopLabel = stopLabel;
    this.enabled = enabled;
    this.hideAfterMs = hideAfterMs;
    this.active = 0;
    this.stopped = false;
    this.visible = false;
    this.text = '';
    this.timer = null;
  }

  _show(text) {
    this.text = text;
    this.visible = true;
    post('overlayShow', { text, kind: this.stopped ? 'stopped' : 'running' });
  }

  _hide() {
    this.visible = false;
    post('overlayHide');
  }

  /** A tool started: show the banner. Call done() when it ends. */
  begin(label) {
    if (!this.enabled) return;
    this.active++;
    clearTimeout(this.timer);
    this._show(`${NAME} is working: ${label}   |   To stop press ${this.stopLabel}`);
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
    this.stopped = true;
    clearTimeout(this.timer);
    this._show(`${NAME} STOPPED (${reason})`);
    this.timer = setTimeout(() => this._hide(), 5000);
    this.timer.unref();
  }

  /** First stop press: the running tool was cancelled; a second press within the window shuts the server down. */
  cancel(reason, windowMs) {
    if (!this.enabled) return;
    this.active = 0;
    clearTimeout(this.timer);
    this._show(`${NAME} CANCELLED (${reason})   |   press again to shut down`);
    this.timer = setTimeout(() => this._hide(), windowMs);
    this.timer.unref();
  }

  /** Hide the banner while the agent takes a screenshot, so it never covers what the agent needs to see. */
  async hiddenDuring(fn) {
    const visible = this.enabled && this.visible;
    if (visible) {
      this._hide();
      try { await callAsync('overlayVisible'); } catch { /* ordering is what matters */ }
      await sleep(60); // let the compositor drop it
    }
    try {
      return await fn();
    } finally {
      if (visible) this._show(this.text);
    }
  }
}
