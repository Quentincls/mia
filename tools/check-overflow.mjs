// Contrôle « rien ne déborde » (demande de Quentin, 17/10/2026 : dans le bloc Assembler, « Passage au
// noir » sortait de la carte). Dans une Mia de test pilotable par CDP, l'outil pose lui-même ce qu'il faut
// regarder, puis mesure dans la page chaque élément visible, en français puis en anglais :
//   a) déborde    : une boîte visible (fond, filet, ombre, image, champ) ou un texte sort de son conteneur
//                   visuel (carte de bloc, menu, panneau, dialogue, carte de l'accueil, onglet, barre)
//                   de plus de 0,5 px ;
//   b) coupé      : un texte ou une boîte rogné par un overflow hidden/clip sans ellipse (y compris une
//                   ligne coupée par une hauteur), un texte indicatif plus large que son champ ;
//   c) ellipse    : un texte tronqué par « … » (ou un line-clamp) dont moins de 70 % reste visible, ou
//                   dont il reste moins de 8 caractères ;
//   d) hors écran : un menu, une info-bulle, une liste, une bulle qui sort de la fenêtre ;
//   e) chevauche  : deux contrôles frères d'une même rangée (flex ou grille) qui se recouvrent.
//   f) disposition gardée : après un aller-retour de largeur à la poignée (216 px puis la largeur d'origine), une
//                   rangée de réglages qui n'a plus la disposition d'avant (pile, interrupteur au bout du bloc).
// Pour chaque défaut : sélecteur lisible, texte, mesures, et une capture recadrée (contour rouge sur
// l'élément, pointillés sur son conteneur) dans --out.
//
//   node tools/check-overflow.mjs <port CDP> [--surface blocks|home|board|all] [--out <dossier>] [--json]
//                                 [--lang fr,en] [--image <fichier>] [--video <fichier>] [--no-shots] [--vues]
//
//   --surface blocks : la planche de banc « Banc de contrôle · débordements », fabriquée par l'outil : un
//             bloc de chaque type du catalogue, seul puis branché (image paysage, vidéo portrait,
//             consigne), titre long, « Avancé » ouvert ; chaque valeur des réglages qui en montrent
//             d'autres (showIf) et de chaque liste ; les états repos, en file, GPU occupé, en cours,
//             fait, périmé, erreur au message long, simulés par des évènements du moteur sur le bus
//             (rien n'est calculé) ; les listes déroulantes ouvertes près du coin de la fenêtre ;
//             l'info-bulle d'une erreur au bord de l'écran.
//   --surface home : l'accueil (projets et planches aux noms longs, recettes, modèles, recherche sans
//             résultat puis pleine, menu de tri, menus des cartes, intérieur d'un projet, nouveautés,
//             bibliothèque des modèles).
//   --surface board : 8 onglets longs groupés par projet (puis un groupe replié), la planche (dock,
//             zoom, mini-carte), la palette (ouverte, recherche vide puis pleine), les menus
//             contextuels (planche et son sous-menu, bloc, fil, section et son sous-menu), l'inspecteur
//             de chaque type, la file de calcul ouverte, la puce GPU, une info-bulle au bord.
//             home et board sont mesurés à 1440 × 900 et à la taille minimale de la fenêtre (900 × 600).
//   --out    : dossier des captures et du rapport JSON (un sous-dossier daté par passage) ; par défaut
//              _dev/check-overflow du dépôt.
//   --json   : le rapport complet en JSON sur la sortie standard (le déroulé passe sur stderr).
//   --video  : une vidéo verticale pour les blocs Média ; sans lui, une vidéo de 2 s est fabriquée avec
//              le ffmpeg de Mia (processeur, quelques dixièmes de seconde) dans --out.
//   --image  : l'image paysage des blocs Média (par défaut assets/looks.jpg du dépôt).
//   --vues   : garde aussi la fenêtre entière de chaque état mesuré de l'accueil et de la planche (vues/).
//   --no-shots : sans captures (plus rapide).
//
// À lancer UNIQUEMENT sur une Mia de test (l'outil crée des projets et des planches) :
//   set MIA_HEADLESS=1 & set MIA_NO_GPU=1 & set MIA_USERDATA=<dossier> & set MIA_PROJECTS_ROOT=<dossier>
//   node_modules\electron\dist\electron.exe . --remote-debugging-port=<port>
// L'outil refuse une Mia dont les données sont celles par défaut (%APPDATA%\Mia). Une Mia cachée ne peint
// pas : comme check-wires.mjs, l'outil y démarre un screencast acquitté. La langue est basculée par le
// chemin de l'app (i18n.setLang : préférence puis rechargement de la fenêtre) et remise comme avant.
// Les ports, les poignées de largeur et les pastilles du mode replié sont posés à cheval sur le bord de
// la carte (graph.css) : jamais signalés. Code de sortie : 0 rien à signaler, 1 des défauts, 2 l'outil
// n'a pas pu mesurer.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const has = (name) => args.includes(name);
const port = Number(args.find((a) => /^\d+$/.test(a)));
const SURFACE = opt('--surface', 'all');
if (!Number.isInteger(port) || port <= 0 || !['blocks', 'home', 'board', 'all'].includes(SURFACE)) {
  console.error('usage : node tools/check-overflow.mjs <port CDP> [--surface blocks|home|board|all] [--out <dossier>] [--json]');
  process.exit(2);
}
const SURFACES = SURFACE === 'all' ? ['blocks', 'home', 'board'] : [SURFACE];
const LANGS = [...new Set(opt('--lang', 'fr,en').split(',').map((s) => s.trim()).filter((l) => l === 'fr' || l === 'en'))];
const JSON_OUT = has('--json');
const SHOTS = !has('--no-shots');
const VIEWS = has('--vues');
const pad2 = (n) => String(n).padStart(2, '0');
const now = new Date();
const STAMP = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
const OUT = path.join(path.resolve(opt('--out', path.join(ROOT, '_dev', 'check-overflow'))), STAMP);
const IMAGE = path.resolve(opt('--image', path.join(ROOT, 'assets', 'looks.jpg')));
let VIDEO = opt('--video', null);
const log = (...a) => (JSON_OUT ? console.error : console.log)(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tailles mesurées : les blocs sont dans le monde de la planche (zoom 1, une fenêtre haute pour les
// grandes cartes) ; l'accueil et la planche à une taille courante et à la plus petite fenêtre de Mia.
const BLOCK_VIEW = [1600, 1200];
const PAGE_VIEWS = [[1440, 900], [900, 600]];

// Contenus longs : des contenus d'utilisateur, donc en français dans les deux langues de l'interface
const TXT = {
  bench: 'Banc de contrôle · débordements',
  title: 'Plan 12 — la salle de cinéma au crépuscule',
  prompt: 'Plan large d’une salle de cinéma au crépuscule, les fauteuils rouges vides, la lumière du projecteur traverse la poussière en suspension, la caméra avance lentement vers l’écran ; ambiance chaude, grain de pellicule, 35 mm, profondeur de champ courte, reflets dorés sur les rangées du balcon.',
  negative: 'texte, filigrane, coupes, visages déformés, mains en trop, image floue, compression visible',
  err: 'ComfyUI a refusé le graphe : le nœud « WanVideoSampler » attend le modèle « wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors », introuvable dans le dossier models\\diffusion_models du moteur. Vérifie le dossier des modèles dans Réglages → Moteur, puis relance le calcul.',
  runMsg: 'Échantillonnage 14/30 · passe haute du débruitage',
  who: 'Claude · Plan 12 — la salle de cinéma au crépuscule',
  section: 'Sources — images et vidéos de référence de toute la séquence du crépuscule',
  folders: [
    { name: 'Court métrage — le film de fin d’études tourné au crépuscule', color: 'teal',
      boards: ['Plan 12 — la salle de cinéma au crépuscule, version longue', 'Plan 13 — le hall de gare sous une pluie battante', 'Plan 14 — l’héroïne dans le wagon qui traverse la ville'] },
    { name: 'Publicité · campagne d’automne pour les réseaux sociaux et l’affichage', color: 'orange',
      boards: ['Spot 30 s — montage final avec le logo animé', 'Déclinaison verticale 9:16 pour les stories'] },
  ],
  loose: ['Essai de lumière très long pour voir comment la carte de l’accueil se comporte', 'Tests'],
};

// ── CDP ───────────────────────────────────────────────────────────────
let list;
try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch {
  console.error(`Aucune Mia pilotable sur le port ${port} (--remote-debugging-port).`);
  process.exit(2);
}
const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || list.find((t) => t.type === 'page');
if (!target) { console.error('Aucune page Mia sur ce port.'); process.exit(2); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 0;
const pend = new Map();
const pageErrors = [];
let casting = false;
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  // screencast : chaque image acquittée, sinon Chromium cesse d'en envoyer (et de peindre)
  else if (d.method === 'Page.screencastFrame') ws.send(JSON.stringify({ id: ++msgId, method: 'Page.screencastFrameAck', params: { sessionId: d.params.sessionId } }));
  else if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') pageErrors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
};
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('connexion CDP refusée')); });
const send = (method, params = {}, ms = 60000) => new Promise((resolve, reject) => {
  const i = ++msgId;
  const t = setTimeout(() => { pend.delete(i); reject(new Error(`CDP : pas de réponse à ${method}`)); }, ms);
  pend.set(i, (d) => { clearTimeout(t); resolve(d); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
async function ev(expr, ms = 90000) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
  if (r.error) throw new Error(r.error.message);
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || 'évaluation');
  return r.result?.result?.value;
}
const J = (v) => JSON.stringify(v);
await send('Runtime.enable');
await send('Page.enable');

async function screencast(on) {
  if (casting) { try { await send('Page.stopScreencast', {}, 3000); } catch { /* page partie */ } casting = false; }
  if (on) { await send('Page.startScreencast', { format: 'jpeg', quality: 5, maxWidth: 200, everyNthFrame: 1 }); casting = true; }
}
/** Deux images (s'il en vient) puis un temps de pose. */
const settle = (ms = 200) => ev(`new Promise((r) => { let n = 0; const t = setTimeout(r, 500); const f = () => { if (++n >= 2) { clearTimeout(t); r(1); } else requestAnimationFrame(f); }; requestAnimationFrame(f); })`).then(() => sleep(ms));

async function setViewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await settle(350);
}
const mouse = (type, x, y, button = 'none', buttons = 0) => send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1 }, 5000);
async function rightClick(x, y) {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, 'right', 2);
  await mouse('mouseReleased', x, y, 'right', 0);
}
async function click(x, y) {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, 'left', 1);
  await mouse('mouseReleased', x, y, 'left', 0);
}
async function key(k) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 }, 5000);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 }, 5000);
}

// ── le détecteur et les aides, installés dans la page (window.__mcf) ──────
// Écrit sans « ` » ni « ${ » : c'est une chaîne (String.raw) évaluée telle quelle par la page.
const PAGE = String.raw`(() => {
// (réinstallé à chaque passage : une version plus ancienne de l'outil a pu rester dans la page)
const TOL = 0.5;
// Posés volontairement à cheval sur le bord de leur carte (graph.css), jamais signalés :
//   .n-port .dot  pastille de port, 10 px posée à -6 px du bord ;
//   .n-cdot       pastilles du mode replié, idem ;
//   .n-resize     poignée de largeur, 12 px au coin bas-droit, à -3 px (invisible).
const STRADDLE = '.n-port .dot, .n-cdot, .n-resize';
const MARK = 'mcf-mark';
let memo = new WeakMap(), opMemo = new WeakMap();
const cs = (el) => { let s = memo.get(el); if (!s) { s = getComputedStyle(el); memo.set(el, s); } return s; };
const px = (v) => parseFloat(v) || 0;
const r1 = (v) => Math.round(v * 10) / 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (n) => new Promise((r) => { let k = 0; const t = setTimeout(r, 500); const f = () => { if (++k >= (n || 2)) { clearTimeout(t); r(); } else requestAnimationFrame(f); }; requestAnimationFrame(f); });
const mod = (p) => import(new URL(p, location.href).href);

function alpha(c) {
  if (!c || c === 'none' || c === 'transparent') return 0;
  let m = /rgba?\(([^)]*)\)/.exec(c);
  if (m) { const p = m[1].split(/[\s,\/]+/).filter(Boolean); return p.length >= 4 ? parseFloat(p[3]) * (p[3].indexOf('%') >= 0 ? 0.01 : 1) : 1; }
  m = /\/\s*([\d.]+%?)\s*\)/.exec(c);
  if (m) return parseFloat(m[1]) * (m[1].indexOf('%') >= 0 ? 0.01 : 1);
  return 1;
}
const REPLACED = /^(IMG|VIDEO|CANVAS|IFRAME|INPUT|TEXTAREA|SELECT)$/;
/** L'élément dessine-t-il une boîte visible (fond, filet, ombre, média, champ) ? */
function drawsBox(el) {
  if (el instanceof SVGElement) return el.tagName.toLowerCase() === 'svg';
  if (REPLACED.test(el.tagName)) return true;
  const s = cs(el);
  if (alpha(s.backgroundColor) > 0.02 || s.backgroundImage !== 'none') return true;
  for (const k of ['Top', 'Right', 'Bottom', 'Left']) {
    const st = s['border' + k + 'Style'];
    if (px(s['border' + k + 'Width']) > 0 && st !== 'none' && st !== 'hidden' && alpha(s['border' + k + 'Color']) > 0.02) return true;
  }
  return !!s.boxShadow && s.boxShadow !== 'none' && alpha(s.boxShadow) > 0.02;
}
/** Un voile ou un décor marqué aria-hidden, sans texte ni pointeur : pas un contenu. */
const decorative = (el) => el.getAttribute('aria-hidden') === 'true' && cs(el).pointerEvents === 'none' && !el.textContent.trim();
function opacityOf(el) {
  if (!el || el === document.documentElement) return 1;
  let v = opMemo.get(el);
  if (v === undefined) { v = parseFloat(cs(el).opacity) * opacityOf(el.parentElement); opMemo.set(el, v); }
  return v;
}
function visible(el) {
  if (!el || !el.getClientRects().length) return false;
  if (cs(el).visibility !== 'visible') return false;
  return opacityOf(el) >= 0.05;
}
const box = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
const rectJSON = (r) => ({ x: r1(r.left), y: r1(r.top), w: r1(r.right - r.left), h: r1(r.bottom - r.top) });
function union(list) {
  let R = null;
  for (const b of list) R = R ? { left: Math.min(R.left, b.left), top: Math.min(R.top, b.top), right: Math.max(R.right, b.right), bottom: Math.max(R.bottom, b.bottom) } : box(b);
  return R;
}
function padBox(a) {
  const r = a.getBoundingClientRect(), s = cs(a);
  return { left: r.left + px(s.borderLeftWidth), top: r.top + px(s.borderTopWidth), right: r.right - px(s.borderRightWidth), bottom: r.bottom - px(s.borderBottomWidth) };
}
function contentBox(a) {
  const p = padBox(a), s = cs(a);
  return { left: p.left + px(s.paddingLeft), top: p.top + px(s.paddingTop), right: p.right - px(s.paddingRight), bottom: p.bottom - px(s.paddingBottom) };
}
const clipsX = (s) => s.overflowX === 'hidden' || s.overflowX === 'clip';
const clipsY = (s) => s.overflowY === 'hidden' || s.overflowY === 'clip';
const lineClamp = (s) => { const v = s.getPropertyValue('-webkit-line-clamp'); return v && v !== 'none' ? v : null; };
/** Un texte occupe sa boîte de caractères à l'horizontale, et sa hauteur de police (pas les jambages du fichier de police) à la verticale. */
function textBox(b, el) {
  const fs = px(cs(el).fontSize) || b.height, c = (b.top + b.bottom) / 2, h = Math.min(b.height, fs);
  return { left: b.left, right: b.right, top: c - h / 2, bottom: c + h / 2 };
}
/** Le plus proche ancêtre qui dessine une boîte d'au moins 14 px (le conteneur visuel). */
function containerOf(el, root, inclusive) {
  for (let a = inclusive ? el : el.parentElement; a; a = a.parentElement) {
    if (a === document.body || a === document.documentElement) return null;
    if (!(a instanceof SVGElement) && drawsBox(a)) { const r = a.getBoundingClientRect(); if (r.width >= 14 && r.height >= 14) return a; }
    if (a === root) return null;
  }
  return null;
}
/**
 * Rogne R par les ancêtres overflow hidden/clip de start (inclus) à stop (inclus). Un ancêtre qui défile
 * (auto/scroll) ne rogne pas : le contenu s'atteint en défilant ; sur cet axe, ce qui dépasse plus haut
 * (le défileur lui-même, ou un ancêtre qui le contient) n'est ni coupé ni débordant. Rend { R, sx, sy }
 * (sx/sy : un défilement a été traversé sur cet axe), ou null si plus rien n'est visible.
 */
function clipWalk(start, stop, R, onCut) {
  let sx = false, sy = false;
  for (let a = start; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
    const s = cs(a), hx = clipsX(s) && !sx, hy = clipsY(s) && !sy;
    if (hx || hy) {
      const p = padBox(a);
      const cut = { l: hx ? p.left - R.left : 0, r: hx ? R.right - p.right : 0, t: hy ? p.top - R.top : 0, b: hy ? R.bottom - p.bottom : 0 };
      if (onCut && Math.max(cut.l, cut.r, cut.t, cut.b) > 1) onCut(a, cut, s);
      R = { left: hx ? Math.max(R.left, p.left) : R.left, right: hx ? Math.min(R.right, p.right) : R.right, top: hy ? Math.max(R.top, p.top) : R.top, bottom: hy ? Math.min(R.bottom, p.bottom) : R.bottom };
      if (R.right - R.left < 0.5 || R.bottom - R.top < 0.5) return null;
    }
    if (/auto|scroll/.test(s.overflowX)) sx = true;
    if (/auto|scroll/.test(s.overflowY)) sy = true;
    if (a === stop) break;
  }
  return { R, sx, sy };
}
/** Un ancêtre (sous body) rogne-t-il ou fait-il défiler ? Sinon seule la fenêtre borne l'élément. */
function inClip(el) {
  for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
    const s = cs(a);
    if (s.overflowX !== 'visible' || s.overflowY !== 'visible') return true;
  }
  return false;
}
const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim());
const clean = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > (n || 90) ? s.slice(0, (n || 90) - 1) + '…' : s; };
/** Le texte d'un élément ; deux morceaux de deux éléments voisins (les options d'un choix) séparés par « · ». */
function textOf(el) {
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return clean(el.value || el.placeholder);
  let s = '', prev = null;
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    const t = n.data.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const p = n.parentElement;
    if (s) s += prev && p !== prev && !prev.contains(p) && !p.contains(prev) ? ' · ' : ' ';
    s += t;
    prev = p;
  }
  return clean(s);
}
const SKIPCLS = /^(on|open|sel|active|hot|is-|has-|lod-|entering|leaving|off|q-open|q-enter|pal-in|no-anim|in$|now$|drop-on|dragging|folding|lifted|landing|f-status|grouped|saved|flash|empty$)/;
function labelOf(el) {
  if (el.id) return '#' + el.id;
  const cls = [...el.classList].filter((c) => !SKIPCLS.test(c)).slice(0, 2);
  let s = cls.length ? '.' + cls.join('.') : el.tagName.toLowerCase();
  for (const a of ['data-param', 'data-port', 'data-dir', 'data-tab', 'data-step']) if (el.hasAttribute(a)) { s += '[' + a + '=' + el.getAttribute(a) + ']'; break; }
  return s;
}
function selOf(el, root) {
  const parts = [];
  for (let n = el; n && n !== root && n !== document.body; n = n.parentElement) { parts.unshift(labelOf(n)); if (n.id) break; }
  if (!parts.length) parts.push(labelOf(el));
  return (parts.length > 5 ? '… › ' : '') + parts.slice(-5).join(' › ');
}
function pathOf(el, root) {
  const p = [];
  for (let n = el; n && n !== root; n = n.parentElement) { if (!n.parentElement) return null; p.unshift([...n.parentElement.children].indexOf(n)); }
  return p;
}
const canvas = document.createElement('canvas'), g2 = canvas.getContext('2d');
function textWidth(text, s) {
  g2.font = [s.fontStyle, s.fontWeight, s.fontSize, s.fontFamily].join(' ');
  try { g2.letterSpacing = s.letterSpacing === 'normal' ? '0px' : s.letterSpacing; } catch (e) { /* ancien Chromium */ }
  const t = s.textTransform === 'uppercase' ? text.toUpperCase() : s.textTransform === 'lowercase' ? text.toLowerCase() : text;
  return g2.measureText(t).width;
}
/** Boîtes des caractères visibles (espaces exclus) d'un élément. */
function charRects(el) {
  const out = [], rg = document.createRange();
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    const p = n.parentElement;
    if (!p || !visible(p)) continue;
    const s = n.data;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c <= 32 || c === 160 || c === 8239 || c === 8201 || (c >= 0xDC00 && c <= 0xDFFF)) continue;
      rg.setStart(n, i); rg.setEnd(n, c >= 0xD800 && c <= 0xDBFF ? i + 2 : i + 1);
      const b = rg.getBoundingClientRect();
      if (b.width || b.height) out.push(b);
    }
  }
  return out;
}
function negMargins(el) {
  const s = cs(el), n = (v) => Math.max(0, -px(v));
  return { x: n(s.marginLeft) + n(s.marginRight), y: n(s.marginTop) + n(s.marginBottom) };
}
/** La part d'un rectangle que laissent voir les ancêtres de from (inclus) jusqu'à stop (inclus) : tout overflow non visible rogne. */
function seen(from, stop, R) {
  for (let a = from; a; a = a.parentElement) {
    const s = cs(a), hx = s.overflowX !== 'visible', hy = s.overflowY !== 'visible';
    if (hx || hy) {
      const p = padBox(a);
      R = { left: hx ? Math.max(R.left, p.left) : R.left, right: hx ? Math.min(R.right, p.right) : R.right, top: hy ? Math.max(R.top, p.top) : R.top, bottom: hy ? Math.min(R.bottom, p.bottom) : R.bottom };
      if (R.right - R.left < 0.5 || R.bottom - R.top < 0.5) return null;
    }
    if (a === stop) break;
  }
  return R;
}
/** Ce qu'un enfant de rangée occupe à l'écran : sa boîte, plus ce qui en dépasse et reste visible (texte, boîtes). */
function inkRect(k) {
  const s = cs(k);
  if (s.display === 'inline' || s.display === 'contents') {
    const rs = [...k.getClientRects()].filter((b) => b.width > 0.5 && b.height > 0.5);
    return rs.length ? union(rs) : null;
  }
  let R = box(k.getBoundingClientRect());
  const spills = s.overflowX === 'visible' && s.overflowY === 'visible' && (k.scrollWidth > k.clientWidth + 1 || k.scrollHeight > k.clientHeight + 1);
  if (spills) {
    for (const d of k.querySelectorAll('*')) {
      if (d instanceof SVGElement && d.tagName.toLowerCase() !== 'svg') continue;
      if (d.matches(STRADDLE) || cs(d).position === 'absolute' || cs(d).position === 'fixed' || !visible(d) || !drawsBox(d) || decorative(d)) continue;
      const v = seen(d.parentElement, k, box(d.getBoundingClientRect()));
      if (v) R = union([R, v]);
    }
    const rg = document.createRange(), w = document.createTreeWalker(k, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      if (!n.data.trim() || !visible(n.parentElement)) continue;
      rg.selectNodeContents(n);
      for (const b of rg.getClientRects()) {
        if (b.width <= 0.5) continue;
        const v = seen(n.parentElement, k, textBox(b, n.parentElement));
        if (v) R = union([R, v]);
      }
    }
  }
  return R;
}
const hasInk = (k) => drawsBox(k) || !!k.textContent.trim() || !!k.querySelector('svg, img, video, canvas, input, textarea');

/**
 * Mesure les racines données. opts : { card (racines = cartes de blocs : pas de « hors écran »),
 * exclude : [sélecteurs dont le sous-arbre est ignoré] }. Rend une liste de constats.
 */
function detect(roots, opts) {
  opts = opts || {};
  memo = new WeakMap(); opMemo = new WeakMap();
  const out = [], vw = innerWidth, vh = innerHeight, card = !!opts.card;
  const skip = [STRADDLE, '#' + MARK, '.' + MARK].concat(opts.exclude || []).join(', ');
  roots.forEach((root, ri) => {
    if (!root || !root.isConnected || !visible(root)) return;
    const flagA = new Map(), flagD = new Set(), cutDone = new Set();
    const info = (el) => ({ sel: selOf(el, root), path: pathOf(el, root), rect: rectJSON(el.getBoundingClientRect()), root: ri });
    const contInfo = (C) => ({ sel: selOf(C, root), path: pathOf(C, root), rect: rectJSON(C.getBoundingClientRect()) });
    const underA = (el, C, self) => { for (let a = self ? el : el.parentElement; a && a !== C; a = a.parentElement) if (flagA.get(a) === C) return true; return false; };
    const underD = (el, self) => { for (let a = self ? el : el.parentElement; a; a = a.parentElement) if (flagD.has(a)) return true; return false; };
    const exceed = (R, c) => ({ l: r1(c.left - R.left), r: r1(R.right - c.right), t: r1(c.top - R.top), b: r1(R.bottom - c.bottom) });
    const worst = (e) => Math.max(e.l, e.r, e.t, e.b);
    const els = [root];
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, { acceptNode(n) {
      if (n.matches(skip)) return NodeFilter.FILTER_REJECT;
      if (cs(n).display === 'none') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    } });
    for (let n; (n = tw.nextNode());) els.push(n);

    for (const el of els) {
      if (el instanceof SVGElement && el.tagName.toLowerCase() !== 'svg') continue;
      if (!visible(el)) continue;
      const s = cs(el), r = el.getBoundingClientRect();
      if (r.width < 0.5 && r.height < 0.5) continue;
      const deco = decorative(el), boxy = drawsBox(el);
      // a) une boîte sort de son conteneur ; b) une boîte rognée par un ancêtre
      if (el !== root && boxy && !deco) {
        const C = containerOf(el, root, false);
        const W = clipWalk(el.parentElement, C, box(r), (a, cut) => {
          if (/^(IMG|VIDEO|CANVAS)$/.test(el.tagName)) return;     // une image dans son puits : son cadrage
          if (cutDone.has(el)) return;
          cutDone.add(el);
          out.push(Object.assign({ kind: 'coupe', what: 'boîte', text: textOf(el), by: selOf(a, root), ex: { l: r1(cut.l), r: r1(cut.r), t: r1(cut.t), b: r1(cut.b) } }, info(el)));
        });
        if (W && C && !underA(el, C)) {
          const e = exceed(W.R, C.getBoundingClientRect());
          if (W.sx) { e.l = 0; e.r = 0; }
          if (W.sy) { e.t = 0; e.b = 0; }
          if (worst(e) > TOL) { flagA.set(el, C); out.push(Object.assign({ kind: 'deborde', what: 'boîte', text: textOf(el), cont: contInfo(C), ex: e }, info(el))); }
        }
      }
      // d) hors de la fenêtre (seulement ce que rien ne rogne : menus, bulles, panneaux posés sur la page)
      if (!card && !deco && (boxy || ownText(el)) && !inClip(el) && !underD(el, false)) {
        const e = exceed(box(r), { left: 0, top: 0, right: vw, bottom: vh });
        if (worst(e) > TOL) { flagD.add(el); out.push(Object.assign({ kind: 'hors-ecran', what: 'boîte', text: textOf(el), ex: e, view: [vw, vh] }, info(el))); }
      }
      // c) texte tronqué par « … » ou par un line-clamp
      const lc = lineClamp(s), ell = s.textOverflow === 'ellipsis' && clipsX(s);
      // un élément tronqué qui en contient un autre au même texte (nom → son texte) : on ne dit que le second
      const inner = (ell || lc) && [...el.querySelectorAll('*')].some((d) => { const ds = cs(d); return (lineClamp(ds) || (ds.textOverflow === 'ellipsis' && clipsX(ds))) && d.textContent.trim() === el.textContent.trim(); });
      if ((ell || lc) && !inner && el.textContent.trim()) {
        const ch = charRects(el);
        if (ch.length) {
          const cb = contentBox(el);
          let shown = -1;
          if (lc && el.scrollHeight > el.clientHeight + 1 && ch.some((b) => (b.top + b.bottom) / 2 > cb.bottom)) {
            shown = ch.filter((b) => (b.top + b.bottom) / 2 <= cb.bottom).length;
          } else if (ell && ch.some((b) => b.right > cb.right + TOL)) {
            const ew = textWidth('…', s);
            shown = ch.filter((b) => b.right <= cb.right - ew + 0.75).length;
          }
          if (shown >= 0) {
            const ratio = shown / ch.length;
            if (ratio < 0.7 || shown < 8) out.push(Object.assign({ kind: 'ellipse', what: lc ? 'lignes' : 'ligne', text: textOf(el), shown, total: ch.length, ratio: Math.floor(ratio * 100) }, info(el)));
          }
        }
      }
      // b) un texte indicatif (ou la valeur d'un champ en lecture seule) plus large que son champ
      if ((el.tagName === 'INPUT' && /^(text|search|number|email|url|tel|)$/.test(el.type)) || el.tagName === 'TEXTAREA') {
        if (document.activeElement !== el) {
          if (el.tagName === 'INPUT') {
            const txt = el.value ? (el.readOnly || el.disabled ? el.value : '') : el.placeholder;
            if (txt) {
              const need = textWidth(txt, s), avail = el.clientWidth - px(s.paddingLeft) - px(s.paddingRight);
              if (need > avail + 1) out.push(Object.assign({ kind: 'coupe', what: el.value ? 'valeur du champ' : 'texte indicatif', text: clean(txt), need: r1(need), avail: r1(avail) }, info(el)));
            }
          } else if (clipsY(s) && el.scrollHeight > el.clientHeight + 2) {
            out.push(Object.assign({ kind: 'coupe', what: 'zone de texte', text: textOf(el), need: el.scrollHeight, avail: el.clientHeight }, info(el)));
          }
        }
      }
      // e) deux frères d'une rangée flex/grille qui se recouvrent
      if (/flex|grid/.test(s.display) && el.children.length > 1) {
        const kids = [];
        for (const k of el.children) {
          if (kids.length >= 30) break;
          if (k.matches(skip) || k instanceof SVGElement && k.tagName.toLowerCase() !== 'svg') continue;
          const ks = cs(k);
          if (ks.position === 'absolute' || ks.position === 'fixed' || ks.display === 'none' || !visible(k) || decorative(k) || !hasInk(k)) continue;
          const R = inkRect(k);
          if (R && R.right - R.left > 0.5 && R.bottom - R.top > 0.5) kids.push({ k, R, m: negMargins(k) });
        }
        for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i], b = kids[j];
          const ow = Math.min(a.R.right, b.R.right) - Math.max(a.R.left, b.R.left);
          const oh = Math.min(a.R.bottom, b.R.bottom) - Math.max(a.R.top, b.R.top);
          if (ow > 1 + a.m.x + b.m.x && oh > 1 + a.m.y + b.m.y) {
            out.push(Object.assign({ kind: 'chevauche', what: 'rangée', text: clean(textOf(a.k), 40) + ' ⟷ ' + clean(textOf(b.k), 40),
              ex: { w: r1(ow), h: r1(oh) }, pair: [pathOf(a.k, root), pathOf(b.k, root)], pairSel: [labelOf(a.k), labelOf(b.k)] }, info(el)));
          }
        }
      }
    }

    // textes : a) qui sortent de leur conteneur, b) rognés sans ellipse, d) hors de la fenêtre
    const xw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const rg = document.createRange();
    for (let n; (n = xw.nextNode());) {
      if (!n.data.trim()) continue;
      const p = n.parentElement;
      if (!p || p.closest(skip) || !visible(p)) continue;
      rg.selectNodeContents(n);
      const rects = [...rg.getClientRects()].filter((b) => b.width > 0.5 && b.height > 0.5).map((b) => textBox(b, p));
      if (!rects.length) continue;
      const C = containerOf(p, root, true);
      let cut = null;
      const W = clipWalk(p, C, union(rects), (a, c, as) => {
        if (cut) return;
        const hz = c.l > 1 || c.r > 1, vt = c.t > 1 || c.b > 1;
        if (hz && !vt && as.textOverflow === 'ellipsis') return;      // c) : mesuré à part
        if (vt && !hz && lineClamp(as)) return;                       // c) : idem
        cut = { a, c };
      });
      if (cut && !cutDone.has(p)) {
        cutDone.add(p);
        out.push(Object.assign({ kind: 'coupe', what: 'texte', text: clean(n.data), by: selOf(cut.a, root), ex: { l: r1(cut.c.l), r: r1(cut.c.r), t: r1(cut.c.t), b: r1(cut.c.b) } }, info(p)));
      }
      if (!W) continue;
      const R = W.R;
      if (C && !underA(p, C, true)) {
        const e = exceed(R, C.getBoundingClientRect());
        if (W.sx) { e.l = 0; e.r = 0; }
        if (W.sy) { e.t = 0; e.b = 0; }
        if (worst(e) > TOL) { flagA.set(p, C); out.push(Object.assign({ kind: 'deborde', what: 'texte', text: clean(n.data), cont: contInfo(C), ex: e }, info(p))); }
      }
      if (!card && !inClip(p) && !clipsX(cs(p)) && !underD(p, true)) {
        const e = exceed(R, { left: 0, top: 0, right: vw, bottom: vh });
        if (worst(e) > TOL) { flagD.add(p); out.push(Object.assign({ kind: 'hors-ecran', what: 'texte', text: clean(n.data), ex: e, view: [vw, vh] }, info(p))); }
      }
    }
  });
  return out;
}

// ── racines, repérage et captures ───────────────────────────────────────
function rootOf(spec) {
  if (!spec) return null;
  if (spec.node) return window.__mia.editor.nodeEl(spec.node);
  if (spec.q) return document.querySelectorAll(spec.q)[spec.i || 0] || null;
  return null;
}
function locate(spec, p) {
  let n = rootOf(spec);
  for (const i of p || []) n = n && n.children[i];
  return n || null;
}
/** Les racines visibles de chaque sélecteur, avec leur adresse pour la capture. */
function pageRoots(sels) {
  const roots = [], specs = [];
  for (const q of sels) {
    document.querySelectorAll(q).forEach((el, i) => {
      if (roots.indexOf(el) >= 0 || !visible(el)) return;
      roots.push(el); specs.push({ q, i, label: q });
    });
  }
  return { roots, specs };
}
function unmark() { document.querySelectorAll('.' + MARK).forEach((n) => n.remove()); }
function markRect(r, dashed) {
  const d = document.createElement('div');
  d.className = MARK;
  d.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;left:' + (r.left - 1) + 'px;top:' + (r.top - 1) + 'px;width:' + (r.width + 2) + 'px;height:' + (r.height + 2) + 'px;border:' + (dashed ? '1px dashed rgba(255,69,58,.75)' : '1.5px solid #ff453a') + ';border-radius:2px';
  document.body.append(d);
}
/** Contours (élément plein, conteneur en pointillés) et cadre de capture autour de l'élément. */
function mark(spec) {
  unmark();
  const el = locate(spec.root, spec.path);
  if (!el) return null;
  const er = el.getBoundingClientRect();
  const cont = spec.cont ? locate(spec.root, spec.cont) : null;
  const cr = cont ? cont.getBoundingClientRect() : null;
  if (cr) markRect(cr, true);
  const pair = (spec.pair || []).map((p) => locate(spec.root, p)).filter(Boolean).map((n) => n.getBoundingClientRect());
  if (pair.length) pair.forEach((r) => markRect(r, false)); else markRect(er, false);
  let x0 = er.left, x1 = er.right, y0 = er.top, y1 = er.bottom;
  if (cr) {
    x0 = Math.min(x0, Math.max(cr.left, er.left - 280)); x1 = Math.max(x1, Math.min(cr.right, er.right + 280));
    y0 = Math.min(y0, Math.max(cr.top, er.top - 110)); y1 = Math.max(y1, Math.min(cr.bottom, er.bottom + 110));
  }
  x0 -= 24; y0 -= 20; x1 += 24; y1 += 20;
  if (x1 - x0 < 220) { const c = (x0 + x1) / 2; x0 = c - 110; x1 = c + 110; }
  if (y1 - y0 < 80) { const c = (y0 + y1) / 2; y0 = c - 40; y1 = c + 40; }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(innerWidth, x1); y1 = Math.min(innerHeight, y1);
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
}
/** Amène un élément d'une carte au centre de la scène, zoom 1 (avant sa capture). */
async function center(nodeId, p) {
  const e = window.__mia.editor, el = locate({ node: nodeId }, p) || e.nodeEl(nodeId);
  if (!el) return false;
  const r = el.getBoundingClientRect(), st = document.getElementById('stage').getBoundingClientRect(), c = e.camera();
  const wx = c.x + (r.left + r.width / 2 - st.left) / c.z, wy = c.y + (r.top + Math.min(r.height, 300) / 2 - st.top) / c.z;
  e.setCamera({ x: wx - st.width / 2, y: wy - st.height / 2, z: 1 });
  await frames(3); await sleep(160);
  return true;
}
/** Un élément d'une racine de page : défilé dans la vue s'il le faut. */
async function reveal(spec, p) {
  const el = locate(spec, p);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) { el.scrollIntoView({ block: 'center' }); await frames(2); await sleep(120); }
  return true;
}

// ── la planche de banc ────────────────────────────────────────────────────
const bench = {
  cat: null,
  async catalog() { if (!this.cat) this.cat = await mod('js/catalog.js'); return this.cat; },
  /** Crée (ou reprend et vide) la planche de banc, puis pose les sources et un bloc de chaque type, seul et branché. */
  async make(cfg) {
    const m = window.__mia, app = m.app, e = m.editor;
    await e.ready;
    const cat = await this.catalog();
    let all = await window.mia.projects.list();
    all = Array.isArray(all) ? all : (all && all.projects) || [];
    let b = all.find((p) => p.name === cfg.name && !p.folderId);
    if (!b) {
      const r = await app.createProject({ name: cfg.name });
      if (!r || !r.id) throw new Error('planche de banc non créée');
      b = { id: r.id };
    } else if ((await app.openProject(b.id)) === false) throw new Error('planche de banc non ouverte');
    await sleep(500);
    const ctx = e.__debug && e.__debug.ctx;
    const old = e.getGraph().nodes.map((n) => n.id);
    if (old.length) e.removeNodes(old);
    if (ctx && ctx.doc.groups.length) ctx.mutate('ungroup', () => { for (const g of [...ctx.doc.groups]) ctx.doc.removeGroup(g.id); });
    await sleep(200);
    const got = await e.importFiles([cfg.image, cfg.video].filter(Boolean), { x: -1300, y: 0 });
    const media = (got || []).map((id) => e.getNode(id)).filter(Boolean);
    const img = media.find((n) => n.data && n.data.kind === 'image'), vid = media.find((n) => n.data && n.data.kind === 'video');
    if (img) e.updateNode(img.id, { x: -1500, y: 0, title: cfg.title }, { history: false });
    if (vid) e.updateNode(vid.id, { x: -1500, y: 700, title: cfg.title }, { history: false });
    // addNode rend l'identifiant du bloc posé
    const add = (type, at, o) => { const r = e.addNode(type, at, Object.assign({ select: false, animate: false }, o)); return r && typeof r === 'object' ? r.id : r; };
    const txtId = add('text', { x: -1500, y: 1900 }, { params: { text: cfg.prompt, negative: cfg.negative }, title: cfg.title });
    const txt = txtId ? { id: txtId } : null;
    const rowA = {}, rowB = {};
    let x = 0;
    for (const ty of cat.types()) {
      const params = {};
      for (const p of ty.params || []) if (p.kind === 'prompt') params[p.id] = p.id === 'negative' ? cfg.negative : cfg.prompt;
      const a = add(ty.id, { x, y: 0 }, { params, title: cfg.title });
      if (a) rowA[ty.id] = a;
      if ((ty.inputs || []).length) {
        const nid = add(ty.id, { x, y: cfg.rowGap }, { title: cfg.title });
        const n = nid ? { id: nid } : null;
        if (n) {
          rowB[ty.id] = n.id;
          let k = 0;
          for (const inp of ty.inputs) {
            const t = inp.type;
            const src = t === 'text' ? (txt && [txt.id, 'text'])
              : t === 'video' ? (vid && [vid.id, 'out'])
              : t === 'image' ? (img && [img.id, 'out'])
              : t === 'media' ? ((k++ % 2 === 0 ? img : vid) && [(k % 2 === 1 ? img : vid).id, 'out']) : null;
            if (src) { try { e.connect(src[0], src[1], n.id, inp.id); } catch (err) { /* refusé : tant pis */ } }
          }
        }
      }
      x += (ty.width || 288) + 180;
    }
    e.select([]);
    await sleep(400);
    return { boardId: b.id, img: img ? img.id : null, vid: vid ? vid.id : null, txt: txt ? txt.id : null, rowA, rowB };
  },
  /** Qui est qui, dans la langue affichée : « Assembler · sequence · seul ». */
  async who(rows) {
    const cat = await this.catalog(), out = {};
    for (const [row, map] of [['seul', rows.rowA], ['branché', rows.rowB]]) {
      for (const [type, id] of Object.entries(map)) out[id] = cat.typeLabel(type) + ' · ' + type + ' · ' + row;
    }
    for (const [k, l] of [['img', 'Média image'], ['vid', 'Média vidéo'], ['txt', 'Consigne']]) if (rows[k]) out[rows[k]] = l + ' · source';
    return out;
  },
  /** Zoom 1, rien de choisi, « Avancé » ouvert sur chaque carte. */
  async prepare(ids) {
    const e = window.__mia.editor;
    e.select([]);
    const c = e.camera();
    e.setCamera({ x: c.x, y: c.y, z: 1 });
    for (let pass = 0; pass < 2; pass++) {
      for (const id of ids) { const el = e.nodeEl(id); if (el) el.querySelectorAll('.np-adv:not(.open)').forEach((b) => { if (!b.hidden) b.click(); }); }
      await frames(2);
    }
    await sleep(250);
    return true;
  },
  /** Mesure des cartes : les cartes hors de la vue restent mises en page (visibility), on les montre le temps de la mesure. */
  cards(ids) {
    const st = document.createElement('style');
    st.textContent = '.node.off { visibility: visible !important; }';
    document.head.append(st);
    try {
      const e = window.__mia.editor;
      return detect(ids.map((id) => e.nodeEl(id)), { card: true });
    } finally { st.remove(); }
  },
  /** Les réglages à faire varier : ceux dont dépendent d'autres réglages (showIf), chaque liste, le LoRA. */
  async variants(ids) {
    const m = window.__mia, e = m.editor, cat = await this.catalog(), out = [];
    // les LoRA que le choix de modèle propose (mêmes filtres que lui) ; un LoRA absent du PC en plus
    let mp = null;
    try { mp = await mod('js/nodes/modelpicker.js'); } catch (err) { mp = null; }
    const loras = mp ? mp.loraModels().map((x) => x.id) : [];
    const isLora = (p) => p.kind === 'model' && (mp ? mp.isLoraParam(p) : /lora/.test((p.caps || []).join(' ')));
    for (const id of ids) {
      const node = e.getNode(id), ty = node && cat.typeOf(node.type);
      if (!ty) continue;
      const conds = new Set((ty.params || []).filter((p) => p.showIf && p.showIf.param).map((p) => p.showIf.param));
      for (const p of ty.params || []) {
        let values = null;
        if (p.kind === 'select' || (conds.has(p.id) && p.kind === 'seg')) values = (p.options || []).map((o) => o.value);
        else if (conds.has(p.id) && p.kind === 'toggle') values = [true, false];
        else if (isLora(p)) values = loras.slice(0, 1).concat(['mcf-lora-absent']);
        else if (p.kind === 'model' && mp && mp.modelsFor) {
          // chaque modèle prêt (4 au plus), un grisé, un à installer : leurs noms s'affichent dans le bouton
          const f = mp.modelsFor(p.caps || []) || {};
          values = [].concat((f.ready || []).slice(0, 4), (f.greyed || []).slice(0, 1), (f.missing || []).slice(0, 1)).map((x) => x && x.id).filter(Boolean);
        }
        if (!values) continue;
        const cur = node.params && node.params[p.id] !== undefined ? node.params[p.id] : p.default;
        values = values.filter((v) => v !== cur);
        if (values.length) out.push({ id, param: p.id, values, restore: node.params ? node.params[p.id] : undefined });
      }
    }
    return out;
  },
  set(id, key, v) { window.__mia.editor.setParam(id, key, v === null ? undefined : v); return true; },
  /** États de calcul simulés : les évènements du moteur, sur le bus, comme s'ils venaient de lui (aucun calcul). */
  async emit(ids, kind, cfg) {
    const m = window.__mia, e = m.editor, cat = await this.catalog(), pid = m.state.project && m.state.project.id, t0 = Date.now();
    const src = (k) => { const n = e.getNode(k === 'image' ? cfg.img : cfg.vid) || e.getNode(cfg.img) || e.getNode(cfg.vid); return n && n.data && n.data.src ? { path: n.data.src, kind: n.data.kind, meta: n.data.meta || null } : null; };
    let count = 0;
    for (const id of ids) {
      const node = e.getNode(id), ty = node && cat.typeOf(node.type);
      if (!ty || !ty.engine) continue;
      const base = { projectId: pid, nodeId: id, jobId: 'mcf-' + id, mode: ty.modes ? 'final' : null, label: node.title || null, type: node.type };
      let evt = null;
      if (kind === 'queued') evt = Object.assign({}, base, { kind: 'queued' });
      else if (kind === 'waiting') evt = Object.assign({}, base, { kind: 'waiting-gpu', who: cfg.who, since: t0 - 754000 });
      else if (kind === 'running') evt = Object.assign({}, base, { kind: 'progress', progress: 0.47, eta: 4000, message: cfg.runMsg });
      else if (kind === 'done') {
        const outputs = {};
        for (const o of ty.outputs || []) { const s = src(o.type === 'image' ? 'image' : 'video'); if (s) outputs[o.id] = s; }
        evt = Object.assign({}, base, { kind: 'done', run: { runId: 'mcf-r-' + id, status: 'done', type: node.type, mode: base.mode, started: t0 - 598000, finished: t0, params: JSON.parse(JSON.stringify(node.params || {})), outputs } });
      } else if (kind === 'error') evt = Object.assign({}, base, { kind: 'error', message: cfg.err, run: { runId: 'mcf-e-' + id, status: 'error', type: node.type, error: cfg.err, log: 'logs/mcf-erreur.log', started: t0 - 42000, finished: t0 } });
      else if (kind === 'cancelled') evt = Object.assign({}, base, { kind: 'cancelled' });
      if (evt) { m.bus.emit('engine:event', evt); count++; }
    }
    return count;
  },
  /** « Périmé » : un réglage de chaque bloc calculé change après sa version ; rend de quoi le remettre. */
  async touch(ids) {
    const e = window.__mia.editor, cat = await this.catalog(), out = [];
    for (const id of ids) {
      const node = e.getNode(id), ty = node && cat.typeOf(node.type);
      if (!ty || !ty.engine) continue;
      for (const p of ty.params || []) {
        const cur = node.params && node.params[p.id] !== undefined ? node.params[p.id] : p.default;
        let v;
        if ((p.kind === 'seg' || p.kind === 'select') && (p.options || []).length > 1) v = p.options.find((o) => o.value !== cur).value;
        else if (p.kind === 'toggle') v = !cur;
        else if (p.kind === 'slider') v = cur === p.min ? p.max : p.min;
        else if (p.kind === 'seed') v = (Number(cur) || 0) + 1;
        else if (p.kind === 'frame') v = cur === 0 ? 1 : 0;
        else continue;
        out.push({ id, key: p.id, old: node.params ? node.params[p.id] : undefined });
        e.setParam(id, p.id, v);
        break;
      }
    }
    return out;
  },
  /** Ouvre la n-ième liste (menu déroulant, choix de modèle) d'une carte, posée près du coin bas-droit de la fenêtre. */
  async openList(id, n) {
    const e = window.__mia.editor, el = e.nodeEl(id);
    const trig = el ? this.lists(el)[n] : null;
    if (!trig) return null;
    const r = trig.getBoundingClientRect(), st = document.getElementById('stage').getBoundingClientRect(), c = e.camera();
    const wx = c.x + (r.left + r.width / 2 - st.left) / c.z, wy = c.y + (r.top + r.height / 2 - st.top) / c.z;
    const tx = innerWidth - 40 - r.width / 2 - st.left, ty = innerHeight - 70 - st.top;
    e.setCamera({ x: wx - tx, y: wy - ty, z: 1 });
    await frames(3); await sleep(120);
    // ouverte ensuite par un vrai clic (le menu déroulant s'ouvre à l'appui, le choix de modèle au clic)
    const q = trig.getBoundingClientRect(), row = trig.closest('[data-param]');
    return { param: row ? row.getAttribute('data-param') : 'liste', x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) };
  },
  /** Les listes (menu déroulant, choix de modèle) affichées dans une carte, même hors de la vue. */
  lists(el) { return [...el.querySelectorAll('.np-ctl .dd, .np-ctl .mp-trigger')].filter((x) => x.getClientRects().length > 0); },
  async listCount(id) { const el = window.__mia.editor.nodeEl(id); return el ? this.lists(el).length : 0; },
  /** Pose l'état (en-tête) d'une carte au bord droit de la fenêtre et rend son centre (pour le survoler). */
  async stateAtEdge(id) {
    const e = window.__mia.editor, el = e.nodeEl(id);
    // l'état est écrit par le corps du bloc (.nb-status, son info-bulle porte le message) ou, à défaut, par l'éditeur
    const s = el && [...el.querySelectorAll('.n-status .nb-status, .n-state')].find((x) => x.getClientRects().length && x.textContent.trim());
    if (!s) return null;
    const r = s.getBoundingClientRect(), st = document.getElementById('stage').getBoundingClientRect(), c = e.camera();
    const wx = c.x + (r.left + r.width / 2 - st.left) / c.z, wy = c.y + (r.top + r.height / 2 - st.top) / c.z;
    const tx = innerWidth - 30 - r.width / 2 - st.left, ty = innerHeight - 40 - st.top;
    e.setCamera({ x: wx - tx, y: wy - ty, z: 1 });
    await frames(3); await sleep(150);
    const q = s.getBoundingClientRect();
    return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) };
  },
  /** Disposition de chaque rangée de réglages affichée (pile, interrupteur au bout, niveau du choix segmenté). */
  layout(ids) {
    const e = window.__mia.editor, out = {};
    for (const id of ids) {
      const el = e.nodeEl(id);
      if (!el) continue;
      const rows = {};
      for (const r of el.querySelectorAll('.np-row[data-param]')) {
        if (!r.getClientRects().length) continue;
        const seg = r.querySelector('.np-ctl > .seg');
        const cls = ['np-stack', 'np-tgl-wide'].filter((c) => r.classList.contains(c))
          .concat(seg ? ['fill', 'wrap', 'as-menu'].filter((c) => seg.classList.contains(c)).map((c) => 'seg-' + c) : []);
        rows[r.getAttribute('data-param')] = cls.join(' ');
      }
      out[id] = rows;
    }
    return out;
  },
  /** Largeur des cartes, comme la poignée (un nombre pour toutes, ou { id: largeur }) ; rend les largeurs d'avant. */
  widths(ids, w) {
    const e = window.__mia.editor, old = {};
    for (const id of ids) {
      const n = e.getNode(id), el = e.nodeEl(id);
      if (!n) continue;
      old[id] = n.w || (el ? el.offsetWidth : 0);
      const v = typeof w === 'number' ? w : w && w[id];
      if (v) e.updateNode(id, { w: v }, { history: false });
    }
    return old;
  },
  /** Rangées dont la disposition n'est plus celle d'avant un aller-retour de largeur (elle dépendrait des gestes). */
  kept(ids, before) {
    const e = window.__mia.editor, now = this.layout(ids), out = [];
    ids.forEach((id, ri) => {
      const el = e.nodeEl(id), a = before[id] || {}, b = now[id] || {};
      if (!el) return;
      for (const k of Object.keys(b)) {
        if (!(k in a) || a[k] === b[k]) continue;
        const row = el.querySelector('.np-row[data-param="' + k + '"]');
        if (!row) continue;
        out.push({ kind: 'garde', what: 'rangée', text: textOf(row.querySelector('.np-label') || row), sel: selOf(row, el), path: pathOf(row, el),
          rect: rectJSON(row.getBoundingClientRect()), root: ri, avant: a[k] || 'normale', apres: b[k] || 'normale' });
      }
    });
    return out;
  },
};

async function closeMenus() { try { (await mod('js/ui/menu.js')).closeMenu(); } catch (e) { /* rien */ } await frames(1); return true; }

/**
 * Témoin du détecteur, avant toute mesure : une petite carte posée un instant sur la page avec un défaut
 * de chaque sorte et une pastille de port à cheval sur son bord. Les cinq sortes doivent sortir, la
 * pastille jamais ; sinon l'outil s'arrête (un détecteur aveugle dirait « rien ne déborde »).
 */
function selfTest() {
  const fx = document.createElement('div');
  fx.id = 'mcf-fixture';
  fx.style.cssText = 'position:fixed;left:24px;top:140px;width:420px;font:12px/1.4 sans-serif;color:#eee;z-index:2147483646';
  fx.innerHTML =
    '<div class="fx-card" style="position:relative;width:200px;padding:6px;background:#1c1c20;border:1px solid #444">' +
      '<div style="display:inline-flex;white-space:nowrap;padding:2px 6px;background:#2a2a30;border:1px solid #555">Coupe franche · Passage au noir, bien trop long</div>' +
      '<div style="width:90px;overflow:hidden;white-space:nowrap">un texte coupé net sans ellipse</div>' +
      '<div style="width:90px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">un texte beaucoup trop long pour sa boîte</div>' +
      '<div style="display:flex;width:180px"><span style="flex:none;width:80px;background:#333">Premier</span><span style="flex:none;width:80px;background:#555;position:relative;left:-30px">Second</span></div>' +
      '<div class="n-port in" style="position:relative;height:20px"><i class="dot" style="position:absolute;left:-12px;top:5px;width:10px;height:10px;box-sizing:border-box;border:1.5px solid #f90;border-radius:50%;background:#1c1c20"></i><span class="lbl">Port</span></div>' +
    '</div>' +
    '<div style="position:fixed;left:calc(100vw - 30px);top:420px;width:140px;padding:4px;background:#2a2a30">sort de la fenêtre</div>';
  document.body.append(fx);
  try {
    const found = detect([fx], {});
    const kinds = [...new Set(found.map((f) => f.kind))];
    const want = ['deborde', 'coupe', 'ellipse', 'chevauche', 'hors-ecran'];
    const missing = want.filter((k) => kinds.indexOf(k) < 0);
    const dots = found.filter((f) => /\.dot|n-port/.test(f.sel));
    return { ok: !missing.length && !dots.length, missing, dots: dots.map((f) => f.kind + ' ' + f.sel), kinds };
  } finally { fx.remove(); }
}

window.__mcf = { detect, pageRoots, mark, unmark, center, reveal, bench, closeMenus, selfTest, mod, frames, sleep, visible,
  page(sels, exclude) { const { roots, specs } = pageRoots(sels); return { found: detect(roots, { exclude: exclude || [] }), specs }; } };
return 'ok';
})()`;

// ── garde-fou et préparation ─────────────────────────────────────────────
async function install() { return ev(PAGE); }

async function waitReady(lang, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const ok = await ev(`(() => !!(document.readyState === 'complete' && window.__mia && window.__mia.app && window.__mia.app.home && window.__mia.app.editor && window.__mia.state && window.__mia.state.prefs && ${lang ? `document.documentElement.lang === ${J(lang)}` : 'true'}))()`, 5000);
      if (ok) { await sleep(1500); await screencast(true); await install(); return true; }
    } catch { /* la page se recharge */ }
    await sleep(400);
  }
  throw new Error(`la fenêtre n'est pas revenue (langue ${lang || '?'})`);
}

/** Bascule la langue par le chemin de l'app : i18n.setLang écrit la préférence, enregistre, recharge. */
async function setLang(lang) {
  const cur = await ev('document.documentElement.lang');
  if (cur === lang) return false;
  await ev(`(async () => { const m = await import(new URL('js/i18n.js', location.href).href); setTimeout(() => m.setLang(${J(lang)}), 0); return 1; })()`);
  await sleep(1200);
  await waitReady(lang);
  return true;
}

/** Une vidéo verticale de 2 s fabriquée avec le ffmpeg de Mia (si --video n'est pas donné). */
function makeVideo(ffmpeg) {
  const file = path.join(OUT, 'banc-portrait.mp4');
  fs.mkdirSync(OUT, { recursive: true });
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24:duration=2',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', file], { stdio: 'ignore', timeout: 60000 });
  return file;
}

// ── relevé des constats ─────────────────────────────────────────────────
const entries = new Map();
let shotNo = 0;
const KIND_FR = { deborde: 'déborde', coupe: 'coupé', ellipse: 'ellipse', 'hors-ecran': 'hors écran', chevauche: 'chevauche', garde: 'disposition gardée' };

async function shoot(spec, name) {
  const clip = await ev(`window.__mcf.mark(${J(spec)})`);
  if (!clip) return null;
  await settle(40);
  let r;
  try { r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } }, 20000); } finally { await ev('window.__mcf.unmark()').catch(() => {}); }
  if (!r?.result?.data) return null;
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  return file;
}

/**
 * Range les constats d'une mesure. Un même défaut (langue, surface, sorte, bloc, sélecteur, texte) n'est
 * compté qu'une fois, avec la liste des états où il se voit ; sa capture est prise à sa première apparition.
 */
async function take(found, ctx, specs) {
  for (const f of found || []) {
    const who = ctx.whoOf ? ctx.whoOf(f.root) : (specs[f.root]?.label || '');
    // la barre de titre (onglets) est la même sur l'accueil et sur la planche : comptée une fois
    const surface = specs[f.root]?.q === '#titlebar' ? 'barre de titre' : ctx.surface;
    // les chiffres d'un texte vivant ne font pas un autre défaut (« il y a 12 min » = « il y a 13 min »)
    const sig = [ctx.lang, surface, f.kind, f.what, who, f.sel, String(f.text).replace(/\d+/g, '#')].join('|');
    const old = entries.get(sig);
    if (old) {
      old.etats.add(ctx.etat);
      if (score(f) > score(old.f)) old.f = f;
      continue;
    }
    const e = { lang: ctx.lang, surface, kind: f.kind, who, etats: new Set([ctx.etat]), f, capture: null };
    entries.set(sig, e);
    if (!SHOTS) continue;
    const spec = specs[f.root];
    try {
      if (spec.node) await ev(`window.__mcf.center(${J(spec.node)}, ${J(f.path)})`);
      else await ev(`window.__mcf.reveal(${J(spec)}, ${J(f.path)})`);
      const name = `${String(++shotNo).padStart(3, '0')}-${ctx.lang}-${surface.replace(/ /g, '-')}-${f.kind}.png`;
      e.capture = await shoot({ root: spec, path: f.path, cont: f.cont?.path, pair: f.pair }, name);
    } catch (err) { e.captureError = err.message; }
  }
}
function score(f) {
  if (f.kind === 'ellipse') return 100 - f.ratio;
  if (f.kind === 'chevauche') return f.ex.w * f.ex.h;
  if (f.need) return f.need - f.avail;
  return f.ex ? Math.max(f.ex.l || 0, f.ex.r || 0, f.ex.t || 0, f.ex.b || 0) : 0;
}

// ── surface « blocks » : la planche de banc ───────────────────────────────
let BENCH = null;
let WHO = {};
const STATES = [
  { kind: 'queued', label: 'en file', wait: 450 },
  { kind: 'waiting', label: 'GPU occupé', wait: 450 },
  { kind: 'running', label: 'en cours 47 %', wait: 450 },
  { kind: 'done', label: 'fait · 9 min 58 s', wait: 3300 },     // la coche « fait » s'efface en 2,4 s
  { kind: 'stale', label: 'périmé', wait: 700 },
  { kind: 'error', label: 'erreur au message long', wait: 700 },
];

async function openBench() {
  if (!BENCH) {
    if (!VIDEO) {
      const info = await ev('window.mia.app.info()');
      if (info?.ffmpeg) { try { VIDEO = makeVideo(info.ffmpeg); } catch (err) { log(`  (pas de vidéo fabriquée : ${err.message})`); } }
    }
    for (const f of [IMAGE, VIDEO].filter(Boolean)) if (!fs.existsSync(f)) throw new Error(`fichier introuvable : ${f}`);
    log('  planche de banc : fabrication…');
    BENCH = await ev(`window.__mcf.bench.make(${J({ name: TXT.bench, image: IMAGE, video: VIDEO, title: TXT.title, prompt: TXT.prompt, negative: TXT.negative, rowGap: 2600 })})`, 180000);
    log(`  planche de banc : ${Object.keys(BENCH.rowA).length} types seuls, ${Object.keys(BENCH.rowB).length} branchés${BENCH.vid ? '' : ' (sans vidéo)'}`);
  } else {
    const ok = await ev(`window.__mia.app.openProject(${J(BENCH.boardId)})`);
    if (ok === false) throw new Error('planche de banc non rouverte');
    await settle(1500);
  }
  WHO = await ev(`window.__mcf.bench.who(${J(BENCH)})`);
}

async function surfaceBlocks(lang) {
  log(`\n[${lang}] blocs`);
  await setViewport(...BLOCK_VIEW);
  await openBench();
  const ids = [...Object.values(BENCH.rowA), ...Object.values(BENCH.rowB)];
  const ctx = (etat, list = ids) => ({ lang, surface: 'blocs', etat, whoOf: (ri) => WHO[list[ri]] || list[ri] });
  const measure = async (etat, list = ids) => {
    const found = await ev(`window.__mcf.bench.cards(${J(list)})`);
    await take(found, ctx(etat, list), list.map((id) => ({ node: id })));
    return found.length;
  };
  await ev(`window.__mcf.bench.prepare(${J(ids)})`);
  await settle(600);
  log(`  repos : ${await measure('repos')} constat(s)`);

  // chaque valeur des réglages qui en montrent d'autres, et de chaque liste
  const vars = await ev(`window.__mcf.bench.variants(${J(ids)})`);
  let nv = 0;
  for (const v of vars) {
    for (const val of v.values) {
      await ev(`window.__mcf.bench.set(${J(v.id)}, ${J(v.param)}, ${J(val)})`);
      await settle(220);
      await ev(`window.__mcf.bench.prepare(${J([v.id])})`);
      await measure(`${v.param} = ${val}`, [v.id]);
      nv++;
    }
    await ev(`window.__mcf.bench.set(${J(v.id)}, ${J(v.param)}, ${J(v.restore ?? null)})`);
  }
  log(`  variantes : ${nv} réglages essayés`);
  await settle(300);

  // aller-retour à la poignée : chaque carte à 216 px (la largeur minimale, mesurée aussi), puis rendue à sa
  // largeur ; aucune rangée ne doit garder une disposition « carte étroite » (pile, interrupteur au bout)
  const before = await ev(`window.__mcf.bench.layout(${J(ids)})`);
  const widths = await ev(`window.__mcf.bench.widths(${J(ids)}, 216)`);
  await settle(500);
  await ev(`window.__mcf.bench.prepare(${J(ids)})`);
  log(`  cartes à 216 px : ${await measure('carte à 216 px')} constat(s)`);
  await ev(`window.__mcf.bench.widths(${J(ids)}, ${J(widths)})`);
  await settle(500);
  const kept = await ev(`window.__mcf.bench.kept(${J(ids)}, ${J(before)})`);
  await take(kept, ctx('après 216 px puis largeur rendue'), ids.map((id) => ({ node: id })));
  log(`  largeur rendue : ${kept.length} rangée(s) restée(s) en disposition étroite`);

  // états simulés
  let touched = [];
  for (const st of STATES) {
    if (st.kind === 'stale') touched = await ev(`window.__mcf.bench.touch(${J(ids)})`);
    else await ev(`window.__mcf.bench.emit(${J(ids)}, ${J(st.kind)}, ${J({ img: BENCH.img, vid: BENCH.vid, who: TXT.who, runMsg: TXT.runMsg, err: TXT.err })})`);
    await settle(st.wait);
    await ev(`window.__mcf.bench.prepare(${J(ids)})`);
    log(`  ${st.label} : ${await measure(st.label)} constat(s)`);
  }

  // l'info-bulle d'une erreur longue, au bord droit de la fenêtre
  const seq = BENCH.rowA.sequence || ids[0];
  const at = await ev(`window.__mcf.bench.stateAtEdge(${J(seq)})`);
  if (at) {
    await mouse('mouseMoved', at.x, at.y);
    await sleep(900);
    await pageMeasure(lang, 'blocs', 'info-bulle de l’erreur au bord', ['#tooltip'], [], () => WHO[seq]);
    await mouse('mouseMoved', 5, 300);
    await sleep(200);
  }

  // remise des réglages touchés, puis les listes déroulantes, ouvertes près du coin bas-droit
  for (const t of touched) await ev(`window.__mcf.bench.set(${J(t.id)}, ${J(t.key)}, ${J(t.old ?? null)})`);
  await ev(`window.__mcf.bench.emit(${J(ids)}, 'cancelled', {})`);
  await settle(300);
  let nl = 0;
  for (const id of Object.values(BENCH.rowA)) {
    const n = await ev(`window.__mcf.bench.listCount(${J(id)})`);
    for (let i = 0; i < n; i++) {
      const at = await ev(`window.__mcf.bench.openList(${J(id)}, ${i})`);
      if (!at) continue;
      await click(at.x, at.y);
      await settle(300);
      await pageMeasure(lang, 'blocs', `liste « ${at.param} » ouverte près du coin`, ['#contextmenu', '.ctxmenu', '.mp-pop'], [], () => WHO[id]);
      await key('Escape');
      await ev(`(async () => { await window.__mcf.closeMenus(); document.querySelectorAll('.mp-pop').forEach((p) => p.remove()); return 1; })()`);
      nl++;
    }
  }
  log(`  listes ouvertes : ${nl}`);
}

// ── données de l'accueil (projets et planches aux noms longs) ───────────────
let DATA = null;
async function ensureData() {
  if (DATA) return DATA;
  DATA = await ev(`(async () => {
    const cfg = ${J(TXT)};
    const lists = async () => { const l = await window.mia.projects.list(); return Array.isArray(l) ? l : (l && l.projects) || []; };
    let folders = await window.mia.folders.list();
    folders = Array.isArray(folders) ? folders : (folders && folders.folders) || [];
    const out = { folders: [], boards: [] };
    for (const f of cfg.folders) {
      let fo = folders.find((x) => x.name === f.name);
      if (!fo) { const r = await window.mia.folders.create({ name: f.name, color: f.color }); fo = { id: r.id }; }
      out.folders.push(fo.id);
      const boards = await lists();
      for (const name of f.boards) {
        let b = boards.find((p) => p.name === name && p.folderId === fo.id);
        if (!b) { const r = await window.mia.projects.create({ name, folderId: fo.id }); b = { id: r.id }; }
        out.boards.push(b.id);
      }
    }
    const boards = await lists();
    for (const name of cfg.loose) {
      let b = boards.find((p) => p.name === name && !p.folderId);
      if (!b) { const r = await window.mia.projects.create({ name }); b = { id: r.id }; }
      out.boards.push(b.id);
    }
    await window.__mia.app.home.refresh();
    return out;
  })()`);
  return DATA;
}

// ce que l'outil voulait montrer et qui n'est pas apparu (un menu qui ne s'ouvre pas…) : dit, jamais « ok »
const missed = [];
let viewNo = 0;
const pageMeasure = async (lang, surface, etat, sels, exclude = [], whoOf = null) => {
  const r = await ev(`window.__mcf.page(${J(sels)}, ${J(exclude)})`);
  if (VIEWS) {
    // --vues : la fenêtre entière de chaque état mesuré, pour juger à l'œil
    const s = await send('Page.captureScreenshot', { format: 'png' }, 20000);
    if (s?.result?.data) {
      fs.mkdirSync(path.join(OUT, 'vues'), { recursive: true });
      const slug = `${lang}-${surface}-${etat}`.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 80);
      fs.writeFileSync(path.join(OUT, 'vues', `${String(++viewNo).padStart(3, '0')}-${slug}.png`), Buffer.from(s.result.data, 'base64'));
    }
  }
  if (!r.specs.length) { missed.push(`${lang} · ${surface} · ${etat}`); log(`  (rien à l’écran pour « ${etat} »)`); return 0; }
  await take(r.found, { lang, surface, etat, ...(whoOf ? { whoOf } : {}) }, r.specs);
  return r.found.length;
};

/**
 * Les mêmes onglets pour l'accueil et la planche, dans les deux langues : les planches aux noms longs (deux
 * projets), puis la planche de banc devant (8 onglets, le plafond de Mia).
 */
async function openTabs(data) {
  await ev(`(async () => {
    const app = window.__mia.app;
    for (const id of app.tabs.ids()) await app.closeTab(id);
    for (const id of ${J(data.boards.slice(0, 7))}) await app.openProject(id);
    ${BENCH ? `await app.openProject(${J(BENCH.boardId)});` : ''}
    return app.tabs.ids().length;
  })()`, 120000);
}

async function surfaceHome(lang) {
  log(`\n[${lang}] accueil`);
  const data = await ensureData();
  await openTabs(data);
  for (const [w, h] of PAGE_VIEWS) {
    await setViewport(w, h);
    const E = (s) => `${w}×${h} · ${s}`;
    const M = (etat, sels, ex) => pageMeasure(lang, 'accueil', E(etat), sels, ex);
    await ev('window.__mia.app.goHome()');
    await ev('window.__mia.app.home.openFolder(null)');
    await settle(900);
    log(`  ${w}×${h} accueil : ${await M('projets, planches, recettes, modèles', ['#titlebar', '#view-home'])} constat(s)`);
    await ev(`window.__mia.app.home.openFolder(${J(data.folders[0])})`);
    await settle(900);
    await M('intérieur d’un projet', ['#titlebar', '#view-home']);
    await ev('window.__mia.app.home.openFolder(null)');
    await settle(700);
    for (const [q, what] of [['zzzz introuvable', 'recherche sans résultat'], ['Plan', 'recherche « Plan »']]) {
      await ev(`(() => { const s = document.getElementById('home-search'); s.value = ${J(q)}; s.dispatchEvent(new Event('input', { bubbles: true })); s.blur(); return 1; })()`);
      await settle(600);
      await M(what, ['#view-home']);
    }
    await ev(`(() => { const s = document.getElementById('home-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    await settle(500);
    // menu de tri, menus des cartes (planche puis projet)
    await ev(`document.getElementById('home-sort').click()`);
    await settle(300);
    await M('menu de tri', ['#contextmenu', '.ctxmenu']);
    await ev('window.__mcf.closeMenus()');
    for (const [q, what] of [['#home-grid .card-more', 'menu d’une planche'], ['.home-folders-grid .card-more', 'menu d’un projet']]) {
      // la dernière carte, défilée dans la vue, puis un vrai clic sur son « ⋮ » (un défilement ferme les menus)
      const at = await ev(`(async () => {
        const b = [...document.querySelectorAll(${J(q)})].pop();
        if (!b) return null;
        b.scrollIntoView({ block: 'center', behavior: 'instant' });
        await window.__mcf.frames(2); await window.__mcf.sleep(500);
        const card = b.closest('.card'); if (card) card.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      if (!at) continue;
      await mouse('mouseMoved', at.x, at.y);
      await sleep(250);
      await click(at.x, at.y);
      await settle(350);
      await M(what, ['#contextmenu', '.ctxmenu']);
      await ev('window.__mcf.closeMenus()');
    }
    // nouveautés : la bulle (comme au premier lancement d'une version) puis la fenêtre
    await ev(`(async () => {
      const { t } = await window.__mcf.mod('js/i18n.js'), { toast } = await window.__mcf.mod('js/ui/toasts.js');
      const v = (window.__mia.state.info && window.__mia.state.info.version) || '0.5';
      toast(t('set.newsToast', { v: v.replace(/\\.0$/, '') }), { icon: 'info', ms: 4000, action: { label: t('set.newsSee'), run: () => {} } });
      return 1;
    })()`);
    await settle(700);
    await M('bulle des nouveautés', ['#toasts']);
    await ev(`(async () => { const s = await window.__mcf.mod('js/ui/settings.js'); await s.openNews(); return 1; })()`);
    await settle(800);
    await M('fenêtre des nouveautés', ['#modal-root', '.modal-scrim']);
    await ev(`(async () => { const m = await window.__mcf.mod('js/ui/modal.js'); m.closeTopModal(); return 1; })()`);
    await settle(400);
    // la bibliothèque des modèles
    await ev(`(async () => { const l = await window.__mcf.mod('js/ui/library.js'); l.openLibrary(); return 1; })()`);
    await settle(900);
    await M('bibliothèque des modèles', ['#library']);
    await ev(`(async () => { const l = await window.__mcf.mod('js/ui/library.js'); l.closeLibrary(); return 1; })()`);
    await settle(400);
  }
}

// ── surface « board » : onglets, palette, menus, inspecteur, file ────────────
async function surfaceBoard(lang) {
  log(`\n[${lang}] planche`);
  const data = await ensureData();
  if (!BENCH) { await setViewport(...BLOCK_VIEW); await openBench(); }
  await openTabs(data);
  const ids = [...Object.values(BENCH.rowA), ...Object.values(BENCH.rowB)];
  // une section au titre long autour des sources (une fois)
  await ev(`(() => {
    const e = window.__mia.editor, g = e.getGraph();
    if (!g.groups.some((x) => x.title === ${J(TXT.section)})) e.addSection({ around: ${J([BENCH.img, BENCH.vid].filter(Boolean))} }, { title: ${J(TXT.section)}, select: false });
    return 1;
  })()`);
  for (const [w, h] of PAGE_VIEWS) {
    await setViewport(w, h);
    const E = (s) => `${w}×${h} · ${s}`;
    const M = (etat, sels, ex) => pageMeasure(lang, 'planche', E(etat), sels, ex);
    await ev(`(() => { const t = window.__mia.app.tabs; t.setCollapsed([]); window.__mia.editor.select([]); return 1; })()`);
    await settle(700);
    log(`  ${w}×${h} onglets : ${await M('8 onglets longs, deux projets', ['#titlebar'])} constat(s)`);
    await ev(`(() => { window.__mia.app.tabs.setCollapsed([${J(data.folders[1])}]); return 1; })()`);
    await settle(600);
    await M('8 onglets, un projet replié', ['#titlebar']);
    await ev(`(() => { window.__mia.app.tabs.setCollapsed([]); return 1; })()`);
    // la planche elle-même (dock, zoom, mini-carte)
    await ev(`(() => { const c = window.__mia.editor.__debug.ctx; if (!c.minimap.visible) c.minimap.toggle(); window.__mia.editor.fit(); return 1; })()`);
    await settle(900);
    log(`  ${w}×${h} planche : ${await M('planche, dock, zoom, mini-carte', ['#view-board'], ['#world'])} constat(s)`);
    // la palette : ouverte, recherche sans résultat, recherche pleine
    await ev('window.__mia.editor.openPalette()');
    await settle(600);
    await M('palette ouverte', ['#palette']);
    for (const [q, what] of [['zzzz introuvable', 'palette, recherche sans résultat'], ['vid', 'palette, recherche « vid »']]) {
      await ev(`(() => { const i = document.querySelector('#palette .pal-input'); i.value = ${J(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
      await settle(400);
      await M(what, ['#palette']);
    }
    await ev(`(() => { window.__mia.editor.__debug.ctx.palette.close(); return 1; })()`);
    await settle(400);
    // menu de la planche, au bord droit, et son sous-menu « Recettes »
    await ev(`(() => { const e = window.__mia.editor; e.setCamera({ x: -60000, y: -60000, z: 1 }); return 1; })()`);
    await settle(400);
    await rightClick(w - 24, Math.round(h * 0.45));
    await settle(350);
    await M('menu de la planche au bord', ['#contextmenu', '.ctxmenu']);
    const sub = await ev(`(() => { const b = [...document.querySelectorAll('#contextmenu .ctx-item')].find((x) => x.querySelector('.ctx-sub')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (sub) {
      await mouse('mouseMoved', sub.x, sub.y);
      await sleep(450);
      await M('sous-menu « Recettes » au bord', ['#contextmenu', '.ctxmenu']);
    }
    await ev('window.__mcf.closeMenus()');
    // menu d'un bloc ouvert dans le coin bas-droit
    await ev(`(() => { window.__mia.editor.__debug.ctx.openNodeMenu(${J(BENCH.rowA.i2v || ids[0])}, { x: innerWidth - 8, y: innerHeight - 8 }); return 1; })()`);
    await settle(350);
    await M('menu d’un bloc dans le coin', ['#contextmenu', '.ctxmenu']);
    await ev('window.__mcf.closeMenus()');
    // menu d'un fil : clic droit au milieu du fil vidéo → Assembler branché
    const wire = await ev(`(async () => {
      const e = window.__mia.editor, g = e.getGraph();
      const ed = g.edges.find((x) => x.to.node === ${J(BENCH.rowB.sequence || '')}) || g.edges[0];
      if (!ed) return null;
      const path = () => document.querySelector('#wires [data-id="' + ed.id + '"] .w-line');
      let p = path(); if (!p) return null;
      const mid = (pp) => { const m = pp.getScreenCTM(), q = pp.getPointAtLength(pp.getTotalLength() * 0.8); return { x: q.x * m.a + q.y * m.c + m.e, y: q.x * m.b + q.y * m.d + m.f }; };
      const a = mid(p), st = document.getElementById('stage').getBoundingClientRect(), c = e.camera();
      e.setCamera({ x: c.x + (a.x - st.left) / c.z - (innerWidth - 60 - st.left), y: c.y + (a.y - st.top) / c.z - (innerHeight * 0.6 - st.top), z: 1 });
      await window.__mcf.frames(3); await window.__mcf.sleep(150);
      p = path(); const b = mid(p);
      return { x: Math.round(b.x), y: Math.round(b.y) };
    })()`);
    if (wire) {
      await rightClick(wire.x, wire.y);
      await settle(350);
      await M('menu d’un fil au bord', ['#contextmenu', '.ctxmenu']);
      await ev('window.__mcf.closeMenus()');
    }
    // menu d'une section (clic droit dans son cadre, hors des blocs) et son sous-menu « Teinte »
    const sect = await ev(`(async () => {
      const e = window.__mia.editor, g = e.getGraph().groups.find((x) => x.title === ${J(TXT.section)});
      if (!g) return null;
      const st = document.getElementById('stage').getBoundingClientRect();
      // la marge gauche du cadre, à mi-hauteur (hors des blocs), posée au bord droit de la fenêtre (loin du zoom)
      const wx = g.x + 14, wy = g.y + g.h * 0.5, sx = innerWidth - 40, sy = Math.round(innerHeight * 0.5);
      e.setCamera({ x: wx - (sx - st.left), y: wy - (sy - st.top), z: 1 });
      await window.__mcf.frames(3); await window.__mcf.sleep(150);
      return { x: sx, y: sy };
    })()`);
    if (sect) {
      await rightClick(sect.x, sect.y);
      await settle(350);
      await M('menu d’une section au bord', ['#contextmenu', '.ctxmenu']);
      const tone = await ev(`(() => { const b = [...document.querySelectorAll('#contextmenu .ctx-item')].find((x) => x.querySelector('.ctx-sub')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      if (tone) {
        await mouse('mouseMoved', tone.x, tone.y);
        await sleep(450);
        await M('sous-menu « Teinte » au bord', ['#contextmenu', '.ctxmenu']);
      }
      await ev('window.__mcf.closeMenus()');
      // (le titre d'une section est peint sur le canevas de la planche : hors de portée du détecteur)
    }
    await mouse('mouseMoved', 5, Math.round(h / 2));
    // l'inspecteur de chaque type
    for (const [type, id] of Object.entries(BENCH.rowA)) {
      await ev(`(() => { window.__mia.bus.emit('inspector:open', { nodeId: ${J(id)} }); return 1; })()`);
      await settle(350);
      await pageMeasure(lang, 'planche', E(`inspecteur ${type}`), ['#inspector'], [], () => WHO[id]);
    }
    await ev(`(async () => { const m = await window.__mcf.mod('js/nodes/inspector.js'); m.closeInspector(); return 1; })()`);
    await settle(300);
    // la file de calcul ouverte : quatre en file, un en cours (évènements simulés)
    const qids = ['i2v', 't2v', 'guided', 'real', 'perform'].map((t) => BENCH.rowA[t]).filter(Boolean);
    const bcfg = { img: BENCH.img, vid: BENCH.vid, who: TXT.who, runMsg: TXT.runMsg, err: TXT.err };
    await ev(`window.__mcf.bench.emit(${J(qids.slice(1))}, 'queued', ${J(bcfg)})`);
    await ev(`window.__mcf.bench.emit(${J(qids.slice(0, 1))}, 'running', ${J(bcfg)})`);
    await settle(400);
    await ev(`(() => { const p = document.querySelector('#queue .q-pill'); if (p && !p.classList.contains('open')) p.click(); return !!p; })()`);
    await settle(500);
    await M('file de calcul ouverte', ['#queue']);
    await ev(`(() => { const p = document.querySelector('#queue .q-pill'); if (p && p.classList.contains('open')) p.click(); return 1; })()`);
    await ev(`window.__mcf.bench.emit(${J(qids)}, 'cancelled', {})`);
    // la puce GPU et sa fenêtre
    await ev(`(() => { const c = document.querySelector('.gpu-chip'); if (c) c.click(); return !!c; })()`);
    await settle(500);
    await M('fenêtre de la puce GPU', ['.gpu-pop']);
    await ev(`(() => { const c = document.querySelector('.gpu-chip'); if (document.querySelector('.gpu-pop') && c) c.click(); return 1; })()`);
    await settle(300);
    // une info-bulle au bord droit (le bouton de fermeture de la fenêtre)
    const tipAt = await ev(`(() => { const b = document.getElementById('win-close') || document.getElementById('tb-settings'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (tipAt) {
      await mouse('mouseMoved', tipAt.x, tipAt.y);
      await sleep(900);
      await M('info-bulle au bord droit', ['#tooltip']);
      await mouse('mouseMoved', 5, Math.round(h / 2));
      await sleep(200);
    }
  }
}

// ── déroulé ──────────────────────────────────────────────────────────────
let failed = null;
let firstLang = null;
const cleanup = async () => {
  try { await ev('window.__mcf && window.__mcf.unmark()', 3000); } catch { /* page partie */ }
  try { await send('Emulation.clearDeviceMetricsOverride', {}, 3000); } catch { /* idem */ }
  try { await screencast(false); } catch { /* idem */ }
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup().finally(() => process.exit(130)); });

try {
  await screencast(true);
  await waitReady(null);
  // garde-fou : jamais la Mia de tous les jours (l'outil crée des planches et des projets)
  const info = await ev('window.mia.app.info()');
  const realData = process.env.APPDATA ? path.join(process.env.APPDATA, 'Mia', 'data') : null;
  if (!info?.dataDir || (realData && path.resolve(info.dataDir).toLowerCase() === path.resolve(realData).toLowerCase())) {
    throw new Error('cette Mia utilise les données de tous les jours : lancer une instance de test (MIA_USERDATA, MIA_PROJECTS_ROOT)');
  }
  // l'assistant du premier lancement ne doit pas couvrir la page
  await ev(`(async () => { await window.mia.prefs.set({ welcomeLater: Date.now() }); const w = document.getElementById('welcome'); if (w) w.remove(); return 1; })()`);
  firstLang = await ev('document.documentElement.lang');
  log(`Mia ${info.version} · port ${port} · surfaces ${SURFACES.join(', ')} · langues ${LANGS.join(', ')}`);
  log(`captures et rapport : ${OUT}`);
  const witness = await ev('window.__mcf.selfTest()');
  if (!witness?.ok) throw new Error(`le témoin du détecteur a échoué (sortes manquantes : ${witness?.missing?.join(', ') || '—'} ; pastilles signalées : ${witness?.dots?.join(', ') || '—'})`);
  log('témoin du détecteur : les cinq sortes sont vues, la pastille de port jamais');
  for (const lang of LANGS) {
    await setLang(lang);
    if (SURFACES.includes('blocks')) await surfaceBlocks(lang);
    if (SURFACES.includes('home')) await surfaceHome(lang);
    if (SURFACES.includes('board')) await surfaceBoard(lang);
  }
  if (firstLang && firstLang !== (await ev('document.documentElement.lang'))) await setLang(firstLang);
} catch (err) {
  failed = err?.message || String(err);
} finally {
  await cleanup();
}

// ── rapport ──────────────────────────────────────────────────────────────
const nf = (v) => (Math.round(v * 10) / 10).toLocaleString('fr-FR');
const SIDE = { l: 'à gauche', r: 'à droite', t: 'en haut', b: 'en bas' };
function measureText(f) {
  const ex = f.ex || {};
  const side = () => { const k = ['l', 'r', 't', 'b'].sort((a, b) => (ex[b] || 0) - (ex[a] || 0))[0]; return `${nf(ex[k])} px ${SIDE[k]}`; };
  switch (f.kind) {
    case 'deborde': return `dépasse de ${side()} de ${f.cont?.sel || 'son conteneur'}`;
    case 'coupe': return f.need ? `${f.what} : ${nf(f.need)} px pour ${nf(f.avail)} px` : `${f.what} rogné de ${side()} par ${f.by}`;
    case 'ellipse': return `${f.shown}/${f.total} caractères visibles (${f.ratio} %)`;
    case 'hors-ecran': return `sort de ${side()} de la fenêtre ${f.view?.join('×')}`;
    case 'chevauche': return `${f.pairSel?.join(' et ')} se recouvrent sur ${nf(f.ex.w)} × ${nf(f.ex.h)} px`;
    case 'garde': return `disposition « ${f.apres} » au lieu de « ${f.avant} » à la largeur d’origine`;
    default: return '';
  }
}
const all = [...entries.values()].map((e) => ({
  langue: e.lang, surface: e.surface, type: KIND_FR[e.kind] || e.kind, ou: e.who, selecteur: e.f.sel, texte: e.f.text,
  mesure: measureText(e.f), conteneur: e.f.cont?.sel || null, etats: [...e.etats], capture: e.capture ? path.basename(e.capture) : null,
  brut: { ex: e.f.ex, rect: e.f.rect, cont: e.f.cont?.rect, shown: e.f.shown, total: e.f.total, ratio: e.f.ratio, need: e.f.need, avail: e.f.avail, by: e.f.by },
}));
// rangés par langue, puis par surface (blocs, barre de titre, accueil, planche) ; l'ordre de découverte ensuite
const SURF_ORDER = ['blocs', 'barre de titre', 'accueil', 'planche'];
all.sort((a, b) => LANGS.indexOf(a.langue) - LANGS.indexOf(b.langue) || SURF_ORDER.indexOf(a.surface) - SURF_ORDER.indexOf(b.surface));
const report = { port, dossier: OUT, langues: LANGS, surfaces: SURFACES, erreur: failed, defauts: all, nonMontres: missed, erreursPage: [...new Set(pageErrors)].slice(0, 20) };
try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'rapport.json'), JSON.stringify(report, null, 2)); } catch { /* dossier impossible */ }

if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
else {
  // regroupés : un même défaut sur plusieurs blocs tient sur une ligne
  const groups = new Map();
  for (const d of all) {
    const k = [d.langue, d.surface, d.type, d.selecteur, String(d.texte).replace(/\d+/g, '#')].join('|');
    const g = groups.get(k) || { ...d, ous: [], etatsAll: new Set(), captures: [] };
    if (d.ou) g.ous.push(d.ou);
    d.etats.forEach((x) => g.etatsAll.add(x));
    if (d.capture) g.captures.push(d.capture);
    groups.set(k, g);
  }
  let last = '';
  for (const g of groups.values()) {
    const head = `${g.langue.toUpperCase()} · ${g.surface}`;
    if (head !== last) { console.log(`\n## ${head}`); last = head; }
    const ou = g.ous.length > 3 ? `${g.ous.slice(0, 3).join(' ; ')} … (+${g.ous.length - 3})` : g.ous.join(' ; ');
    const etats = [...g.etatsAll];
    console.log(`- [${g.type}] ${g.selecteur}${g.texte ? ` « ${g.texte} »` : ''} — ${g.mesure}`);
    console.log(`    ${ou ? `${ou} — ` : ''}${etats.length > 4 ? `${etats.slice(0, 4).join(', ')} … (${etats.length} états)` : etats.join(', ')}${g.captures.length ? ` — ${g.captures[0]}${g.captures.length > 1 ? ` (+${g.captures.length - 1})` : ''}` : ''}`);
  }
  if (missed.length) console.log(`\nNon montré (donc non mesuré) :\n${missed.map((m) => `- ${m}`).join('\n')}`);
  if (report.erreursPage.length) console.log(`\nErreurs de la page (${report.erreursPage.length}) :\n${report.erreursPage.slice(0, 8).join('\n')}`);
  console.log(`\nRapport : ${path.join(OUT, 'rapport.json')}`);
  if (failed) console.log(`\nL’OUTIL N’A PAS PU TOUT MESURER : ${failed}`);
  console.log(all.length ? `\nRÉSULTAT : ${all.length} défaut(s) (${LANGS.map((l) => `${l.toUpperCase()} ${all.filter((d) => d.langue === l).length}`).join(', ')}).` : (failed ? '' : '\nRÉSULTAT : rien ne déborde.'));
}
ws.close();
process.exit(failed ? 2 : all.length ? 1 : 0);
