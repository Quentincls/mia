'use strict';
/**
 * Renders the README banner from its HTML source, in a hidden window, at device scale 2.
 *
 *   node_modules/electron/dist/electron.exe assets/src/render-banner.js assets/src/banner.html assets/banner.png
 *   node_modules/electron/dist/electron.exe assets/src/render-banner.js assets/src/banner.fr.html assets/banner.fr.png
 *
 * The page is laid out at 1920×480 design pixels with `html { zoom: .5 }`, so one design pixel is one
 * output pixel. Fonts: Segoe UI Variable and Cascadia Mono (shipped with Windows 11). Nothing is shown
 * on screen and the scratch profile goes to the system temp folder.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(1).filter((a) => !a.startsWith('--') && a !== __filename);
const page = path.resolve(args.find((a) => a.endsWith('.html')) || path.join(__dirname, 'banner.html'));
const out = path.resolve(args.find((a) => a.endsWith('.png')) || path.join(__dirname, '..', 'banner.png'));
const W = 1920;
const H = 480;

app.commandLine.appendSwitch('force-device-scale-factor', '2');
app.setPath('userData', path.join(os.tmpdir(), 'mia-render-banner'));
setTimeout(() => { console.error('render-banner: timed out'); app.exit(2); }, 30000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: W / 2, height: H / 2, useContentSize: true, frame: false,
    paintWhenInitiallyHidden: true, backgroundColor: '#000000',
    webPreferences: { backgroundThrottling: false }
  });
  await win.loadFile(page);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('saved', out, img.getSize());
  app.quit();
});
