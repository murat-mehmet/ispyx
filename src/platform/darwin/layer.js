// Effect windows and text masks on macOS. The app owns the window; the pixels live in a file that both
// processes map into memory, so no pixel data crosses the socket (PROTOCOL.md, "Layers").
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { callSync, post } from './rpc.js';

const PROT_READ = 1, PROT_WRITE = 2, MAP_SHARED = 1, O_RDWR = 2;

let libc = null;
const require = createRequire(import.meta.url);
/** koffi and libSystem load on first use (Layer's constructor is synchronous), so importing this works on every OS. */
function libcSync() {
  if (libc) return libc;
  const koffi = require('koffi');
  const lib = koffi.load('/usr/lib/libSystem.B.dylib');
  libc = {
    koffi,
    open: lib.func('int open(const char *path, int flags)'),
    close: lib.func('int close(int fd)'),
    mmap: lib.func('void *mmap(void *addr, size_t len, int prot, int flags, int fd, int64_t off)'),
    munmap: lib.func('int munmap(void *addr, size_t len)'),
  };
  return libc;
}

export class Layer {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.shown = false;
    this.id = 0;
    this.map = null;
    const len = width * height * 4;
    const r = callSync('layerCreate', { width, height });
    this.id = r.layer;
    try {
      const c = libcSync();
      const fd = c.open(r.file, O_RDWR);
      if (fd < 0) throw new Error(`cannot open ${r.file}`);
      let ptr;
      try {
        ptr = c.mmap(null, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
      } finally {
        c.close(fd); // the mapping stays valid after close
      }
      if (!ptr) throw new Error(`mmap of ${r.file} failed`);
      this.map = ptr;
      this.px = new Uint8Array(c.koffi.view(ptr, len));
    } catch (e) {
      post('layerDestroy', { layer: this.id });
      throw new Error(`Could not map the effect window buffer: ${e.message}`);
    }
  }

  /** Shows the top-left `width` x `height` part of the buffer, starting at row srcY, at (x, y) with opacity `alpha` (0-255). */
  present(x, y, alpha, height = this.height, width = this.width, srcY = 0) {
    post('layerPresent', {
      layer: this.id,
      x: Math.round(x),
      y: Math.round(y),
      alpha: Math.max(0, Math.min(255, Math.round(alpha))),
      height: Math.max(1, Math.min(this.height, Math.round(height))),
      width: Math.max(1, Math.min(this.width, Math.round(width))),
      srcY: Math.max(0, Math.round(srcY)),
    });
    this.shown = true;
  }

  destroy() {
    if (!this.id) return;
    try { post('layerDestroy', { layer: this.id }); } catch { /* app gone */ }
    this.id = 0;
    if (this.map) {
      try { libc.munmap(this.map, this.width * this.height * 4); } catch { /* already unmapped */ }
      this.map = null;
    }
    this.px = new Uint8Array(0);
  }
}

/** Anti-aliased text coverage (0-255 per pixel) in the system UI font, rendered by the app. */
export function textMask(text, heightPx = 22, weight = 600) {
  const r = callSync('textMask', { text, heightPx, weight });
  const data = fs.readFileSync(r.file);
  if (data.length < r.width * r.height) throw new Error(`textMask file is too short (${data.length} bytes for ${r.width}x${r.height}).`);
  return { width: r.width, height: r.height, mask: new Uint8Array(data.buffer, data.byteOffset, r.width * r.height) };
}
