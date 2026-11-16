// ── Cartes des blocs et sections ──────────────────────────────────────
// L'éditeur dessine le cadre de chaque bloc (da.md §4.2) : en-tête avec glyphe,
// titre, état et menu ⋯ ; barre de progression ; rangées de ports avec leurs
// pastilles à cheval sur le bord ; poignée de largeur. Le contenu (aperçu,
// réglages, pied) appartient à F (`nodes/body.js`), monté dans des
// emplacements fixes. Si ce module manque ou échoue, un corps minimal prend le
// relais pour que la planche reste utilisable.
//
// Règles de performance (tech.md §3) : position par `transform` (jamais
// left/top), aucune lecture de mise en page pendant un glisser — les ancres des
// ports sont mesurées une fois, puis à chaque redimensionnement (ResizeObserver).

import { t, tl } from '../i18n.js';
import { icon } from '../icons.js';
import { fmtClock } from '../util.js';
import { typeOf, typeLabel, inputDefs, outputDefs } from '../catalog.js';
import { ms, reduced, play, replayClass } from '../ui/motion.js';
import { tip } from '../ui/tooltip.js';
import { nodeInputs, nodeOutputs, isModelBlock, portsSignature, modelBlockTitle, hiddenInputs, blockWorkflow, startPoints } from '../nodes/ports.js';
import { openAddInput } from '../nodes/addinput.js';
import { portTip } from '../nodes/porthelp.js';

const BORDER = 1;          // filet de la carte (unités monde)
const HEAD_H = 36;         // --node-head-h
const SMALL_WELL = 120;    // en dessous (px écran), les vidéos se mettent en pause (da.md §4.7)

const h = (tag, cls, attrs) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};
const glyph = (name, size) => icon(name, size) || icon('g-unknown', size) || '';

/**
 * Titre affiché d'un bloc : celui donné par Quentin ; pour un Média, le rôle
 * annoncé par la recette (« Image de début », gardé en FR et EN dans
 * `data.role` puis `data.placeholder`, et traduit à l'affichage : changer de
 * langue change le titre), sinon le nom du fichier ; sinon le nom du type.
 */
export const displayTitle = (node) => node.title
  || (node.type === 'import' && (
    (node.data?.role && tl(node.data.role))
    || (node.data?.placeholder && tl(node.data.placeholder))
    || node.data?.name))
  || (isModelBlock(node) && modelBlockTitle(node))       // bloc Modèle : le nom de sa famille (SPEC §23)
  || typeLabel(node.type) || node.type;

/** Le titre « par défaut » (sans nom donné par Quentin) : revenir à lui = effacer le titre. */
export const defaultTitle = (node) => displayTitle({ ...node, title: null });

/**
 * Change le texte d'un élément sans remplacer son nœud texte. `textContent =` retire et insère un
 * nœud : une mutation de structure qui, avec les :has() de la page (queue.css), restylait toute la
 * planche (≈ 7 ms par écriture, mesuré) ; changer `data` coûte dix fois moins.
 */
export function setText(el, s) {
  const f = el.firstChild;
  if (f && f.nodeType === 3 && !f.nextSibling) { if (f.data !== s) f.data = s; }
  else if (el.textContent !== s) el.textContent = s;
}

// ── une carte ─────────────────────────────────────────────────────────

export class NodeView {
  constructor(ed, node, { animate = false } = {}) {
    this.ed = ed;
    this.id = node.id;
    this.type = typeOf(node.type);
    this.h = estimateHeight(node, this.type);
    this.anchors = { in: new Map(), out: new Map() };
    this.ports = { in: new Map(), out: new Map() };
    this.visible = true;
    this.small = false;
    this.lastRun = null;

    const el = this.el = h('article', 'node');
    el.dataset.id = node.id;
    el.dataset.type = node.type;
    if (!this.type) el.classList.add('unknown');

    this.prog = h('div', 'n-prog');
    this.head = h('header', 'n-head');
    this.glyphEl = h('span', 'n-glyph');
    this.glyphEl.innerHTML = glyph(this.type?.icon || 'g-unknown', 14);
    this.thumb = h('span', 'n-thumb');
    this.titleEl = h('span', 'n-title');
    // un titre coupé par « … » (carte étroite, nom long) se lit en entier au survol
    tip(this.titleEl, () => (!this.renaming && this.titleEl.scrollWidth > this.titleEl.clientWidth + 1 ? this.titleEl.textContent : ''));
    this.staleEl = h('span', 'n-stale');
    this.staleEl.dataset.tip = t('graph.stale');
    this.stateEl = h('span', 'n-state');
    this.status = h('span', 'n-status');
    this.more = h('button', 'n-more', { type: 'button', tabindex: '-1' });
    this.more.innerHTML = glyph('more', 16);
    this.more.dataset.tip = t('graph.tip.more');
    this.head.append(this.glyphEl, this.thumb, this.titleEl, this.staleEl, h('span', 'n-gap'), this.stateEl, this.status, this.more);

    this.preview = h('div', 'n-preview');
    this.portsEl = h('div', 'n-ports');
    this.controls = h('div', 'n-controls');
    this.resizer = h('div', 'n-resize');
    // pastilles du mode replié : tous les ports se rejoignent au centre de l'en-tête
    this.cIn = h('i', 'n-cdot in');
    this.cOut = h('i', 'n-cdot out');
    // (en vue lointaine, le titre à taille écran est peint sur le canevas de la
    // planche : un élément par carte coûtait une couche composée chacun)

    el.append(this.prog, this.head, this.preview, this.portsEl, this.controls, this.resizer, this.cIn, this.cOut);
    this._buildPorts(node);

    // F remplit parfois l'emplacement d'état lui-même : on s'efface alors pour
    // ne pas écrire deux fois « 47 % » dans l'en-tête
    this._statusObs = new MutationObserver(() => {
      el.classList.toggle('f-status', this.status.childNodes.length > 0);
    });
    this._statusObs.observe(this.status, { childList: true });

    this.more.addEventListener('click', (e) => {
      e.stopPropagation();
      ed.openNodeMenu(this.id, this.more);
    });
    el.addEventListener('pointerenter', () => ed.setHover(this.id));
    el.addEventListener('pointerleave', () => ed.setHover(null, this.id));

    this.apply(node, true);
    if (animate) {
      // `scale` se compose avec la translation : l'origine est en coordonnées monde — le point
      // de pose s'il y en a un (double-clic, fil lâché : la carte naît de là), sinon son centre
      const o = ed.poseOrigin;
      if (o && Number.isFinite(o.x) && Number.isFinite(o.y)) this.el.style.transformOrigin = `${o.x}px ${o.y}px`;
      else this._centerOrigin(node);
      el.classList.add('entering');
      // les animations du contenu remontent aussi jusqu'ici, et l'anneau de sélection
      // (::before, 120 ms) a la carte pour cible : on attend l'arrivée elle-même
      const done = (e) => {
        if (e.target !== el || e.pseudoElement || e.animationName !== 'g-node-in') return;
        el.removeEventListener('animationend', done);
        el.classList.remove('entering');
        el.style.transformOrigin = '';
      };
      el.addEventListener('animationend', done);
    }
    this._mountBody(node);
  }

  // ── ports ──

  /** Entrées reliées de ce bloc (un bloc Modèle garde, grisées, celles que son modèle ne prend pas). */
  _connected() {
    const out = [];
    for (const e of this.ed.doc.edges) if (e.to.node === this.id && !out.includes(e.to.port)) out.push(e.to.port);
    return out;
  }

  _buildPorts(node) {
    const connected = this._connected();
    const opts = this._portOpts();
    const ins = nodeInputs(node, connected, opts), outs = nodeOutputs(node);
    this._portsSig = portsSignature(node, connected, opts);
    this.portsEl.replaceChildren();
    this.ports.in.clear();
    this.ports.out.clear();
    const rows = Math.max(ins.length, outs.length);
    for (let i = 0; i < rows; i++) {
      const row = h('div', 'n-row');
      if (ins[i]) row.append(this._port(ins[i], 'in'));
      if (outs[i]) row.append(this._port(outs[i], 'out'));
      this.portsEl.append(row);
    }
    // bloc Modèle vide : « Partir de : Image de début · Rendu 3D · Vidéo guide · Fiche personnage » — rien d'imposé
    const starts = isModelBlock(node) && !this.reveal?.length ? startPoints(node, connected) : [];
    if (starts.length) {
      const row = h('div', 'n-row n-startrow');
      const lbl = h('span', 'n-start-lbl');
      lbl.textContent = t('graph.port.startFrom');
      row.append(lbl);
      for (const sp of starts) {
        const b = h('button', 'n-start', { type: 'button' });
        b.textContent = tl(sp.label);
        b.dataset.tip = t('graph.port.startTip', { what: sp.what.map((w) => tl(w)).join(' · ') + (sp.trial ? t('graph.port.startTrial') : '') });
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => { e.stopPropagation(); if (!this.ed.readonly) this._showPort(sp.id, true); });
        row.append(b);
      }
      // les entrées d'appoint (images-clés, son à suivre…) restent à un « + » près
      if (hiddenInputs(node, connected).some((d) => !starts.some((s) => s.id === d.id))) row.append(this._addButton('n-start n-start-more', 12));
      this.portsEl.append(row);
    }
    // bloc Modèle : « + Ajouter » une entrée que le modèle sait prendre (le reste du temps, elles restent rangées)
    else if (isModelBlock(node) && !this.reveal?.length && hiddenInputs(node, connected).length) {
      const row = h('div', 'n-row n-addrow');
      row.append(this._addButton('n-add', 13, t('graph.port.add')));
      this.portsEl.append(row);
    }
    this.el.classList.toggle('no-ports', rows === 0);
    this.el.classList.toggle('no-in', !ins.length);
    this.el.classList.toggle('no-out', !outs.length);
  }

  /** Bouton « + » (« Ajouter ») : le menu des entrées que le modèle sait prendre et qui ne sont pas montrées. */
  _addButton(cls, size, text) {
    const add = h('button', cls, { type: 'button' });
    add.innerHTML = text ? `${glyph('plus', size)}<span>${text}</span>` : glyph('plus', size);
    if (!text) add.setAttribute('aria-label', t('graph.port.add'));
    add.dataset.tip = t('graph.port.addTip');
    add.addEventListener('pointerdown', (e) => e.stopPropagation());
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.ed.readonly) return;
      openAddInput(this.ed.doc.node(this.id), add, hiddenInputs(this.ed.doc.node(this.id), this._connected()), (id) => this._showPort(id, true),
        (value) => this.ed.api.setParam(this.id, 'model', value));
    });
    return add;
  }

  _port(def, dir) {
    const p = h('div', `n-port ${dir}`);
    p.dataset.port = def.id;
    p.dataset.dir = dir;
    if (def.multi) p.dataset.multi = '';
    if (def.unused) p.classList.add('unused');
    if (def.peek) p.classList.add('peek');
    if (def.ignored) p.classList.add('ignored');
    const dot = h('i', 'dot');
    const lbl = h('span', 'lbl');
    lbl.textContent = tl(def.label);
    // au survol : ce qu'est l'entrée, à quoi elle sert, et ce que le modèle du bloc en fait (porthelp.js)
    tip(p, () => {
      const node = this.ed.doc.node(this.id);
      const r = portTip(node, def, dir, p.dataset.t || def.type);
      if (r && def.unused) r.body = t('graph.port.unused');
      if (r && def.ignored) {
        const w = blockWorkflow(node, this._connected());
        if (w) r.meta = [t('port.ignored', { what: tl(w.workflow.label || {}) }), r.meta].filter(Boolean).join(' · ');
      }
      return r;
    });
    p.append(dot, lbl);
    if (def.removable) {
      // une entrée ajoutée avec « + » et restée vide : × pour la ranger
      const x = h('button', 'n-unshow', { type: 'button' });
      x.innerHTML = glyph('close', 11);
      x.dataset.tip = t('graph.port.remove');
      x.addEventListener('pointerdown', (e) => e.stopPropagation());
      x.addEventListener('click', (e) => { e.stopPropagation(); this._showPort(def.id, false); });
      p.append(x);
    }
    this.ports[dir].set(def.id, { el: p, dot, lbl, def });
    return p;
  }

  /** Montre (« + Ajouter ») ou range (×) une entrée d'un bloc Modèle : node.data.shown, annulable. */
  _showPort(id, on) {
    const node = this.ed.doc.node(this.id);
    if (!node || this.ed.readonly) return;
    const cur = Array.isArray(node.data?.shown) ? node.data.shown : [];
    const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
    this.ed.api.updateNode(this.id, { data: { shown: next } });
  }

  _portOpts() { return { extra: this.reveal || [], hold: this.hold || [] }; }

  /** Refait les rangées d'un bloc Modèle (révélation, fin d'un geste) ; true si c'en est un. */
  rebuildPorts() {
    const node = this.ed.doc.node(this.id);
    if (!node || !isModelBlock(node)) return false;
    this._buildPorts(node);
    this.refreshPorts();
    this.measure();
    return true;
  }

  /**
   * Pendant qu'on tire un fil : les entrées rangées qui peuvent le recevoir (`ids`) se montrent, le temps du geste ;
   * `null` les range. Renvoie true si les pastilles ont bougé (l'appelant retrace les fils).
   */
  setReveal(ids) {
    const next = ids?.length ? [...ids] : null;
    if ((this.reveal || []).join() === (next || []).join()) return false;
    this.reveal = next;
    return this.rebuildPorts();
  }

  /** Types concrets et état relié/libre des pastilles (après tout changement de fils). */
  refreshPorts() {
    const ed = this.ed;
    for (const dir of ['in', 'out']) {
      for (const [id, p] of this.ports[dir]) {
        const type = ed.portType(this.id, id, dir) || 'media';
        if (p.el.dataset.t !== type) p.el.dataset.t = type;
        const n = ed.connections(this.id, id, dir);
        p.el.classList.toggle('on', n > 0);
        if (p.def.multi) {
          const base = tl(p.def.label);
          // entrée bornée (SPEC §17) : « 3 / 9 » dès le premier fil, on voit ce qui reste
          const txt = p.def.max > 0 ? (n > 0 ? `${base} · ${n} / ${p.def.max}` : base) : n > 1 ? `${base} · ${n}` : base;
          setText(p.lbl, txt);
        }
      }
    }
    // pastilles du mode replié : type de la première entrée / sortie
    const fi = this.ports.in.values().next().value, fo = this.ports.out.values().next().value;
    this.cIn.hidden = !fi;
    this.cOut.hidden = !fo;
    if (fi) { this.cIn.dataset.t = fi.el.dataset.t; this.cIn.classList.toggle('on', fi.el.classList.contains('on')); }
    if (fo) { this.cOut.dataset.t = fo.el.dataset.t; this.cOut.classList.toggle('on', fo.el.classList.contains('on')); }
  }

  /** Mesure les ancres des ports en coordonnées locales. Renvoie true si elles ont bougé. */
  measure() {
    // une carte hors vue garde sa mise en page (visibility) : la mesure reste juste
    const node = this.ed.doc.node(this.id);
    if (!node) return false;
    const hgt = this.el.offsetHeight;
    // ce qui, sur la carte elle-même, change sa mise en page (voir Views._touch)
    this.mw = this.el.style.width;
    this.mc = this.el.classList.contains('collapsed');
    if (hgt > 0) {
      this.h = hgt;
      // hauteur type d'un bloc sans média : sert d'estimation au prochain du même type
      if (node.type !== 'import' && !node.collapsed) typeHeights.set(`${node.type}|${node.w}`, hgt);
    }
    let moved = false;
    for (const dir of ['in', 'out']) {
      for (const [id, p] of this.ports[dir]) {
        let y;
        if (node.collapsed) y = BORDER + HEAD_H / 2;
        else {
          const row = p.el.parentElement;
          y = BORDER + row.offsetTop + row.offsetHeight / 2;
        }
        if (this.anchors[dir].get(id) !== y) { this.anchors[dir].set(id, y); moved = true; }
      }
    }
    return moved;
  }

  /**
   * Point d'accroche local d'un port (y), avec repli sur une estimation tant qu'on n'a pas mesuré.
   * Si la carte a changé de largeur ou de repli depuis la dernière mesure (poignée de largeur,
   * updateNode, annuler), ses puits ont suivi la largeur et les rangées de ports ont déjà bougé :
   * on remesure ici, tout de suite, au lieu de tracer le fil sur l'ancienne mise en page jusqu'au
   * passage du ResizeObserver (une image plus tard, ou jamais dans une fenêtre qui ne peint pas).
   */
  anchorY(portId, dir) {
    if (this.mw !== undefined && this.el.isConnected
      && (this.el.style.width !== this.mw || this.el.classList.contains('collapsed') !== this.mc)) this.measure();
    const v = this.anchors[dir].get(portId);
    if (v != null) return v;
    const node = this.ed.doc.node(this.id);
    if (node?.collapsed) return BORDER + HEAD_H / 2;
    const list = dir === 'out' ? nodeOutputs(node) : nodeInputs(node, this._connected());
    const i = Math.max(0, list.findIndex((p) => p.id === portId));
    return BORDER + HEAD_H + (this.preview.childNodes.length ? 200 : 6) + i * 28 + 14;
  }

  // ── état du modèle → DOM ──

  /**
   * Applique position, largeur, titre et drapeaux. Ne touche que ce qui change.
   * Renvoie true si la mise en page de la carte a pu changer (largeur, repli) :
   * ses ancres sont alors à remesurer avant de tracer les fils.
   */
  apply(node, first = false) {
    const el = this.el;
    let relayout = false;
    const tr = `translate(${node.x}px, ${node.y}px)`;
    if (el.style.transform !== tr) el.style.transform = tr;
    const w = `${node.w}px`;
    if (el.style.width !== w) { el.style.width = w; relayout = true; }
    const title = displayTitle(node);
    if (this.titleEl.textContent !== title && !this.renaming) this.titleEl.textContent = title;
    if (el.classList.contains('collapsed') !== !!node.collapsed) {
      el.classList.toggle('collapsed', !!node.collapsed);
      relayout = true;
      if (!first) this._fold(!!node.collapsed);
    }
    el.classList.toggle('bypass', !!node.bypass);
    // bloc Modèle : un autre modèle, d'autres entrées (SPEC §23) — les rangées sont refaites, les fils suivent
    if (!first && isModelBlock(node) && portsSignature(node, this._connected(), this._portOpts()) !== this._portsSig) {
      this._buildPorts(node);
      this.refreshPorts();
      relayout = true;
    }
    if (first) this.refreshPorts();
    if (node.collapsed) this._thumb(node);
    return relayout && !first;
  }

  /**
   * Replier / déplier en hauteur animée (FLIP, SPEC §20.1) : la carte a déjà sa nouvelle
   * forme (les fils sont sur leurs pastilles) ; un clip-path la referme comme un store,
   * ou la déroule depuis l'en-tête. Le contenu reste affiché le temps de se refermer.
   */
  _fold(collapsing) {
    const el = this.el;
    this._foldAnim?.cancel();
    this._foldAnim = null;
    el.classList.remove('folding');
    if (reduced() || !el.isConnected || !this.visible || this.ed.lod >= 2) return;
    const shut = `inset(-4px -16px calc(100% - ${HEAD_H + 2}px) -16px)`;
    const open = 'inset(-4px -16px 0px -16px)';
    if (collapsing) el.classList.add('folding');
    const a = play(el, [{ clipPath: collapsing ? open : shut }, { clipPath: collapsing ? shut : open }],
      { dur: 'enter', easing: collapsing ? 'cam' : 'out' });
    if (!a) { el.classList.remove('folding'); return; }
    this._foldAnim = a;
    const end = () => {
      if (this._foldAnim !== a) return;
      this._foldAnim = null;
      el.classList.remove('folding');
    };
    a.finished.then(end, end);
  }

  /** Un fil vient d'arriver sur ce port : un battement de la pastille (220 ms, sans halo). */
  pulsePort(portId, dir) {
    const node = this.ed.doc.node(this.id);
    const dot = node?.collapsed
      ? (dir === 'in' ? this.cIn : this.cOut)
      : this.ports[dir]?.get(portId)?.dot;
    if (dot) replayClass(dot, 'pulse', { timeout: ms('pulse') });
  }

  /** Porté (glisser) : l'ombre s'allonge ; reposé : elle revient en fondu. */
  lift(on) {
    const el = this.el;
    if (on) { el.classList.remove('landing'); el.classList.add('lifted'); return; }
    if (!el.classList.contains('lifted')) return;
    el.classList.remove('lifted');
    replayClass(el, 'landing', { timeout: ms('exit') });
  }

  _centerOrigin(node) {
    this.el.style.transformOrigin = `calc(${node.x}px + 50%) calc(${node.y}px + 50%)`;
  }

  /** Déplacement pendant un glisser : une seule écriture. */
  setPos(x, y) { this.el.style.transform = `translate(${x}px, ${y}px)`; }

  setSelected(on) { this.el.classList.toggle('sel', on); }

  raise(z) { this.el.style.zIndex = String(z); }

  _thumb(node) {
    const url = this.ed.thumbFor(node);
    if (!url) { this.thumb.replaceChildren(); this.thumb.classList.remove('has'); this.el.classList.remove('has-thumb'); return; }
    let img = this.thumb.firstChild;
    if (!img) { img = h('img', null, { alt: '', draggable: 'false', decoding: 'async' }); this.thumb.append(img); }
    if (img.getAttribute('src') !== url) img.setAttribute('src', url);
    this.thumb.classList.add('has');
    this.el.classList.add('has-thumb');
  }

  /**
   * État de calcul (da.md §4.5) : barre de 2 px, texte mono dans l'en-tête,
   * filet rouge en erreur, anneau « périmé » à côté du titre. Le corps (F)
   * reçoit le même état par `onRun`.
   */
  setRun(st, current, stale) {
    const kind = st?.kind || 'idle';
    const el = this.el;
    const prev = el.dataset.state || 'idle';
    if (prev !== kind) el.dataset.state = kind;
    // une erreur qui arrive (pas celle qu'on retrouve en ouvrant la planche) : léger refus de l'en-tête
    if (kind === 'error' && prev !== 'error' && this._seenRun) replayClass(el, 'err-shake', { timeout: ms('fade') });
    // un calcul qui finit bien devant Quentin : une petite coche qui se trace, une fois
    // (runs.js dit « done » quand une version existe, le repli de l'éditeur « idle »)
    if ((kind === 'done' || kind === 'idle') && (prev === 'running' || prev === 'queued' || prev === 'waiting-gpu')
      && current && current.status !== 'error' && current.runId !== this._lastDone) this._tick();
    if (current?.runId) this._lastDone = current.runId;
    this._seenRun = true;

    // barre de progression
    const busy = kind === 'running';
    const p = st?.progress;
    if (busy) {
      if (this.prog.classList.contains('filling')) { clearTimeout(this._progT); this.prog.classList.remove('filling'); }
      this.prog.classList.remove('fade');
      if (!this.prog.classList.contains('on')) this.prog.style.setProperty('--z', String(this.ed.cam.z));
      this.prog.classList.add('on');
      const indet = p == null || !(p >= 0);
      this.prog.classList.toggle('indet', indet);
      if (!indet) this.prog.style.setProperty('--p', String(Math.max(0.02, Math.min(1, p))));
    } else if (this.prog.classList.contains('on') && !this.prog.classList.contains('filling')) {
      // fin de barre. Réussie : elle se remplit d'abord (--dur-pop), puis s'efface ; une barre
      // qui s'éteint à 90 % ferait « interrompu ». Erreur, annulation ou barre sans chiffre
      // (indéterminée) : fondu direct.
      const prog = this.prog;
      clearTimeout(this._progT);
      const fade = () => {
        prog.classList.add('fade');
        prog.classList.remove('on', 'filling');
        this._progT = setTimeout(() => prog.classList.remove('fade', 'indet'), ms('cam') + 20);
      };
      const ok = (kind === 'done' || kind === 'idle') && current && current.status !== 'error'
        && !prog.classList.contains('indet') && !reduced();
      if (ok) {
        prog.classList.remove('indet');
        prog.classList.add('filling');
        prog.style.setProperty('--p', '1');
        this._progT = setTimeout(fade, ms('pop') + 20);
      } else fade();
    }

    // texte d'état
    let txt = '', tip = '';
    if (kind === 'queued') txt = t('graph.state.queued');
    else if (kind === 'waiting-gpu') {
      txt = t('graph.state.waiting');
      if (st.who) tip = t('graph.state.waitingWho', { who: st.who });
    } else if (kind === 'running') {
      if (p != null && p >= 0) {
        txt = t('graph.pct', { n: Math.round(p * 100) });
        if (st.eta > 0) {
          txt += ` · ${clock(st.eta)}`;
          tip = t('graph.state.eta', { time: fmtClock(Date.now() + st.eta * 1000) });
        }
      } else txt = t('graph.state.running');
      if (st.message) tip = tip ? `${st.message} — ${tip}` : st.message;
    } else if (kind === 'error') {
      txt = t('graph.state.error');
      tip = st.message || '';
    } else if (kind === 'cancelled') txt = t('graph.state.cancelled');
    else if (current && current.status !== 'error') {
      const d = current.finished && current.started ? (current.finished - current.started) / 1000 : 0;
      txt = d > 0 ? t('graph.state.doneIn', { d: durShort(d) }) : t('graph.state.done');
    }
    setText(this.stateEl, txt);
    if (tip) this.stateEl.dataset.tip = tip; else delete this.stateEl.dataset.tip;

    this.staleEl.classList.toggle('on', !!stale && kind !== 'running' && kind !== 'queued');
    this.lastRun = st;
    // le corps (F) n'est prévenu que si l'état a vraiment changé : cette méthode
    // est rappelée après chaque modification du graphe, pour l'anneau « périmé »
    const sig = `${kind}|${p}|${st?.eta}|${st?.message}|${st?.jobId}|${st?.preview}|${current?.runId}|${!!stale}`;
    if (sig !== this._runSig && this.body?.onRun) {
      this._runSig = sig;
      try { this.body.onRun(st || { kind: 'idle' }); } catch (e) { console.error('[editor] onRun', e); }
    }
    const node = this.ed.doc.node(this.id);
    if (node?.collapsed) this._thumb(node);
  }

  /** « Fait » : coche tracée en 300 ms, gardée 2,4 s, effacée en fondu. */
  _tick() {
    if (reduced()) return;
    this.doneEl?.remove();
    clearTimeout(this._doneT);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'n-done');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<path d="M3.5 8.5l3 3 6-6.5"/>';
    this.doneEl = svg;
    this.stateEl.before(svg);
    this._doneT = setTimeout(() => {
      svg.classList.add('out');
      this._doneT = setTimeout(() => { svg.remove(); if (this.doneEl === svg) this.doneEl = null; }, ms('cam') + 60);
    }, 2400);
  }

  /** Le bloc entre ou sort de la vue, ou devient trop petit pour jouer ses vidéos. */
  setVisibility(visible, small) {
    const changed = visible !== this.visible || small !== this.small;
    if (!changed) return;
    this.visible = visible;
    this.small = small;
    this.el.classList.toggle('off', !visible);
    // les vidéos de F ont leur propre gestion (IntersectionObserver, taille du
    // puits) : l'éditeur ne pilote que celles de son corps minimal, et prévient
    // tout le monde par un évènement sur la carte
    if (this.body?.minimal) {
      const play = visible && !small;
      for (const v of this.el.querySelectorAll('video')) {
        if (!play && !v.paused) { v.dataset.miaPaused = '1'; v.pause(); }
        else if (play && v.dataset.miaPaused) { delete v.dataset.miaPaused; v.play().catch(() => {}); }
      }
    }
    this.el.dispatchEvent(new CustomEvent('mia:visibility', { detail: { visible, small } }));
  }

  // ── corps (F) ──

  _mountBody(node) {
    const slots = { head: this.head, status: this.status, progress: this.prog, preview: this.preview, controls: this.controls };
    const api = this.ed.bodyApi(this.id);
    const mod = this.ed.bodyModule;
    if (mod?.mountBody && this.type) {
      try {
        this.body = mod.mountBody(node, this.type, slots, api) || null;
        return;
      } catch (e) {
        console.error(`[editor] corps du bloc « ${node.type} » en échec, corps minimal à la place`, e);
        this.preview.replaceChildren();
        this.controls.replaceChildren();
      }
    }
    this.body = minimalBody(node, this.type, slots, api);
  }

  /** Le modèle a changé de l'extérieur (annuler, réglage, amont) : on prévient le corps. */
  updateBody(node) {
    if (!this.body?.update) return;
    try { this.body.update(node); } catch (e) { console.error('[editor] update', e); }
  }

  startRename(onDone) {
    if (this.renaming) return;
    this.renaming = true;
    const node = this.ed.doc.node(this.id);
    const input = h('input', 'n-title-input', { type: 'text', spellcheck: 'false' });
    input.value = displayTitle(node);
    this.titleEl.replaceChildren(input);
    this.el.classList.add('renaming');
    input.focus();
    input.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      this.renaming = false;
      this.el.classList.remove('renaming');
      const v = input.value.trim();
      this.titleEl.textContent = displayTitle(this.ed.doc.node(this.id) || node);
      onDone(ok ? v : null);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  destroy(animate = false) {
    this._statusObs.disconnect();
    clearTimeout(this._progT);
    clearTimeout(this._doneT);
    this._foldAnim?.cancel();
    try { this.body?.destroy?.(); } catch (e) { console.error('[editor] destroy', e); }
    this.body = null;
    for (const v of this.el.querySelectorAll('video')) { try { v.pause(); } catch { /* déjà libérée */ } }
    if (animate && !reduced()) {
      const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(this.el.style.transform);
      if (m) this._centerOrigin({ x: +m[1], y: +m[2] });
      this.el.classList.remove('sel', 'lifted');
      this.el.classList.add('leaving');
      this.el.style.pointerEvents = 'none';
      setTimeout(() => this.el.remove(), ms('pop') + 20);
    } else this.el.remove();
  }
}

// ── gestionnaire ──────────────────────────────────────────────────────
// Les sections ne sont plus des éléments du DOM : elles sont peintes sur le
// canevas de la planche (sections.js), comme dans Slate.

export class Views {
  constructor(ed, nodesEl) {
    this.ed = ed;
    this.nodesEl = nodesEl;
    this.nodes = new Map();
    this.lod = 0;
    // une seule observation pour toutes les cartes ; le rappel arrive après la
    // mise en page, les lectures d'offset y sont gratuites
    this.ro = new ResizeObserver((entries) => {
      for (const en of entries) {
        const v = this.nodes.get(en.target.dataset.id);
        if (!v) continue;
        const h0 = v.h;
        const moved = v.measure();
        ed.onNodeResized(v.id, moved, h0);
      }
    });

    // Le ResizeObserver ne passe qu'au rendu d'une image, et une fenêtre qui ne
    // peint pas (cachée : tests, assistants ; réduite) n'en rend aucune. Un contenu
    // qui change alors (aperçu rempli par F, image ou vidéo chargée, police arrivée)
    // laisserait les fils loin de leurs pastilles. On note donc les cartes dont le
    // contenu bouge ; si une image arrive, son ResizeObserver s'en charge (rien à
    // lire ici : pas de mise en page forcée pendant qu'une vidéo joue) ; sinon on
    // les remesure nous-mêmes, peu après (_schedule).
    this.dirty = new Set();
    this.flushT = 0;
    this.flushRaf = 0;
    this.mo = new MutationObserver((recs) => { for (const r of recs) this._touch(r.target, r); });
    this.mo.observe(nodesEl, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'src', 'poster', 'width', 'height', 'rows', 'open']
    });
    // chargements de médias (ne remontent pas : capture), taille de vidéo connue
    const onMedia = (e) => this._touch(e.target, null);
    for (const type of ['load', 'loadedmetadata', 'resize', 'error']) nodesEl.addEventListener(type, onMedia, true);
    this.onFonts = () => { for (const id of this.nodes.keys()) this.dirty.add(id); this._schedule(); };
    try { document.fonts?.addEventListener('loadingdone', this.onFonts); } catch { /* sans FontFaceSet */ }
  }

  /** Un changement dans le DOM d'une carte : elle sera remesurée juste après. */
  _touch(target, rec) {
    const el = target && (target.nodeType === 1 ? target : target.parentElement);
    // la pastille du lecteur (posée par-dessus le puits) et l'avancement d'un son se
    // réécrivent à chaque image pendant la lecture sans jamais changer la hauteur de la carte
    if (rec && (el?.closest?.('.media-ctl')
      || (rec.type === 'attributes' && rec.attributeName === 'style' && el?.classList?.contains('nb-audio')))) return;
    const card = el?.closest?.('.node');
    if (!card) return;
    const v = this.nodes.get(card.dataset.id);
    if (!v || v.el !== card) return;
    // la carte elle-même : glisser (transform), premier plan, sélection, hors vue…
    // rien de cela ne change sa mise en page ; seuls largeur et repli comptent
    if (rec && rec.type === 'attributes' && rec.target === card
      && card.style.width === v.mw && card.classList.contains('collapsed') === v.mc) return;
    this.dirty.add(v.id);
    this._schedule();
  }

  /**
   * Une fenêtre qui peint rend une image sous ~16 ms : le ResizeObserver de cette
   * image (avant qu'elle soit peinte) remesure ce qui a changé de taille, et la
   * remesure de secours est annulée. Sans image dans les 80 ms, on remesure ici.
   */
  _schedule() {
    if (this.flushT) return;
    this.flushT = setTimeout(() => this._flush(), 80);
    this.flushRaf = requestAnimationFrame(() => {
      this.flushRaf = 0;
      clearTimeout(this.flushT);
      this.flushT = 0;
      this.dirty.clear();
    });
  }

  /** Remesure les cartes touchées (fenêtre qui ne peint pas). */
  _flush() {
    this.flushT = 0;
    if (this.flushRaf) { cancelAnimationFrame(this.flushRaf); this.flushRaf = 0; }
    if (!this.dirty.size) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const v = this.nodes.get(id);
      if (!v || !v.el.isConnected) continue;
      const h0 = v.h;
      const moved = v.measure();
      if (moved || v.h !== h0) this.ed.onNodeResized(v.id, moved, h0);
    }
  }

  get(id) { return this.nodes.get(id) || null; }

  clear() {
    for (const v of this.nodes.values()) { this.ro.unobserve(v.el); v.destroy(false); }
    this.nodes.clear();
    this.dirty.clear();
    this.mo.takeRecords();
    clearTimeout(this.flushT);
    if (this.flushRaf) cancelAnimationFrame(this.flushRaf);
    this.flushT = this.flushRaf = 0;
  }

  add(node, opts) {
    const v = new NodeView(this.ed, node, opts);
    this.nodes.set(node.id, v);
    this.nodesEl.append(v.el);
    this.ro.observe(v.el);
    return v;
  }

  remove(id, animate = false) {
    const v = this.nodes.get(id);
    if (!v) return;
    this.ro.unobserve(v.el);
    v.destroy(animate);
    this.nodes.delete(id);
  }

  /**
   * Réconcilie le DOM avec le document (chargement, annuler, coller…). Les
   * cartes qui survivent sont mises à jour sur place : leurs vidéos continuent.
   * `changed` = ids dont le contenu a pu changer (le corps est prévenu).
   */
  sync({ changed = null, animateNew = false } = {}) {
    const doc = this.ed.doc;
    const live = new Set();
    const relaid = [];
    for (const n of doc.nodes) {
      live.add(n.id);
      const v = this.nodes.get(n.id);
      if (!v) { this.add(n, { animate: animateNew }); continue; }
      if (v.el.dataset.type !== n.type) {
        // même id, autre type (rare : restauration croisée) → on reconstruit
        this.remove(n.id);
        this.add(n, { animate: false });
        continue;
      }
      if (v.apply(n)) relaid.push(v);
      if (!changed || changed.has(n.id)) v.updateBody(n);
    }
    for (const id of [...this.nodes.keys()]) if (!live.has(id)) this.remove(id, animateNew);
    this.refreshPorts();
    // Largeur ou repli changés (annuler, assistant, tous les blocs élargis d'un coup) :
    // les puits suivent la largeur, donc les rangées de ports descendent tout de suite.
    // On remesure maintenant (une seule mise en page pour tout le lot) pour que les fils
    // tracés juste après tombent déjà sur les pastilles, sans attendre le
    // ResizeObserver de l'image suivante.
    this.remeasure(relaid);
  }

  /**
   * Remesure ces cartes tout de suite (écritures d'abord, lectures ensuite : une
   * seule mise en page forcée). Les fils sont retracés par l'appelant (wires.sync,
   * juste après) ; le ResizeObserver passera ensuite sans rien à refaire.
   */
  remeasure(list) {
    for (const v of list || []) if (v.el.isConnected) v.measure();
  }

  refreshPorts(ids = null) {
    for (const v of this.nodes.values()) if (!ids || ids.has(v.id)) v.refreshPorts();
  }

  /**
   * Élimine ce qui sort de la vue et met en pause les vidéos trop petites.
   * `revealOnly` (au milieu d'un geste de caméra) : on ne fait que montrer les cartes qui
   * entrent ; cacher celles qui sortent attend la fin du geste (settle). Basculer `.off` sur
   * des centaines de cartes à chaque image d'un zoom restylait la planche entière.
   */
  cull(rect, z, revealOnly = false) {
    const doc = this.ed.doc;
    for (const n of doc.nodes) {
      const v = this.nodes.get(n.id);
      if (!v) continue;
      if (revealOnly && v.visible) continue;
      const vis = n.x < rect.x + rect.w && n.x + n.w > rect.x && n.y < rect.y + rect.h && n.y + v.h > rect.y;
      if (revealOnly && !vis) continue;
      const small = (n.w - 16) * z < SMALL_WELL || this.lod >= 2;
      v.setVisibility(vis, small);
    }
  }
}

// ── utilitaires ───────────────────────────────────────────────────────

// Dernière hauteur mesurée par type et largeur (blocs sans média) : la meilleure
// estimation pour le prochain bloc du même type.
const typeHeights = new Map();

/**
 * Hauteur probable d'un bloc avant sa première mesure (placer une recette, une
 * colonne de médias). Calée sur les cartes réelles de F : en-tête 36 + filets,
 * puits 16:9 (ou le ratio du média, 460 px au plus), rangées de ports de 28 px,
 * réglages de 32 px, « Avancé » 28 px, pied 52 px.
 */
export function estimateHeight(node, type) {
  if (node.collapsed) return HEAD_H + 2;
  const w = node.w || type?.width || 288;
  if (type && type.id !== 'import') {
    const known = typeHeights.get(`${type.id}|${w}`);
    if (known) return known;
  }
  const rows = isModelBlock(node) ? Math.max(nodeInputs(node).length + (hiddenInputs(node).length ? 1 : 0), 1)
    : Math.max(type?.inputs?.length || 0, type?.outputs?.length || 0);
  let hgt = HEAD_H + 2 + (rows ? rows * 28 + 12 : 0);
  const inner = Math.max(40, w - 16);
  if (type?.id === 'import') {
    const d = node.data || {};
    const m = d.meta;
    const kind = d.kind || d.placeholder?.kind;
    // un son : bandeau de forme d'onde au ratio 3:1 (nodes/media.js, AUDIO_RATIO)
    const r = m?.w && m?.h ? m.h / m.w : kind === 'video' ? 9 / 16 : kind === 'audio' ? 1 / 3 : 3 / 4;
    hgt += Math.min(460, inner * r) + 8;
    if (d.kind === 'video' || (!d.src && kind === 'video')) hgt += 32;     // « Avancé › » des vidéos
  } else if (type?.id === 'text') hgt += 83 + 40;
  else if (type?.id === 'note') hgt += 107;
  else {
    hgt += Math.round(inner * 9 / 16) + 7;                                  // puits du résultat
    const ps = (type?.params || []).filter((p) => !p.advanced && !p.showIf && !(p.caps || []).includes('lora'));
    for (const p of ps) hgt += p.kind === 'prompt' ? 104 : 32;
    if ((type?.params || []).some((p) => p.advanced)) hgt += 28;
    if (type?.engine) hgt += 52;
  }
  return Math.round(hgt);
}

/** « 38 s », « 4 min 12 s », « 1 h 05 » : durée d'un calcul terminé (affichée en mono majuscule). */
function durShort(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} s`;
  if (s < 3600) {
    const m = Math.floor(s / 60), r = s % 60;
    return m < 10 && r ? `${m} min ${r} s` : `${m} min`;
  }
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60);
  return `${hh} h ${String(mm).padStart(2, '0')}`;
}

/** « 00:12 », « 4:05 », « 1:02:03 » : temps restant en chiffres tabulaires. */
function clock(s) {
  s = Math.max(0, Math.round(s));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (v) => String(v).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

// ── corps minimal (si nodes/body.js manque) ───────────────────────────
// Volontairement simple : l'aperçu d'un média, le texte d'une consigne, un
// résumé des réglages et le bouton de lancement. Il ne remplace pas F ; il
// garantit seulement qu'une planche s'ouvre et se lit toujours.

function minimalBody(node, type, slots, api) {
  let textArea = null;

  const render = (n) => {
    if (textArea && document.activeElement === textArea) return;   // ne pas casser une frappe
    slots.preview.replaceChildren();
    slots.controls.replaceChildren();
    textArea = null;
    if (!type) {
      const p = h('div', 'mb-note');
      p.textContent = t('graph.unknownType');
      slots.controls.append(p);
      return;
    }
    if (type.id === 'import') return renderMedia(n);
    if (type.id === 'text' || type.id === 'note') {
      textArea = h('textarea', 'mb-text', { spellcheck: 'false', rows: type.id === 'note' ? '4' : '3' });
      textArea.value = n.params?.text || '';
      const ph = type.params?.[0]?.placeholder;
      if (ph) textArea.placeholder = tl(ph);
      textArea.addEventListener('input', () => api.setParam('text', textArea.value));
      slots.controls.append(textArea);
      return;
    }
    const rows = h('div', 'mb-rows');
    for (const p of type.params || []) {
      if (p.advanced) continue;
      const row = h('div', 'mb-row');
      const k = h('span', 'mb-k');
      k.textContent = tl(p.label);
      const v = h('span', 'mb-v');
      v.textContent = paramText(p, n.params?.[p.id], api, n);
      row.append(k, v);
      rows.append(row);
    }
    if (rows.childNodes.length) slots.controls.append(rows);
    if (type.engine) {
      const foot = h('div', 'mb-foot');
      const est = h('span', 'mb-est');
      const e = type.estimate;
      est.textContent = e ? tl(e.preview || e) : '';
      foot.append(est);
      for (const mode of type.modes || [null]) {
        const b = h('button', `mb-btn${mode === 'final' ? ' ghost' : ''}`, { type: 'button' });
        b.textContent = mode === 'final' ? t('graph.body.final') : mode === 'preview' ? t('graph.body.preview') : t('graph.body.run');
        b.addEventListener('click', () => api.run(mode));
        foot.append(b);
      }
      slots.controls.append(foot);
    }
  };

  const renderMedia = (n) => {
    const d = n.data || {};
    const well = h('div', 'mb-well');
    if (d.src) {
      const m = d.meta || {};
      if (m.w && m.h) well.style.aspectRatio = `${m.w} / ${m.h}`;
      const url = (rel) => (rel ? api.mediaUrl(rel) : null);
      if (d.kind === 'video') {
        const v = h('video', null, { muted: '', loop: '', playsinline: '', preload: 'metadata' });
        v.muted = true;
        v.src = url(d.proxy || d.src);
        if (d.poster) v.poster = url(d.poster);
        v.autoplay = true;
        well.append(v);
      } else if (d.kind === 'audio') {
        well.style.aspectRatio = '3 / 1';
        if (d.poster) {
          const wave = h('span', 'mb-wave');
          wave.style.setProperty('--wave', `url("${url(d.poster)}")`);
          well.append(wave);
        }
      } else {
        const img = h('img', null, { alt: '', draggable: 'false', decoding: 'async' });
        img.src = url(d.src);
        well.append(img);
      }
      const badge = h('span', 'mb-badge');
      const parts = [];
      if (m.w && m.h) parts.push(`${m.w}×${m.h}`);
      if (d.kind === 'video' && m.fps) parts.push(`${Math.round(m.fps * 100) / 100} ${t('graph.fps')}`);
      if ((d.kind === 'video' || d.kind === 'audio') && m.duration) parts.push(`${Math.round(m.duration * 10) / 10} s`);
      badge.textContent = parts.join(' · ');
      if (parts.length) well.append(badge);
    } else {
      well.classList.add('empty');
      const ph = d.placeholder;
      const kind = ph?.kind || 'media';
      const g = h('span', 'mb-ph-glyph');
      g.innerHTML = glyph(kind === 'video' ? 'film' : kind === 'image' ? 'frame' : kind === 'audio' ? 'audio' : 'import', 22);
      const a = h('span', 'mb-ph-title');
      a.textContent = ph ? tl(ph) : t('graph.drop.here');
      const b = h('span', 'mb-ph-sub');
      b.textContent = t(`graph.drop.${['video', 'image', 'audio'].includes(kind) ? kind : 'media'}`);
      well.append(g, a, b);
    }
    slots.preview.append(well);
  };

  render(node);
  return {
    minimal: true,
    update: render,
    onRun() {},
    destroy() { slots.preview.replaceChildren(); slots.controls.replaceChildren(); }
  };
}

function paramText(p, v, api, node) {
  if (p.kind === 'prompt') {
    if (p.port && api.graph?.inputsOf(node.id)?.[p.port]?.length) return t('graph.body.fromWire');
    return v ? String(v) : '—';
  }
  if (p.kind === 'seg' || p.kind === 'select') {
    const o = (p.options || []).find((x) => String(x.value) === String(v));
    return o ? tl(o.label) : String(v ?? '');
  }
  if (p.kind === 'slider') return `${v}${p.unit ? ` ${p.unit}` : ''}`;
  if (p.kind === 'toggle') return v ? t('graph.yes') : t('graph.no');
  if (p.kind === 'model') return v === 'none' ? t('graph.none') : v === 'auto' || v == null ? t('graph.auto') : String(v);
  if (p.kind === 'frame') return v === -1 ? t('graph.lastFrame') : String(v);
  return v == null || v === '' ? '—' : String(v);
}
