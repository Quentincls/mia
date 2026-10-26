'use strict';
// « Réécrire en anglais » (Prompt block): a text model on this PC turns the typed prompt (often French, with typos)
// into one clear English prompt before any block gets it, through ComfyUI's TextGenerate. Not the LTX Gemma: it wrote
// gibberish at the 25/10 GPU trial. Not Klein's Qwen3 8B: its file has no output layer (lm_head), the part that
// writes. The reader of Qwen-Image 2.1 (Qwen3-VL 8B) keeps it; else the reader of Qwen Image Edit (Qwen2.5-VL 7B). The chat is
// written out in full (system rules, two examples, the request): no built-in template, the same for both. A LoRA's
// trigger word never comes from here: the image block adds it.
const fs = require('node:fs');
const path = require('node:path');
const P = require('../patch');

const E = P.exec;

const READERS = [
  { file: 'qwen3vl_8b_int8_convrot.safetensors', label: 'Qwen3-VL 8B' },
  { file: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', label: 'Qwen2.5-VL 7B' },
];
const MAX_TOKENS = 320;
// sampled, but barely: the same text always gives the same rewrite (fixed seed), without the loops of greedy decoding
const SAMPLING = { temperature: 0.3, top_k: 20, top_p: 0.9, min_p: 0, repetition_penalty: 1.05, seed: 0 };

const SYSTEM = [
  'You rewrite what a person wants to see into one clear English prompt for an image or video model.',
  'The request is often in French and may have spelling mistakes: understand what was meant from the context and fix it'
    + ' (for example « un chato en ruinne » is a ruined castle).',
  'Keep every element the person asked for, with its place, size, number and colour. Do not add characters, animals,'
    + ' objects or actions that were not asked for.',
  'Describe, in this order: the main subject, the setting, the background, then the light and the sky (time of day,'
    + ' weather). Give a style only if the person gave one. Keep any action or movement that was asked for.',
  'End with what must not appear, as short phrases such as "no people" or "no text", only when it keeps the idea clean:'
    + ' "no people" when the request has nobody in it.',
  'Write plain descriptive English: one paragraph of 40 to 90 words. No title, no list, no quotes, no explanation,'
    + ' no question.',
  'If the request is already clear English, keep it almost as it is and only fix the mistakes.',
].join('\n');

const EXAMPLES = [
  ['une vielle femme qui lit dans un jardin en automne, lumiere du soir, style aquarelle',
    'An old woman reading a book on a wooden bench in a garden in autumn, orange and red leaves on the trees and on the'
    + ' grass, a low stone wall and a small house in the background, warm golden evening light with long soft shadows'
    + ' under a clear sky, watercolor painting style.'],
  ['un phare sur une falaise pendant une tempete, les vagues tape fort',
    'A white lighthouse standing on a high rocky cliff above the sea, huge waves crashing hard against the rocks below,'
    + ' the stormy sea stretching to the horizon, dark heavy clouds and driving rain, the lighthouse beam cutting through'
    + ' the gloom, no people.'],
];

const TXT = {
  reading: { fr: 'Réécriture de la consigne…', en: 'Rewriting the prompt…' },
  empty: { fr: 'Écris d’abord la consigne.', en: 'Write the prompt first.' },
  gibberish: {
    fr: 'La réécriture n’a rien donné de lisible. Relance, ou décoche « Réécrire en anglais ».',
    en: 'The rewrite gave nothing readable. Run it again, or untick “Rewrite in English”.',
  },
  done: { fr: 'Consigne réécrite en anglais (par {model}, sur ce PC) : « {text} »', en: 'Prompt rewritten in English (by {model}, on this PC): “{text}”' },
  reader: { fr: 'Lecteur de consignes de Qwen', en: 'Qwen prompt reader' },
};

/** The whole chat, as Qwen models read it (ChatML). */
function chat(request) {
  const turn = (role, text) => `<|im_start|>${role}\n${text}<|im_end|>\n`;
  return turn('system', SYSTEM)
    + EXAMPLES.map(([q, a]) => turn('user', q) + turn('assistant', a)).join('')
    + turn('user', request)
    + '<|im_start|>assistant\n';
}

/** The answer as one plain paragraph: no reasoning, label, quotes, list marks or line breaks. */
function clean(raw) {
  let s = String(raw || '');
  s = s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<\|[^|]*\|>/g, ' ');
  s = s.replace(/^\s*(?:english\s+)?(?:prompt|rewritten prompt|answer|output)\s*:\s*/i, '');
  s = s.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•#>]+|\d+[.)])\s*/, '').trim()).filter(Boolean).join(' ');
  s = s.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
  for (const [a, b] of [['"', '"'], ['“', '”'], ['«', '»'], ["'", "'"]]) {
    if (s.startsWith(a) && s.endsWith(b) && s.length > 2) s = s.slice(a.length, -b.length).trim();
  }
  return s;
}

/** Gibberish (the 25/10 Gemma kind): too few words, mostly not letters, or one word looping. */
function readable(s) {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  const chars = s.replace(/\s/g, '');
  const letters = (chars.match(/[a-zA-ZÀ-ÿ]/g) || []).length;
  if (letters / Math.max(1, chars.length) < 0.75) return false;
  let run = 1;
  for (let i = 1; i < words.length; i++) {
    run = words[i].toLowerCase() === words[i - 1].toLowerCase() ? run + 1 : 1;
    if (run >= 4) return false;
  }
  return true;
}

/**
 * The first reader ComfyUI lists, with the name it lists it under (a subfolder too). When it cannot list, the first
 * one: the validator then names what is missing.
 */
async function readerOf(x) {
  let list = null;
  try { list = await x.comfy.models('text_encoders'); } catch { list = null; }
  if (!Array.isArray(list) || !list.length) return { ...READERS[0], name: READERS[0].file };
  const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase();
  for (const r of READERS) {
    const name = list.find((n) => norm(n) === norm(r.file) || norm(n).endsWith(`/${norm(r.file)}`));
    if (name) return { ...r, name };
  }
  return { ...READERS[0], name: READERS[0].file };
}

async function run(x) {
  E.begin(x);
  const typed = String(x.params.text ?? '').trim();
  if (!typed) throw new Error(E.t(TXT.empty));
  const reader = await readerOf(x);
  x.progress && x.progress(null, E.t(TXT.reading));
  const g = {
    // « stable_diffusion »: ComfyUI's plain Qwen-VL text model, the one TextGenerate writes with (as the PE of the
    // Qwen-Image 2.1 template), not the Qwen-Image 2.1 encoder wrapper
    1: { class_type: 'CLIPLoader', inputs: { clip_name: reader.name, type: 'stable_diffusion', device: 'default' } },
    2: { class_type: 'TextGenerate', inputs: {
      clip: ['1', 0], prompt: chat(typed), max_length: MAX_TOKENS, sampling_mode: 'on',
      'sampling_mode.temperature': SAMPLING.temperature, 'sampling_mode.top_k': SAMPLING.top_k,
      'sampling_mode.top_p': SAMPLING.top_p, 'sampling_mode.min_p': SAMPLING.min_p,
      'sampling_mode.repetition_penalty': SAMPLING.repetition_penalty, 'sampling_mode.seed': SAMPLING.seed,
      'sampling_mode.presence_penalty': 0, thinking: false, use_default_template: false, mtp: 'off',
    } },
    3: { class_type: 'PreviewAny', inputs: { source: ['2', 0] } },
  };
  const res = await E.submit(x, g, { range: [0.05, 0.95] });
  const text = clean(E.enhancedText(res, '3'));
  if (!readable(text)) {
    x.log && x.log(`réécriture illisible : ${JSON.stringify(E.enhancedText(res, '3')).slice(0, 600)}`);
    throw new Error(E.t(TXT.gibberish));
  }
  const file = path.join(x.outDir, 'consigne.txt');
  fs.writeFileSync(file, `${text}\n`, 'utf8');
  return {
    outputs: { text: { abs: file, kind: 'text', meta: { text, original: typed, reader: reader.file } } },
    model: `${E.t(TXT.reader)} (${reader.label})`,
    notes: [E.t(TXT.done, { model: reader.label, text: text.length > 400 ? `${text.slice(0, 400)}…` : text })],
  };
}

/** About half a minute: the reader loads (≈ 9 GB) then writes a hundred words. */
function estimate() {
  return 0.5;
}

module.exports = { run: E.wrap(run), estimate, READERS, _chat: chat, _clean: clean, _readable: readable };
