// Le mot court d'une façon de faire (workflow) d'un bloc Modèle : « text », « image », « refs »… Module pur (aucun
// import) : lu par le choix du modèle (familypicker.js), la rangée Mode (params.js) et le banc tools/test-route.js.

/** Clé du mot court d'une façon de faire : « text », « image », « refs »… (null si inconnue). */
export function wordKey(wf) {
  const id = String((wf && wf.id) || '');
  const rules = [
    [/^t2v$|^t2i$|text-to-video/, 'text'], [/^i2v$|image-to-video|first-last-frame/, 'image'],
    [/^refs$|reference-to-video|image-reference|custom-references/, 'refs'], [/^guided$/, 'guided'], [/^real$/, 'real'],
    [/^perform$|motion-control|motion-transfer/, 'act'], [/video-edit/, 'vedit'], [/^extend$|video-extend/, 'extend'], [/^sheet$/, 'sheet'],
    [/video-reference/, 'follow'], [/object-swap/, 'swap'], [/restyle/, 'restyle'], [/cinema-studio/, 'cinema'],
    // « image vers image » (SOUL V2) = retoucher une image, avant la règle « texte » qui attrape tout « soul »
    [/^edit$|\/edit$|image-to-image/, 'edit'], [/text-to-image|soul|ideogram|z-image|recraft|grok-imagine-image|ads-studio|marketing-studio/, 'text'],
  ];
  const r = rules.find(([re]) => re.test(id));
  return r ? r[1] : null;
}

/**
 * Ce que montre la rangée Mode pour chaque façon de faire : sa clé de mot court, ou null quand deux modes auraient le
 * même mot (« Auto · Texte · Texte ») ou qu'aucun mot ne convient : il prend alors son libellé entier.
 */
export function modeWordKeys(workflows) {
  const keys = (workflows || []).map(wordKey);
  return keys.map((k) => (k && keys.indexOf(k) === keys.lastIndexOf(k) ? k : null));
}
