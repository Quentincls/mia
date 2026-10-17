// ── Annuler / rétablir ────────────────────────────────────────────────
// Pile d'instantanés JSON du graphe (blocs, fils, sections — jamais la caméra
// ni la sélection), comme dans Slate. Un graphe Mia pèse quelques dizaines de
// Ko : copier tout est plus simple et plus sûr que des opérations inverses.
//
// Deux gestes produisent une seule entrée au lieu de dizaines :
//  - un glisser : `begin` au premier mouvement, `commit` au lâcher ;
//  - la frappe dans un réglage : chaque modification porte une clé
//    (`param:<bloc>:<réglage>`) ; deux modifications de même clé à moins de
//    COALESCE_MS d'écart fusionnent dans la même entrée.

const MAX_ENTRIES = 100;
const COALESCE_MS = 1200;

export class History {
  /**
   * @param {{capture: () => string, restore: (snap: string) => void}} io
   *   `capture` renvoie l'état courant sérialisé, `restore` le remet en place.
   */
  constructor(io) {
    this.io = io;
    this.past = [];
    this.future = [];
    this._pending = null;
    this._depth = 0;
    this.onchange = null;
  }

  reset() {
    this.past.length = 0;
    this.future.length = 0;
    this._pending = null;
    this._depth = 0;
    this._emit();
  }

  /**
   * Capture l'état *avant* une modification. Les appels imbriqués sont permis :
   * seul le plus extérieur capture et valide (un « rebrancher » qui appelle
   * `connect` ne fait qu'une entrée).
   */
  begin(label = '', key = null) {
    if (this._depth++ > 0) return;
    this._pending = { label, key, state: this.io.capture() };
  }

  /** Valide la modification ; ne pousse rien si l'état n'a pas changé. */
  commit() {
    if (this._depth === 0) return false;
    if (--this._depth > 0) return false;
    const p = this._pending;
    this._pending = null;
    if (!p) return false;
    const now = this.io.capture();
    if (now === p.state) return false;
    const last = this.past[this.past.length - 1];
    const t = performance.now();
    if (p.key && last && last.key === p.key && t - last.at < COALESCE_MS && !this.future.length) {
      // même geste qui continue : on garde l'état d'avant la toute première frappe
      last.at = t;
    } else {
      this.past.push({ label: p.label, key: p.key, state: p.state, at: t });
      if (this.past.length > MAX_ENTRIES) this.past.shift();
    }
    this.future.length = 0;
    this._emit();
    return true;
  }

  /** Abandonne la capture en cours (le geste a été annulé ; à l'appelant de remettre l'état). */
  cancel() {
    if (this._depth === 0) return;
    if (--this._depth > 0) return;
    this._pending = null;
  }

  get busy() { return this._depth > 0; }

  /** begin + modification + commit. */
  record(label, fn, key = null) {
    this.begin(label, key);
    try { return fn(); } finally { this.commit(); }
  }

  /** Coupe la fusion en cours : la prochaine modification fera une entrée neuve. */
  seal() {
    const last = this.past[this.past.length - 1];
    if (last) last.key = null;
  }

  /**
   * Réécrit tous les instantanés (passés, futurs, en cours) : un changement
   * « système » qui n'est pas un geste de Quentin (proxy vidéo arrivé en tâche de
   * fond) ne doit pas être défait par un Ctrl+Z ultérieur. `fn(content)` modifie
   * le contenu sur place.
   */
  rewrite(fn) {
    const fix = (s) => {
      try { const c = JSON.parse(s); fn(c); return JSON.stringify(c); } catch { return s; }
    };
    for (const e of this.past) e.state = fix(e.state);
    for (const e of this.future) e.state = fix(e.state);
    if (this._pending) this._pending.state = fix(this._pending.state);
  }

  undo() {
    if (this._depth) return false;
    const e = this.past.pop();
    if (!e) return false;
    this.future.push({ label: e.label, key: null, state: this.io.capture(), at: 0 });
    this.io.restore(e.state);
    this._emit();
    return true;
  }

  redo() {
    if (this._depth) return false;
    const e = this.future.pop();
    if (!e) return false;
    this.past.push({ label: e.label, key: null, state: this.io.capture(), at: 0 });
    this.io.restore(e.state);
    this._emit();
    return true;
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  _emit() { if (this.onchange) this.onchange(this); }
}
