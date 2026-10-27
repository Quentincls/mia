# ComfyUI graphs: sources, licences and changes

The `*.api.json` files in this folder are ComfyUI graphs in API format: lists of nodes and their settings. Mia's
executors load them node by node, so they cannot carry comments; **this file is their modification notice**. For
each graph derived from a published example it gives the exact source, the licence the file keeps, and every change
made for Mia. The changes were made by Quentin Colus, the author of Mia; the files are in the state of
17 October 2026 (Mia 0.5.0). The sources were compared with these files on that date.

At run time the executors (`electron/engine/executors/*.js`) still change settings (prompt, size, length, seed,
model file) and may add nodes (LoRAs, guides, keys). Those graphs are built on the user's PC and sent to the user's
own ComfyUI; they are not distributed. `index.json` names, in French, the nodes each executor sets.

Mia's own code is under the Apache License 2.0 (`LICENSE` at the root of the repository). The graphs listed below as
derived are **not** under Apache-2.0: each one keeps the licence of its source. They are separate data files,
aggregated with Mia, not linked into its code.

| File | Source | Licence of the file |
|---|---|---|
| `ltx_i2v.api.json` | Lightricks, ComfyUI-LTXVideo, `example_workflows/2.5/LTX-2.5_T2V_I2V_Single_Stage_Distilled.json` | LTX-2.x Community License Agreement **and** LTX-2 Community License Agreement (5 January 2026) |
| `ltx_t2v.api.json` | same example | LTX-2.x Community License Agreement **and** LTX-2 Community License Agreement (5 January 2026) |
| `rtx_vsr.api.json` | Comfy-Org, `ComfyUI_Nvidia_VFX_Nodes` `example_workflows/rtx_video_upscale.json` | Apache-2.0 |
| `ltx_upscale.api.json` | Lightricks, ComfyUI-LTXVideo `example_workflows/2.5/LTX-2.5_V2V_TiledFusion_Native_4K_8K.json` | LTX-2.x Community License Agreement |
| `ltx_layout_single.api.json` | Lightricks, Hugging Face `Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render`, `LTX-2.5_ICLoRA_Layout_To_Render_Two_Stage_Distilled.json` | LTX-2.x Community License Agreement |
| `minimax_i2v.api.json` | Comfy-Org/workflow_templates, `templates/video_minimax_h3_i2v.json` | MIT |
| `minimax_r2v.api.json` | Comfy-Org/workflow_templates, `templates/video_minimax_h3_r2v.json` | MIT |
| `qwen_edit_2511.api.json` | Comfy-Org/workflow_templates, `templates/image_qwen_image_edit_2511_int8.json` | MIT |
| `flux2_klein9b_t2i.api.json` | Comfy-Org/workflow_templates, `templates/image_flux2_klein_text_to_image.json` | MIT |
| `flux2_klein9b_edit.api.json` | Comfy-Org/workflow_templates, `templates/image_flux2_klein_image_edit_9b_distilled.json` | MIT |
| `qwen_image21_t2i.api.json` | Comfy-Org/workflow_templates, `templates/image_qwen_image_2_1_t2i.json` | MIT |
| `wan_animate2.api.json` | Comfy-Org/workflow_templates, `templates/video_wan_animate2.json` | MIT |
| `seedvr2_native.api.json` | ComfyUI, `blueprints/Upscale Video (SeedVR2 3B Int8).json` | GPL-3.0 |
| `depth_vda.api.json` | written by the author for Mia | Apache-2.0 |
| `seedvr2_node.api.json` | written by the author for Mia | Apache-2.0 |

Full licence texts, in `docs/licenses/`:
[LTX-2.x-Community-License.txt](../../../docs/licenses/LTX-2.x-Community-License.txt),
[LTX-2-Community-License.txt](../../../docs/licenses/LTX-2-Community-License.txt),
[Comfy-Org-workflow_templates-MIT.txt](../../../docs/licenses/Comfy-Org-workflow_templates-MIT.txt),
[GPL-3.0.txt](../../../docs/licenses/GPL-3.0.txt).

Common to every derived graph: written in ComfyUI's API format (converted from the interface format, or rewritten
by hand where noted; subgraphs flattened, notes, previews and reroutes dropped), the example's own input files
replaced by placeholders (`mia/…`) and its prompts by empty or neutral ones, the seed set to 42 (the executors set
the real seed), and the final video node (`CreateVideo` +
`SaveVideo`) replaced by `SaveImage` (PNG frames, node `9990`) and, where there is sound, `SaveAudioAdvanced` (FLAC,
node `9991`): Mia encodes the video once, itself.

---

## LTX graphs (Lightricks)

`ltx_i2v.api.json`, `ltx_t2v.api.json` and `ltx_layout_single.api.json` are modified versions of example workflows
that Lightricks publishes with LTX-2.5. Example workflows are "Complementary Materials" of LTX-2.x, so these three
files are **Derivatives of LTX-2.x** (section 1.5 of the LTX-2.x Community License Agreement). They are distributed
under that Agreement, not under Apache-2.0:

- the use-based restrictions of section 4 and **Attachment A** (which incorporates Lightricks' Acceptable Use Policy,
  <https://static.lightricks.com/legal/ltx-acceptable-use-policy.pdf>) apply to them, to their use and to their
  outputs, and are part of the terms under which Mia distributes them;
- entities with annual revenues of USD 10,000,000 or more need a paid licence from Lightricks for any use other than
  a non-commercial purpose (section 2);
- section 6 asks to keep the safety, watermarking, provenance and disclosure features of LTX-2.x and of its
  outputs.

`ltx_i2v` and `ltx_t2v` come from the repository
[Lightricks/ComfyUI-LTXVideo](https://github.com/Lightricks/ComfyUI-LTXVideo), whose `LICENSE` file is the
LTX-2 Community License Agreement of 5 January 2026, while the example itself belongs to LTX-2.5, which Lightricks
licenses under the LTX-2.x Community License Agreement of 11 August 2026. These two files are therefore distributed
under both agreements, and their terms add up.

Mia is not affiliated with or endorsed by Lightricks (section 8 of the LTX-2.x Community License Agreement).

### `ltx_t2v.api.json` (block « Vidéo depuis un texte »)

Source: <https://github.com/Lightricks/ComfyUI-LTXVideo/blob/master/example_workflows/2.5/LTX-2.5_T2V_I2V_Single_Stage_Distilled.json>,
text-to-video path. Node ids are the example's (`<subgraph>:<node>`).

- `5004:5569` model: `ltx-2.5-22b-distilled-transformer-bf16` → `…-comfy-int8-convrot` (int8).
- `5004:5572` text encoder: `gemma4-12b-with-proj-ltx-2.5-bf16` → `…-comfy-int8-convrot` (int8).
- Prompt enhancer removed: `5004:5545` (Gemma 4 E2B loader), `5014:5546`, `5014:5549` (`TextGenerateLTX2Prompt`)
  and their switches `5014:5555`, `5014:5556`.
- Cloud text-encoder branch removed: `5014:5504`, `5014:5505` (`GemmaAPITextEncode`), `5014:5557` (API key test),
  `5014:5558`, `5014:5560` (switches).
- Start-image branch removed (no dummy image): `2004` (`LoadImage`), `5014:4990` (`ResizeImageMaskNode`),
  `5014:5506` and `5014:5019` ("use image" switch), `5514:3336` (`LTXVPreprocess`), `5514:3159`
  (`LTXVImgToVideoInplace`); the empty latent goes straight to `5514:4528`.
- `5516:4831` sampler: `euler_ancestral` → `euler`.
- `5514:3059` default size: 960 × 544 → 1920 × 1088 (the executor sets the block's size).
- `5516:4832` seed: 43 → 42.
- `5544` (`PreviewAny`) removed; `5518:4849` + `4852` (`CreateVideo`, `SaveVideo`) → `9990` `SaveImage` +
  `9991` `SaveAudioAdvanced` (FLAC).

### `ltx_i2v.api.json` (block « Animer une image », LTX model)

Source: the same example, image-to-video path, rewritten by hand with new node ids (`1`–`24`); same model, sigmas
(`1.0 … 0.0`, 8 steps), `CFGGuider` at 1, `LTXVPreprocess` at 18 and tiled decoding as the example.

- Model and text encoder in int8, as for `ltx_t2v`.
- Prompt enhancer and cloud text-encoder branch removed, as for `ltx_t2v`.
- fps, duration and frame-count primitives and their math node replaced by fixed values (24 fps, 121 frames) that
  the executor sets.
- Start image: `ResizeImageMaskNode` (longer side 1536) → `ImageScale` (lanczos, cover, centred crop) to the output
  size, before `LTXVPreprocess`; the "image given or not" switch removed (an image is always given).
- `LTXVImgToVideoInplace` strength: 0.7 → 1.
- Sampler: `euler_ancestral` → `euler`.
- Default size: 960 × 544 → 1088 × 1920 (portrait); seed 43 → 42.
- `CreateVideo` + `SaveVideo` → `9990` `SaveImage` + `9991` `SaveAudioAdvanced` (FLAC).

### `ltx_upscale.api.json` (block « Agrandir », LTX · détails)

Subgraphs flattened; IC-LoRA Refine Details on both stages; int8 UNET and Gemma, no prompt enhancer nor Gemma API branch; audio removed (Mia muxes the source sound back); canvas sizes set by the executor instead of LTXVGetTilingSizes; SaveVideo replaced by SaveImage.

### `ltx_layout_single.api.json` (blocks « Rendre photoréaliste » and « Vidéo guidée », LTX model)

Source: <https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render/blob/main/LTX-2.5_ICLoRA_Layout_To_Render_Two_Stage_Distilled.json>
(model repository licensed under the LTX-2.x Community License Agreement), first stage only. Node ids are the
example's.

- `5004:5602` model and `5004:5605` text encoder: bf16 → int8 (`…-comfy-int8-convrot`).
- Second stage removed: `9034:*` (latent upscaler and 3-step re-sampler) and `5004:9035`
  (`LatentUpscaleModelLoader`); decoding now reads `5516:5000` (`LTXVCropGuides`) output 2.
- `5004:5600` (audio VAE) removed: this graph makes no sound.
- `5548:5026` (`ResizeImageMaskNode`, shorter side 544) bypassed: the layout video is used at its own size.
- Cloud text-encoder branch removed: `5014:5504`, `5014:5505`, `5014:5557`, `5014:5558`, `5014:5560`.
- `5516:4831` sampler: `euler_ancestral` → `euler`.
- `5518:5538` tiled decoding: tiles 512 / overlap 64 → 768 / 192.
- `9002:5012`, `9002:9042`: two inputs the example does not set written out (`use_streaming` false,
  `tile_frames` 97).
- `5518:4849` + `4852` (`CreateVideo`, `SaveVideo`) → `9990` `SaveImage`.
- The « Vidéo guidée » block changes this graph at run time (IC-LoRA Union-Control instead of Layout-To-Render,
  attention mask, edges or depth guide); those changes are made in code and listed in `index.json`.

---

## Comfy-Org workflow templates (MIT)

Source repository: [Comfy-Org/workflow_templates](https://github.com/Comfy-Org/workflow_templates), also installed
with ComfyUI as the Python package `comfyui-workflow-templates-json` (version 0.1.104, pinned in
`engine-setup/constraints.txt`). MIT License, Copyright (c) 2023-present Comfy Org; full text, with its copyright
and permission notice, in `docs/licenses/Comfy-Org-workflow_templates-MIT.txt`.

### `minimax_i2v.api.json` (blocks « Animer une image » and « Vidéo guidée », MiniMax H3 model)

Source: `templates/video_minimax_h3_i2v.json`. Same chain as the template (`UNETLoader` fl2va int8, turbo
`LoraLoaderModelOnly`, Qwen3-VL text encoder, `MiniMaxH3ImageToVideo`, `res_multistep`, `simple`, `BasicGuider`,
`SamplerCustomAdvanced`, video and audio decoding), rewritten by hand with new node ids (`1`–`18`).

- Video VAE: `minimax_h3_video_vae_int8_convrot` → `minimax_h3_video_vae_fp16`.
- Turbo 8-step LoRA always on (the template's switch is off by default), 8 steps; the switches and step
  primitives removed.
- `ResolutionSelector`, `ImageScaleToTotalPixels`, `GetImageSize` and the length math replaced by values computed by
  Mia (multiples of 32, 17k + 5 frames at 24 fps) and an `ImageScale` (lanczos, centred crop) before `first_frame`.
- The executor adds the end image (`last_frame`, nodes `7` and `19`) when one is given.
- Seed 1 → 42; `CreateVideo` + `SaveVideo` → `9990` `SaveImage` + `9991` `SaveAudioAdvanced` (FLAC).

### `minimax_r2v.api.json` (block « Vidéo à partir de références »)

Source: `templates/video_minimax_h3_r2v.json`, rewritten by hand with new node ids.

- Video VAE int8 → fp16 (`minimax_h3_video_vae_fp16`).
- Turbo 4-step LoRA switched on (the template's switch set to true), 4 steps.
- `ResolutionSelector` and `ComfyMathExpression` replaced by values computed by Mia (multiples of 32,
  17k + 5 frames).
- One reference image by default (`20`); the executor adds up to 9 images and 3 videos with their sound.
- `CreateVideo` + `SaveVideo` → `9990` `SaveImage` + `9991` `SaveAudioAdvanced` (FLAC).

### `qwen_edit_2511.api.json` (block « Retoucher une image »)

Source: `templates/image_qwen_image_edit_2511_int8.json`. Same node ids as the template.

- `170:160` `FluxKontextImageScale` → `ImageScale` (lanczos, centred crop, working size about 1.6 MP in multiples
  of 16; 944 × 1664 by default).
- `170:168` (Lightning LoRA, 4 steps) on by default: false → true.
- `170:169` seed: random → 42; `170:151` example prompt emptied; `41` example image replaced by a placeholder.

### `flux2_klein9b_t2i.api.json` and `flux2_klein9b_edit.api.json` (Model block, FLUX.2 Klein 9B)

Sources: `templates/image_flux2_klein_text_to_image.json` (its distilled subgraph, flattened) and
`templates/image_flux2_klein_image_edit_9b_distilled.json` (its subgraph, flattened). Node ids renumbered.

- `1` `UNETLoader`: `flux-2-klein-9b.safetensors` (Black Forest Labs, distilled 9B; the model itself is under the
  FLUX Non-Commercial License, not this file), instead of the 4B file (text to image) or `flux-2-klein-9b-fp8`
  (edit); `3` `VAELoader`: `flux2-vae.safetensors` instead of `full_encoder_small_decoder`.
- Text to image: `2` `CLIPLoader` `qwen_3_4b` → `qwen_3_8b_fp8mixed.safetensors` (the 9B encoder); width and
  height of `8` (`Flux2Scheduler`) and `9` (`EmptyFlux2LatentImage`) set by Mia from the block's format and
  resolution, in multiples of 16.
- With an image: `20` `LoadImage` placeholder; `21` `ImageScaleToTotalPixels` nearest-exact / steps 1 → lanczos /
  steps 16, megapixels set from the resolution.
- `10` seed: random → 42; `4` example prompt emptied.

### `qwen_image21_t2i.api.json` (Model block, Qwen-Image 2.1)

Source: `templates/image_qwen_image_2_1_t2i.json`, its subgraph flattened (ids kept as `subgraph:node`).

- Prompt enhancer branch removed (`TextGenerate`, its `CLIPLoader`, `ComfySwitchNode`, `PreviewAny`, its prompt), and
  the top-level `ResolutionSelector` (the size comes from Mia); `461` `SaveImageAdvanced` → `SaveImage`.
- `459:451` `UNETLoader`: `qwen_image_2.1_turbo_int8_convrot.safetensors` (Turbo; the model is under the Qwen
  research license, not this file); `459:458` `KSampler` steps 25 → 8 (Turbo, cfg 1), seed 42.
- `459:456` `EmptyLatentImage` width and height set by Mia from the block's format and resolution (multiples of 32).

### `wan_animate2.api.json` (block « Animer un personnage »)

Source: `templates/video_wan_animate2.json`. Same node ids as the template; its default Chinese negative prompt for
Wan (`672:581`) is kept.

- `672:587` `pose_end_percent` set to 1.0 (the API export of the template Mia started from had 0).
- `672:594` `WanAnimate2Cache`: dtype `int8` → `default` (device `gpu`).
- `672:600` working size: 482 × 854 → 720 × 1280.
- `672:582`, `672:585`: the example's character description and action replaced by neutral default prompts.
- Comparison video removed (`291:*`, `292`); `246` and `672:245` (`SaveVideo`, `CreateVideo`) → `9990` `SaveImage`
  (Mia puts the sound of the motion video back).
- `672:597` seed: random → 42.

---

## ComfyUI blueprint (GPL-3.0)

### `seedvr2_native.api.json` (block « Agrandir », SeedVR2 int8 models)

Source: `blueprints/Upscale Video (SeedVR2 3B Int8).json`, shipped with ComfyUI
(<https://github.com/comfyanonymous/ComfyUI>), whose repository is licensed under the GNU General Public License,
version 3. This file stays under **GPL-3.0** (full text in `docs/licenses/GPL-3.0.txt`); it is a separate data file
aggregated with Mia and does not change the licence of Mia's code. Comfy-Org also publishes the same graph as the
MIT template `utility_seedvr2_3b_int8_upscale_video`; Mia's file was made from the blueprint, so GPL-3.0 applies.

Modified by Quentin Colus for Mia, 17 October 2026 (Mia 0.5.0):

- Subgraph flattened, new node ids (`1`–`13`).
- Temporal chunking always on (`SeedVR2TemporalChunk` / `SeedVR2TemporalMerge`, overlap 0 → 2); the blueprint's
  switches, its boolean and `Video Slice` removed.
- `ResizeImageMaskNode`: "scale by multiplier" × 2 → "scale shorter dimension" 1440 (the executor sets 1440 or
  2160).
- Model: `seedvr2_3b_int8_convrot` → `seedvr2_7b_int8_convrot` by default (the executor chooses 3B or 7B).
- `SeedVR2PostProcessing` colour correction: `none` → `lab`.
- Seed → 42; `CreateVideo` and the video output → `9990` `SaveImage` (PNG frames).

---

## Graphs written for Mia (Apache-2.0)

`depth_vda.api.json` (Video Depth Anything Small, through the nodes of ComfyUI-Video-Depth-Anything) and
`seedvr2_node.api.json` (SeedVR2 through the nodes of ComfyUI-SeedVR2_VideoUpscaler, with the settings of the
author's command-line tool) were written by the author from those nodes' inputs. They are under Apache-2.0, like the
rest of Mia.
