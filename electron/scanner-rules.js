'use strict';
// Mia — règles du scanner de modèles + catalogue d'affichage FR/EN.
//
// Deux parties, toutes deux en DONNÉES (aucune logique de parcours ici) :
//  1. RULES : port fidèle de `_plan/model_rules.json` (outil interne de l'auteur, non publié ; généré par scan_probe.py --dump-rules). Le scanner Node
//     reconnaît un fichier par les NOMS de ses tenseurs, jamais en chargeant un poids. Toute modification de ces
//     règles doit faire monter RULES.schema (ou RULES_REV) : le cache models-cache.json est alors relu de zéro.
//  2. Le catalogue : ce que l'utilisateur voit. Un fichier identifié (famille/rôle) devient « LTX 2.5 », « Profondeur »,
//     « Pièce interne »… avec une phrase simple, la mémoire, la vitesse, la licence. Source : models.md §6,
//     engine.md §7.9 (licences), usage.md §3.3.
//
// Aucun chemin du labo en dur hors des valeurs par défaut : tout passe par `engineRoot` (prefs).

// Révision locale des règles d'IDENTIFICATION : à incrémenter dès qu'un champ du cache de fichiers change de sens
// (tout est alors relu de zéro). Le catalogue d'affichage a sa propre révision (CATALOG_REV) : la changer jette
// seulement l'inventaire mis en cache, pas l'identification des fichiers (le démarrage reste rapide).
const RULES_REV = 1;
const CATALOG_REV = 3;   // 3 : textes neutres (licence MiniMax, mémoire vidéo, dossier du moteur), identités hors dépôt

// ---------------------------------------------------------------------------------------------
// 1. Règles de classification (port de model_rules.json, ordre significatif : la 1re règle gagne)
// ---------------------------------------------------------------------------------------------
const RULES = {
  schema: 1,
  loraSuffix: "\\.(lora\\.(a|b|down|up)(\\.weight)?|lokr\\.w[12]|hada\\.w[12]\\.[ab]|alpha|diff\\.b|diff)$",
  auxTensor: "(scale|comfy\\.quant|absmax|quant\\.map|quant\\.state|scaled\\.fp8|hf\\.asset|tokenizer|spiece|position\\.ids|num\\.batches\\.tracked|running\\.(mean|var)|^__)",
  rules: [
    {"id":"minimax_h3","family":"MiniMax H3","role":"diffusion_model","task":"video_audio","all":["token.refiner.blocks","video.patch.proj"],"any":["audio.patch.proj","final.layer.video.out"],"lora_all":["blocks.#.attn.qkv.proj","token.refiner.blocks"]},
    {"id":"minimax_h3_control","family":"MiniMax H3","role":"controlnet","task":"video_control","all":["^control.blocks.#","^control.proj.in"]},
    {"id":"ltx2_av","family":"LTX-2.x","role":"diffusion_model","task":"video_audio","any":["audio.adaln.single","av.ca.a2v.gate.adaln.single","audio.patchify.proj"],"probe":["adaln.single.linear",1],"sizes":{"4096":"22B"},"blocks":"transformer.blocks.#.attn1.to.q"},
    {"id":"ltxv","family":"LTX-Video 0.9","role":"diffusion_model","task":"video","all":["transformer.blocks.#.attn1.to.k","transformer.blocks.#.attn2.to.k"],"any":["adaln.single.linear","caption.projection","patchify.proj"],"lora_all":["transformer.blocks.#.attn1.to.(k|q)","transformer.blocks.#.attn2.to.(k|q)"],"lora_none":["transformer.blocks.#.attn.add.k.proj","single.transformer.blocks","img.mlp","down.blocks","up.blocks"],"lora_probe":["transformer.blocks.#.attn1.to.q",1],"sizes":{"2048":"2B","4096":"13B/22B (LTX-2)"},"blocks":"transformer.blocks.#.attn1.to.q"},
    {"id":"hunyuan_video","family":"HunyuanVideo","role":"diffusion_model","task":"video","all":["double.blocks.#.img.attn.qkv","txt.in.individual.token.refiner"]},
    {"id":"wan","family":"Wan 2.x","role":"diffusion_model","task":"video","all":["blocks.#.self.attn.q","blocks.#.cross.attn.k","blocks.#.ffn"],"none":["single.blocks","double.blocks","adaln.modulation"],"probe":["patch.embedding",0],"lora_probe":["blocks.#.self.attn.q",1],"sizes":{"1536":"1.3B","3072":"5B","5120":"14B"},"blocks":"blocks.#.self.attn.q","flags":{"i2v":["cross.attn.k.img","img.emb"],"vace":["vace.blocks"],"animate":["pose.patch.embedding","face.adapter","motion.encoder"]}},
    {"id":"qwen_image","family":"Qwen-Image","role":"diffusion_model","task":"image","all":["transformer.blocks.#.img.mlp","transformer.blocks.#.txt.mod"],"lora_all":["transformer.blocks.#.attn.add.k.proj"],"lora_any":["img.mlp","img.mod","txt.mlp"],"probe":["img.in",0],"sizes":{"3072":"20B"},"blocks":"transformer.blocks.#.img.mlp","flags":{"edit_plus":["index.timestep.zero"]}},
    {"id":"flux2","family":"FLUX.2","role":"diffusion_model","task":"image","any":["double.stream.modulation.img","single.stream.modulation"],"probe":["context.embedder",0],"sizes":{"3072":"Klein 4B","6144":"dev 32B"}},
    {"id":"flux1","family":"FLUX.1","role":"diffusion_model","task":"image","any":["double.blocks.#.img.attn.qkv","single.transformer.blocks.#.attn.to.k"],"lora_any":["double.blocks.#.img.attn.(qkv|proj)","single.transformer.blocks.#","single.blocks.#.linear1"],"flags":{"chroma":["distilled.guidance.layer"]}},
    {"id":"sd3","family":"Stable Diffusion 3.x","role":"diffusion_model","task":"image","all":["joint.blocks.#.context.block"]},
    {"id":"seedvr2","family":"SeedVR2","role":"diffusion_model","task":"video_upscale","any":["blocks.#.ada.vid","blocks.#.mlp.vid.proj.in","blocks.#.attn.proj.qkv.vid"],"probe":["vid.in.proj",0],"sizes":{"2560":"3B","3072":"7B"},"blocks":"blocks.#.ada.(vid|all)"},
    {"id":"sdxl","family":"SDXL","role":"diffusion_model","task":"image","all":["input.blocks.#.#"],"any":["label.emb.#.#","conditioner.embedders.1"],"lora_any":["lora.te2","input.blocks.#.#.transformer.blocks.#.attn2.to.k"]},
    {"id":"sd2","family":"Stable Diffusion 2.x","role":"diffusion_model","task":"image","all":["input.blocks.#.#","cond.stage.model.model.transformer"]},
    {"id":"sd15","family":"Stable Diffusion 1.5","role":"diffusion_model","task":"image","any":["input.blocks.#.#.transformer.blocks","down.blocks.#.attentions.#.transformer.blocks"],"none":["joint.blocks","label.emb"]},
    {"id":"trellis_flow","family":"TRELLIS / TripoSplat (3D)","role":"3d","task":"image_to_3d","all":["adaln.modulation.1","blocks.#.cross.attn"],"none":["patch.embedding"]},
    {"id":"controlnet_sd","family":"ControlNet","role":"controlnet","task":"image_control","any":["input.hint.block","controlnet.cond.embedding","zero.convs.#","controlnet.down.blocks"]},
    {"id":"controlnet_flux","family":"ControlNet (DiT)","role":"controlnet","task":"image_control","all":["controlnet.blocks.#"]},
    {"id":"ipadapter","family":"IP-Adapter","role":"adapter","task":"image_control","all":["ip.adapter"],"any":["image.proj"]},
    {"id":"gemma_ltx","family":"Gemma (encodeur LTX-2)","role":"text_encoder","all":["layers.#.pre.feedforward.layernorm","text.embedding.projection"]},
    {"id":"gemma","family":"Gemma","role":"text_encoder","all":["layers.#.pre.feedforward.layernorm"]},
    {"id":"qwen3_vl","family":"Qwen3-VL","role":"text_encoder","all":["^visual.blocks","deepstack.merger.list"],"probe":["embed.tokens",1],"sizes":{"2048":"2B","2560":"4B","4096":"8B","5120":"32B"}},
    {"id":"qwen25_vl","family":"Qwen2.5-VL","role":"text_encoder","all":["^visual.blocks","^(model.)?layers.#"],"probe":["embed.tokens",1],"sizes":{"2048":"3B","3584":"7B","5120":"32B"}},
    {"id":"qwen3","family":"Qwen3","role":"text_encoder","all":["layers.#.self.attn.q.norm","layers.#.mlp.gate.proj"],"none":["^visual"],"probe":["embed.tokens",1],"sizes":{"1024":"0.6B","2048":"1.7B","2560":"4B","4096":"8B"}},
    {"id":"llama","family":"Llama","role":"llm","all":["layers.#.self.attn.q.proj","layers.#.mlp.gate.proj"],"none":["^visual","layers.#.self.attn.q.norm"],"probe":["embed.tokens",0],"sizes":{"32000":"Llama 2 / Mistral","128256":"Llama 3"}},
    {"id":"umt5","family":"umT5-XXL","role":"text_encoder","all":["encoder.block.#.layer.0.selfattention.q"],"probe":["shared",0],"sizes":{"32128":"T5-XXL (Flux/SD3)","256384":"umT5-XXL (Wan)"}},
    {"id":"clip_text","family":"CLIP texte","role":"text_encoder","all":["text.model.encoder.layers.#"],"probe":["text.model.embeddings.token.embedding",1],"sizes":{"768":"CLIP-L","1024":"OpenCLIP-H","1280":"CLIP-G"}},
    {"id":"clip_vision","family":"CLIP Vision","role":"clip_vision","all":["vision.model.encoder.layers.#"],"any":["visual.projection","vision.model.post.layernorm"],"probe":["vision.model.embeddings.patch.embedding",0],"sizes":{"1024":"ViT-L","1280":"ViT-H","1664":"ViT-bigG"}},
    {"id":"minimax_vae","family":"MiniMax H3","role":"vae","meta_any":["minimax_h3_video_vae","minimax_h3_audio_vae"]},
    {"id":"ltx_audio_vae","family":"LTX-2.x","role":"audio_vae","all":["^audio.vae","^vocoder"]},
    {"id":"ltx_vae","family":"LTX-2.x / LTX-Video","role":"vae","all":["per.channel.statistics"]},
    {"id":"wan_vae","family":"Wan 2.x / Qwen-Image","role":"vae","all":["^encoder.downsamples","^decoder.upsamples"],"probe":["^conv2",0],"sizes":{"16":"Wan 2.1 / Qwen-Image (16 canaux)","48":"Wan 2.2 (48 canaux)"}},
    {"id":"flux2_vae","family":"FLUX.2","role":"vae","all":["^bn.running.mean","^decoder"]},
    {"id":"kl_vae","family":"VAE (AutoencoderKL)","role":"vae","any":["^(first.stage.model.)?decoder.up.#.block","^decoder.up.blocks.#","^decoder.mid.block"],"none":["^model.diffusion.model","^unet"],"probe":["^(first.stage.model.)?decoder.conv.in",1],"sizes":{"4":"SD 1.5 / SDXL (4 canaux)","16":"16 canaux (Flux.1 / SD3 / video)"}},
    {"id":"ltx_latent_up","family":"LTX-2.x","role":"latent_upscaler","all":["^post.upsample.res.blocks","^upsampler"]},
    {"id":"esrgan","family":"ESRGAN / Real-ESRGAN","role":"upscaler","any":["^model.1.sub.#.rdb1","^body.#.rdb1","^rrdb.trunk"]},
    {"id":"span","family":"SPAN","role":"upscaler","all":["^block.1.c1.r"]},
    {"id":"swinir","family":"SwinIR / DAT / HAT","role":"upscaler","all":["^layers.#.residual.group"]},
    {"id":"video_depth_anything","family":"Video Depth Anything","role":"depth","task":"depth_video","all":["pretrained.blocks.#","head.motion.modules"]},
    {"id":"depth_anything3","family":"Depth Anything 3","role":"depth","task":"depth_multiview","all":["^model.backbone.pretrained","^model.head.scratch"]},
    {"id":"depth_anything2","family":"Depth Anything V2","role":"depth","task":"depth_image","any":["^neck.reassemble.stage","^depth.head.scratch"],"probe":["^backbone.embeddings.patch.embeddings.projection",0],"sizes":{"384":"Small","768":"Base","1024":"Large"}},
    {"id":"sam2","family":"SAM 2","role":"segmentation","task":"segment_track","any":["^image.encoder.trunk","^memory.attention","^memory.encoder"]},
    {"id":"birefnet","family":"BiRefNet","role":"segmentation","task":"cutout","all":["^bb.layers"],"any":["^squeeze.module","^decoder"]},
    {"id":"matanyone","family":"MatAnyone","role":"matting","task":"matte_video","all":["^mask.encoder","^pixel.encoder"]},
    {"id":"raft","family":"RAFT","role":"optical_flow","all":["^feature.encoder","^update.block"]},
    {"id":"rife","family":"RIFE","role":"frame_interp","any":["^block0.conv0","^block.tea"]},
    {"id":"dino","family":"DINOv2/v3","role":"vision_backbone","all":["^embeddings.(cls|mask).token"],"any":["^layer.#","^encoder.layer.#","^blocks.#"],"flags":{"registers":["^embeddings.register.tokens"]}},
  ],
  nameHints: [
    ["ltx-?2\\.?5",{"family":"LTX-2.x","version":"2.5"}],
    ["ltx-?2\\.?3",{"family":"LTX-2.x","version":"2.3"}],
    ["layout-to-render",{"adapter":"IC-LoRA Layout-To-Render"}],
    ["refine-details",{"adapter":"IC-LoRA Refine-Details"}],
    ["union-control",{"adapter":"IC-LoRA Union-Control"}],
    ["in-outpainting",{"adapter":"IC-LoRA In/Outpainting"}],
    ["ingredients",{"adapter":"IC-LoRA Ingredients"}],
    ["ripple",{"adapter":"Ripple (propagation 1re image)"}],
    ["lightning|lightx2v|distill|turbo|\\d+steps?|8step",{"speed":"acceleree (peu d'etapes)"}],
    ["qwen.?image.?edit",{"family":"Qwen-Image","variant":"Edit"}],
    ["qwen_image_vae",{"family":"Qwen-Image"}],
    ["wan.?animate",{"family":"Wan 2.x","variant":"Animate"}],
    ["wan2[._]1.?vae",{"family":"Wan 2.x"}],
    ["seedvr2.*vae|ema_vae",{"family":"SeedVR2"}],
    ["minimax",{"family":"MiniMax H3"}],
    ["nvfp4",{"quant_hint":"nvfp4"}],
    ["int8",{"quant_hint":"int8"}],
    ["fp8",{"quant_hint":"fp8"}],
    ["kimodo",{"family":"NVIDIA Kimodo","role":"motion"}],
    ["llm2vec",{"family":"LLM2Vec (Llama 3)","role":"llm"}],
    ["trellis",{"family":"TRELLIS.2 (3D)","role":"3d"}],
    ["triposplat",{"family":"TripoSplat (3D)","role":"3d"}],
    ["klein",{"family":"FLUX.2"}],
    ["marigold",{"family":"Marigold Normals","role":"normals"}],
    ["face_landmarker",{"family":"MediaPipe Face Landmarker","role":"face"}],
    ["raft_large",{"family":"RAFT","role":"optical_flow"}],
    ["video_depth_anything_vit(s|b|l)",{"family":"Video Depth Anything","role":"depth"}],
    ["sam2",{"family":"SAM 2"}],
    ["birefnet",{"family":"BiRefNet","role":"segmentation"}],
    ["multivue/cameras|da3",{"family":"Depth Anything 3","role":"depth"}],
    ["dino.?v3",{"family":"DINOv3","role":"vision_backbone"}],
  ],
  hfArch: {
    "BiRefNet": ["BiRefNet","segmentation"],
    "DepthAnythingForDepthEstimation": ["Depth Anything V2","depth"],
    "Sam2VideoModel": ["SAM 2","segmentation"],
    "Sam2Model": ["SAM 2","segmentation"],
    "MarigoldNormalsPipeline": ["Marigold Normals","normals"],
    "MarigoldDepthPipeline": ["Marigold Depth","depth"],
    "Flux2KleinPipeline": ["FLUX.2","pipeline"],
    "FluxPipeline": ["FLUX.1","pipeline"],
    "StableDiffusionXLPipeline": ["SDXL","pipeline"],
    "StableDiffusionPipeline": ["Stable Diffusion 1.5","pipeline"],
    "LlamaForCausalLM": ["Llama","llm"],
    "Qwen3ForCausalLM": ["Qwen3","llm"],
    "DINOv3ViTModel": ["DINOv3","vision_backbone"],
    "Dinov2Model": ["DINOv2","vision_backbone"],
    "SparseStructureFlowModel": ["TRELLIS (3D)","3d"],
    "DepthAnything3Net": ["Depth Anything 3","depth"],
  },
  weightExt: [".bin",".ckpt",".gguf",".onnx",".pt",".pt2",".pth",".safetensors",".sft",".task",".tflite"],
  partialExt: [".crdownload",".download",".incomplete",".part",".partial"],
  pruneDirs: ["$recycle.bin",".git",".locks","3dressources","__pycache__","appdata\\local\\temp","binaries","content","deriveddatacache","intermediate","megascans library","node_modules","onedrive","plugins","program files","program files (x86)","python","saved","site-packages","standalone-env","system volume information","temp","venv","venv_mediapipe","windows"],
  ggufFtype: {"0":"F32","1":"F16","2":"Q4_0","3":"Q4_1","7":"Q8_0","8":"Q5_0","9":"Q5_1","10":"Q2_K","11":"Q3_K_S","12":"Q3_K_M","13":"Q3_K_L","14":"Q4_K_S","15":"Q4_K_M","16":"Q5_K_S","17":"Q5_K_M","18":"Q6_K","19":"IQ2_XXS","20":"IQ2_XS","21":"Q2_K_S","22":"IQ3_XS","23":"IQ3_XXS","24":"IQ1_S","25":"IQ4_NL","26":"IQ3_S","27":"IQ3_M","28":"IQ2_S","29":"IQ2_M","30":"IQ4_XS","31":"IQ1_M","32":"BF16","38":"MXFP4"},
  ggufDiffusionArch: ["aura","chroma","cosmos","flux","hidream","hunyuan","hyvid","ltxv","lumina","lumina2","qwen_image","sd1","sd3","sdxl","wan"],
};

// Dossiers de modèles connus de ComfyUI (GET /models/<dossier>). `videodepthanything` n'est pas listé par
// /models : le custom node le lit en direct, on le marque « comfy » à la main (models.md §5.4).
const COMFY_FOLDERS = ['checkpoints', 'diffusion_models', 'unet', 'text_encoders', 'clip', 'vae', 'loras',
  'clip_vision', 'controlnet', 'model_patches', 'upscale_models', 'latent_upscale_models', 'seedvr2',
  'audio_encoders', 'background_removal', 'frame_interpolation', 'optical_flow', 'detection',
  'geometry_estimation', 'style_models', 'embeddings', 'gligen', 'photomaker', 'vae_approx', 'diffusers',
  'hypernetworks', 'classifiers'];
const UNLISTED_COMFY_FOLDERS = ['videodepthanything'];
// Sous-dossiers que ComfyUI range sous un autre nom de liste (folder_paths.py).
const FOLDER_ALIASES = { unet: 'diffusion_models', clip: 'text_encoders', t2i_adapter: 'controlnet' };
// Préférence entre deux copies identiques : un dossier natif l'emporte sur un dossier de custom node.
const FOLDER_RANK = ['diffusion_models', 'loras', 'vae', 'text_encoders', 'clip_vision', 'latent_upscale_models',
  'model_patches', 'controlnet', 'videodepthanything', 'seedvr2'];

// Seuils de taille (octets) : 1 Mo dans les racines connues, 50 Mo en recherche large.
const MIN_BYTES_ROOT = 1 << 20;
const MIN_BYTES_BROAD = 50 << 20;

// ---------------------------------------------------------------------------------------------
// 2. Racines, dans l'ordre de models.md §5.2 (les fichiers yaml de ComfyUI sont insérés par le scanner
//    juste après la racine du labo). Libellés en FR/EN : ils s'affichent dans le détail d'un modèle.
// ---------------------------------------------------------------------------------------------
function knownRoots(env) {
  const E = env.engineRoot, H = env.home, L = env.local, R = env.roaming;
  const train = { fr: "LoRA en cours d’entraînement", en: 'LoRAs in training' };
  return [
    { path: `${E}/models`, kind: 'comfy', label: { fr: 'Dossier du moteur', en: 'Engine folder' }, lab: true },
    { path: `${L}/Comfy-Desktop/ComfyUI-Shared/models`, kind: 'comfy', app: 'ComfyUI Desktop',
      label: { fr: 'ComfyUI Desktop', en: 'ComfyUI Desktop' } },
    { path: `${E}/env/ComfyUI/models`, kind: 'comfy', label: { fr: 'ComfyUI (dossier interne)', en: 'ComfyUI (internal folder)' } },
    { glob: `${L}/Comfy-Desktop/ComfyUI-Installs/*/ComfyUI/models`, kind: 'comfy', app: 'ComfyUI Desktop',
      label: { fr: 'ComfyUI Desktop (installation)', en: 'ComfyUI Desktop (install)' } },
    { glob: 'C:/ComfyUI*/**/models', kind: 'comfy', app: 'ComfyUI', label: { fr: 'ComfyUI', en: 'ComfyUI' } },
    { glob: 'D:/ComfyUI*/**/models', kind: 'comfy', app: 'ComfyUI', label: { fr: 'ComfyUI', en: 'ComfyUI' } },
    { glob: `${E}/personnages/*/lora`, kind: 'training', label: train },
    { glob: `${E}/projects/*/lora`, kind: 'training', label: train },
    { glob: `${E}/projects/*/*/lora`, kind: 'training', label: train },
    { path: 'C:/LocalMesh/models', kind: 'app', app: 'LocalMesh', label: { fr: 'LocalMesh', en: 'LocalMesh' } },
    { path: `${H}/StabilityMatrix/Models`, kind: 'app', app: 'Stability Matrix', label: { fr: 'Stability Matrix', en: 'Stability Matrix' } },
    { path: `${R}/StabilityMatrix/Models`, kind: 'app', app: 'Stability Matrix', label: { fr: 'Stability Matrix', en: 'Stability Matrix' } },
    { path: env.ollama, kind: 'ollama', app: 'Ollama', label: { fr: 'Ollama', en: 'Ollama' } },
    { path: `${H}/.lmstudio/models`, kind: 'app', app: 'LM Studio', label: { fr: 'LM Studio', en: 'LM Studio' } },
    { path: `${H}/.cache/lm-studio/models`, kind: 'app', app: 'LM Studio', label: { fr: 'LM Studio', en: 'LM Studio' } },
    { path: `${H}/pinokio/api`, kind: 'app', app: 'Pinokio', label: { fr: 'Pinokio', en: 'Pinokio' } },
    { path: `${H}/invokeai/models`, kind: 'app', app: 'InvokeAI', label: { fr: 'InvokeAI', en: 'InvokeAI' } },
    { path: `${env.hfHome}/hub`, kind: 'hf_cache', label: { fr: 'Hugging Face (cache)', en: 'Hugging Face (cache)' } },
  ];
}

// Fichiers extra_model_paths de ComfyUI dont on lit les `base_path` (racines supplémentaires).
function extraPathFiles(env) {
  return [
    `${env.engineRoot}/config/*.yaml`,
    `${env.roaming}/Comfy Desktop/instance-model-paths/*.yaml`,
    `${env.local}/Comfy-Desktop/ComfyUI-Installs/*/ComfyUI/extra_model_paths.yaml`,
    `${env.engineRoot}/env/ComfyUI/extra_model_paths.yaml`,
  ];
}

// Recherche large (sur demande seulement) : tout D:\ et le profil.
function broadRoots(env) {
  return ['D:/', env.home];
}

// Ce que dit une autre application, en une ligne.
const APPS = {
  'LocalMesh': { fr: 'Image vers 3D', en: 'Image to 3D' },
  'Kimodo Studio': { fr: 'Texte vers mouvement (mocap)', en: 'Text to motion (mocap)' },
  'ComfyUI Desktop': { fr: 'Ancienne installation de ComfyUI, que le moteur de Mia ne lit pas', en: "Former ComfyUI install, not read by Mia's engine" },
  'ComfyUI': { fr: 'Une autre installation de ComfyUI', en: 'Another ComfyUI install' },
  'Ollama': { fr: 'Assistants texte', en: 'Text assistants' },
  'LM Studio': { fr: 'Assistants texte', en: 'Text assistants' },
  'Stability Matrix': { fr: 'Gestionnaire de modèles d’image', en: 'Image model manager' },
  'Pinokio': { fr: 'Lanceur d’applications IA', en: 'AI app launcher' },
  'InvokeAI': { fr: 'Création d’images', en: 'Image creation' },
};

// ---------------------------------------------------------------------------------------------
// 3. Capacités : vocabulaire FERMÉ (SPEC §7, utilisé par nodes.json `caps`). `prefer` = clés du catalogue,
//    dans l'ordre du choix « Auto ». `group` = section de la bibliothèque.
// ---------------------------------------------------------------------------------------------
// Fichier attendu : nom exact, dossier de ComfyUI (sous <engineRoot>\models) et taille approximative. Sert à dire
// QUOI ajouter et OÙ quand un modèle ou une pièce manque (jamais de téléchargement par Mia).
const F = (file, folder, sizeGB = null) => ({ file, folder, sizeGB });
const FILES = {
  ltx: F('ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', 'diffusion_models', 21.5),
  ltxTe: F('gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', 'text_encoders', 15.4),
  ltxVae: F('ltx-2.5-video-vae-bf16.safetensors', 'vae', 1.5),
  ltxAudioVae: F('ltx-2.5-audio-vae-bf16.safetensors', 'vae', 0.4),
  ltxL2r: F('ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors', 'loras', 1.3),
  ltxUnion: F('ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors', 'loras', 0.7),
  ltxIngredients: F('ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors', 'loras', 1.3),
  minimax: F('minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'diffusion_models', 21),
  minimaxTe: F('qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'text_encoders', 15.7),
  minimaxVae: F('minimax_h3_video_vae_fp16.safetensors', 'vae', 5.2),
  minimaxControl: F('minimax_h3_fun_controlnet_union_2.0_pruned_int8_convrot.safetensors', 'model_patches', 4.5),
  ref2v: F('minimax_h3_ref2va_pruned_int8_convrot.safetensors', 'diffusion_models', 21),
  ref2vTurbo: F('minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors', 'loras', 2),
  wan: F('wan_animate_2_int8_convrot.safetensors', 'diffusion_models', 16.7),
  wanTe: F('umt5_xxl_fp8_e4m3fn_scaled.safetensors', 'text_encoders', 6.7),
  wanVision: F('clip_vision_h.safetensors', 'clip_vision', 1.3),
  wanVae: F('Wan2_1_VAE_bf16.safetensors', 'vae', 0.25),
  qwen: F('qwen_image_edit_2511_int8_convrot.safetensors', 'diffusion_models', 20.5),
  qwenTe: F('qwen_2.5_vl_7b_fp8_scaled.safetensors', 'text_encoders', 9.4),
  qwenVae: F('qwen_image_vae.safetensors', 'vae', 0.25),
  seedvr2: F('seedvr2_7b_int8_convrot.safetensors', 'diffusion_models', 8.3),
  seedvr2Vae: F('seedvr2_ema_vae_fp16.safetensors', 'vae', 0.5),
  vda: F('video_depth_anything_vits.pth', 'videodepthanything', 0.12),
  birefnet: F('BiRefNet', 'outils', 0.44),
};

const LTX_ORDER = ['ltx-int8', 'ltx-nvfp4', 'ltx-other'];
// `name` = le modèle attendu, `files` = ce qu'il faut ajouter quand la capacité manque ; `download` = rien n'est encore sur le PC.
// `optional` = capacité facultative (jamais listée dans « Il manque »).
const CAPS = [
  { id: 'image-to-video', group: 'video', prefer: [...LTX_ORDER, 'minimax'],
    name: { fr: 'LTX 2.5', en: 'LTX 2.5' },
    label: { fr: 'Animer une image', en: 'Animate an image' },
    missing: { fr: 'Aucun modèle vidéo prêt (LTX 2.5 ou MiniMax H3).', en: 'No video model ready (LTX 2.5 or MiniMax H3).' },
    files: [FILES.ltx] },
  { id: 'text-to-video', group: 'video', prefer: LTX_ORDER,
    name: { fr: 'LTX 2.5', en: 'LTX 2.5' },
    label: { fr: 'Vidéo depuis un texte', en: 'Video from text' },
    missing: { fr: "LTX 2.5 n’est pas installé.", en: 'LTX 2.5 is not installed.' },
    files: [FILES.ltx] },
  { id: '3d-to-real', group: 'video', prefer: LTX_ORDER,
    name: { fr: 'LTX 2.5 · Blockout → rendu', en: 'LTX 2.5 · Blockout to render' },
    label: { fr: 'Rendre photoréaliste', en: 'Make it photoreal' },
    missing: { fr: 'Il faut LTX 2.5 et son mode « Blockout → rendu ».', en: 'Needs LTX 2.5 and its “Blockout to render” mode.' },
    files: [FILES.ltx, FILES.ltxL2r] },
  // Vidéo guidée (SPEC §17) : LTX + mode Union-Control par défaut, MiniMax H3 + son guidage en alternative.
  { id: 'guided-video', group: 'video', prefer: [...LTX_ORDER, 'minimax'],
    name: { fr: 'LTX 2.5 · Vidéo guidée', en: 'LTX 2.5 · Guided video' },
    label: { fr: 'Vidéo guidée', en: 'Guided video' },
    missing: { fr: 'Il faut LTX 2.5 et son mode « Vidéo guidée », ou MiniMax H3 et son guidage.',
      en: 'Needs LTX 2.5 and its “Guided video” mode, or MiniMax H3 and its guidance.' },
    files: [FILES.ltx, FILES.ltxUnion] },
  // Vidéo à partir de références (SPEC §17) : MiniMax H3 « Reference to Video » (souvent pas encore installé).
  { id: 'reference-to-video', group: 'video', prefer: ['minimax-ref2v'],
    name: { fr: 'MiniMax H3 · Références', en: 'MiniMax H3 · References' },
    label: { fr: 'Vidéo à partir de références', en: 'Video from references' },
    missing: { fr: 'Modèle non installé : MiniMax H3 Références (≈ 23 Go à télécharger).',
      en: 'Model not installed: MiniMax H3 References (≈ 23 GB to download).' },
    files: [FILES.ref2v, FILES.ref2vTurbo], download: true, sizeGB: 23 },
  { id: 'character-performance', group: 'video', prefer: ['wan-animate'],
    name: { fr: 'Wan Animate 2', en: 'Wan Animate 2' },
    label: { fr: 'Animer un personnage', en: 'Animate a character' },
    missing: { fr: "Wan Animate 2 n’est pas installé.", en: 'Wan Animate 2 is not installed.' },
    files: [FILES.wan] },
  { id: 'image-edit', group: 'image', prefer: ['qwen-edit'],
    name: { fr: 'Qwen Image Edit', en: 'Qwen Image Edit' },
    label: { fr: 'Retoucher une image', en: 'Edit an image' },
    missing: { fr: "Qwen Image Edit n’est pas installé.", en: 'Qwen Image Edit is not installed.' },
    files: [FILES.qwen] },
  { id: 'upscale', group: 'upscale', prefer: ['seedvr2-7b', 'seedvr2-3b'],
    name: { fr: 'SeedVR2', en: 'SeedVR2' },
    label: { fr: 'Agrandir', en: 'Upscale' },
    missing: { fr: "SeedVR2 n’est pas installé.", en: 'SeedVR2 is not installed.' },
    files: [FILES.seedvr2] },
  // Depth Anything V2 n'est pas branché dans le bloc Profondeur : jamais proposé, jamais choisi par « Auto ».
  { id: 'depth', group: 'depth', prefer: ['vda-small'],
    name: { fr: 'Video Depth Anything · Small', en: 'Video Depth Anything · Small' },
    label: { fr: 'Profondeur', en: 'Depth' },
    missing: { fr: "Video Depth Anything (Small) n’est pas installé.", en: 'Video Depth Anything (Small) is not installed.' },
    files: [FILES.vda] },
  { id: 'cutout', group: 'cutout', prefer: ['birefnet'],
    name: { fr: 'BiRefNet', en: 'BiRefNet' },
    label: { fr: 'Détourer', en: 'Cut out' },
    missing: { fr: "BiRefNet n’est pas installé.", en: 'BiRefNet is not installed.' },
    files: [FILES.birefnet] },
  // LoRA (SPEC §12) : facultatif, pas de choix « Auto » (le bloc part de « Aucun »).
  { id: 'lora', group: 'loras', prefer: [], noDefault: true, optional: true,
    label: { fr: 'Mes LoRA', en: 'My LoRAs' },
    missing: { fr: 'Aucun LoRA pour l’instant : glisse un fichier LoRA sur Mia pour en ajouter.',
      en: 'No LoRA yet: drop a LoRA file on Mia to add one.' } },
];

// ---------------------------------------------------------------------------------------------
// 3 bis. Modèles de base et LoRA : chaque modèle de base porte `baseKey`, chaque LoRA `loraFor` (même clé).
//        Un bloc ne propose que les LoRA dont `loraFor` = `baseKey` de son modèle.
// ---------------------------------------------------------------------------------------------
const BASES = {
  ltx: { families: ['LTX-2.x'], label: { fr: 'LTX 2.5', en: 'LTX 2.5' }, media: 'video' },
  minimax: { families: ['MiniMax H3'], label: { fr: 'MiniMax H3', en: 'MiniMax H3' }, media: 'video' },
  wan: { families: ['Wan 2.x'], label: { fr: 'Wan', en: 'Wan' }, media: 'video' },
  qwen: { families: ['Qwen-Image'], label: { fr: 'Qwen Image', en: 'Qwen Image' }, media: 'image' },
  seedvr2: { families: ['SeedVR2'], label: { fr: 'SeedVR2', en: 'SeedVR2' }, media: 'video' },
  ltxv: { families: ['LTX-Video 0.9'], label: { fr: 'LTX-Video 0.9 (ancienne version)', en: 'LTX-Video 0.9 (old version)' }, media: 'video' },
  hunyuan: { families: ['HunyuanVideo'], label: { fr: 'HunyuanVideo', en: 'HunyuanVideo' }, media: 'video' },
  flux: { families: ['FLUX.1'], label: { fr: 'FLUX.1', en: 'FLUX.1' }, media: 'image' },
  flux2: { families: ['FLUX.2'], label: { fr: 'FLUX.2', en: 'FLUX.2' }, media: 'image' },
  sdxl: { families: ['SDXL'], label: { fr: 'SDXL', en: 'SDXL' }, media: 'image' },
  sd15: { families: ['Stable Diffusion 1.5'], label: { fr: 'Stable Diffusion 1.5', en: 'Stable Diffusion 1.5' }, media: 'image' },
  sd2: { families: ['Stable Diffusion 2.x'], label: { fr: 'Stable Diffusion 2', en: 'Stable Diffusion 2' }, media: 'image' },
  sd3: { families: ['Stable Diffusion 3.x'], label: { fr: 'Stable Diffusion 3', en: 'Stable Diffusion 3' }, media: 'image' },
};
const MEDIA_WORD = { video: { fr: 'vidéo', en: 'video' }, image: { fr: 'image', en: 'image' } };
const FAMILY_BASE = new Map(Object.entries(BASES).flatMap(([k, b]) => b.families.map((f) => [f, k])));
const baseKeyOf = (family) => (family ? FAMILY_BASE.get(family) || null : null);
// « LTX 2.5 (vidéo) » : ce qu'affiche la modale « Ajouter un LoRA » et le détail d'un LoRA.
function baseLabel(key, withMedia = true) {
  const b = BASES[key];
  if (!b) return null;
  if (!withMedia) return { ...b.label };
  const w = MEDIA_WORD[b.media] || { fr: '', en: '' };
  return { fr: `${b.label.fr} (${w.fr})`, en: `${b.label.en} (${w.en})` };
}
const GENRES = {
  character: { fr: 'Personnage', en: 'Character' },
  place: { fr: 'Lieu', en: 'Place' },
  style: { fr: 'Style', en: 'Style' },
};
// Phrase simple d'un LoRA, selon son genre et son modèle de base.
function loraDesc(genre, loraFor) {
  const b = BASES[loraFor];
  if (!b) return { fr: 'Un LoRA dont Mia ne reconnaît pas le modèle d’origine.', en: 'A LoRA whose base model Mia does not recognise.' };
  const what = {
    character: { fr: 'Un personnage à toi', en: 'A character of yours' },
    place: { fr: 'Un lieu à toi', en: 'A place of yours' },
    style: { fr: 'Un style', en: 'A style' },
  }[genre] || { fr: 'Un LoRA', en: 'A LoRA' };
  return { fr: `${what.fr}, pour ${b.label.fr}.`, en: `${what.en}, for ${b.label.en}.` };
}
// Nom affiché d'un LoRA d'après son fichier : « mara_ltx25_02000.safetensors » → « Mara ».
function loraNameFromFile(file) {
  const raw = String(file || '').replace(/\.(safetensors|sft|ckpt|pt|pth|bin|gguf)$/i, '');
  // le numéro d'étape final, et le mot qui l'annonce (« lora_weights_step_01500 » → « weights »)
  let s = raw.replace(/(?:[_\-. ](?:steps?|epoch))?[_\-. ]0*\d{3,6}$/i, '');
  s = s.replace(/(^|[_\-. ])(ltx[-_.]?2(?:[._]?\d)?|ltx25|ltxv|lora|wan(?:2(?:[._]\d)?)?|qwen|flux|sdxl|v\d+(?:[._]\d+)?)(?=[_\-. ]|$)/gi, '$1');
  s = s.replace(/[_\-.]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!s) s = raw.replace(/[_]+/g, ' ').trim() || 'LoRA';
  return (s.charAt(0).toUpperCase() + s.slice(1)).slice(0, 60);
}
// Genre deviné d'après le nom et le mot déclencheur (la modale le laisse modifier).
function guessGenre(text) {
  const s = ` ${String(text || '').toLowerCase().replace(/[_\-.]+/g, ' ')} `;   // « style_film » se lit « style film »
  if (/\b(style|look|grade|lut|anime|painting|cinematic|aesthetic|film ?grain)\b/.test(s)) return 'style';
  if (/(toit|roof|rooftop|room|street|city|lieu|place|house|maison|interior|exterior|building|gare|station|forest|for[eê]t|\brue\b|ville|appart|kitchen|cuisine|office|bureau|landscape|paysage)/.test(s)) return 'place';
  return 'character';
}

// ---------------------------------------------------------------------------------------------
// 4. Licences (engine.md §7.9). `forbidden` = jamais proposé, quel que soit le contexte.
// ---------------------------------------------------------------------------------------------
const LIC = {
  ltx: { fr: "Usage commercial gratuit sous 10 M$ de chiffre d’affaires (licence LTX-2.x Community ; LTX-2 Community pour les fichiers LTX-2.3).",
    en: 'Free for commercial use under $10M revenue (LTX-2.x Community license; LTX-2 Community for LTX-2.3 files).' },
  apache: { fr: 'Usage commercial autorisé (Apache-2.0).', en: 'Commercial use allowed (Apache-2.0).' },
  mit: { fr: 'Usage commercial autorisé (MIT).', en: 'Commercial use allowed (MIT).' },
  bsd: { fr: 'Usage commercial autorisé (BSD).', en: 'Commercial use allowed (BSD).' },
  openrail: { fr: 'Usage commercial autorisé (OpenRAIL++-M).', en: 'Commercial use allowed (OpenRAIL++-M).' },
  minimax: { fr: 'Licence propre à MiniMax : lis-la avant un usage commercial.',
    en: "MiniMax's own license: read it before any commercial use." },
  trial: { fr: 'Non commercial (CC-BY-NC) : pour des essais seulement, pas pour un projet payé.',
    en: 'Non-commercial (CC-BY-NC): for trials only, not for paid work.' },
  nc: { fr: 'Licence non commerciale : jamais proposé dans les blocs.',
    en: 'Non-commercial license: never offered in blocks.' },
  noeu: { fr: "Licence qui exclut l’Union européenne : jamais proposé.",
    en: 'License excludes the European Union: never offered.' },
  own: { fr: 'Entraîné par toi.', en: 'Trained by you.' },
  unknown: { fr: 'Licence non vérifiée.', en: 'License not checked.' },
};

// ---------------------------------------------------------------------------------------------
// 5. Catalogue d'affichage. La 1re entrée dont `when` correspond l'emporte. Champs de `when` :
//    family / role / rule (chaîne, liste ou RegExp), name (RegExp sur le nom de fichier en minuscules),
//    path (RegExp sur le chemin complet en minuscules, séparateur /), flag (indicateur de règle), bundle (bool).
//    `needs` = pièces internes (clés du catalogue) sans lesquelles le moteur est « incomplet ».
//    `condCaps` = capacité ajoutée seulement si une pièce est prête (3D → réel exige le mode Layout-To-Render).
//    vramGB = pic estimé (models.md §6.2), speed / quality de 1 à 3 (models.md §6.3, mesures du labo).
// ---------------------------------------------------------------------------------------------
const LTX_NEEDS = ['ltx-te', 'ltx-vae', 'ltx-audio-vae'];
const LTX_COND = [{ cap: '3d-to-real', needs: 'ltx-l2r' }, { cap: 'guided-video', needs: 'ltx-union' }];
const PART = (what) => ({ hidden: true, part: what });

const CATALOG = [
  // --- interdits par licence d'abord : ils ne doivent jamais tomber dans une entrée « utilisable » ---
  { key: 'vda-forbidden', when: { name: /video_depth_anything_(vitb|vitl)|metric_video_depth|video_depth_anything_metric/ },
    label: { fr: 'Video Depth Anything · grand', en: 'Video Depth Anything · large' },
    desc: { fr: 'Profondeur vidéo, version non commerciale.', en: 'Video depth, non-commercial version.' },
    caps: ['depth'], license: 'forbidden', licenseNote: LIC.nc, vramGB: 6, speed: 2, quality: 3 },
  { key: 'hunyuan', when: { rule: 'hunyuan_video' },
    label: { fr: 'HunyuanVideo', en: 'HunyuanVideo' },
    desc: { fr: 'Modèle vidéo exclu par sa licence.', en: 'Video model excluded by its license.' },
    caps: [], license: 'forbidden', licenseNote: LIC.noeu },
  { key: 'hunyuan-name', when: { name: /hunyuan|gamecraft/ },
    label: { fr: 'HunyuanVideo', en: 'HunyuanVideo' },
    desc: { fr: 'Modèle vidéo exclu par sa licence.', en: 'Video model excluded by its license.' },
    caps: [], license: 'forbidden', licenseNote: LIC.noeu },
  { key: 'qwen-image-21', when: { name: /qwen.?image.?2[._]?1/ },
    label: { fr: 'Qwen-Image 2.1', en: 'Qwen-Image 2.1' },
    desc: { fr: 'Version de recherche, exclue par sa licence.', en: 'Research release, excluded by its license.' },
    caps: [], license: 'forbidden', licenseNote: LIC.nc },
  { key: 'matanyone', when: { family: 'MatAnyone' },
    label: { fr: 'MatAnyone', en: 'MatAnyone' },
    desc: { fr: 'Détourage fin et stable d’une vidéo (cheveux, contre-jour).', en: 'Fine, stable video matting (hair, backlight).' },
    caps: [], engine: 'worker', license: 'forbidden', licenseNote: LIC.nc, vramGB: 2, speed: 2, quality: 3 },
  { key: 'nc-misc', when: { name: /ditto|lucy.?edit|tc.?light|gimm.?vfi/ },
    label: null, desc: { fr: 'Modèle exclu par sa licence.', en: 'Model excluded by its license.' },
    caps: [], license: 'forbidden', licenseNote: LIC.nc },

  // --- moteurs vidéo ---
  { key: 'ltx-nvfp4', when: { family: 'LTX-2.x', role: 'diffusion_model', name: /nvfp4/ },
    label: { fr: 'LTX 2.5 · RTX 50', en: 'LTX 2.5 · RTX 50' },
    desc: { fr: 'Le même modèle LTX en format ultra-compact pour les cartes RTX 50 : un peu plus rapide.',
      en: 'The same LTX model in an ultra-compact format for RTX 50 cards: a little faster.' },
    caps: ['image-to-video', 'text-to-video'], condCaps: LTX_COND, needs: LTX_NEEDS, tier: 'blackwell',
    license: 'ok', licenseNote: LIC.ltx, vramGB: 19, speed: 3, quality: 3 },
  { key: 'ltx-int8', when: { family: 'LTX-2.x', role: 'diffusion_model', name: /int8/ },
    label: { fr: 'LTX 2.5', en: 'LTX 2.5' },
    desc: { fr: "Vidéo à partir d’une image, d’un texte ou d’un rendu 3D. Le plus polyvalent, réglé pour 24 Go de mémoire vidéo.",
      en: 'Video from an image, a text or a 3D render. The most versatile, tuned for 24 GB of video memory.' },
    caps: ['image-to-video', 'text-to-video'], condCaps: LTX_COND, needs: LTX_NEEDS, expect: FILES.ltx,
    license: 'ok', licenseNote: LIC.ltx, vramGB: 21, speed: 2, quality: 3 },
  { key: 'ltx-other', when: { family: 'LTX-2.x', role: 'diffusion_model' },
    label: null, desc: { fr: 'Modèle vidéo LTX dans une autre précision.', en: 'LTX video model in another precision.' },
    caps: ['image-to-video', 'text-to-video'], condCaps: LTX_COND, needs: LTX_NEEDS,
    license: 'ok', licenseNote: LIC.ltx, vramGB: null, speed: 1, quality: 3 },
  // « Reference to Video » (SPEC §17) : avant l'entrée générale, sinon il serait pris pour le modèle d'images.
  { key: 'minimax-ref2v', when: { family: 'MiniMax H3', role: 'diffusion_model', name: /ref2v|r2v/ },
    label: { fr: 'MiniMax H3 · Références', en: 'MiniMax H3 · References' },
    desc: { fr: "Une vidéo avec le son, à partir de tes images et vidéos de référence (jusqu’à 9 images et 3 vidéos).",
      en: 'A video with sound, from your reference images and videos (up to 9 images and 3 videos).' },
    caps: ['reference-to-video'], needs: ['minimax-te', 'minimax-vae', 'minimax-ref2v-turbo'], expect: FILES.ref2v,
    license: 'rd', licenseNote: LIC.minimax, vramGB: 21, speed: 2, quality: 3 },
  { key: 'minimax', when: { family: 'MiniMax H3', role: 'diffusion_model' },
    label: { fr: 'MiniMax H3', en: 'MiniMax H3' },
    desc: { fr: 'Vidéo avec le son, entre une première et une dernière image.',
      en: 'Video with sound, between a first and a last frame.' },
    caps: ['image-to-video'], needs: ['minimax-te', 'minimax-vae'], expect: FILES.minimax,
    condCaps: [{ cap: 'guided-video', needs: 'minimax-control' }],
    license: 'rd', licenseNote: LIC.minimax, vramGB: 21, speed: 2, quality: 3 },
  { key: 'wan-animate', when: { family: 'Wan 2.x', role: 'diffusion_model', flag: 'animate' },
    label: { fr: 'Wan Animate 2', en: 'Wan Animate 2' },
    desc: { fr: "Ton personnage, d’après une seule image, rejoue le mouvement d’une vidéo, visage stable.",
      en: 'Your character, from a single image, replays the motion of a video with a steady face.' },
    caps: ['character-performance'], needs: ['wan-te', 'wan-vision', 'wan-vae'], expect: FILES.wan,
    license: 'ok', licenseNote: LIC.apache, vramGB: 18, speed: 1, quality: 3 },
  { key: 'qwen-edit', when: { family: 'Qwen-Image', role: 'diffusion_model', name: /edit/ },
    label: { fr: 'Qwen Image Edit', en: 'Qwen Image Edit' },
    desc: { fr: 'Change une image selon ta consigne, sans bouger le cadrage.',
      en: 'Changes an image following your prompt, without moving the framing.' },
    caps: ['image-edit'], needs: ['qwen-te', 'qwen-vae'], expect: FILES.qwen,
    license: 'ok', licenseNote: LIC.apache, vramGB: 21, speed: 2, quality: 2 },

  // --- agrandir ---
  { key: 'seedvr2-7b', when: { family: 'SeedVR2', role: 'diffusion_model', name: /^seedvr2_7b/ },
    label: { fr: 'SeedVR2 · qualité', en: 'SeedVR2 · quality' },
    desc: { fr: "Agrandit fidèlement une image ou une vidéo. Plus fin, plus lent.",
      en: 'Faithfully upscales an image or a video. Finer, slower.' },
    caps: ['upscale'], needs: ['seedvr2-vae'], tier: 'quality', expect: FILES.seedvr2,
    license: 'ok', licenseNote: LIC.apache, vramGB: 12, speed: 1, quality: 2 },
  { key: 'seedvr2-3b', when: { family: 'SeedVR2', role: 'diffusion_model', name: /^seedvr2_3b/ },
    label: { fr: 'SeedVR2 · rapide', en: 'SeedVR2 · fast' },
    desc: { fr: 'Agrandit vite, idéal pour un aperçu.', en: 'Upscales fast, ideal for a preview.' },
    caps: ['upscale'], needs: ['seedvr2-vae'], tier: 'fast',
    license: 'ok', licenseNote: LIC.apache, vramGB: 7, speed: 2, quality: 1 },
  { key: 'seedvr2-cli', when: { family: 'SeedVR2', role: 'diffusion_model' },
    label: { fr: 'SeedVR2 7B · ancien outil', en: 'SeedVR2 7B · former tool' },
    desc: { fr: "Version lue par l’outil SeedVR2 en ligne de commande. Mia utilise les versions int8.",
      en: "Version read by the SeedVR2 command-line tool. Mia uses the int8 versions." },
    caps: [], unused: true, license: 'ok', licenseNote: LIC.apache, vramGB: 12, speed: 1, quality: 2 },

  // --- profondeur, détourage ---
  { key: 'vda-small', when: { name: /video_depth_anything_vits/ },
    label: { fr: 'Video Depth Anything · Small', en: 'Video Depth Anything · Small' },
    desc: { fr: 'Profondeur de chaque image, stable dans le temps (clair = proche).',
      en: 'Per-frame depth, stable over time (bright = near).' },
    caps: ['depth'], comfyFolder: 'videodepthanything',
    license: 'ok', licenseNote: LIC.apache, vramGB: 3, speed: 3, quality: 2 },
  // Pas branché dans le bloc Profondeur (qui utilise toujours Video Depth Anything) : présent, jamais proposé.
  { key: 'da2-large', when: { family: 'Depth Anything V2' },
    label: { fr: 'Depth Anything V2 · Large', en: 'Depth Anything V2 · Large' },
    desc: { fr: "Profondeur très détaillée d’une image fixe. Pour des essais seulement.",
      en: 'Very detailed depth of a still image. For trials only.' },
    caps: [], unused: true, engine: 'worker',
    license: 'trial', licenseNote: LIC.trial, vramGB: 3, speed: 2, quality: 3 },
  { key: 'birefnet', when: { family: 'BiRefNet' },
    label: { fr: 'BiRefNet', en: 'BiRefNet' },
    desc: { fr: 'Détoure le sujet principal, cheveux compris (fond transparent).',
      en: 'Cuts out the main subject, hair included (transparent background).' },
    caps: ['cutout'], engine: 'worker',
    license: 'ok', licenseNote: LIC.mit, vramGB: 2, speed: 3, quality: 3 },

  // --- outils présents mais pas encore utilisés par un bloc de Mia ---
  { key: 'sam2', when: { family: 'SAM 2' },
    label: { fr: 'SAM 2.1 · Large', en: 'SAM 2.1 · Large' },
    desc: { fr: 'Clique sur un objet : il est suivi sur toute la vidéo.', en: 'Click an object: it is tracked through the video.' },
    caps: [], unused: true, engine: 'worker', license: 'ok', licenseNote: LIC.apache, vramGB: 3, speed: 2, quality: 3 },
  { key: 'marigold', when: { family: 'Marigold Normals' },
    label: { fr: 'Marigold Normals', en: 'Marigold Normals' },
    desc: { fr: 'Orientation des surfaces, pour ré-éclairer une image.', en: 'Surface orientation, to relight an image.' },
    caps: [], unused: true, engine: 'worker', license: 'ok', licenseNote: LIC.openrail, vramGB: 4, speed: 2, quality: 3 },
  { key: 'raft', when: { family: 'RAFT' },
    label: { fr: 'RAFT · Large', en: 'RAFT · Large' },
    desc: { fr: 'Mesure le mouvement entre deux images.', en: 'Measures motion between two frames.' },
    caps: [], unused: true, engine: 'worker', license: 'ok', licenseNote: LIC.bsd, vramGB: 1, speed: 3, quality: 3 },
  { key: 'face-landmarks', when: { family: 'MediaPipe Face Landmarker' },
    label: { fr: 'Repères du visage', en: 'Face landmarks' },
    desc: { fr: '478 points du visage (regard, proportions), calculés sur le processeur.',
      en: '478 face points (gaze, proportions), computed on the CPU.' },
    caps: [], unused: true, engine: 'worker', license: 'ok', licenseNote: LIC.apache, vramGB: 0, speed: 3, quality: 3 },

  // --- modes de LTX (IC-LoRA) : pièces internes, choisies par les blocs eux-mêmes ---
  { key: 'ltx-l2r', when: { role: 'lora', name: /layout-to-render/ }, ...PART('mode'), expect: FILES.ltxL2r,
    label: { fr: 'Mode Blockout → rendu', en: 'Blockout to render mode' },
    desc: { fr: 'Ton blockout Unreal devient photoréel, le look vient d’une image clé.',
      en: 'Your Unreal blockout becomes photoreal; the look comes from a keyframe.' },
    license: 'ok', licenseNote: LIC.ltx },
  { key: 'ltx-union', when: { role: 'lora', name: /union-control/ }, ...PART('mode'), expect: FILES.ltxUnion,
    label: { fr: 'Mode Vidéo guidée', en: 'Guided video mode' },
    desc: { fr: 'La vidéo suit la profondeur ou les contours d’une vidéo guide.', en: 'The video follows the depth or the edges of a guide video.' },
    license: 'ok', licenseNote: LIC.ltx },
  { key: 'ltx-inpaint', when: { role: 'lora', name: /in-outpainting/ }, ...PART('mode'),
    label: { fr: 'Mode Refaire une zone', en: 'Redo an area mode' },
    desc: { fr: 'Régénère seulement ce que tu masques.', en: 'Regenerates only what you mask.' },
    license: 'ok', licenseNote: LIC.ltx },
  { key: 'ltx-ingredients', when: { role: 'lora', name: /ingredients/ }, ...PART('mode'), expect: FILES.ltxIngredients,
    label: { fr: "Mode Personnage d’après une fiche", en: 'Character from a sheet mode' },
    desc: { fr: "Garde l’identité d’une fiche de référence.", en: 'Keeps the identity of a reference sheet.' },
    license: 'ok', licenseNote: LIC.ltx },
  { key: 'ltx-ripple', when: { role: 'lora', name: /ripple/ }, ...PART('mode'),
    label: { fr: 'Mode Propager une retouche', en: 'Propagate an edit mode' },
    desc: { fr: 'Tu retouches la première image, la vidéo suit.', en: 'You retouch the first frame, the video follows.' },
    license: 'ok', licenseNote: LIC.ltx },
  { key: 'ltx-refine', when: { role: 'lora', name: /refine-details/ }, ...PART('mode'),
    label: { fr: 'Mode Affiner les détails (4K)', en: 'Refine details (4K) mode' },
    desc: { fr: 'Ajoute du détail sans changer le cadrage. Testé : gain quasi nul.', en: 'Adds detail without changing the framing. Tested: almost no gain.' },
    license: 'ok', licenseNote: LIC.ltx },

  // --- accélérateurs ---
  { key: 'qwen-lightning', when: { role: 'lora', name: /lightning/ }, ...PART('speedup'),
    label: { fr: 'Accélérateur Qwen (4 étapes)', en: 'Qwen accelerator (4 steps)' },
    desc: { fr: 'Rend la retouche d’image dix fois plus rapide.', en: 'Makes image editing ten times faster.' },
    license: 'ok', licenseNote: LIC.apache },
  { key: 'wan-lightx2v', when: { role: 'lora', name: /lightx2v/ }, ...PART('speedup'),
    label: { fr: 'Accélérateur Wan', en: 'Wan accelerator' },
    desc: { fr: 'Moins d’étapes de calcul pour Wan Animate.', en: 'Fewer compute steps for Wan Animate.' },
    license: 'ok', licenseNote: LIC.apache },
  { key: 'minimax-ref2v-turbo', when: { role: 'lora', name: /(ref2v|r2v).*turbo|turbo.*(ref2v|r2v)/ }, ...PART('speedup'), expect: FILES.ref2vTurbo,
    label: { fr: 'Accélérateur MiniMax Références (4 étapes)', en: 'MiniMax References accelerator (4 steps)' },
    desc: { fr: 'La vidéo à partir de références en 4 étapes de calcul.', en: 'Video from references in 4 compute steps.' },
    license: 'rd', licenseNote: LIC.minimax },
  { key: 'minimax-turbo', when: { role: 'lora', name: /turbo/ }, ...PART('speedup'),
    label: { fr: 'Accélérateur MiniMax (8 étapes)', en: 'MiniMax accelerator (8 steps)' },
    desc: { fr: 'MiniMax H3 en 8 étapes au lieu de 40.', en: 'MiniMax H3 in 8 steps instead of 40.' },
    license: 'rd', licenseNote: LIC.minimax },

  // --- encodeurs de texte et d'image ---
  { key: 'ltx-te', when: { family: 'Gemma (encodeur LTX-2)' }, ...PART('text_encoder'), expect: FILES.ltxTe,
    label: { fr: 'Encodeur de texte LTX', en: 'LTX text encoder' },
    desc: { fr: 'Lit ta consigne pour LTX (Gemma 12B).', en: 'Reads your prompt for LTX (Gemma 12B).' },
    license: 'ok', licenseNote: LIC.ltx },
  { key: 'qwen-te', when: { family: 'Qwen2.5-VL' }, ...PART('text_encoder'), expect: FILES.qwenTe,
    label: { fr: 'Encodeur de texte Qwen', en: 'Qwen text encoder' },
    desc: { fr: 'Lit ta consigne et ton image pour Qwen Image Edit.', en: 'Reads your prompt and image for Qwen Image Edit.' },
    license: 'ok', licenseNote: LIC.apache },
  { key: 'wan-te', when: { family: 'umT5-XXL' }, ...PART('text_encoder'), expect: FILES.wanTe,
    label: { fr: 'Encodeur de texte Wan', en: 'Wan text encoder' },
    desc: { fr: 'Lit ta consigne pour Wan Animate.', en: 'Reads your prompt for Wan Animate.' },
    license: 'ok', licenseNote: LIC.apache },
  { key: 'minimax-te', when: { family: 'Qwen3-VL' }, ...PART('text_encoder'), expect: FILES.minimaxTe,
    label: { fr: 'Encodeur de texte MiniMax', en: 'MiniMax text encoder' },
    desc: { fr: 'Lit ta consigne pour MiniMax H3 (Qwen3-VL 32B).', en: 'Reads your prompt for MiniMax H3 (Qwen3-VL 32B).' },
    license: 'rd', licenseNote: LIC.minimax },
  { key: 'wan-vision', when: { family: 'CLIP Vision' }, ...PART('clip_vision'), expect: FILES.wanVision,
    label: { fr: "Lecteur d’image Wan", en: 'Wan image reader' },
    desc: { fr: 'Regarde l’image de ton personnage pour Wan Animate.', en: 'Looks at your character image for Wan Animate.' },
    license: 'ok', licenseNote: LIC.mit },

  // --- décodeurs (VAE) et agrandisseur latent ---
  { key: 'ltx-audio-vae', when: { rule: 'ltx_audio_vae' }, ...PART('audio_vae'), expect: FILES.ltxAudioVae,
    label: { fr: 'Décodeur audio LTX', en: 'LTX audio decoder' },
    desc: { fr: 'Transforme le calcul de LTX en son.', en: "Turns LTX's computation into sound." },
    license: 'ok', licenseNote: LIC.ltx },
  { key: 'ltx-vae-conv', when: { rule: 'ltx_vae', name: /conv/ }, ...PART('vae'),
    label: { fr: 'Décodeur vidéo LTX · pour « Propager une retouche »', en: 'LTX video decoder · for “Propagate an edit”' },
    desc: { fr: 'Variante du décodeur utilisée par la recette « Propager une retouche ».', en: 'Decoder variant used by the “Propagate an edit” recipe.' },
    license: 'ok', licenseNote: LIC.ltx },
  { key: 'ltx-vae', when: { rule: 'ltx_vae' }, ...PART('vae'), expect: FILES.ltxVae,
    label: { fr: 'Décodeur vidéo LTX', en: 'LTX video decoder' },
    desc: { fr: 'Transforme le calcul de LTX en images.', en: "Turns LTX's computation into frames." },
    license: 'ok', licenseNote: LIC.ltx },
  { key: 'ltx-upscaler', when: { role: 'latent_upscaler' }, ...PART('latent_upscaler'),
    label: { fr: 'Agrandisseur LTX ×2 (2e étape)', en: 'LTX ×2 upscaler (2nd stage)' },
    desc: { fr: 'Double la définition de LTX pendant le calcul.', en: "Doubles LTX's resolution during the computation." },
    license: 'ok', licenseNote: LIC.ltx },
  { key: 'minimax-vae', when: { family: 'MiniMax H3', role: 'vae', name: /video/ }, ...PART('vae'), expect: FILES.minimaxVae,
    label: { fr: 'Décodeur vidéo MiniMax', en: 'MiniMax video decoder' },
    desc: { fr: 'Transforme le calcul de MiniMax en images.', en: "Turns MiniMax's computation into frames." },
    license: 'rd', licenseNote: LIC.minimax },
  { key: 'minimax-audio-vae', when: { family: 'MiniMax H3', role: 'vae' }, ...PART('audio_vae'),
    label: { fr: 'Décodeur audio MiniMax', en: 'MiniMax audio decoder' },
    desc: { fr: 'Transforme le calcul de MiniMax en son.', en: "Turns MiniMax's computation into sound." },
    license: 'rd', licenseNote: LIC.minimax },
  { key: 'minimax-control', when: { family: 'MiniMax H3', role: 'controlnet', name: /pruned|int8/ }, ...PART('controlnet'), expect: FILES.minimaxControl,
    label: { fr: 'Guidage MiniMax (profondeur, contours)', en: 'MiniMax guidance (depth, edges)' },
    desc: { fr: 'Fait suivre une vidéo guide à MiniMax H3.', en: 'Makes MiniMax H3 follow a guide video.' },
    license: 'rd', licenseNote: LIC.minimax },
  { key: 'minimax-control-full', when: { family: 'MiniMax H3', role: 'controlnet' }, ...PART('controlnet'), unused: true,
    label: { fr: 'Guidage MiniMax · version complète', en: 'MiniMax guidance · full version' },
    desc: { fr: 'Version non élaguée, plus lourde ; Mia utilise la version int8.', en: 'Unpruned, heavier version; Mia uses the int8 one.' },
    license: 'rd', licenseNote: LIC.minimax },
  { key: 'qwen-vae', when: { family: 'Qwen-Image', role: 'vae' }, ...PART('vae'), expect: FILES.qwenVae,
    label: { fr: 'Décodeur Qwen', en: 'Qwen decoder' },
    desc: { fr: 'Transforme le calcul de Qwen en image.', en: "Turns Qwen's computation into an image." },
    license: 'ok', licenseNote: LIC.apache },
  { key: 'wan-vae', when: { rule: 'wan_vae' }, ...PART('vae'), expect: FILES.wanVae,
    label: { fr: 'Décodeur Wan', en: 'Wan decoder' },
    desc: { fr: 'Transforme le calcul de Wan en images.', en: "Turns Wan's computation into frames." },
    license: 'ok', licenseNote: LIC.apache },
  { key: 'seedvr2-vae', when: { family: 'SeedVR2', role: 'vae' }, ...PART('vae'), expect: FILES.seedvr2Vae,
    label: { fr: 'Décodeur SeedVR2', en: 'SeedVR2 decoder' },
    desc: { fr: 'Transforme le calcul de SeedVR2 en images.', en: "Turns SeedVR2's computation into frames." },
    license: 'ok', licenseNote: LIC.apache },
];

// LoRA d'identité (personnage, lieu) reconnues par le nom, sur le chemin complet (le dossier d'entraînement
// `personnages/<nom>/lora/…` nomme le personnage, pas le fichier). Rien dans le dépôt : chaque utilisateur
// peut décrire les siennes dans %APPDATA%\Mia\data\identities.json (lu par le scanner au démarrage) :
//   [{ "key": "mara", "names": ["mara", "mra"], "kind": "character"|"place", "trigger": "mra woman",
//      "label": { "fr": "Mara", "en": "Mara" } }]
// Sinon le mot déclencheur vient des métadonnées d'entraînement du LoRA ou du registre loras.json.
const IDENTITY = [];
const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
/** Remplace (sur place : le scanner garde la référence) les identités par celles d'identities.json ; → combien. */
function setIdentities(list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e !== 'object') continue;
    const key = String(e.key || '').trim().toLowerCase();
    const names = (Array.isArray(e.names) ? e.names : [e.key]).map((n) => String(n || '').trim().toLowerCase())
      .filter((n) => n.length >= 2 && n.length <= 60);
    if (!/^[a-z0-9_-]{1,40}$/.test(key) || !names.length) continue;
    const kind = e.kind === 'place' ? 'place' : 'character';
    const lab = e.label && typeof e.label === 'object' ? e.label : { fr: String(e.label || key), en: String(e.label || key) };
    out.push({ key, kind, test: new RegExp(`(^|[\\/_.\\-])(${names.map(escRx).join('|')})([\\/_.\\-]|$)`),
      trigger: typeof e.trigger === 'string' && e.trigger.trim() ? e.trigger.trim().slice(0, 60) : null,
      label: { fr: String(lab.fr || lab.en || key).slice(0, 60), en: String(lab.en || lab.fr || key).slice(0, 60) } });
  }
  IDENTITY.splice(0, IDENTITY.length, ...out);
  return out.length;
}
const IDENTITY_DESC = {
  character: { fr: 'Personnage entraîné par toi, pour LTX 2.5.', en: 'Character you trained, for LTX 2.5.' },
  place: { fr: 'Lieu entraîné par toi, pour LTX 2.5.', en: 'Place you trained, for LTX 2.5.' },
};

// Phrase par défaut d'un fichier sans entrée de catalogue, d'après sa tâche puis son rôle (models.md §6.4).
const TASK_DESC = {
  video_audio: { fr: 'Créer une vidéo avec le son.', en: 'Create a video with sound.' },
  video: { fr: 'Créer une vidéo.', en: 'Create a video.' },
  image: { fr: 'Créer ou retoucher une image.', en: 'Create or edit an image.' },
  video_upscale: { fr: 'Agrandir une vidéo.', en: 'Upscale a video.' },
  depth_video: { fr: 'Passe de profondeur.', en: 'Depth pass.' },
  depth_image: { fr: "Profondeur d’une image.", en: 'Image depth.' },
  depth_multiview: { fr: 'Profondeur et caméras à partir de plusieurs vues.', en: 'Depth and cameras from several views.' },
  segment_track: { fr: 'Suivre un objet.', en: 'Track an object.' },
  cutout: { fr: 'Détourer.', en: 'Cut out.' },
  matte_video: { fr: 'Détourage vidéo fin.', en: 'Fine video matting.' },
  image_to_3d: { fr: 'Image vers 3D.', en: 'Image to 3D.' },
  image_control: { fr: 'Guider une image.', en: 'Guide an image.' },
  video_control: { fr: 'Guider une vidéo.', en: 'Guide a video.' },
};
const ROLE_DESC = {
  diffusion_model: { fr: 'Modèle de création.', en: 'Generation model.' },
  checkpoint: { fr: 'Modèle de création complet.', en: 'Complete generation model.' },
  lora: { fr: "Variante ou réglage d’un modèle.", en: 'A variant or tweak of a model.' },
  text_encoder: { fr: "Lit la consigne pour un modèle.", en: 'Reads the prompt for a model.' },
  clip_vision: { fr: "Regarde une image pour un modèle.", en: 'Looks at an image for a model.' },
  vae: { fr: "Transforme le calcul d’un modèle en images.", en: "Turns a model's computation into frames." },
  audio_vae: { fr: "Transforme le calcul d’un modèle en son.", en: "Turns a model's computation into sound." },
  latent_upscaler: { fr: 'Agrandit pendant le calcul.', en: 'Upscales during the computation.' },
  upscaler: { fr: 'Agrandir une image.', en: 'Upscale an image.' },
  controlnet: { fr: 'Guide un modèle avec une passe.', en: 'Guides a model with a pass.' },
  adapter: { fr: 'Guide un modèle avec une image.', en: 'Guides a model with an image.' },
  depth: { fr: 'Passe de profondeur.', en: 'Depth pass.' },
  segmentation: { fr: 'Détourer ou suivre un objet.', en: 'Cut out or track an object.' },
  matting: { fr: 'Détourage fin.', en: 'Fine matting.' },
  normals: { fr: 'Orientation des surfaces.', en: 'Surface orientation.' },
  optical_flow: { fr: 'Mesure le mouvement.', en: 'Measures motion.' },
  frame_interp: { fr: 'Invente des images intermédiaires.', en: 'Creates in-between frames.' },
  vision_backbone: { fr: "Analyse d’image.", en: 'Image analysis.' },
  '3d': { fr: "Pièce d’un modèle 3D.", en: 'Part of a 3D model.' },
  motion: { fr: 'Mouvement (mocap).', en: 'Motion (mocap).' },
  llm: { fr: 'Assistant texte (hors du champ de Mia).', en: "Text assistant (outside Mia's scope)." },
  pipeline: { fr: 'Ensemble complet de pièces.', en: 'A complete set of parts.' },
  face: { fr: 'Repères du visage.', en: 'Face landmarks.' },
  unknown: { fr: 'Modèle non reconnu.', en: 'Unrecognised model.' },
};
// Rôles rangés d'office dans les « Pièces internes ».
const INTERNAL_ROLES = new Set(['text_encoder', 'clip_vision', 'vae', 'audio_vae', 'latent_upscaler']);

// Pastille de précision (models.md §6.4).
function quantClass(q) {
  const s = String(q || '').toLowerCase();
  if (!s || s === '?') return null;
  if (s.includes('nvfp4') || s.includes('mxfp4')) return 'ultra';
  if (/nf4|q[2-6]|iq[1-4]|tq[12]|4 bits/.test(s)) return 'very';
  if (/int8|fp8|q8|i8/.test(s)) return 'compact';
  if (/bf16|fp16|fp32|f16|f32|fp64|f64/.test(s)) return 'full';
  return null;
}
const QUANT_LABEL = {
  full: { fr: 'Pleine qualité', en: 'Full quality' },
  compact: { fr: 'Compact', en: 'Compact' },
  ultra: { fr: 'Ultra-compact (RTX 50)', en: 'Ultra-compact (RTX 50)' },
  very: { fr: 'Très compact', en: 'Very compact' },
};

// Textes d'état affichés sous un modèle (raison d'un « inutilisé » ou d'un « incomplet »).
const NOTES = {
  training: { fr: "Étape d’entraînement : ComfyUI ne la voit pas.", en: 'Training step: ComfyUI does not see it.' },
  promoted: { fr: 'Copie de la version retenue.', en: 'Copy of the version you kept.' },
  duplicate: { fr: 'Copie identique d’un autre fichier.', en: 'Identical copy of another file.' },
  notVisible: { fr: 'ComfyUI ne voit pas ce fichier.', en: 'ComfyUI does not see this file.' },
  noExtraYaml: { fr: 'ComfyUI tourne sans le fichier extra_minimax.yaml : il ne voit pas ce modèle.',
    en: 'ComfyUI runs without extra_minimax.yaml: it does not see this model.' },
  internalComfy: { fr: 'Dossier ignoré par le ComfyUI du moteur (il lit le dossier models du moteur).',
    en: "Folder ignored by the engine's ComfyUI (it reads the engine's models folder)." },
  notUsed: { fr: 'Pas encore utilisé par un bloc de Mia.', en: 'Not used by any Mia block yet.' },
  unreadable: { fr: 'Fichier illisible.', en: 'Unreadable file.' },
  userRoot: { fr: 'Dossier ajouté par toi : Mia le liste, ComfyUI ne le lit pas.', en: 'Folder you added: Mia lists it, ComfyUI does not read it.' },
  found: { fr: 'Trouvé par la recherche approfondie.', en: 'Found by the deep search.' },
  partial: { fr: 'Téléchargement interrompu.', en: 'Interrupted download.' },
  partialComplete: { fr: 'Le téléchargement semble fini mais le fichier n’a jamais été renommé.',
    en: 'The download looks finished but the file was never renamed.' },
  forbidden: { fr: 'Exclu par sa licence : jamais proposé.', en: 'Excluded by its license: never offered.' },
  loraUnknownBase: { fr: 'Mia ne reconnaît pas le modèle pour lequel ce LoRA a été fait : aucun bloc ne le propose.',
    en: 'Mia does not recognise the model this LoRA was made for: no block offers it.' },
};
// « Fait pour X, que Mia n'a pas » : un LoRA dont le modèle de base n'est pas installé.
function loraNoBaseNote(loraFor) {
  const b = baseLabel(loraFor, false) || { fr: loraFor, en: loraFor };
  return { fr: `Fait pour ${b.fr} : aucun modèle installé ne peut s’en servir pour l’instant.`,
    en: `Made for ${b.en}: no installed model can use it yet.` };
}

// Réponses de mia.models.inspect quand le fichier déposé n'est pas un LoRA (SPEC §12.1).
const INSPECT = {
  model: (dir) => ({ fr: `Ce fichier est un modèle complet, pas un LoRA : range-le dans le dossier du moteur (${dir}), puis clique « Rescanner » dans la bibliothèque.`,
    en: `This file is a full model, not a LoRA: put it in the engine folder (${dir}), then click “Rescan” in the library.` }),
  part: (dir) => ({ fr: `Ce fichier est une pièce de modèle (encodeur, décodeur…), pas un LoRA : range-le dans le dossier du moteur (${dir}).`,
    en: `This file is a model part (encoder, decoder…), not a LoRA: put it in the engine folder (${dir}).` }),
  unknown: { fr: 'Fichier non reconnu : ce n’est ni un LoRA ni un modèle que Mia sait lire.',
    en: 'Unrecognised file: neither a LoRA nor a model Mia can read.' },
  unreadable: { fr: 'Fichier illisible : il est peut-être incomplet ou abîmé.', en: 'Unreadable file: it may be incomplete or damaged.' },
  missing: { fr: 'Fichier introuvable.', en: 'File not found.' },
  unknownBase: { fr: 'un modèle que Mia ne reconnaît pas', en: 'a model Mia does not recognise' },
};
// Extensions qu'un glisser-déposer envoie à inspect (SPEC §12.5).
const MODEL_EXT = ['.safetensors', '.sft', '.ckpt', '.pt', '.pth', '.gguf', '.bin'];

module.exports = {
  RULES_REV, CATALOG_REV, RULES, COMFY_FOLDERS, UNLISTED_COMFY_FOLDERS, FOLDER_ALIASES, FOLDER_RANK,
  MIN_BYTES_ROOT, MIN_BYTES_BROAD,
  knownRoots, extraPathFiles, broadRoots, APPS,
  CAPS, FILES, LIC, CATALOG, IDENTITY, setIdentities, IDENTITY_DESC, TASK_DESC, ROLE_DESC, INTERNAL_ROLES,
  BASES, MEDIA_WORD, GENRES, baseKeyOf, baseLabel, loraDesc, loraNameFromFile, guessGenre, loraNoBaseNote,
  quantClass, QUANT_LABEL, NOTES, INSPECT, MODEL_EXT,
};
