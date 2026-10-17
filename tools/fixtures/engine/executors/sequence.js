// L'estimation grandit avec le nombre de clips : le test vérifie que la durée prévue suit l'entrée.
module.exports = require('./_fake')('sequence', [{ id: 'video', kind: 'video' }],
  { estimate: (x) => ((x.inputs && Array.isArray(x.inputs.clips) ? x.inputs.clips.length : 1) * 2) });
