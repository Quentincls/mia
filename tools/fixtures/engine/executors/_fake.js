'use strict';
// Faux executors pour tools/test-engine.js : ni GPU ni ComfyUI — seulement des fichiers, des durées, la progression
// et le signal d'annulation. Le comportement de chaque bloc vient de globalThis.__miaTest.cfg[<executor> | <nodeId>] =
//   {delay, fail, partial (écrit d'abord un fichier partiel), lora (appelle x.ensureLora('lora')), py (lance x.py.run)}.
const fs = require('node:fs');
const path = require('node:path');

function firstInputKind(x) {
  for (const v of Object.values(x.inputs || {})) {
    const o = Array.isArray(v) ? v[0] : v;
    if (o && (o.kind === 'image' || o.kind === 'video')) return o.kind;
  }
  return null;
}

module.exports = function fake(name, ports, { estimate } = {}) {
  return {
    async run(x) {
      const T = globalThis.__miaTest || (globalThis.__miaTest = { log: [], cfg: {} });
      const cfg = { ...(T.cfg[name] || {}), ...(T.cfg[x.nodeId] || {}) };
      const rec = { name, nodeId: x.nodeId, runId: x.runId, mode: x.mode, params: x.params, inputs: x.inputs,
        model: x.model('model'), start: Date.now(), end: null, lock: null, engineRoot: x.engineRoot, notes: x.notes,
        hasEnsureLora: typeof x.ensureLora === 'function', outDir: x.outDir };
      if (T.lockPath) {
        const lp = typeof T.lockPath === 'function' ? T.lockPath() : T.lockPath;
        try { rec.lock = JSON.parse(fs.readFileSync(lp, 'utf8')); } catch { rec.lock = null; }
      }
      T.log.push(rec);
      if (cfg.partial) fs.writeFileSync(path.join(x.outDir, 'partiel.mp4'), 'à moitié');
      if (cfg.lora && x.params.lora && x.params.lora !== 'none') rec.lora = await x.ensureLora('lora');
      if (cfg.py) rec.py = await x.py.run('ok', { text: 'py' });
      const steps = 5;
      const delay = cfg.delay ?? 150;
      for (let i = 0; i < steps && !x.signal.aborted; i++) {
        x.progress(i / steps, `étape ${i + 1}/${steps}`);
        await new Promise((r) => {
          const t = setTimeout(r, delay / steps);
          x.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
        });
      }
      rec.end = Date.now();
      if (x.signal.aborted) {
        rec.cancelled = true;
        const e = new Error('Annulé');
        e.name = 'AbortError';
        throw e;
      }
      if (cfg.fail) { x.log('échec simulé'); throw new Error(cfg.fail); }
      const outputs = {};
      for (const p of ports) {
        const kind = p.kind === 'follow' ? (firstInputKind(x) || 'image') : p.kind;
        const abs = path.join(x.outDir, `${p.id}.${kind === 'video' ? 'mp4' : 'png'}`);
        fs.writeFileSync(abs, `${name}:${p.id}:${x.runId}`);
        outputs[p.id] = { abs, kind };
      }
      x.progress(1, 'fini');
      x.log(`${name} ok`);
      return { outputs, notes: cfg.notes };
    },
    estimate: estimate || (() => 1)
  };
};
