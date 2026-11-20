'use strict';
/**
 * Mia — builds the Windows packages, one architecture after the other (npm run dist, dist:zip, dist:dir).
 *
 *   node tools/dist.js [installer|zip|dir] [x64] [arm64]
 *     installer   the installer (NSIS) and the portable zip — the default
 *     zip         the portable zip only
 *     dir         the unpacked folder only (release\win-unpacked, release\win-arm64-unpacked)
 *     x64 arm64   which architectures (default: both, x64 first)
 *
 * Names in release\ : the x64 files keep the names of the earlier versions, the arm64 ones say so —
 *   Mia-<version>-installation.exe          Mia-<version>-portable.zip          (x64: PCs with an Intel or AMD processor)
 *   Mia-<version>-arm64-installation.exe    Mia-<version>-arm64-portable.zip    (arm64: Windows on an ARM processor)
 *
 * One run of electron-builder per architecture: with both in one run, NSIS would make one installer holding both,
 * and the two zips would get the same name. The targets are named here (not taken from package.json → build.win.target,
 * whose arch list would win over the one asked for).
 *
 * Electron comes from electron-builder's own download of the official build of each architecture (checked against
 * Electron's SHASUMS256, kept in %LOCALAPPDATA%\electron\Cache, where `npm install` already put the one of this PC).
 * Never node_modules\electron\dist: that is the Electron of the PC that ran npm install (an arm64 one on an ARM PC),
 * right for one architecture only. The afterPack of tools/check-package.js checks that Mia.exe is of the architecture
 * being built.
 *
 * tools/check-package.js runs before (npm « predist ») and after the packing of each architecture (afterPack).
 */
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const KINDS = { installer: ['nsis', 'zip'], zip: ['zip'], dir: ['dir'] };
const ARCHS = ['x64', 'arm64'];

/** What changes for an architecture, on top of package.json → build (deep-merged by electron-builder). */
function overrides(arch) {
  if (arch === 'x64') return {};
  return {
    win: { artifactName: `Mia-\${version}-${arch}-portable.\${ext}` },
    nsis: { artifactName: `Mia-\${version}-${arch}-installation.\${ext}` }
  };
}

function parseArgs(argv) {
  const kind = argv.find((a) => KINDS[a]) || 'installer';
  const archs = ARCHS.filter((a) => argv.includes(a));
  const unknown = argv.filter((a) => !KINDS[a] && !ARCHS.includes(a));
  if (unknown.length) throw new Error(`dist : argument inconnu « ${unknown.join(' ')} » (installer | zip | dir, x64 | arm64)`);
  return { kind, archs: archs.length ? archs : ARCHS };
}

async function main() {
  const { kind, archs } = parseArgs(process.argv.slice(2));
  const { build, Platform, Arch } = require('electron-builder');
  for (const arch of archs) {
    console.log(`\n=== Mia : paquet Windows ${arch} (${KINDS[kind].join(' + ')}) ===`);
    await build({
      projectDir: ROOT,
      targets: Platform.WINDOWS.createTarget(KINDS[kind], Arch[arch]),
      config: overrides(arch),
      publish: 'never'
    });
  }
}

module.exports = { overrides, parseArgs };

if (require.main === module) {
  main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
}
