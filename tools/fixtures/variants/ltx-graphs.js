'use strict';
// Graphes ComfyUI que les executors LTX de Mia ENVERRAIENT (Animer une image, Vidéo depuis un texte, Rendre
// photoréaliste, Vidéo guidée), sans rien exécuter : ni ComfyUI, ni ffmpeg, ni GPU. Les vrais executors tournent ;
// seules les sorties de patch.exec vers le moteur (envoi, téléversement, encodage) sont remplacées le temps de
// l'appel, et le graphe est relevé au moment où il partirait.
// Pour tools/test-engine.js (appariement de l'encodeur de texte, SPEC §7) et la référence graphes-ltx-avant-e3.json.
const path = require('path');
const os = require('os');

const MIA = path.resolve(__dirname, '..', '..', '..');
const ENGINE = path.join(MIA, 'electron', 'engine');
const P = require(path.join(ENGINE, 'patch.js'));
const CAT = require(path.join(MIA, 'src', 'catalog', 'nodes.json'));

const E = P.exec;
const KINDS = ['i2v', 't2v', 'real', 'guided'];
// entrées jamais lues (téléversement et encodage sont remplacés) : seul leur nom de fichier arrive dans le graphe
const VIDEO = { abs: 'faux/plan.mp4', kind: 'video', meta: { w: 1920, h: 1080, fps: 24, frames: 49, duration: 49 / 24, hasAudio: false } };
const INPUTS = {
  i2v: { start: { abs: 'faux/debut.png', kind: 'image', meta: { w: 1920, h: 1080 } } },
  t2v: {},
  real: { video: VIDEO },
  guided: { guide: VIDEO },
};
const EXTRA = { guided: { follow: 'edges' } };       // contours : pas de passe de profondeur à calculer

function defaults(kind) {
  const type = CAT.types.find((t) => t.id === kind);
  const p = {};
  for (const d of type.params || []) if (d.default !== undefined) p[d.id] = JSON.parse(JSON.stringify(d.default));
  return { ...p, prompt: 'un phare sous la pluie', seed: 7, ...(EXTRA[kind] || {}) };
}

/**
 * capture(kind, { model, lang, params }) → { graphs: [graphe envoyé…], notes: texte | undefined, error: message | null }
 * `model` : l'entrée d'inventaire du réglage « model » (ou null : aucun inventaire, les valeurs du gabarit).
 */
async function capture(kind, { model = null, lang = 'fr', params = {} } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`executor inconnu : ${kind}`);
  const exec = require(path.join(ENGINE, 'executors', `${kind}.js`));
  const graphs = [];
  const frames = Array.from({ length: 200 }, (_, i) => ({ abs: `faux/sortie/frame_${String(i + 1).padStart(5, '0')}_.png`,
    filename: `frame_${String(i + 1).padStart(5, '0')}_.png`, subfolder: 'mia/r_banc', type: 'output' }));
  const stubs = {
    submit: async (_x, g) => { graphs.push(JSON.parse(JSON.stringify(g))); return { outputs: {} }; },
    upload: async (_x, abs) => `mia/${path.basename(abs)}`,
    filesOrThrow: async () => frames,
    files: async () => [],
    framesToVideo: async (_x, _f, dst) => dst,
    prepVideo: async (_x, _i, dst) => dst,
    stillTo: async (_x, _s, dst) => dst,
    encode: async () => ({ code: 0 }),
    ffmpeg: async () => ({ code: 0 }),
    cleanup: async () => {},
  };
  const kept = {};
  for (const k of Object.keys(stubs)) { kept[k] = E[k]; E[k] = stubs[k]; }
  const x = {
    lang, mode: 'final', runId: 'r_banc', outDir: path.join(os.tmpdir(), 'mia-banc-graphes-jamais-ecrit'),
    params: { ...defaults(kind), ...params },
    inputs: JSON.parse(JSON.stringify(INPUTS[kind])),
    model: (key) => (key === 'model' ? model : null),
    comfy: {}, ffmpeg: { probe: async () => ({}), run: async () => ({ code: 0 }) },
    progress() {}, log() {}, signal: null,
  };
  try {
    const res = await exec.run(x);
    return { graphs, notes: res && res.notes, error: null };
  } catch (e) {
    return { graphs, notes: undefined, error: String((e && e.message) || e) };
  } finally {
    for (const k of Object.keys(stubs)) E[k] = kept[k];
    E.setLang('fr');
  }
}

module.exports = { capture, KINDS };
