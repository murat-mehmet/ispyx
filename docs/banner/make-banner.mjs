// Builds docs/banner.png, the README banner, from the real on-screen effects (src/effects/scan.js): the eye sits on
// the top edge of a captured window and its light follows the scan line down, as after a screenshot. The pixels are
// drawn here; the text is set by text.swift with the system font, so this runs on macOS:
//   node docs/banner/make-banner.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../../src/core/image.js';
import { renderEye, pupilPos, drawWedge, renderBand, renderFrame } from '../../src/effects/scan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'banner.png');

const S = 2; // drawn at 2x for sharp text and edges on high-density screens
const W = 1280 * S, H = 320 * S;
const clamp = (v) => Math.min(1, Math.max(0, v));

// straight-alpha float canvas, opaque
const rgb = new Float32Array(W * H * 3);
const put = (x, y, r, g, b, a) => {
  const i = (y * W + x) * 3;
  rgb[i] += (r - rgb[i]) * a; rgb[i + 1] += (g - rgb[i + 1]) * a; rgb[i + 2] += (b - rgb[i + 2]) * a;
};
/** Premultiplied BGRA sprite (as the effects draw them) over the canvas at (ox, oy). */
function blit(px, w, h, ox, oy) {
  for (let y = 0; y < h; y++) {
    const cy = oy + y;
    if (cy < 0 || cy >= H) continue;
    for (let x = 0; x < w; x++) {
      const cx = ox + x;
      if (cx < 0 || cx >= W) continue;
      const j = (y * w + x) * 4, a = px[j + 3] / 255;
      if (a <= 0) continue;
      const i = (cy * W + cx) * 3;
      rgb[i] = px[j + 2] + rgb[i] * (1 - a); rgb[i + 1] = px[j + 1] + rgb[i + 1] * (1 - a); rgb[i + 2] = px[j] + rgb[i + 2] * (1 - a);
    }
  }
}
const rect = (x0, y0, w, h, r, g, b, a, rad = 0) => {
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) {
      const qx = Math.abs(x + 0.5 - (x0 + w / 2)) - (w / 2 - rad), qy = Math.abs(y + 0.5 - (y0 + h / 2)) - (h / 2 - rad);
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
      const k = clamp(0.5 - sd);
      if (k > 0) put(x, y, r, g, b, a * k);
    }
  }
};

// background: the app icon's dark green-black, a soft green light behind the eye, a faint pixel grid
const FX0 = 700 * S, FY0 = 78 * S, FW = 500 * S, FH = 206 * S; // the captured window
const ex = FX0 + FW / 2, glowY = FY0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const t = y / H;
    const g = Math.exp(-(((x - ex) / (520 * S)) ** 2) - (((y - glowY) / (260 * S)) ** 2));
    const grid = (x % (32 * S) === 0 || y % (32 * S) === 0) ? 0.035 : 0;
    const i = (y * W + x) * 3;
    rgb[i] = 12 + 6 * (1 - t) + 18 * g + 60 * grid;
    rgb[i + 1] = 20 + 10 * (1 - t) + 46 * g + 255 * grid;
    rgb[i + 2] = 17 + 7 * (1 - t) + 26 * g + 110 * grid;
  }
}

// the window being captured: title bar with its three dots, a sidebar and some lines of content
rect(FX0, FY0, FW, FH, 30, 38, 35, 1, 12 * S);
rect(FX0, FY0, FW, 30 * S, 40, 50, 46, 1, 12 * S);
rect(FX0, FY0 + 18 * S, FW, 12 * S, 40, 50, 46, 1);
[[255, 95, 87], [254, 188, 46], [40, 200, 64]].forEach(([r, g, b], k) => rect(FX0 + (16 + k * 20) * S, FY0 + 10 * S, 11 * S, 11 * S, r, g, b, 0.9, 5.5 * S));
rect(FX0 + 12 * S, FY0 + 44 * S, 108 * S, FH - 58 * S, 38, 48, 44, 1, 8 * S);
for (let k = 0; k < 5; k++) rect(FX0 + 24 * S, FY0 + (58 + k * 26) * S, (70 - (k % 3) * 14) * S, 9 * S, 70, 86, 80, 1, 4.5 * S);
const rows = [300, 240, 330, 180, 280, 220];
rows.forEach((w, k) => rect(FX0 + 140 * S, FY0 + (52 + k * 24) * S, w * S, 10 * S, 64, 80, 74, 1, 5 * S));

// the scan line, part of the way down the window, with the region above it already lit
const lineY = FY0 + 150 * S;
rect(FX0, FY0 + 30 * S, FW, lineY - FY0 - 30 * S, 60, 255, 110, 0.05);
const bandH = 70 * S;
const band = new Uint8Array(FW * bandH * 4);
renderBand(band, FW, bandH);
blit(band, FW, bandH, FX0, lineY - bandH + 2 * S);

// the green frame around the captured region
const frame = new Uint8Array(FW * FH * 4);
renderFrame(frame, FW, FH);
blit(frame, FW, FH, FX0, FY0);

// the eye on the top edge, looking down at the line, and its light reaching the line
const es = 116 * S, gy = 0.85;
const eox = Math.round(ex - es / 2), eoy = Math.round(FY0 - es / 2);
const p = pupilPos(es, 0, gy);
const wedge = new Uint8Array(W * H * 4);
drawWedge(wedge, W, H, eox + p.x, eoy + p.y, FX0 + 6 * S, FX0 + FW - 6 * S, lineY);
blit(wedge, W, H, 0, 0);
const eye = new Uint8Array(es * es * 4);
renderEye(eye, es, 1, 0, gy, 0.6);
blit(eye, es, es, eox, eoy);

// rounded corners so the banner sits as a card on GitHub's light and dark pages
const R = 18 * S, out = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const qx = Math.abs(x + 0.5 - W / 2) - (W / 2 - R), qy = Math.abs(y + 0.5 - H / 2) - (H / 2 - R);
    const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - R;
    const i = (y * W + x) * 3, o = (y * W + x) * 4;
    out[o] = rgb[i]; out[o + 1] = rgb[i + 1]; out[o + 2] = rgb[i + 2]; out[o + 3] = clamp(0.5 - sd) * 255;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ispyx-banner-'));
const art = path.join(tmp, 'art.png');
fs.writeFileSync(art, encodePng(out, W, H));
execFileSync('swift', [path.join(HERE, 'text.swift'), art, OUT, String(S)], { stdio: 'inherit' });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`written: ${OUT}`);
