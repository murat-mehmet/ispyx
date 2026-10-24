// Writes the icon the panel page shows (icon.png, 128 px, edge to edge) from the shared app icon.
//   node make-panel-icon.mjs <output.png>
// build.sh runs this into Ispyx.app/Contents/Resources/panel/.
import fs from 'node:fs';
import { encodePng } from '../../src/core/image.js';
import { renderIcon } from '../../src/effects/appicon.js';

const out = process.argv[2];
if (!out) {
  console.error('usage: node make-panel-icon.mjs <output.png>');
  process.exit(2);
}
fs.writeFileSync(out, encodePng(renderIcon(128, { tight: true }), 128, 128));
