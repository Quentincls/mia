'use strict';
/**
 * Mia — builds the application icons from the vector source.
 *
 *   node_modules\electron\dist\electron.exe tools\make-icons.js [--png-dir <folder>]
 *
 * Renders assets\src\app-icon.svg (the white tile with the M cut out of it) at every size Windows
 * asks for — 16, 20, 24, 32, 40, 48 (100 to 150 % scaling), 64, 128, 256 — with Chromium itself, in a
 * hidden window and software rendering only (no GPU). Each size is rasterised from the vector, not
 * downscaled from 256, so the small ones stay crisp. Then packs them into a PNG-compressed .ico.
 *
 * Writes src\assets\mia.ico, src\assets\mia-app.ico (an identical copy under another name: Explorer
 * caches icons by path, a new name sidesteps a stale cache — Slate's trick) and src\assets\icon.png
 * (256 px). With --png-dir, every size is also written there as a PNG, to inspect.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'assets', 'src', 'app-icon.svg');
const ASSETS = path.join(ROOT, 'src', 'assets');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// a build tool must leave no trace in %APPDATA%\Electron and never touch the GPU
app.setPath('userData', path.join(os.tmpdir(), 'mia-make-icons'));
app.disableHardwareAcceleration();

const argDir = (() => {
  const i = process.argv.indexOf('--png-dir');
  return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : null;
})();

/** ICO container with PNG entries (Windows Vista+ reads PNG at every size). */
function packIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);       // 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);                        // no palette
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);                     // planes
    dir.writeUInt16LE(32, o + 6);                    // bits per pixel
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/** Runs in the hidden page: SVG → PNG data URL at each size. */
const RENDER = `async (svg, sizes) => {
  const out = {};
  for (const size of sizes) {
    const sized = svg.replace('<svg ', '<svg width="' + size + '" height="' + size + '" ');
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(sized)));
    await img.decode();
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    g.clearRect(0, 0, size, size);
    g.drawImage(img, 0, 0, size, size);
    out[size] = c.toDataURL('image/png');
  }
  return out;
}`;

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SOURCE, 'utf8').replace(/<title>[\s\S]*?<\/title>/, '');
  const win = new BrowserWindow({ show: false, width: 300, height: 300, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('data:text/html;charset=utf-8,<!doctype html><meta charset="utf-8"><body></body>');
  const urls = await win.webContents.executeJavaScript(`(${RENDER})(${JSON.stringify(svg)}, ${JSON.stringify(SIZES)})`);
  const entries = SIZES.map((size) => ({ size, png: Buffer.from(urls[size].split(',')[1], 'base64') }));

  fs.mkdirSync(ASSETS, { recursive: true });
  const ico = packIco(entries);
  fs.writeFileSync(path.join(ASSETS, 'mia.ico'), ico);
  fs.writeFileSync(path.join(ASSETS, 'mia-app.ico'), ico);
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), entries[entries.length - 1].png);
  if (argDir) {
    fs.mkdirSync(argDir, { recursive: true });
    for (const e of entries) fs.writeFileSync(path.join(argDir, `mia-${e.size}.png`), e.png);
  }
  console.log(`mia.ico: ${entries.length} sizes (${SIZES.join(', ')}), ${ico.length} bytes`);
  app.exit(0);
}).catch((e) => {
  console.error('make-icons failed:', e);
  app.exit(1);
});
