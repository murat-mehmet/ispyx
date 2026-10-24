// Builds Ispyx/Resources/Ispyx.icns: the eye of the screenshot animation (renderEye in src/effects/scan.js) on a
// dark rounded square, in every size an .iconset needs. Run with any Node from this folder:
//   node make-icon.mjs        (needs iconutil, which ships with macOS)
// build.sh copies the result into the app; rerun this only when the eye or the background changes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../../src/core/image.js';
import { renderIcon } from '../../src/effects/appicon.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'Ispyx', 'Resources', 'Ispyx.icns');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ispyx-icon-'));
const set = path.join(dir, 'Ispyx.iconset');
fs.mkdirSync(set);
for (const base of [16, 32, 128, 256, 512]) {
  for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
    const s = base * scale;
    fs.writeFileSync(path.join(set, `icon_${base}x${base}${suffix}.png`), encodePng(renderIcon(s), s, s));
  }
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', OUT]);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`written: ${OUT}`);
