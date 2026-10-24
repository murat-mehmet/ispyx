// BGRA pixel buffers -> downscaled PNG. No dependencies beyond node:zlib.
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Area-average downscale of a top-down BGRA buffer to outW x outH, returned as opaque RGBA. */
export function toRgbaScaled(bgra, w, h, outW, outH) {
  const out = Buffer.alloc(outW * outH * 4);
  const xr = w / outW;
  const yr = h / outH;
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor(oy * yr);
    const y1 = Math.max(y0 + 1, Math.min(h, Math.floor((oy + 1) * yr)));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor(ox * xr);
      const x1 = Math.max(x0 + 1, Math.min(w, Math.floor((ox + 1) * xr)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          b += bgra[i]; g += bgra[i + 1]; r += bgra[i + 2]; n++;
        }
      }
      const o = (oy * outW + ox) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Crop a capture to region {x,y,width,height} (window pixels), clamped to its bounds. Returns null if nothing is left. */
export function cropCapture(cap, region) {
  const x0 = Math.max(0, Math.round(region.x));
  const y0 = Math.max(0, Math.round(region.y));
  const x1 = Math.min(cap.width, Math.round(region.x + region.width));
  const y1 = Math.min(cap.height, Math.round(region.y + region.height));
  if (x1 <= x0 || y1 <= y0) return null;
  const w = x1 - x0;
  const h = y1 - y0;
  const bits = Buffer.alloc(w * h * 4);
  // subarray + set: cap.bits may be a plain Uint8Array (macOS), which has no Buffer.copy.
  for (let y = 0; y < h; y++) bits.set(cap.bits.subarray(((y0 + y) * cap.width + x0) * 4, ((y0 + y) * cap.width + x1) * 4), y * w * 4);
  return { ...cap, bits, width: w, height: h, region: { x: x0, y: y0, width: w, height: h } };
}

/** Capture result -> { png, width, height, scale } where scale = output pixels per screen pixel. */
export function shrinkToPng(cap, maxWidth) {
  const outW = Math.max(1, Math.min(cap.width, Math.floor(maxWidth)));
  const scale = outW / cap.width;
  const outH = Math.max(1, Math.round(cap.height * scale));
  const rgba = toRgbaScaled(cap.bits, cap.width, cap.height, outW, outH);
  return { png: encodePng(rgba, outW, outH), width: outW, height: outH, scale, rgba };
}

/** Minimal decoder for PNGs written by encodePng (filter 0, RGBA 8-bit). Used by tests. */
export function decodePng(png) {
  let p = 8, w = 0, h = 0;
  const idat = [];
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    const type = png.toString('ascii', p + 4, p + 8);
    const data = png.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) raw.copy(rgba, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
  return { width: w, height: h, rgba };
}
