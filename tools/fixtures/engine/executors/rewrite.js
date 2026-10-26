'use strict';
// Faux « Réécrire en anglais » pour tools/test-engine.js : « EN: » + la consigne en majuscules, sans GPU ni ComfyUI.
// globalThis.__miaTest.cfg.rewrite = { fail } pour simuler une réécriture illisible.
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  async run(x) {
    const T = globalThis.__miaTest || (globalThis.__miaTest = { log: [], cfg: {} });
    T.log.push({ name: 'rewrite', nodeId: x.nodeId, runId: x.runId, params: x.params, start: Date.now() });
    const cfg = T.cfg.rewrite || {};
    if (cfg.fail) throw new Error(cfg.fail);
    const text = `EN: ${String(x.params.text || '').toUpperCase()}`;
    const abs = path.join(x.outDir, 'consigne.txt');
    fs.writeFileSync(abs, `${text}\n`, 'utf8');
    return { outputs: { text: { abs, kind: 'text', meta: { text } } }, notes: ['réécrite'] };
  },
  estimate: () => 0.5,
};
