// ── Ce qu'est une entrée, à quoi elle sert (infobulle des pastilles) ──
// Demande de Quentin (24/10) : au survol d'une entrée ou d'une sortie, une
// infobulle qui vulgarise. Elle dit le genre (image, vidéo…), une phrase
// simple, et pour un bloc Modèle ce que le modèle en fait (« Sert à : Animer
// une image ») et combien il en prend. FR et EN, comme tout le reste.

import { t, tl, has, register } from '../i18n.js';
import { isModelBlock, blockFamily } from './ports.js';
import { portsOfWorkflow } from './route.js';

register({
  fr: {
    'port.kind.in': 'Entrée',
    'port.kind.out': 'Sortie',
    'port.type.image': 'image',
    'port.type.video': 'vidéo',
    'port.type.media': 'image ou vidéo',
    'port.type.text': 'texte',
    'port.type.audio': 'son',
    'port.usedFor': 'Sert à : {list}',
    'port.upTo': 'Jusqu’à {n}',
    'port.notTaken': 'Pas prise par {family}',
    'port.trial': 'À essayer : pas encore validée au labo',
    'port.help.start': 'La première image du plan : le modèle part d’elle et la met en mouvement.',
    'port.help.end': 'L’image où le plan doit arriver. Conseillée : le texte seul ne place pas l’action.',
    'port.help.keys': 'Des images par où le plan doit passer, entre le début et la fin. Mia les répartit à intervalles égaux, dans l’ordre des fils (du haut vers le bas). Garde le cadrage de l’image de début : une image-clé cadrée autrement fait couper le plan.',
    'port.help.sheet': 'Une planche qui montre ton personnage ou tes objets (plusieurs vues sur une image) : le modèle garde leur apparence sur tout le plan.',
    'port.help.refs': 'Des images de personnages, d’objets ou de lieux à réunir dans la vidéo. Cite-les dans la consigne : « Image 1 », « Image 2 »…',
    'port.help.refVideos': 'Des vidéos dont le modèle reprend le mouvement, le cadrage ou l’ambiance. Cite-les : « Vidéo 1 »…',
    'port.help.refAudios': 'Des sons (une voix, une musique) que la vidéo doit reprendre ou suivre. Cite-les : « Son 1 »…',
    'port.help.video': 'La vidéo de départ, que le modèle transforme.',
    'port.help.video.ltx': 'Ton rendu 3D (Unreal, Blender, en « Lumière seule ») : LTX le repeint en image réelle, plan par plan.',
    'port.help.video.cloud': 'La vidéo à modifier ou à prolonger : le modèle part d’elle.',
    'port.help.video.minimax': 'La vidéo à prolonger : MiniMax reprend sa fin et continue le plan. Le résultat est la vidéo entière, rallongée.',
    'port.help.guide': 'Une vidéo dont le modèle suit la forme et le mouvement (profondeur ou contours), sans en copier les couleurs.',
    'port.help.look': 'Une image qui donne le style : couleurs, lumière, matières. Souvent la première image, retouchée.',
    'port.help.mask': 'Une image noir et blanc : le blanc dit où le modèle peut inventer, le noir ce qu’il garde.',
    'port.help.character': 'Ton personnage, de face et bien éclairé : c’est lui qui va jouer.',
    'port.help.motion': 'Une vidéo de toi ou d’un acteur : le personnage reprend ses gestes, son visage et ses mains.',
    'port.help.image': 'L’image à retoucher : le modèle change ce que dit la consigne et garde le reste.',
    'port.help.ref': 'Jusqu’à deux images d’appui : une tenue, un objet ou un style à reprendre. Cite-les « image 2 », « image 3 » (l’image à retoucher est l’image 1).',
    'port.help.audio': 'Un son (voix, musique) sur lequel la vidéo se cale : les lèvres, le rythme.',
    'port.help.prompt': 'Branche un bloc Consigne pour écrire le texte à part (pratique pour le réutiliser) ; sinon, écris-le dans le bloc.',
    'port.help.media': 'L’image ou la vidéo à traiter.',
    'port.help.clips': 'Les plans à mettre bout à bout, dans l’ordre des blocs, du haut vers le bas.',
    'port.help.out.gen': 'Ce que fait le bloc ({kind}) : à brancher sur la suite (Agrandir, Finition, Assembler…).',
    'port.help.out': 'Ce que produit le bloc : à brancher sur la suite.',
  },
  en: {
    'port.kind.in': 'Input',
    'port.kind.out': 'Output',
    'port.type.image': 'image',
    'port.type.video': 'video',
    'port.type.media': 'image or video',
    'port.type.text': 'text',
    'port.type.audio': 'sound',
    'port.usedFor': 'Used for: {list}',
    'port.upTo': 'Up to {n}',
    'port.notTaken': 'Not taken by {family}',
    'port.trial': 'To try: not checked at the lab yet',
    'port.help.start': 'The first frame of the shot: the model starts from it and sets it in motion.',
    'port.help.end': 'The frame the shot must land on. Recommended: text alone does not place the action.',
    'port.help.keys': 'Frames the shot must pass through, between the start and the end. Mia spaces them evenly, in wire order (top to bottom). Keep the start image’s framing: a keyframe framed differently makes the shot cut.',
    'port.help.sheet': 'A sheet showing your character or objects (several views on one image): the model keeps how they look through the shot.',
    'port.help.refs': 'Images of characters, objects or places to bring together in the video. Name them in the prompt: “Image 1”, “Image 2”…',
    'port.help.refVideos': 'Videos whose motion, framing or mood the model takes up. Name them: “Video 1”…',
    'port.help.refAudios': 'Sounds (a voice, music) the video must take up or follow. Name them: “Sound 1”…',
    'port.help.video': 'The starting video, which the model transforms.',
    'port.help.video.ltx': 'Your 3D render (Unreal, Blender, “Lighting only”): LTX repaints it as real footage, shot by shot.',
    'port.help.video.cloud': 'The video to edit or extend: the model starts from it.',
    'port.help.video.minimax': 'The video to extend: MiniMax picks up its end and carries the shot on. The result is the whole video, made longer.',
    'port.help.guide': 'A video whose shape and motion the model follows (depth or edges), without copying its colours.',
    'port.help.look': 'An image that sets the style: colours, light, materials. Often the first frame, retouched.',
    'port.help.mask': 'A black and white image: white is where the model may invent, black what it keeps.',
    'port.help.character': 'Your character, front-facing and well lit: this is who will act.',
    'port.help.motion': 'A video of you or an actor: the character takes up their gestures, face and hands.',
    'port.help.image': 'The image to edit: the model changes what the prompt says and keeps the rest.',
    'port.help.ref': 'Up to two helper images: an outfit, an object or a style to take up. Name them “image 2”, “image 3” (the image to edit is image 1).',
    'port.help.audio': 'A sound (voice, music) the video locks onto: lips, rhythm.',
    'port.help.prompt': 'Connect a Prompt block to write the text apart (handy to reuse it); otherwise, write it in the block.',
    'port.help.media': 'The image or video to process.',
    'port.help.clips': 'The shots to put end to end, in the order of the blocks, top to bottom.',
    'port.help.out.gen': 'What the block makes ({kind}): connect it to what comes next (Upscale, Finish, Join…).',
    'port.help.out': 'What the block makes: connect it to what comes next.',
  },
});

const typeWord = (k) => (has(`port.type.${k}`) ? t(`port.type.${k}`) : k);

/**
 * Infobulle riche d'une pastille : { kicker, title, body, meta } (tooltip.js), ou '' quand il n'y a rien à dire.
 * `node` : le bloc ; `def` : la définition du port telle que le bloc la montre (ports.js) ; `dir` : 'in' | 'out'.
 */
export function portTip(node, def, dir, kind) {
  if (!node || !def) return '';
  const fam = isModelBlock(node) ? blockFamily(node) : null;
  const kicker = `${t(dir === 'out' ? 'port.kind.out' : 'port.kind.in')} · ${typeWord(kind || def.type)}`;
  let body = '';
  if (dir === 'out') {
    body = fam ? t('port.help.out.gen', { kind: typeWord(kind || def.type) }) : (def.hint ? tl(def.hint) : t('port.help.out'));
  } else {
    const id = def.id;
    const special = fam && id === 'video' ? (fam.provider === 'local' ? `port.help.video.${fam.key}` : 'port.help.video.cloud') : null;
    if (special && has(special)) body = t(special);
    // bloc Modèle : la phrase simple d'abord (le conseil du catalogue vise les anciens blocs)
    else if (fam && has(`port.help.${id}`)) body = t(`port.help.${id}`);
    else if (def.hint) body = tl(def.hint);
    else if (has(`port.help.${id}`)) body = t(`port.help.${id}`);
  }
  const meta = [];
  if (dir === 'in' && fam) {
    const name = fam.def.name;
    if (def.unused) meta.push(t('port.notTaken', { family: name }));
    else {
      // les façons de faire de cette famille qui se servent de cette entrée (la Consigne sert partout : on la tait)
      if (def.id !== 'prompt') {
        const uses = (fam.def.workflows || []).filter((wf) => portsOfWorkflow(wf)[def.id]).map((wf) => tl(wf.label || {}));
        if (uses.length) meta.push(t('port.usedFor', { list: [...new Set(uses)].join(' · ') }));
      }
    }
  }
  if (dir === 'in' && def.multi && def.max > 0 && !def.unused) meta.push(t('port.upTo', { n: def.max }));
  if (dir === 'in' && def.trial && !def.unused) meta.push(t('port.trial'));
  if (!body && !meta.length) return '';
  return { kicker, title: tl(def.label), body, meta: meta.join(' · ') };
}
