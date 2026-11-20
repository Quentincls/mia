'use strict';
/**
 * Mia — training tool descriptor: the fake tool (tools\fixtures\train\fake-trainer.js), see electron\train\common.js.
 *
 * No Python, no GPU: a Node script started with Mia's own binary (ELECTRON_RUN_AS_NODE=1). It speaks the protocol
 * of the training folder exactly, so the whole service and the whole screen are tested without a graphics card.
 * It only exists when MIA_TRAIN_FAKE=1 (test instances and benches): a real Mia never lists it.
 * Same checkpoint layout as LTX, so the same resume rules are exercised.
 */
const fs = require('node:fs');
const path = require('node:path');
const C = require('./common');

const script = (root) => path.join(root, 'tools', 'fixtures', 'train', 'fake-trainer.js');
const enabled = () => process.env.MIA_TRAIN_FAKE === '1';

function detect({ root }) {
  const s = script(root);
  if (!enabled() || !fs.existsSync(s)) return { ok: false, version: null, python: null, why: { code: 'tool', path: s } };
  return { ok: true, version: '1.0.0', python: null, why: null };
}

function command({ dir, run, token, resumeFrom, root }) {
  return {
    exe: process.execPath,
    args: [script(root), ...C.adapterArgs({ dir, run, token, resumeFrom })],
    cwd: dir,
    env: { ELECTRON_RUN_AS_NODE: '1' }
  };
}

/** The base that goes with it: tiny numbers, so a whole training lasts seconds. */
const BASE = {
  id: 'fake',
  label: { fr: 'Faux modèle (test)', en: 'Fake model (test)' },
  media: 'image',
  tool: 'fake',
  toolVersion: '1.0.0',
  suffix: 'fake',
  enabled: true,
  tried: true,
  weights: [],
  arch: null,
  name_or_path: null,
  minSide: 64,
  needCommitGB: 0,
  defaults: { rank: 32, lr: 0.0001, batch: 1, optimizer: 'adamw', resolutions: [64], saveEvery: 250, sampleEvery: 500 },
  lengths: { short: 1500, normal: 2500, long: 3000 },
  sample: { kind: 'image' },
  measured: { sPerStep: 0.05, sampleSec: 0.2, loadSec: 0.1, encodeSecPerImage: 0.01, peakVramGB: 0, checkpointMB: 0.001 },
  disk: { cacheMBPerImage: 0, reserveGB: 0 }
};

module.exports = {
  id: 'fake',
  label: 'faux outil',
  gpu: false,
  enabled,
  BASE,
  detect,
  command,
  checkpoints: C.ltxCheckpoints,
  verify: C.ltxVerify,
  cleanTmp: C.ltxCleanTmp
};
