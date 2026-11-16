// Vérifie une clé Higgsfield SANS rien dépenser ni rien enregistrer (SPEC §23).
// Demande l'état d'un calcul qui n'existe pas : 404 = la clé est acceptée, 401 = refusée, 403 = solde insuffisant.
//   node tools/hf-check.mjs            (la clé est demandée, au format ID:SECRET)
// La clé ne quitte pas cette commande : elle n'est ni écrite sur le disque, ni affichée.
import readline from 'node:readline';

const BASE = 'https://api.higgsfield.ai';

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // la saisie n'est pas renvoyée à l'écran
    rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
  });
}

const key = process.env.HF_KEY || await ask('Colle ta clé Higgsfield (ID:SECRET) puis Entrée : ');
if (!/^[^:\s]+:[^:\s]+$/.test(key)) {
  console.log('Ce n’est pas une clé au format ID:SECRET.');
  process.exit(2);
}
try {
  const r = await fetch(`${BASE}/requests/00000000-0000-4000-8000-000000000000/status`, {
    headers: { Authorization: `Key ${key}` },
  });
  if (r.status === 404) console.log('Clé acceptée par Higgsfield (aucun crédit dépensé).');
  else if (r.status === 401) console.log('Clé refusée par Higgsfield (401) : vérifie l’identifiant et le secret.');
  else if (r.status === 403) console.log('Clé reconnue, mais Higgsfield refuse l’accès (403) : solde de crédits insuffisant ?');
  else console.log(`Réponse inattendue de Higgsfield : ${r.status} ${(await r.text()).slice(0, 200)}`);
} catch (e) {
  console.log(`Higgsfield ne répond pas : ${e.message}`);
  process.exit(1);
}
