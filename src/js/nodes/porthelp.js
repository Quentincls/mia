// ── Ce qu'est une entrée, à quoi elle sert (infobulle des pastilles) ──
// Demande de Quentin (24/10) : au survol d'une entrée ou d'une sortie, une
// infobulle qui vulgarise. Elle dit le genre (image, vidéo…), une phrase
// simple, et pour un bloc Modèle ce que le modèle en fait (« Sert à : Animer
// une image ») et combien il en prend. FR et EN, comme tout le reste.

import { t, tl, has, register } from '../i18n.js';
import { inputDefs } from '../catalog.js';
import { isModelBlock, blockFamily, portLabels } from './ports.js';
import { portsOfWorkflow, needsOf } from './route.js';

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
    'port.usedForWith': '{what} (avec {needs})',
    'port.upTo': 'Jusqu’à {n}',
    'port.notTaken': 'Pas prise par {family}',
    'port.ignored': 'Pas utilisée pour « {what} »',
    'port.trial': 'À essayer : pas encore validée au labo',
    'port.help.start': 'La première image du plan : le modèle part d’elle et la met en mouvement.',
    'port.help.end': 'L’image où le plan doit arriver. Conseillée : sans elle, le texte seul décide où finit l’action.',
    'port.help.keys': 'Des images par où le plan doit passer, entre le début et la fin. Mia les répartit à intervalles égaux, dans l’ordre des fils (du haut vers le bas). Garde le cadrage de l’image de début : une image-clé cadrée autrement fait couper le plan.',
    'port.help.sheet': 'Une seule image qui réunit côte à côte ton personnage, ses tenues, ses objets ou le lieu : LTX s’en sert de modèle sur tout le plan. Va avec une image de début. Dans la consigne, désigne chaque élément par sa place (« l’homme à gauche »).',
    'port.help.refs': 'Des images de personnages, d’objets ou de lieux à réunir dans la vidéo, sans image de début. Cite-les dans la consigne : « Image 1 », « Image 2 »…',
    'port.help.refs.cloud': 'Des images de personnages, d’objets ou de lieux à réunir dans la vidéo, dans l’ordre des blocs branchés, du haut vers le bas.',
    'port.help.refVideos': 'Des vidéos dont le modèle reprend le mouvement, le cadrage ou l’ambiance. Seul le début est lu, sur la durée du plan. Cite-les : « Vidéo 1 »…',
    'port.help.refAudios': 'Des sons dont la vidéo s’inspire : une voix à imiter, une musique, une ambiance. Ils ne sont pas calés dans le temps ; pour que la vidéo suive un son précis (lèvres, rythme), utilise « Son à suivre ». Cite-les : « Son 1 »…',
    'port.help.video': 'La vidéo de départ, que le modèle transforme.',
    'port.help.video.ltx': 'Ton rendu 3D (Unreal, Blender, passe « Lumière seule ») : LTX le repeint en image filmée, sans toucher à la caméra ni au mouvement.',
    'port.help.video.cloud': 'La vidéo à modifier ou à prolonger : le modèle part d’elle.',
    'port.help.video.minimax': 'La vidéo à prolonger : MiniMax reprend sa fin et continue le plan. Le résultat est la vidéo entière, rallongée.',
    'port.help.guide': 'Une vidéo dont le modèle suit la forme et le mouvement (profondeur ou contours), sans en copier les couleurs. Avec une image de début, garde le cadrage de la 1re image du guide : sinon le plan coupe.',
    'port.help.layout': 'Une image dont le modèle garde la composition (placement, perspective, profondeur), pas les couleurs ni le style : ta LoRA garde la main. Le format suit cette image.',
    'port.help.look': 'Une image qui donne le look : couleurs, lumière, matières (souvent la 1re image, retouchée). En vidéo guidée, le plan part d’elle : garde le cadrage du guide. Le plus simple : branche ton image de début, elle sert de look.',
    'port.help.mask': 'Une image noir et blanc : dans le blanc, le modèle ne suit plus le guide et invente ; dans le noir, il suit le guide de près. Toute l’image est quand même recalculée (LTX).',
    'port.help.mask.qwen21': 'La zone à changer, peinte dans un bloc Masque (blanc = la zone). Seule la zone est recalculée et recollée : le reste de l’image ne bouge pas d’un pixel. Une petite zone est agrandie toute seule pour être calculée en détail.',
    'port.help.image.qwen21': 'L’image à retoucher. Branche aussi la zone (bloc Masque) : seule elle change, d’après la consigne.',
    'port.help.character': 'Ton personnage, de face et bien éclairé : c’est lui qui va jouer.',
    'port.help.motion': 'Une vidéo de toi ou d’un acteur : le personnage reprend ses gestes, son visage et ses mains.',
    'port.help.image': 'L’image à retoucher : le modèle change ce que dit la consigne et garde le reste.',
    'port.help.ref': 'Jusqu’à deux images d’appui : une tenue, un objet ou un style à reprendre. Cite-les « Image 2 », « Image 3 » (l’image à retoucher est l’Image 1).',
    'port.help.audio': 'Un son (voix, musique) sur lequel la vidéo se cale : les lèvres, le rythme.',
    'port.help.prompt': 'Branche un bloc Consigne pour écrire le texte à part (pratique pour le réutiliser) ; sinon, écris-le dans le bloc.',
    'port.help.media': 'L’image ou la vidéo à traiter.',
    'port.help.clips': 'Les plans à mettre bout à bout, dans l’ordre des blocs, du haut vers le bas.',
    'port.help.out.gen': 'Le résultat ({kind}) : branche-le sur la suite (Agrandir, Finition, Assembler…).',
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
    'port.usedForWith': '{what} (with {needs})',
    'port.upTo': 'Up to {n}',
    'port.notTaken': 'Not taken by {family}',
    'port.ignored': 'Not used for “{what}”',
    'port.trial': 'To try: not checked at the lab yet',
    'port.help.start': 'The first frame of the shot: the model starts from it and sets it in motion.',
    'port.help.end': 'The frame the shot must land on. Recommended: without it, the text alone decides where the action ends.',
    'port.help.keys': 'Frames the shot must pass through, between the start and the end. Mia spaces them evenly, in wire order (top to bottom). Keep the start image’s framing: a keyframe framed differently makes the shot cut.',
    'port.help.sheet': 'One image putting your character, outfits, props or the place side by side: LTX uses it as a model through the whole shot. Goes with a start image. In the prompt, point at each element by its place (“the man on the left”).',
    'port.help.refs': 'Images of characters, objects or places to bring together in the video, no start image needed. Name them in the prompt: “Image 1”, “Image 2”…',
    'port.help.refs.cloud': 'Images of characters, objects or places to bring together in the video, in the order of the connected blocks, top to bottom.',
    'port.help.refVideos': 'Videos whose motion, framing or mood the model borrows. Only the start is read, as long as the shot. Name them: “Video 1”…',
    'port.help.refAudios': 'Sounds the video draws on: a voice to imitate, music, an atmosphere. They are not placed in time; for the video to follow a precise sound (lips, rhythm), use “Sound to follow”. Name them: “Sound 1”…',
    'port.help.video': 'The starting video, which the model transforms.',
    'port.help.video.ltx': 'Your 3D render (Unreal, Blender, “Lighting only” pass): LTX repaints it as filmed footage, without touching the camera or the motion.',
    'port.help.video.cloud': 'The video to edit or extend: the model starts from it.',
    'port.help.video.minimax': 'The video to extend: MiniMax picks up its end and carries the shot on. The result is the whole video, made longer.',
    'port.help.guide': 'A video whose shape and motion the model follows (depth or outlines), without copying its colours. With a start image, keep the framing of the guide’s first frame: otherwise the shot cuts.',
    'port.help.layout': 'An image whose composition the model keeps (placement, perspective, depth), not its colours or style: your LoRA keeps control. The format follows this image.',
    'port.help.look': 'An image that sets the look: colours, light, materials (often the first frame, retouched). In guided video the shot starts from it: keep the guide’s framing. Simplest: connect your start image, it is used as the look.',
    'port.help.mask': 'A black and white image: in the white, the model stops following the guide and invents; in the black, it follows the guide closely. The whole picture is still remade (LTX).',
    'port.help.mask.qwen21': 'The zone to change, painted in a Mask block (white = the zone). Only the zone is remade and pasted back: the rest of the image does not move by a pixel. A small zone is enlarged on its own to be computed in detail.',
    'port.help.image.qwen21': 'The image to retouch. Connect the zone too (Mask block): only it changes, following the prompt.',
    'port.help.character': 'Your character, front-facing and well lit: this is who will act.',
    'port.help.motion': 'A video of you or an actor: the character takes up their gestures, face and hands.',
    'port.help.image': 'The image to edit: the model changes what the prompt says and keeps the rest.',
    'port.help.ref': 'Up to two helper images: an outfit, an object or a style to take up. Name them “Image 2”, “Image 3” (the image to edit is Image 1).',
    'port.help.audio': 'A sound (voice, music) the video locks onto: lips, rhythm.',
    'port.help.prompt': 'Connect a Prompt block to write the text separately (handy to reuse it); otherwise, type it in the block.',
    'port.help.media': 'The image or video to process.',
    'port.help.clips': 'The shots to put end to end, in the order of the blocks, top to bottom.',
    'port.help.out.gen': 'The result ({kind}): connect it to what comes next (Upscale, Finish, Join clips…).',
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
    // une aide propre à la famille (port.help.video.ltx…) ou aux modèles en ligne (port.help.refs.cloud…)
    const special = fam ? (fam.provider === 'local' ? `port.help.${id}.${fam.key}` : `port.help.${id}.cloud`) : null;
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
      // avec ce qu'il faut brancher en plus : « Sert à : Animer une image (avec Image de début) »
      if (def.id !== 'prompt') {
        const labels = portLabels(fam);
        const word = (pid) => tl(labels[pid] || inputDefs(node.type).find((i) => i.id === pid)?.label || { fr: pid });
        const uses = (fam.def.workflows || []).filter((wf) => portsOfWorkflow(wf)[def.id]).map((wf) => {
          const needs = needsOf(wf).filter((pid) => pid !== def.id);
          return needs.length ? t('port.usedForWith', { what: tl(wf.label || {}), needs: needs.map(word).join(', ') }) : tl(wf.label || {});
        });
        if (uses.length) meta.push(t('port.usedFor', { list: [...new Set(uses)].join(' · ') }));
      }
    }
  }
  if (dir === 'in' && def.multi && def.max > 0 && !def.unused) meta.push(t('port.upTo', { n: def.max }));
  if (dir === 'in' && def.trial && !def.unused) meta.push(t('port.trial'));
  if (!body && !meta.length) return '';
  return { kicker, title: tl(def.label), body, meta: meta.join(' · ') };
}
