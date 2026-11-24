'use strict';
/**
 * Test of the assistant bridge (SPEC §13), end to end, without any GPU job:
 *   a hidden Mia (its own profile and projects folder) + mcp/mia-mcp.js driven over stdio exactly like
 *   an MCP client (Claude, Codex) would: initialize, tools/list, create a project, import a generated
 *   image, add a Profondeur block, wire it, set a setting, read the board, arrange, say, snapshot…
 *
 *   node tools/test-bridge.js            run, then close the test Mia
 *   node tools/test-bridge.js --keep     leave the test Mia open (CDP on port 9429) to look at it
 *
 * Against a test Mia already running (never Quentin's own: the test creates boards and projects):
 *   MIA_BRIDGE_FILE=<its bridge.json> MIA_NO_LAUNCH=1 MIA_CDP_PORT=<its CDP port> node tools/test-bridge.js
 *   (MIA_TEST_DIR=<folder> for the test image and the snapshots; that Mia stays open.)
 *
 * Projects and boards (SPEC §18): projects (folders) are created, boards filed into them and reopened
 * by « Projet / Planche » — once this Mia's preload has mia.folders (otherwise those checks are skipped).
 *
 * Training a LoRA (mia_train_*): driven with the fake tool (tools\fixtures\train\fake-trainer.js — no Python, no
 * GPU). The Mia launched here has MIA_NO_GPU=1 and MIA_TRAIN_FAKE=1; a reused one without the fake tool skips
 * that part.
 *
 * NEVER the owner's Mia: this bench only talks to the bridge of its own hidden Mia. A MIA_BRIDGE_FILE that names
 * the owner's bridge (%APPDATA%\Mia\data\bridge.json or its %TEMP%\Mia\bridge.json copy) is refused, and the MCP
 * server it starts is given that one file to read (no %TEMP% copy).
 *
 * Writes only under _dev/fix-G/ (profile, projects, the test image, snapshot.png) or MIA_TEST_DIR.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
// an already running test Mia (its bridge.json given), or one launched here
const EXTERNAL = !!process.env.MIA_BRIDGE_FILE && process.env.MIA_NO_LAUNCH === '1';
const DEV = process.env.MIA_TEST_DIR ? path.resolve(process.env.MIA_TEST_DIR) : path.join(ROOT, '_dev', 'fix-G');
const USERDATA = path.join(DEV, 'userdata');
const PROJECTS = path.join(DEV, 'projects');
const BRIDGE_FILE = EXTERNAL ? path.resolve(process.env.MIA_BRIDGE_FILE) : path.join(USERDATA, 'data', 'bridge.json');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const CDP_PORT = Number(process.env.MIA_CDP_PORT) || 9429;
const KEEP = process.argv.includes('--keep') || EXTERNAL;
const STAMP = new Date().toISOString().slice(11, 19).replace(/:/g, '');   // names unique per run (a reused projects folder)

// The owner's own Mia writes its bridge here: this bench creates boards, projects and trainings, it must never reach it.
const OWNER_BRIDGES = [
  path.join(process.env.APPDATA || path.join(require('node:os').homedir(), 'AppData', 'Roaming'), 'Mia', 'data', 'bridge.json'),
  path.join(require('node:os').tmpdir(), 'Mia', 'bridge.json')
].map((p) => path.resolve(p).toLowerCase());
if (OWNER_BRIDGES.includes(path.resolve(BRIDGE_FILE).toLowerCase())) {
  console.error(`Refusé : ${BRIDGE_FILE} est le pont de la Mia du propriétaire. Ce banc ne parle qu’à une Mia de test (MIA_USERDATA à part).`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, what, extra) {
  if (cond) console.log(`  ok   ${what}`);
  else { failures++; console.log(`  FAIL ${what}${extra !== undefined ? ` — ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400)}` : ''}`); }
}

// ---------------------------------------------------------------- a test image (PNG, pure Node)
function crcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
}
const CRC = crcTable();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A little scene with depth: sky, sun, distant hills, a near block, a floor. */
function makePng(file, W = 768, H = 512) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      let r, g, b;
      const horizon = H * 0.55 + Math.sin(x / 70) * 18;
      if (y < horizon) { const k = y / horizon; r = 70 + 90 * k; g = 110 + 80 * k; b = 170 + 60 * k; }
      else { const k = (y - horizon) / (H - horizon); r = 60 + 70 * k; g = 70 + 50 * k; b = 50 + 30 * k; }
      if ((x - 560) ** 2 + (y - 120) ** 2 < 46 ** 2) { r = 250; g = 225; b = 160; }
      if (x > 180 && x < 360 && y > 250 && y < 470) { const s = 150 - (x - 180) * 0.3; r = s; g = s * 0.8; b = s * 0.7; }
      const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(file, png);
}

// ---------------------------------------------------------------- CDP (inspection only)
async function cdpEval(expr) {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const out = await new Promise((resolve) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d.result?.result?.value); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  return out;
}

// ---------------------------------------------------------------- MCP client over stdio
function startMcp() {
  // this one bridge file and nothing else: without MIA_BRIDGE_MIRROR the server never reads %TEMP%\Mia\bridge.json
  const env = { ...process.env, MIA_BRIDGE_FILE: BRIDGE_FILE, MIA_NO_LAUNCH: '1' };
  delete env.MIA_BRIDGE_MIRROR;
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'mia-mcp.js')], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  let buf = '';
  let seq = 0;
  const pending = new Map();
  const stderr = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { console.log('  !! non-JSON on stdout:', line.slice(0, 200)); failures++; continue; }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => stderr.push(d));
  const request = (method, params, timeoutMs = 120000) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const tool = async (name, args = {}, timeoutMs) => {
    const m = await request('tools/call', { name, arguments: args }, timeoutMs);
    if (m.error) return { rpcError: m.error };
    const r = m.result || {};
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    let json = null;
    try { json = JSON.parse(text); } catch { /* plain text (errors) */ }
    return { isError: !!r.isError, text, json, content: r.content || [] };
  };
  return { child, request, notify, tool, stderr };
}

// ---------------------------------------------------------------- a job beside a LoRA training (SPEC §8.7), without Mia
// mia_jobs / mia_wait read the engine's job list: a job beside a training says so (besideTraining), one held behind it
// says it waits (waitsForTraining) with the engine's message — the same queue as the user's « Générer ».
async function testBesideFields() {
  console.log('· a job beside a LoRA training: mia_jobs / mia_wait fields (fake engine, no Mia)');
  const { Bridge } = require(path.join(ROOT, 'electron', 'bridge.js'));
  const WAIT = 'Attend de la place à côté de l’entraînement « Plumo » (fin vers 15 h 10) : il faut ≈ 29 Go, 40 sont libres moins 16 de marge';
  const list = [
    { jobId: 'j1', projectId: 'p_x', projectName: 'Plan', nodeId: 'n_1', label: 'Portrait', type: 'gen', mode: 'final', state: 'running', progress: 0.4, eta: 20, message: 'étape 3/8', beside: 'Plumo' },
    { jobId: 'j2', projectId: 'p_x', projectName: 'Plan', nodeId: 'n_2', label: 'Plan large', type: 'gen', mode: 'final', state: 'queued', progress: null, eta: null, message: WAIT, trainWait: true, waitShort: 'Pas assez de mémoire : il faut ≈ 29 Go, 40 libres moins 16 de marge' },
    { jobId: 'j3', projectId: 'p_x', projectName: 'Plan', nodeId: 'n_3', label: 'Redimensionner', type: 'resize', mode: 'final', state: 'queued', progress: null, eta: null, message: 'En file' }
  ];
  const fakeEngine = { jobList: () => list, on() {}, off() {} };
  const b = new Bridge({ paths: { data: path.join(DEV, 'beside-unit') }, app: { getVersion: () => '0' }, engine: fakeEngine, log: () => {} });
  const jobs = await b.jobs();
  const j1 = jobs.find((j) => j.jobId === 'j1');
  const j2 = jobs.find((j) => j.jobId === 'j2');
  const j3 = jobs.find((j) => j.jobId === 'j3');
  check(j1 && j1.besideTraining === 'Plumo' && !j1.waitsForTraining, 'mia_jobs: a job beside the training → besideTraining', j1);
  check(j2 && j2.waitsForTraining === true && j2.message === WAIT && !j2.besideTraining, 'mia_jobs: a job held behind the training → waitsForTraining + the reason with the figures', j2);
  check(j2 && !('waitShort' in j2), 'mia_jobs: the whole sentence only (the queue’s short reason, waitShort, stays in Mia)', j2);
  check(j3 && !('besideTraining' in j3) && !('waitsForTraining' in j3), 'mia_jobs: any other job unchanged', j3);
  const w2 = await b.wait({ jobId: 'j2', timeoutS: 1 });
  check(w2 && w2.timedOut === true && w2.waitsForTraining === true && w2.message === WAIT, 'mia_wait: still held → waitsForTraining and the reason', w2);
  const w1 = await b.wait({ jobId: 'j1', timeoutS: 1 });
  check(w1 && w1.timedOut === true && w1.besideTraining === 'Plumo', 'mia_wait: running beside → besideTraining', w1);
  const src = fs.readFileSync(path.join(ROOT, 'mcp', 'mia-mcp.js'), 'utf8');
  check(/besideTraining/.test(src) && /waitsForTraining/.test(src) && /Générer pendant un entraînement/.test(src),
    'mia-mcp.js: the descriptions name besideTraining, waitsForTraining and the setting');
}

// ---------------------------------------------------------------- run
async function main() {
  fs.mkdirSync(DEV, { recursive: true });
  await testBesideFields();
  const image = path.join(DEV, 'test-scene.png');
  makePng(image);
  let mia = null;
  if (EXTERNAL) {
    console.log('· test Mia already running: bridge', BRIDGE_FILE, '· CDP port', CDP_PORT);
  } else {
    // a fresh projects folder for each run (only the test's own folder)
    fs.rmSync(PROJECTS, { recursive: true, force: true });
    fs.mkdirSync(PROJECTS, { recursive: true });
    // … and no training left from an earlier run (the test profile's own folders only)
    for (const f of [path.join(USERDATA, 'training'), path.join(USERDATA, 'loras-mia'), path.join(USERDATA, 'data', 'trainings.json'), path.join(USERDATA, 'data', 'train-timings.json')]) {
      fs.rmSync(f, { recursive: true, force: true });
    }
    try { fs.unlinkSync(BRIDGE_FILE); } catch { /* none */ }
    console.log('· launching a hidden Mia (CDP port', CDP_PORT, ')');
    // its own profile, projects and bridge file; no GPU job ever (MIA_NO_GPU), trainings with the fake tool only
    // MIA_HF_BASE: never Higgsfield — a run of an online block in « Auto » reaches the engine, which refuses
    // it anyway here (no account linked in this profile); a port where nobody listens, in case it did not
    const miaEnv = { ...process.env, MIA_HEADLESS: '1', MIA_USERDATA: USERDATA, MIA_PROJECTS_ROOT: PROJECTS, MIA_NO_GPU: '1', MIA_TRAIN_FAKE: '1', MIA_BRIDGE_FILE: BRIDGE_FILE, MIA_HF_BASE: 'http://127.0.0.1:9' };
    delete miaEnv.MIA_BRIDGE_MIRROR;
    delete miaEnv.ELECTRON_RUN_AS_NODE;
    mia = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${CDP_PORT}`], {
      env: miaEnv,
      stdio: 'ignore',
      windowsHide: true,
      detached: true
    });
    mia.unref();
    console.log('  pid', mia.pid);
    fs.writeFileSync(path.join(DEV, 'mia.pid'), String(mia.pid));
  }

  let mcp = null;
  try {
    const t0 = Date.now();
    while (!fs.existsSync(BRIDGE_FILE) && Date.now() - t0 < 40000) await sleep(250);
    check(fs.existsSync(BRIDGE_FILE), 'bridge.json written');
    const info = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
    check(info.port >= 8777 && info.port <= 8799 && /^[0-9a-f]{48}$/.test(info.token) && info.pid > 0, 'bridge.json has port, token, pid', info.port);

    // the token is required
    const noTok = await fetch(`http://127.0.0.1:${info.port}/call`, { method: 'POST', body: '{"method":"ping"}' }).then((r) => r.status).catch((e) => e.message);
    check(noTok === 401, 'a call without the token is refused (401)', noTok);

    if (EXTERNAL) {
      // a reused test Mia: the tabs of earlier runs would fill the strip (8 at most)
      const closed = await cdpEval('(async () => { const app = window.__mia.app; const ids = app.tabs.ids(); for (const id of ids) await app.closeTab(id); return ids.length; })()').catch(() => null);
      console.log('  earlier tabs closed:', closed);
    }
    console.log('· MCP server over stdio');
    mcp = startMcp();
    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.0.0' } });
    check(init.result && init.result.protocolVersion === '2025-06-18' && init.result.serverInfo?.name === 'mia' && init.result.capabilities?.tools, 'initialize', init);
    mcp.notify('notifications/initialized', {});
    const list = await mcp.request('tools/list', {});
    const names = (list.result?.tools || []).map((t) => t.name);
    const expected = ['mia_status', 'mia_catalog', 'mia_list_projects', 'mia_create_folder', 'mia_create_project', 'mia_open_project', 'mia_get_board', 'mia_add_block', 'mia_connect',
      'mia_set_params', 'mia_rename_block', 'mia_remove_blocks', 'mia_import_media', 'mia_insert_recipe', 'mia_arrange', 'mia_move_blocks', 'mia_run', 'mia_wait', 'mia_jobs',
      'mia_cancel', 'mia_get_output', 'mia_snapshot', 'mia_focus', 'mia_add_section', 'mia_say', 'mia_request', 'mia_pending',
      'mia_train_options', 'mia_train_prepare', 'mia_train_start', 'mia_train_status', 'mia_train_wait', 'mia_train_control', 'mia_train_note'];
    check(expected.every((n) => names.includes(n)) && names.length === expected.length, `tools/list: ${names.length} tools`, names);
    check((list.result?.tools || []).every((t) => t.inputSchema && t.inputSchema.type === 'object' && t.description), 'every tool has a schema and a description');
    // before SPEC §18 a board was a « project »: projectId stays accepted (deprecated) beside boardId
    const aliased = (list.result?.tools || []).filter((t) => ['mia_open_project', 'mia_get_board', 'mia_run', 'mia_wait'].includes(t.name));
    check(aliased.length === 4 && aliased.every((t) => t.inputSchema.properties?.projectId?.deprecated === true && t.inputSchema.properties?.boardId),
      'open_project, get_board, run, wait: boardId + projectId (deprecated alias) in the schema', aliased.map((t) => [t.name, Object.keys(t.inputSchema.properties || {})]));
    const instr = init.result?.instructions || '';
    check(/BOARD/.test(instr) && /planche/.test(instr) && /PROJECT/.test(instr) && /folder/.test(instr), 'the instructions explain projects (folders) and boards');
    check(/TRAINING A LoRA/.test(instr) && /only PROPOSES/.test(instr) && /mia_request \{training:true\}/.test(instr), 'the instructions explain LoRA training (prepare, then only a proposal)');
    check((list.result?.tools || []).find((t) => t.name === 'mia_request')?.inputSchema?.properties?.training?.type === 'boolean', 'mia_request takes training:true');
    const pong = await mcp.request('ping', {});
    check(pong.result && !pong.error, 'ping');

    const st = await mcp.tool('mia_status');
    check(!st.isError && st.json?.mia?.interfaceReady === true, 'mia_status (interface ready)', st.text);
    // the checks below drive Mia directly, as before SPEC §13.7; the green light has its own part (testGreenlight)
    await askGo(false);

    const cat = await mcp.tool('mia_catalog', { type: 'depth' });
    const depthDef = cat.json?.types?.[0];
    check(!cat.isError && depthDef?.type === 'depth' && depthDef.inputs?.[0]?.port === 'media', 'mia_catalog {type:depth}', cat.text.slice(0, 300));
    const full = await mcp.tool('mia_catalog');
    check(!full.isError && full.json?.types?.length >= 15 && Array.isArray(full.json?.recipes), `mia_catalog: ${full.json?.types?.length} types, ${full.json?.recipes?.length} recipes`);

    const created = await mcp.tool('mia_create_project', { name: `Test du pont ${STAMP}` });
    const pid = created.json?.boardId;
    check(!created.isError && pid && created.json.folder === null, 'mia_create_project (a board outside any project)', created.text);

    const imp = await mcp.tool('mia_import_media', { paths: [image] });
    const importId = imp.json?.blocks?.[0]?.nodeId;
    check(!imp.isError && importId && imp.json.blocks[0].kind === 'image', 'mia_import_media (absolute path)', imp.text);

    const bad = await mcp.tool('mia_import_media', { paths: ['relatif\\image.png'] });
    check(bad.isError && /absolu/i.test(bad.text), 'import refuses a relative path, in French', bad.text);

    const add = await mcp.tool('mia_add_block', { type: 'depth', near: importId, title: 'Profondeur du test' });
    const depthId = add.json?.nodeId;
    check(!add.isError && depthId && add.json.inputs?.some((i) => i.port === 'media'), 'mia_add_block depth near the image', add.text.slice(0, 300));

    const badType = await mcp.tool('mia_add_block', { type: 'nope' });
    check(badType.isError && /Type de bloc inconnu/.test(badType.text), 'unknown type → French error listing the types', badType.text.slice(0, 160));

    const wire = await mcp.tool('mia_connect', { from: { node: importId }, to: { node: depthId } });
    check(!wire.isError && wire.json?.to?.port === 'media' && wire.json?.from?.port === 'out', 'mia_connect (ports guessed)', wire.text);

    const back = await mcp.tool('mia_connect', { from: { node: depthId }, to: { node: importId } });
    check(back.isError && /n’a pas d’entrée/.test(back.text), 'wire into a block without input → French error', back.text);

    const detail = depthDef?.params?.find((p) => p.id === 'detail');
    const other = detail?.options?.find((o) => o.value !== detail.default)?.value;
    const set = await mcp.tool('mia_set_params', { nodeId: depthId, params: { detail: other } });
    check(!set.isError && set.json?.params?.detail === other, `mia_set_params detail=${other}`, set.text.slice(0, 300));
    const badSet = await mcp.tool('mia_set_params', { nodeId: depthId, params: { detail: 'ultra-max' } });
    check(badSet.isError && /Valeurs permises/.test(badSet.text), 'bad value → French error with the allowed values', badSet.text);

    const ren = await mcp.tool('mia_rename_block', { nodeId: importId, title: 'Image de test' });
    check(!ren.isError && ren.json?.title === 'Image de test', 'mia_rename_block', ren.text);

    const boardR = await mcp.tool('mia_get_board');
    const b = boardR.json;
    check(!boardR.isError && b?.blocks?.length === 2 && b.wires?.length === 1, 'mia_get_board: 2 blocks, 1 wire', boardR.text.slice(0, 300));
    const imgBlock = b?.blocks?.find((x) => x.id === importId);
    check(imgBlock?.media?.path && fs.existsSync(imgBlock.media.path), 'the imported file is in the project (absolute path)', imgBlock?.media);

    const out = await mcp.tool('mia_get_output', { nodeId: importId });
    check(!out.isError && out.json?.outputs?.[0]?.path, 'mia_get_output of the Média block', out.text);
    const noRes = await mcp.tool('mia_get_output', { nodeId: depthId });
    check(noRes.isError && /pas encore de résultat/.test(noRes.text), 'mia_get_output of a block never run → French hint', noRes.text);

    const jobs = await mcp.tool('mia_jobs');
    check(!jobs.isError && Array.isArray(jobs.json), 'mia_jobs', jobs.text.slice(0, 200));
    const wt = await mcp.tool('mia_wait', { nodeId: depthId, timeoutS: 2 });
    check(wt.isError && /Aucun calcul/.test(wt.text), 'mia_wait on a block with no job → French error', wt.text);

    // a light job (ffmpeg on the CPU, no GPU): run → wait → output
    const rs = await mcp.tool('mia_add_block', { type: 'resize', near: importId, params: { size: 'x0.5' }, title: 'Moitié' });
    const resizeId = rs.json?.nodeId;
    check(!rs.isError && resizeId && rs.json.params?.size === 'x0.5', 'mia_add_block resize (light job) with params', rs.text.slice(0, 200));
    const noIn = await mcp.tool('mia_run', { nodeId: resizeId });
    check(noIn.isError && /calcul|Branche|entrée/i.test(noIn.text), 'mia_run without its input → French error, no job', noIn.text);
    const w2 = await mcp.tool('mia_connect', { from: { node: importId, port: 'out' }, to: { node: resizeId } });
    check(!w2.isError, 'mia_connect image → resize', w2.text);
    const again = await mcp.tool('mia_connect', { from: { node: importId, port: 'out' }, to: { node: resizeId } });
    check(again.isError && /to\.port/.test(again.text), 'mia_connect without a port never replaces a wire (asks to name the input)', again.text);
    const typo = await mcp.tool('mia_connect', { from: { node: importId }, to: { node: resizeId }, toPort: 'media' });
    check(typo.isError && /toPort/.test(typo.text) && /from \{node, port\}/.test(typo.text), 'MCP: an unknown field (toPort) is an error listing the fields', typo.text);
    const str = await mcp.tool('mia_connect', { from: { node: importId }, to: resizeId });
    check(str.isError && /object/.test(str.text), 'MCP: a nodeRef given as a string is refused (schema: object)', str.text);
    const run = await mcp.tool('mia_run', { nodeId: resizeId });
    const jobId = run.json?.jobId;
    check(!run.isError && jobId, 'mia_run → jobId', run.text);
    check(run.json?.boardId === pid && run.json?.projectId === pid, 'mia_run → boardId, and projectId (its deprecated old name)', run.text);
    const done = await mcp.tool('mia_wait', { jobId, timeoutS: 60 }, 90000);
    const outFile = done.json?.run?.outputs?.[0]?.path;
    // a test profile on a PC whose engine folder is not the default one has no ffmpeg: the light job cannot run there
    const noFfmpeg = done.json?.state === 'error' && /ffmpeg/i.test(done.json?.message || '');
    if (noFfmpeg) console.log('  SKIP no ffmpeg in this test Mia (no engine folder set in its profile): the result of the light job is not checked (3 checks)');
    else check(!done.isError && done.json?.state === 'done' && outFile && fs.existsSync(outFile), 'mia_wait → done, output file on disk', done.text.slice(0, 400));
    check(done.json?.boardId === pid && done.json?.projectId === pid, 'mia_wait → boardId and projectId', done.text.slice(0, 300));
    const jl = await mcp.tool('mia_jobs');
    const jj = (jl.json || []).find((j) => j.jobId === jobId);
    check(jj && jj.boardId === pid && jj.projectId === pid, 'mia_jobs → boardId and projectId', jj || jl.text.slice(0, 300));
    // the deprecated alias in the calls themselves
    const gp = await mcp.tool('mia_get_board', { projectId: pid });
    check(!gp.isError && gp.json?.board?.id === pid, 'mia_get_board {projectId} (deprecated alias of boardId)', gp.text.slice(0, 200));
    const wp = await mcp.tool('mia_wait', { nodeId: resizeId, projectId: pid, timeoutS: 5 });
    if (noFfmpeg) check(!wp.isError && wp.json?.jobId === jobId && wp.json.state === 'error', 'mia_wait {nodeId, projectId} (the job that could not run)', wp.text.slice(0, 300));
    else check(!wp.isError && wp.json?.jobId === jobId && wp.json.state === 'done', 'mia_wait {nodeId, projectId}', wp.text.slice(0, 300));
    const go = await mcp.tool('mia_get_output', { nodeId: resizeId });
    if (!noFfmpeg) check(!go.isError && go.json?.outputs?.[0]?.meta?.w === 384, 'mia_get_output: the half-size image (384 px)', go.text.slice(0, 300));

    // a recipe beside the rest, then removed (Ctrl+Z-able, no file deleted)
    const rec = await mcp.tool('mia_insert_recipe', { recipe: 'depth-video' });
    const recIds = (rec.json?.blocks || []).map((x) => x.nodeId);
    check(!rec.isError && recIds.length === 4 && rec.json.blocks.some((x) => x.waitsFor), 'mia_insert_recipe depth-video (4 blocks, one waits for a video)', rec.text.slice(0, 300));
    const gone = await mcp.tool('mia_remove_blocks', { nodeIds: recIds });
    check(!gone.isError && gone.json?.removed?.length === 4, 'mia_remove_blocks', gone.text.slice(0, 200));

    const arr = await mcp.tool('mia_arrange');
    check(!arr.isError && arr.json?.arranged === 3, 'mia_arrange', arr.text);
    // a tidy board (asked by Quentin on 24/11/2026: « ils superposent les choses ») — overlaps listed, a move onto
    // another block refused, a free move, a grid of some blocks: nothing covers anything afterwards
    const gb0 = await mcp.tool('mia_get_board');
    check(Array.isArray(gb0.json?.overlaps) && gb0.json.overlaps.length === 0 && (gb0.json?.sections || []).every((s) => Array.isArray(s.nodeIds)),
      'mia_get_board: overlaps listed (none after mia_arrange), sections give their blocks', gb0.json?.overlaps);
    const bl = gb0.json?.blocks || [];
    const onto = await mcp.tool('mia_move_blocks', { moves: [{ nodeId: bl[0].id, x: bl[1].x, y: bl[1].y }] });
    check(onto.isError && /serait posé sur|would sit on/.test(onto.text), 'mia_move_blocks refuses a place on another block, nothing moves', onto.text.slice(0, 200));
    const shift = await mcp.tool('mia_move_blocks', { nodeIds: [bl[0].id], dx: 0, dy: -1200 });
    check(!shift.isError && shift.json?.moved?.[0]?.nodeId === bl[0].id && shift.json.moved[0].y <= bl[0].y - 1150, 'mia_move_blocks by dx / dy', shift.text.slice(0, 200));
    const gridded = await mcp.tool('mia_arrange', { nodeIds: bl.map((x) => x.id), layout: 'grid', columns: 2 });
    check(!gridded.isError && gridded.json?.arranged === bl.length && gridded.json?.layout === 'grid' && gridded.json?.overlaps?.length === 0,
      'mia_arrange {nodeIds, layout: grid, columns: 2}: nothing covers', gridded.text.slice(0, 300));
    const badLayout = await mcp.tool('mia_arrange', { layout: 'spiral' });
    check(badLayout.isError, 'mia_arrange refuses an unknown layout', badLayout.text.slice(0, 160));

    const foc = await mcp.tool('mia_focus', { nodeIds: [importId, depthId] });
    check(!foc.isError, 'mia_focus', foc.text);
    const over = await cdpEval(`(() => { const ed = window.__mia.editor; const g = ed.getGraph();
      const b = g.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: ed.nodeEl(n.id).offsetHeight }));
      const hits = []; for (const a of b) for (const c of b) if (a.id < c.id && a.x < c.x + c.w && a.x + a.w > c.x && a.y < c.y + c.h && a.y + a.h > c.y) hits.push(a.id + '/' + c.id);
      return hits; })()`);
    check(Array.isArray(over) && over.length === 0, 'no block overlaps another after arrange', over);

    const projs = await mcp.tool('mia_list_projects');
    const mine = projs.json?.boards?.find((p) => p.id === pid);
    check(!projs.isError && Array.isArray(projs.json?.folders) && mine && mine.folderId === null, 'mia_list_projects → {folders, boards}; the test board is outside any project', projs.text.slice(0, 300));

    const say = await mcp.tool('mia_say', { text: 'J’ai posé une profondeur sur ton image : regarde à droite.' });
    check(!say.isError && say.json?.shown === true, 'mia_say (bubble shown)', say.text);

    const shot = await mcp.tool('mia_snapshot');
    const img = shot.content.find((c) => c.type === 'image');
    check(!shot.isError && img && img.mimeType === 'image/png' && img.data.length > 1000, 'mia_snapshot returns an image', shot.text);
    if (img) {
      const f = path.join(DEV, 'snapshot.png');
      fs.writeFileSync(f, Buffer.from(img.data, 'base64'));
      console.log('  snapshot →', f);
    }
    const shotNode = await mcp.tool('mia_snapshot', { nodeId: depthId });
    const img2 = shotNode.content.find((c) => c.type === 'image');
    if (img2) fs.writeFileSync(path.join(DEV, 'snapshot-node.png'), Buffer.from(img2.data, 'base64'));
    check(!shotNode.isError && img2, 'mia_snapshot of one block', shotNode.text);

    // the actions are in the undo history (Ctrl+Z), the cursor and the pill are on screen
    const ui = await cdpEval(`(() => {
      const ed = window.__mia.editor;
      const h = ed.__debug && ed.__debug.ctx.history;
      const cur = document.querySelector('.pr-cursor');
      const pill = document.querySelector('.pr-pill');
      return { undo: h ? h.past.map((e) => e.label) : null, cursor: !!cur && cur.classList.contains('on'), label: cur && cur.querySelector('.pr-label').textContent,
               pill: !!pill && pill.classList.contains('on'), pillText: pill && pill.textContent };
    })()`);
    check(ui && ui.undo && ui.undo.length >= 4, 'AI actions are in the undo history', ui?.undo);
    check(ui && ui.label === 'Claude' && ui.pill && /Claude/.test(ui.pillText), 'presence cursor « Claude » + title bar pill', ui);
    const undone = await cdpEval(`(() => { const ed = window.__mia.editor; const n = ed.getGraph().nodes.length; ed.undo(); ed.undo(); const m = ed.getGraph(); ed.redo(); ed.redo(); return { before: n, afterUndo: m.nodes.length + '/' + m.edges.length, after: ed.getGraph().nodes.length + '/' + ed.getGraph().edges.length }; })()`);
    check(undone && undone.after === '3/2', 'undo / redo of the AI actions', undone);

    const rm = await mcp.tool('mia_remove_blocks', { nodeIds: ['n_inexistant'] });
    check(rm.isError && /n’existe pas/.test(rm.text), 'remove of an unknown block → French error', rm.text.slice(0, 160));

    await testFolders(mcp, pid);
    await testCloudModes(mcp, image);
    await testParallel(mcp, image);
    await testGreenlight(mcp);
    await testModeSwitch(mcp, image);
    await testTraining(mcp);
  } catch (e) {
    failures++;
    console.log('  FAIL', e && e.stack ? e.stack : e);
  } finally {
    if (mcp) {
      try { mcp.child.stdin.end(); } catch { /* closed */ }
      const err = mcp.stderr.join('');
      if (err.trim()) console.log('· mcp stderr:\n' + err.trim().split('\n').map((l) => '    ' + l).join('\n'));
    }
    if (!KEEP && mia) {
      // ask Mia to close (it removes bridge.json), then make sure our own process tree is gone
      try { await cdpEval('window.mia.win.close()'); } catch { /* already gone */ }
      const t0 = Date.now();
      while (fs.existsSync(BRIDGE_FILE) && Date.now() - t0 < 8000) await sleep(200);
      check(!fs.existsSync(BRIDGE_FILE), 'bridge.json removed when Mia quits');
      try { execFileSync('taskkill', ['/PID', String(mia.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* exited */ }
    } else {
      console.log(`· test Mia left open (${mia ? `pid ${mia.pid}, ` : ''}CDP ${CDP_PORT})`);
    }
  }
  console.log(failures ? `\n${failures} échec(s)` : '\nTout est bon.');
  process.exit(failures ? 1 : 0);
}

// ---------------------------------------------------------------- online Model blocks: mode, tier, notes (30/10)
// Nothing is ever sent to Higgsfield: the blocks are only placed, wired and set (no mia_run).
/** Turns the user's green light on or off in the test Mia (Réglages → Assistants → « Demander mon feu vert »). */
async function askGo(on) {
  await cdpEval(`(async () => { await window.mia.prefs.set({ assistantAsk: ${on ? 'true' : 'false'} }); window.__mia.state.prefs.assistantAsk = ${on ? 'true' : 'false'}; })()`);
}

// The user's green light (SPEC §13.7): nothing moves before « C'est parti », « Pause », and « À générer ».
async function testGreenlight(mcp) {
  console.log('· green light: request card, pause, « À générer »');
  await askGo(true);
  const count = () => cdpEval('window.__mia.editor.getGraph().nodes.length');
  const n0 = await count();
  const early = await mcp.tool('mia_add_block', { type: 'depth' });
  check(early.isError && /mia_request/.test(early.text) && (await count()) === n0, 'no green light yet: nothing is placed, the error says to call mia_request', early.text.slice(0, 160));
  const read = await mcp.tool('mia_get_board');
  check(!read.isError, 'reading the board needs no green light', read.text.slice(0, 120));

  // declined
  const no = mcp.tool('mia_request', { title: 'Poser une profondeur', summary: 'Un bloc sur ta planche.', steps: ['Poser le bloc Profondeur'], runs: 1 });
  await sleep(700);
  const card = await cdpEval(`(() => { const c = document.querySelector('.gl-ask'); return c ? { title: c.querySelector('.gl-ask-title').textContent, sub: c.querySelector('.gl-ask-sub').textContent, btns: [...c.querySelectorAll('.gl-ask-acts .btn')].map((b) => b.textContent) } : null; })()`);
  check(card && /Claude attend ton feu vert/.test(card.title) && /Poser une profondeur/.test(card.sub) && /1 calcul/.test(card.sub) && card.btns.join('|') === 'Détail|Plus tard|C’est parti', 'the request card: who, what, how many computations, three buttons', card);
  await cdpEval(`document.querySelectorAll('.gl-ask-acts .btn')[1].click()`);
  const chip = await cdpEval(`(() => { const c = document.querySelector('.gl-stack .gl-chip'); const t = c && c.textContent; if (c) c.click(); return t; })()`);
  check(/attend ton feu vert/.test(chip || '') && (await cdpEval(`!!document.querySelector('.gl-ask')`)), '« Plus tard » leaves a chip; a click brings the card back', chip);
  await cdpEval(`(() => { document.querySelectorAll('.gl-ask-acts .btn')[0].click(); document.querySelector('.gl-refuse').click(); })()`);
  const refused = await no;
  check(!refused.isError && refused.json?.state === 'declined', '« Refuser » → the assistant is told', refused.text.slice(0, 160));
  const still = await mcp.tool('mia_add_block', { type: 'depth' });
  check(still.isError && (await count()) === n0, 'declined: still nothing placed', still.text.slice(0, 120));

  // accepted
  const yes = mcp.tool('mia_request', { title: 'Poser une profondeur', summary: 'Un bloc sur ta planche, puis son calcul.', runs: 1 });
  await sleep(700);
  await cdpEval(`document.querySelector('.gl-ask-acts .btn-primary').click()`);
  const ok = await yes;
  check(!ok.isError && ok.json?.state === 'accepted' && !(await cdpEval(`!!document.querySelector('.gl-ask')`)), '« C’est parti » → accepted, the card leaves', ok.text.slice(0, 160));
  const src = (read.json?.blocks || []).find((b) => b.type === 'import');
  const dep = await mcp.tool('mia_add_block', { type: 'depth', near: src?.id });
  const wire = await mcp.tool('mia_connect', { from: { node: src?.id }, to: { node: dep.json?.nodeId } });
  check(!dep.isError && !wire.isError && (await count()) === n0 + 1, 'with the green light the assistant acts', [dep.text.slice(0, 100), wire.text.slice(0, 100)]);

  // pause
  await cdpEval(`document.querySelector('.pr-pause').click()`);
  const held = mcp.tool('mia_rename_block', { nodeId: dep.json?.nodeId, title: 'Profondeur du test' });
  await sleep(1500);
  const during = await cdpEval(`({ title: window.__mia.editor.getNode(${JSON.stringify(dep.json?.nodeId)}).title || null, pill: document.querySelector('.pr-pill-txt').textContent, btn: document.querySelector('.pr-pause').textContent })`);
  check(during && during.title === null && /pause/i.test(during.pill) && during.btn === 'Reprendre', '« Pause »: the action waits, the title bar says so', during);
  await cdpEval(`document.querySelector('.pr-pause').click()`);
  const resumed = await held;
  check(!resumed.isError && resumed.json?.title === 'Profondeur du test', '« Reprendre »: the action goes on', resumed.text.slice(0, 120));

  // « À générer »
  const run = await mcp.tool('mia_run', { nodeId: dep.json?.nodeId });
  const jobs = await mcp.tool('mia_jobs');
  check(!run.isError && run.json?.awaitingUser === true && run.json?.pendingId && !run.json?.jobId, 'a heavy run is proposed, not started', run.text.slice(0, 200));
  const again = await mcp.tool('mia_run', { nodeId: dep.json?.nodeId });
  const tray = await cdpEval(`(() => { const c = document.querySelector('.gl-tray'); return c ? { rows: [...c.querySelectorAll('.gl-row')].map((r) => r.querySelector('.gl-name').textContent + '|' + r.querySelector('.gl-check').getAttribute('aria-checked')), go: c.querySelector('.gl-tray-foot .btn').textContent } : null; })()`);
  check(again.json?.pendingId === run.json?.pendingId && tray && tray.rows.join() === 'Profondeur du test|true' && /\(1\)/.test(tray.go), '« À générer »: one line per block, ticked, « Générer la sélection (1) »', { tray, jobs: jobs.text.slice(0, 80) });
  const pend = await mcp.tool('mia_pending');
  check(!pend.isError && pend.json?.granted === true && pend.json?.paused === false && (pend.json?.toGenerate || []).some((x) => x.pendingId === run.json.pendingId && x.state === 'waiting' && x.ticked === true), 'mia_pending: granted, the run is waiting for the user', pend.text.slice(0, 300));
  await cdpEval(`document.querySelector('.gl-tray .gl-check').click()`);
  const off = await cdpEval(`({ go: document.querySelector('.gl-tray-foot .btn').disabled, total: document.querySelector('.gl-total').textContent })`);
  check(off && off.go === true && off.total === 'Rien de coché', 'unticked: nothing to generate', off);
  await cdpEval(`document.querySelector('.gl-tray .gl-check').click()`);
  await cdpEval(`document.querySelector('.gl-tray-foot .btn').click()`);
  await sleep(1200);
  // this test Mia refuses heavy computations (MIA_NO_GPU): the click reaches the engine, which says no on the line
  const after = await mcp.tool('mia_pending');
  const mine = (after.json?.toGenerate || []).find((x) => x.pendingId === run.json.pendingId);
  const line = await cdpEval(`(() => { const r = document.querySelector('.gl-tray .gl-sub'); return r ? r.textContent : null; })()`);
  check(mine && (mine.state === 'launched' || (mine.state === 'waiting' && line)), '« Générer la sélection » sends the ticked run to the engine (started, or its refusal shown on the line)', { mine, line });
  await cdpEval(`(() => { const b = document.querySelector('.gl-tray-head .btn'); if (b) b.click(); })()`);
  check(!(await cdpEval(`!!document.querySelector('.gl-tray')`)), '« Tout retirer » empties the list', null);
  await askGo(false);
  const free = await mcp.tool('mia_request', { title: 'Sans feu vert' });
  check(!free.isError && free.json?.state === 'accepted', 'setting off: mia_request answers accepted at once', free.text.slice(0, 120));
}

// « Je valide · Auto » (SPEC §13.7, asked by Quentin on 19/11/2026: « si je suis pas devant mon PC je pourrais
// pas le faire »): the switch at the bottom left of the board, the same preference as Réglages → « Demander mon feu
// vert ». In « Auto » EVERYTHING starts at once, heavy jobs of the PC and paid online ones included (his decision).
// Cases: (a) a card waits and he switches → accepted; (b) lines in « À générer » at the switch → they stay, with a line,
// and a run asked again starts at once; (c) back to « Je valide » → the next action asks again, nothing cancelled;
// (d) « Pause » keeps its role (and shows in « Auto » too).
async function testModeSwitch(mcp, image) {
  console.log('· « Je valide · Auto »: the switch of the board, cases a to d');
  const sw = () => cdpEval(`(() => {
    const r = document.getElementById('gl-mode');
    if (!r) return null;
    const b = r.getBoundingClientRect(), d = document.getElementById('dock').getBoundingClientRect(), z = document.getElementById('zoombar').getBoundingClientRect();
    return { opts: [...r.querySelectorAll('.gl-mode-opt')].map((o) => o.textContent + '|' + o.getAttribute('aria-checked')),
      auto: r.classList.contains('is-auto'), titles: r.querySelectorAll('[title]').length + (r.hasAttribute('title') ? 1 : 0), role: r.getAttribute('role'),
      rightOfDock: b.left >= d.right && b.left - d.right < 20, sameRow: Math.abs(b.bottom - d.bottom) < 1, bottomLeft: d.left < 40 && Math.abs(b.bottom - z.bottom) < 1 && (innerWidth < 900 || b.right <= z.left), at: [Math.round(b.left), Math.round(b.top), Math.round(b.right), innerWidth, innerHeight, Math.round(z.left)],
      shown: b.width > 0 && getComputedStyle(r).display !== 'none', pref: window.__mia.state.prefs.assistantAsk, tight: r.classList.contains('tight') };
  })()`);
  // the words of « Je valide »: « Claude demande » in a narrow window, where it shows alone (this test window is small)
  const askWord = (st) => (st && st.tight ? 'Claude demande' : 'Je valide');
  // choose a mode (a click on the mode already chosen would switch in a narrow window, where only it shows)
  const click = (m) => cdpEval(`(() => { const b = document.querySelector('.gl-mode-opt[data-mode="${m}"]'); if (b && b.getAttribute('aria-checked') !== 'true') b.click(); return !!b; })()`);
  const filePref = () => cdpEval(`window.mia.prefs.get().then((p) => p.assistantAsk)`);
  const tipOf = (m) => cdpEval(`(async () => {
    const b = document.querySelector('.gl-mode-opt[data-mode="${m}"]');
    b.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: 1, clientY: 1 }));
    await new Promise((r) => setTimeout(r, 800));
    const t = document.getElementById('tooltip');
    const out = t && !t.hidden ? t.textContent : null;
    b.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    return out;
  })()`);
  const pauseShown = () => cdpEval(`(() => { const p = document.querySelector('.pr-pause'); return !!p && !p.hidden; })()`);
  const count = () => cdpEval('window.__mia.editor.getGraph().nodes.length');
  const trayRows = () => cdpEval(`(() => { const c = document.querySelector('.gl-tray'); return c ? { rows: [...c.querySelectorAll('.gl-row')].map((r) => r.querySelector('.gl-name').textContent + '|' + r.querySelector('.gl-check').getAttribute('aria-checked')), before: (c.querySelector('.gl-before') || {}).textContent || null } : null; })()`);

  // the switch, « Je valide » first
  await askGo(true);
  await click('ask');
  await sleep(300);
  let s = await sw();
  check(s && s.shown && s.role === 'radiogroup' && s.opts.join() === askWord(s) + '|true,Auto|false' && !s.auto && s.titles === 0,
    'the switch is on the board: « Je valide » chosen, « Auto » next to it, radio buttons, no title=', s);
  check(s && s.bottomLeft && s.rightOfDock && s.sameRow, 'bottom left of the board, right of the dock, on its row', s);
  const tipAuto = await tipOf('auto');
  const tipAsk = await tipOf('ask');
  // (a narrow window adds what a click does: « Clic : passer en « Je valide ». »)
  check(String(tipAuto || '').startsWith('Claude lance tout sans te demander, y compris les calculs en ligne payants.'), 'Mia’s tooltip of « Auto » says what it implies, in one sentence', tipAuto);
  check(/attend ton « C’est parti »/.test(tipAsk || '') && /À générer/.test(tipAsk || ''), 'the tooltip of « Je valide »', tipAsk);

  // a narrow window (relecture of 19/11: 900 px with the Higgsfield amount): only the chosen mode shows. Alone, « Je
  // valide » read as a button that validates something: it says « Claude demande », with a small switch in front of it.
  // The zoom bar is pushed left by a wide Higgsfield amount, as in a narrow window.
  const narrow = await cdpEval(`(async () => {
    const r = document.getElementById('gl-mode'), hf = document.querySelector('.zb-hf'), z = document.getElementById('zoombar');
    if (!r || !hf || !z) return null;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const still = document.createElement('style');           // the knob read where it ends, not in its move
    still.textContent = '.gl-mode-sw::after { transition: none !important; }';
    document.head.append(still);
    const look = () => {
      const shown = [...r.querySelectorAll('.gl-mode-opt')].filter((o) => o.offsetWidth);
      const sw = shown[0] && shown[0].querySelector('.gl-mode-sw');
      return { tight: r.classList.contains('tight'), shown: shown.map((o) => o.textContent), sw: !!sw && sw.offsetWidth > 0,
        dot: [...r.querySelectorAll('.gl-mode-dot')].some((d) => d.offsetWidth > 0), knob: sw ? getComputedStyle(sw, '::after').transform : null,
        swColor: sw ? getComputedStyle(sw).borderTopColor : null, room: Math.round(z.getBoundingClientRect().left - r.getBoundingClientRect().right),
        pref: window.__mia.state.prefs.assistantAsk };
    };
    const keep = { hidden: hf.hidden, sep: hf.nextElementSibling ? hf.nextElementSibling.hidden : null, html: hf.innerHTML, min: hf.style.minWidth };
    hf.hidden = false;
    if (hf.nextElementSibling) hf.nextElementSibling.hidden = false;
    hf.innerHTML = '<span class="zb-hf-name">Higgsfield</span><span class="zb-hf-amt">reste 112,40 $</span>';
    const wide = r.offsetWidth;
    const delta = z.getBoundingClientRect().left - (r.getBoundingClientRect().left + wide - 20);
    hf.style.minWidth = (hf.offsetWidth + delta) + 'px';
    r.dispatchEvent(new PointerEvent('pointerenter'));
    await wait(100);
    const ask = look();
    const btn = r.querySelector('.gl-mode-opt.on');
    btn.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: 1, clientY: 1 }));
    await wait(800);
    const t = document.getElementById('tooltip');
    const tipText = t && !t.hidden ? t.textContent : null;
    btn.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    btn.click();
    await wait(400);
    const auto = look();
    r.querySelector('.gl-mode-opt.on').click();
    await wait(400);
    const back = look();
    hf.hidden = keep.hidden;
    if (hf.nextElementSibling) hf.nextElementSibling.hidden = keep.sep;
    hf.innerHTML = keep.html;
    hf.style.minWidth = keep.min;
    // room enough (the zoom bar out of the way: this test window is small): both choices, their own words, no switch
    z.style.display = 'none';
    r.dispatchEvent(new PointerEvent('pointerenter'));
    await wait(100);
    const wideLook = look();
    z.style.display = '';
    r.dispatchEvent(new PointerEvent('pointerenter'));
    await wait(100);
    still.remove();
    return { ask, tip: tipText, auto, back, wide: wideLook, vw: innerWidth };
  })()`);
  const accentRgb = await cdpEval(`(() => { const d = document.createElement('i'); d.style.color = 'var(--accent)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; })()`);
  check(narrow && narrow.ask.tight && narrow.ask.shown.join() === 'Claude demande' && narrow.ask.sw && !narrow.ask.dot && narrow.ask.pref === true && (narrow.ask.room >= 0 || narrow.vw < 900),
    'narrow window, « Je valide »: only « Claude demande » shows, with a small switch in front of it (not « Je valide » alone)', narrow && narrow.ask);
  check(narrow && /Clic\s:\spasser en\s«\sAuto\s»/.test(narrow.tip || '') && /attend ton\s«\sC’est parti\s»/.test(narrow.tip || ''),
    'narrow window: its tooltip says the mode and what a click does', narrow && narrow.tip);
  check(narrow && narrow.auto.tight && narrow.auto.shown.join() === 'Auto' && narrow.auto.sw && narrow.auto.pref === false
    && /matrix\(1, 0, 0, 1, 10, 0\)/.test(narrow.auto.knob || '') && narrow.auto.swColor === accentRgb,
    'narrow window: a click switches to « Auto », the knob moves right, in the accent', { auto: narrow && narrow.auto, accentRgb });
  check(narrow && narrow.back.shown.join() === 'Claude demande' && narrow.back.pref === true && !narrow.wide.tight && narrow.wide.shown.join() === 'Je valide,Auto' && !narrow.wide.sw,
    'narrow window: a click switches back; wide again, both choices and their own words come back, no switch', narrow && { back: narrow.back, wide: narrow.wide });

  // (a) a request card waits; the user switches to « Auto » → the request is accepted, the card leaves
  const asked = mcp.tool('mia_request', { title: 'Poser deux blocs', summary: 'Une profondeur et un calcul en ligne.', runs: 2 });
  await sleep(700);
  check(await cdpEval(`!!document.querySelector('.gl-ask')`), '(a) the card « Claude attend ton feu vert » waits');
  await click('auto');
  const got = await asked;
  s = await sw();
  check(!got.isError && got.json?.state === 'accepted' && got.json?.mode === 'auto' && /Auto/.test(got.json?.note || '') && /payants/.test(got.json?.note || ''),
    '(a) switched while the card waits → accepted, mode "auto", the note says that everything starts, paid ones included', got.text.slice(0, 300));
  check(!(await cdpEval(`!!document.querySelector('.gl-ask, .gl-stack .gl-chip')`)) && s && s.auto && s.opts.join() === askWord(s) + '|false,Auto|true' && s.pref === false,
    '(a) the card leaves; the switch shows « Auto » (the accent)', s);
  check((await filePref()) === false, 'the preference is written (prefs.assistantAsk false)');
  const accent = await cdpEval(`(() => { const o = document.querySelector('.gl-mode-opt[data-mode="auto"]'); const d = o.querySelector('.gl-mode-dot'); const cs = getComputedStyle(d); const root = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(); return { dot: cs.backgroundColor, accent: root, ring: getComputedStyle(o).boxShadow, glow: [...getComputedStyle(o).boxShadow.matchAll(/(-?[0-9.]+)px (-?[0-9.]+)px ([0-9.]+)px/g)].some((m) => +m[3] > 0) }; })()`);
  check(accent && /rgb\(77, 130, 243\)|rgb\(59, 111, 224\)/.test(accent.dot) && /inset/.test(accent.ring) && !accent.glow, '« Auto » chosen: the dot in Mia’s one accent, a 1 px ring, no glow', accent);

  // the same preference in Réglages → Assistants
  const setRow = () => cdpEval(`(() => { const r = [...document.querySelectorAll('.set-row')].find((x) => x.textContent.includes('Demander mon feu vert')); const t = r && r.querySelector('[role="switch"]'); return t ? t.getAttribute('aria-checked') : null; })()`);
  await cdpEval(`(async () => { const m = await import(new URL('js/ui/settings.js', location.href).href); m.openSettings(); return 1; })()`);
  await sleep(900);
  check((await setRow()) === 'false', 'Réglages → « Demander mon feu vert » shows it off', await setRow());
  const hint = await cdpEval(`(() => { const r = [...document.querySelectorAll('.set-row')].find((x) => x.textContent.includes('Demander mon feu vert')); return r ? r.textContent : null; })()`);
  check(/Auto/.test(hint || '') && /en bas à gauche de la planche/.test(hint || ''), 'its sentence names « Auto » and the switch of the board', hint);
  await cdpEval(`(() => { const r = [...document.querySelectorAll('.set-row')].find((x) => x.textContent.includes('Demander mon feu vert')); r.querySelector('[role="switch"]').click(); return 1; })()`);
  await sleep(700);
  s = await sw();
  check(s && !s.auto && s.opts[0] === askWord(s) + '|true' && (await filePref()) === true, 'turned on in Réglages → the switch of the board shows « Je valide »', s);
  await cdpEval(`(() => { const r = [...document.querySelectorAll('.set-row')].find((x) => x.textContent.includes('Demander mon feu vert')); r.querySelector('[role="switch"]').click(); return 1; })()`);
  await sleep(700);
  s = await sw();
  check(s && s.auto && (await filePref()) === false, 'turned off in Réglages → « Auto » on the board', s);
  await cdpEval(`(() => { const b = document.querySelector('.set-close, .modal-close'); if (b) b.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1; })()`);
  await sleep(500);

  // « Auto »: everything starts — a board, blocks, a heavy job of the PC, a paid online one
  const board = await mcp.tool('mia_create_project', { name: `Agit seul ${STAMP}` });
  check(!board.isError && board.json?.boardId, 'no request: the assistant creates a board', board.text.slice(0, 160));
  const imp = await mcp.tool('mia_import_media', { paths: [image] });
  const src = imp.json?.blocks?.[0]?.nodeId;
  const dep = await mcp.tool('mia_add_block', { type: 'depth', near: src });
  await mcp.tool('mia_connect', { from: { node: src }, to: { node: dep.json?.nodeId } });
  check(!imp.isError && src && !dep.isError && dep.json?.nodeId, 'it imports and places blocks without asking', [imp.text.slice(0, 100), dep.text.slice(0, 100)]);
  const pend0 = await mcp.tool('mia_pending');
  check(!pend0.isError && pend0.json?.mode === 'auto' && pend0.json?.enabled === false && pend0.json?.granted === true && /Auto/.test(pend0.json?.note || ''),
    'mia_pending: mode "auto", granted, and a note that says what it means', pend0.text.slice(0, 300));
  const heavy = await mcp.tool('mia_run', { nodeId: dep.json?.nodeId });
  // this test Mia refuses heavy jobs (MIA_NO_GPU): the refusal proves the run went to the engine, not to « À générer »
  check(!heavy.json?.awaitingUser && (heavy.json?.jobId || (heavy.isError && /MIA_NO_GPU|Aucun modèle installé|No model installed|n’est plus disponible|no longer available/.test(heavy.text))) && !(await trayRows()),
    'a heavy job of the PC starts at once (the engine answers), nothing in « À générer »', heavy.text.slice(0, 200));
  const hf = await mcp.tool('mia_add_block', { type: 'gen', params: { model: 'hf:kling-4-0', workflow: 'kling-video/v4.0/text-to-video', prompt: 'a lighthouse at dawn' }, title: 'Kling payant' });
  const paid = await mcp.tool('mia_run', { nodeId: hf.json?.nodeId });
  // no Higgsfield account in this profile: the engine refuses it before any call (and MIA_HF_BASE points nowhere)
  check(!hf.isError && !paid.json?.awaitingUser && (paid.json?.jobId || (paid.isError && /Higgsfield/.test(paid.text))) && !(await trayRows()),
    'a PAID online job starts at once too (the engine answers: no account here), nothing in « À générer »', paid.text.slice(0, 200));

  // (d) « Pause » keeps its role, and shows while an assistant works in « Auto » too (the preference set
  // directly too: this part does not depend on the switch)
  await askGo(false);
  const ren = mcp.tool('mia_rename_block', { nodeId: dep.json?.nodeId, title: 'Profondeur seule' });
  let seen = false;
  for (let i = 0; i < 12 && !seen; i++) { seen = await pauseShown(); if (!seen) await sleep(100); }
  await ren;
  check(seen, '(d) « Pause » shows in the title bar while the assistant works in « Auto »');
  await cdpEval(`document.querySelector('.pr-pause').click()`);
  const held = mcp.tool('mia_rename_block', { nodeId: dep.json?.nodeId, title: 'Profondeur en pause' });
  await sleep(1500);
  const during = await cdpEval(`window.__mia.editor.getNode(${JSON.stringify(dep.json?.nodeId)}).title`);
  // (not mia_pending here: the calls of one assistant wait in a row, it would wait behind the paused one)
  const pill = await cdpEval(`document.querySelector('.pr-pill-txt').textContent`);
  check(during === 'Profondeur seule' && /pause/i.test(pill || ''), '(d) « Pause » holds the assistant in « Auto » too', { during, pill });
  await cdpEval(`document.querySelector('.pr-pause').click()`);
  const after = await held;
  check(!after.isError && after.json?.title === 'Profondeur en pause', '(d) « Reprendre »: it goes on', after.text.slice(0, 120));
  // (c + d) relecture of 19/11: « Pause » in « Auto », then « Je valide », then « Reprendre »: the action held by the
  // pause was checked before the switch, it used to pass without a green light. Now it is looked at again.
  await cdpEval(`document.querySelector('.pr-pause').click()`);
  const heldAsk = mcp.tool('mia_rename_block', { nodeId: dep.json?.nodeId, title: 'Profondeur retenue' });
  await sleep(1200);
  await click('ask');
  await sleep(300);
  await cdpEval(`document.querySelector('.pr-pause').click()`);
  const heldOut = await heldAsk;
  const heldTitle = await cdpEval(`window.__mia.editor.getNode(${JSON.stringify(dep.json?.nodeId)}).title`);
  check(heldOut.isError && /mia_request/.test(heldOut.text) && heldTitle === 'Profondeur en pause',
    '(c + d) held by « Pause » in « Auto », then « Je valide », then « Reprendre »: the held action asks for the green light, nothing moves', { err: heldOut.text.slice(0, 120), heldTitle });
  await click('auto');
  await sleep(300);

  // (c) back to « Je valide » while it works: its next action asks again; nothing is cancelled
  await click('ask');
  await sleep(300);
  const n0 = await count();
  const refused = await mcp.tool('mia_add_block', { type: 'depth', near: src });
  check(refused.isError && /mia_request/.test(refused.text) && (await count()) === n0, '(c) back to « Je valide »: the next action is refused until mia_request', refused.text.slice(0, 160));
  // a green light given in « Je valide », then « Auto », then « Je valide » again: taken back too
  const yes = mcp.tool('mia_request', { title: 'Une profondeur de plus', runs: 1 });
  await sleep(700);
  await cdpEval(`document.querySelector('.gl-ask-acts .btn-primary').click()`);
  const ok = await yes;
  check(!ok.isError && ok.json?.state === 'accepted' && ok.json?.mode === 'ask', 'mia_request in « Je valide » says mode "ask"', ok.text.slice(0, 200));
  await click('auto');
  await sleep(200);
  await click('ask');
  await sleep(300);
  const again = await mcp.tool('mia_add_block', { type: 'depth', near: src });
  check(again.isError && /mia_request/.test(again.text), '(c) the green light given before « Auto » does not come back with « Je valide »: asked again', again.text.slice(0, 160));
  // (c) relecture of 19/11: « Auto » then « Je valide » at once (a click by mistake, taken back): the answer
  // to the first write used to bring « Auto » back for a few milliseconds (assistants passed without a green light)
  const race = await cdpEval(`(async () => {
    const st = window.__mia.state, bus = window.__mia.bus, seen = [];
    const spy = () => seen.push(st.prefs.assistantAsk + '/' + document.getElementById('gl-mode').classList.contains('is-auto'));
    bus.on('prefs:changed', spy);
    document.querySelector('.gl-mode-opt[data-mode="auto"]').click();
    document.querySelector('.gl-mode-opt[data-mode="ask"]').click();
    const t0 = performance.now();
    while (performance.now() - t0 < 700) { spy(); await new Promise((r) => setTimeout(r, 0)); }
    bus.off('prefs:changed', spy);
    return { seen: [...new Set(seen)], file: (await window.mia.prefs.get()).assistantAsk, now: st.prefs.assistantAsk };
  })()`);
  check(race && race.seen.join() === 'true/false' && race.file === true && race.now === true,
    '(c) two quick clicks « Auto » then « Je valide »: « Je valide » holds, « Auto » never comes back, not even for a moment', race);
  const n1 = await count();
  await cdpEval(`(() => { document.querySelector('.gl-mode-opt[data-mode="auto"]').click(); document.querySelector('.gl-mode-opt[data-mode="ask"]').click(); return 1; })()`);
  const raced = await Promise.all([0, 2, 4, 6, 8, 12, 20, 40].map(async (d) => { await sleep(d); const x = await mcp.tool('mia_add_block', { type: 'depth', near: src }); return x.isError; }));
  await sleep(300);
  check(raced.every(Boolean) && (await count()) === n1, '(c) …and no assistant action passes during the two clicks', { raced, n1, now: await count() });

  // (b) lines in « À générer » when the user switches to « Auto »: they stay, unticked ones unticked, with a line
  const go = mcp.tool('mia_request', { title: 'Deux calculs', runs: 2 });
  await sleep(700);
  await cdpEval(`document.querySelector('.gl-ask-acts .btn-primary').click()`);
  await go;
  const p1 = await mcp.tool('mia_run', { nodeId: dep.json?.nodeId });
  const p2 = await mcp.tool('mia_run', { nodeId: hf.json?.nodeId });
  check(p1.json?.awaitingUser && p2.json?.awaitingUser, '« Je valide »: both runs go to « À générer »', [p1.text.slice(0, 80), p2.text.slice(0, 80)]);
  const before = await trayRows();
  await click('auto');
  await sleep(500);
  const kept = await trayRows();
  check(before && kept && kept.rows.join() === before.rows.join() && [...kept.rows].sort().join() === 'Kling payant|false,Profondeur en pause|true',
    '(b) switched to « Auto »: the lines stay as they were (the paid one unticked), nothing starts by itself', { before, kept });
  check(kept && kept.before === 'Proposés avant « Auto » : ils attendent ta coche.', '(b) …with a line that says they wait for the tick', kept && kept.before);
  const pendB = await mcp.tool('mia_pending');
  const waitingB = (pendB.json?.toGenerate || []).filter((x) => x.state === 'waiting').map((x) => x.pendingId).sort().join();
  check(pendB.json?.mode === 'auto' && waitingB === [p1.json?.pendingId, p2.json?.pendingId].sort().join() && /mia_run/.test(pendB.json?.note || ''),
    '(b) mia_pending: both still waiting, and the note says mia_run starts them now', pendB.text.slice(0, 400));
  // a run asked again for a line of the list starts at once: here the engine refuses it (MIA_NO_GPU), the line stays
  const re = await mcp.tool('mia_run', { nodeId: dep.json?.nodeId });
  check(!re.json?.awaitingUser && (re.json?.jobId || (re.isError && /MIA_NO_GPU|Aucun modèle installé|No model installed|n’est plus disponible|no longer available/.test(re.text))), '(b) mia_run of a line in « Auto » goes to the engine at once', re.text.slice(0, 160));
  // once started, its line leaves the list as « launched » (the same function presence.js calls after a start)
  const left = await cdpEval(`(async () => { const g = await import(new URL('js/ui/greenlight.js', location.href).href); return g.launched({ nodeId: ${JSON.stringify(dep.json?.nodeId)}, boardId: window.__mia.state.project.id, jobId: 'j_banc' }); })()`);
  const pendL = await mcp.tool('mia_pending');
  const l1 = (pendL.json?.toGenerate || []).find((x) => x.pendingId === p1.json?.pendingId);
  check(left === true && l1 && l1.state === 'launched' && l1.jobId === 'j_banc' && (await trayRows())?.rows.join() === 'Kling payant|false',
    '(b) a line started in « Auto » leaves the list, mia_pending says launched with its jobId', { left, l1 });
  await cdpEval(`(() => { const b = document.querySelector('.gl-tray-head .btn'); if (b) b.click(); })()`);
  await askGo(false);
}

// ---------------------------------------------------------------- training a LoRA (mia_train_*), with the fake tool
// Conception §10.2, cases 27 to 30 (and 17 for the card): two doors — the green light to prepare, then a
// SUGGESTION the user starts himself; the card comes from train.json, so it survives a reload.

/** The cards of suggested trainings as the user sees them. */
function trainCards() {
  return cdpEval(`[...document.querySelectorAll('.gl-train')].map((c) => ({
    id: c.dataset.training, title: c.querySelector('.gl-ask-title').textContent, sub: c.querySelector('.gl-ask-sub').textContent,
    err: c.querySelector('.gl-train-err') ? c.querySelector('.gl-train-err').textContent : '',
    btns: [...c.querySelectorAll('.gl-ask-acts .btn')].filter((b) => !b.hidden).map((b) => b.textContent) }))`);
}
const clickCard = (id, act) => cdpEval(`(() => { const b = document.querySelector('.gl-train[data-training=${JSON.stringify(id)}] [data-act="${act}"]'); if (b) b.click(); return !!b; })()`);
/**
 * The training screen open on `id`, with a suggestion pending: what the user sees — the card of that training (it
 * must not be drawn over its own screen), the banner, how many visible buttons say `word`, and whether anything
 * fixed (the cards' stack) lies over a text of the screen.
 */
async function trainScreenWith(id, word) {
  await cdpEval(`(window.__mia.app.openTrain(${JSON.stringify(id)}), 1)`);
  for (let i = 0; i < 60; i++) {
    const ok = await cdpEval(`window.__mia.state.view === 'train' && !!document.querySelector('#view-train .tr-prop:not([hidden])')`).catch(() => false);
    if (ok) break;
    await sleep(150);
  }
  await sleep(400);
  return cdpEval(`(() => {
    const vis = (n) => { if (!n || !n.isConnected) return false; const r = n.getBoundingClientRect(); const cs = getComputedStyle(n); return r.width > 0.5 && r.height > 0.5 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    // a card of ANOTHER training keeps its place (its « Voir » leads there): only the rest is measured
    const fixed = [...document.querySelectorAll('.gl-stack > *, .gl-side > *')].filter(vis).filter((n) => !n.dataset.training || n.dataset.training === ${JSON.stringify(id)}).map((n) => n.getBoundingClientRect());
    const texts = [...document.querySelectorAll('#view-train *')].filter((n) => vis(n) && [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()));
    const covered = texts.filter((n) => { const r = n.getBoundingClientRect(); return fixed.some((f) => Math.min(f.right, r.right) - Math.max(f.left, r.left) > 1 && Math.min(f.bottom, r.bottom) - Math.max(f.top, r.top) > 1); }).map((n) => n.textContent.trim().slice(0, 40));
    return {
      card: [...document.querySelectorAll('.gl-train[data-training=${JSON.stringify(id)}], .gl-train-chip[data-training=${JSON.stringify(id)}]')].filter(vis).length,
      banner: vis(document.querySelector('#view-train .tr-prop')),
      word: [...document.querySelectorAll('button')].filter(vis).filter((b) => b.textContent.trim() === ${JSON.stringify(word)}).length,
      covered
    };
  })()`);
}
async function leaveTrainScreen() {
  await cdpEval(`(window.__mia.app.goHome(), 1)`);
  for (let i = 0; i < 40; i++) { if (await cdpEval(`window.__mia.state.view === 'home'`).catch(() => false)) break; await sleep(150); }
  await sleep(400);
}
const pillOn = () => cdpEval(`(() => { const p = document.querySelector('.pr-pill'); return !!p && p.classList.contains('on'); })()`);
/** mia_request, answered in the window: « C'est parti » (true) or « Refuser » (false). */
async function answerRequest(mcp, args, accept) {
  const p = mcp.tool('mia_request', args);
  await sleep(700);
  const card = await cdpEval(`(() => { const c = document.querySelector('.gl-ask'); return c ? c.querySelector('.gl-ask-sub').textContent : null; })()`);
  await cdpEval(accept ? `document.querySelector('.gl-ask-acts .btn-primary').click()` : `document.querySelector('.gl-refuse').click()`);
  return { card, answer: await p };
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

async function testTraining(mcp) {
  console.log('· training a LoRA: options, the two doors, the suggestion card, pause, « Mes LoRA », notes (fake tool, no GPU)');
  // what an assistant reads of a finished training whose final LoRA could not be filed (trainer.js finished → filed)
  {
    const { Bridge } = require(path.join(ROOT, 'electron', 'bridge.js'));
    const view = (lang, s) => Bridge.prototype.trainView.call({ engineNow: () => null, lang: () => lang }, { trainingId: 't_x', state: 'fini', loss: { mean100: null }, ...s });
    const filed = { ok: false, code: 'fileFailed', at: 1, message: { fr: 'Le dossier des LoRA est inaccessible.', en: 'The LoRA folder cannot be reached.' } };
    check(view('fr', { filed }).notFiled === 'Le dossier des LoRA est inaccessible.' && view('en', { filed }).notFiled === 'The LoRA folder cannot be reached.'
      && view('fr', { filed: null, lora: { file: 'a.safetensors', step: 10 } }).notFiled === null,
    'mia_train_status: a final LoRA that could not be filed → notFiled says why, in Mia’s language (null once filed)', [view('fr', { filed }).notFiled, view('en', { filed }).notFiled]);
  }
  const opt = await mcp.tool('mia_train_options');
  const fake = (opt.json?.bases || []).find((b) => b.id === 'fake');
  check(!opt.isError && Array.isArray(opt.json?.bases) && opt.json.bases.some((b) => b.id === 'ltx25') && opt.json.disk?.root && 'active' in opt.json,
    'mia_train_options: the trainable models, the disk, the active training', opt.text.slice(0, 300));
  if (!fake) {
    console.log('  SKIP this Mia has no fake training tool (MIA_TRAIN_FAKE=1): the training calls are not tested');
    return;
  }
  const ltx = opt.json.bases.find((b) => b.id === 'ltx25');
  check(fake.ready === true && ltx && ltx.ready === false && typeof ltx.why === 'string' && ltx.why.length > 3 && ltx.lengths?.normal === 2500,
    'the fake model is ready; LTX is refused in this test Mia, with the reason (MIA_NO_GPU)', { fake: fake.ready, ltx: ltx && [ltx.ready, ltx.why] });
  check(path.resolve(opt.json.disk.root).toLowerCase().startsWith(path.resolve(DEV).toLowerCase()) || EXTERNAL, 'the trainings folder of the test Mia is its own', opt.json.disk.root);

  // the image sets: 12 images (9 with a .txt beside them), 12 all captioned, 300 for the big import
  const setA = path.join(DEV, 'train-set-a');
  const setB = path.join(DEV, 'train-set-b');
  const setC = path.join(DEV, 'train-set-c');
  for (const d of [setA, setB, setC]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
  const seed = path.join(DEV, 'train-seed.png');
  makePng(seed, 96, 96);
  const name2 = (i) => `img_${String(i).padStart(2, '0')}`;
  for (let i = 1; i <= 12; i++) {
    fs.copyFileSync(seed, path.join(setA, `${name2(i)}.png`));
    if (i <= 9) fs.writeFileSync(path.join(setA, `${name2(i)}.txt`), `a woman by a window, take ${i}`);
    fs.copyFileSync(seed, path.join(setB, `${name2(i)}.png`));
    fs.writeFileSync(path.join(setB, `${name2(i)}.txt`), `a street at night, take ${i}`);
  }
  const big = [];
  for (let i = 1; i <= 301; i++) { const f = path.join(setC, `big_${String(i).padStart(3, '0')}.png`); fs.copyFileSync(seed, f); big.push(f); }
  const txt1 = fs.readFileSync(path.join(setA, 'img_01.txt'), 'utf8');

  // a reused test Mia: suggestions left by an earlier run would add their cards to the ones counted below
  await cdpEval(`window.mia.train.list().then((l) => Promise.all(l.filter((x) => x.proposal).map((x) => window.mia.train.update(x.id, { proposal: null }))).then(() => 1))`).catch(() => null);

  // ── case 27 (first half): no green light, nothing that prepares or acts goes through
  await askGo(true);
  const refused = await answerRequest(mcp, { title: 'Entraîner un LoRA de test', training: true }, false);
  check(/Il prépare un entraînement de LoRA\. Tu le lanceras toi-même ensuite\./.test(refused.card || '') && !/à cocher/.test(refused.card || '') && !/modifier ta planche/.test(refused.card || ''),
    'mia_request {training:true}: the card says a training is being prepared and that the user will start it', refused.card);
  check(refused.answer.json?.state === 'declined', '… declined', refused.answer.text.slice(0, 120));
  const noGo = await mcp.tool('mia_train_prepare', { name: 'Rosa test', base: 'fake', trigger: 'rsa woman', folder: setA });
  check(noGo.isError && /mia_request/.test(noGo.text), 'no green light: mia_train_prepare is refused', noGo.text.slice(0, 140));
  const noGo2 = await mcp.tool('mia_train_start', { trainingId: 't_inconnu' });
  const noGo3 = await mcp.tool('mia_train_control', { trainingId: 't_inconnu', action: 'pause' });
  check(noGo2.isError && /mia_request/.test(noGo2.text) && noGo3.isError && /mia_request/.test(noGo3.text), 'no green light: mia_train_start and mia_train_control are refused', [noGo2.text.slice(0, 80), noGo3.text.slice(0, 80)]);
  const list0 = await cdpEval('window.mia.train.list().then((l) => l.length)');
  check(list0 === 0 || EXTERNAL, 'nothing was created', list0);

  // ── case 28: request(training) → prepare → start → awaitingUser → « Lancer »
  const okGo = await answerRequest(mcp, { title: 'Entraîner un LoRA de test', summary: '12 images, modèle de test.', training: true }, true);
  check(okGo.answer.json?.state === 'accepted' && /mia_train_prepare/.test(okGo.answer.json?.note || ''), '« C’est parti » → accepted; the note says what comes next', okGo.answer.text.slice(0, 200));

  const relPath = await mcp.tool('mia_train_prepare', { name: 'X', base: 'fake', trigger: 'x', images: ['relatif\\a.png'] });
  check(relPath.isError && /absolu/i.test(relPath.text), 'mia_train_prepare refuses a relative path', relPath.text.slice(0, 120));
  const noBase = await mcp.tool('mia_train_prepare', { name: 'X', base: 'nope', trigger: 'x', folder: setA });
  check(noBase.isError && /fake/.test(noBase.text), 'an unknown model → an error listing the models', noBase.text.slice(0, 160));
  const notReady = await mcp.tool('mia_train_prepare', { name: 'X', base: 'ltx25', trigger: 'x', folder: setA });
  check(notReady.isError && /LTX 2\.5/.test(notReady.text), 'a model that cannot be trained here → an error with the reason, no draft', notReady.text.slice(0, 200));

  const prepA = await mcp.tool('mia_train_prepare', { name: 'Rosa test', base: 'fake', trigger: 'rsa woman', folder: setA,
    captions: [{ file: 'img_10.png', text: 'seated by a window, soft light' }, { file: 'absente.png', text: 'x' }], steps: 600, advanced: { saveEvery: 50, sampleEvery: 150 } });
  const A = prepA.json?.trainingId;
  const dsA = prepA.json?.dataset || {};
  check(!prepA.isError && /^t_/.test(A || '') && prepA.json.state === 'pret' && prepA.json.importing === false && dsA.count === 12 && dsA.captioned === 10,
    'mia_train_prepare: a draft with 12 images, 10 captions (9 files + 1 written)', prepA.text.slice(0, 400));
  check((dsA.missing || []).join() === 'img_11.png,img_12.png' && prepA.json?.ready === false && /2 images sans légende/.test(prepA.json?.why || ''),
    '… the images without a caption by their original names; ready:false says why', { missing: dsA.missing, why: prepA.json?.why });
  check((prepA.json?.notes || []).some((n) => /absente\.png/.test(n)), '… a caption for an image that is not in the set is reported', prepA.json?.notes);
  const dirA = prepA.json?.dir;
  const docA = () => readJson(path.join(dirA || '', 'train.json'));
  const dataA = readJson(path.join(dirA || '', 'dataset', 'dataset.json')) || [];
  check(docA()?.by?.who === 'Claude' && dataA.find((e) => e.original === 'img_10.png')?.captionBy === 'Claude' && dataA.find((e) => e.original === 'img_01.png')?.captionBy === 'file',
    'the draft and the caption are signed « Claude » (PRÉPARÉ PAR, ÉCRITE PAR)', docA()?.by);
  check(!fs.existsSync(path.join(setA, 'img_10.txt')) && fs.readFileSync(path.join(setA, 'img_01.txt'), 'utf8') === txt1 && fs.readdirSync(setA).length === 21,
    'the original folder is untouched (no caption written beside the images)', fs.readdirSync(setA).length);

  const early = await mcp.tool('mia_train_start', { trainingId: A });
  check(early.isError && /2 images sans légende/.test(early.text) && !docA()?.proposal, 'mia_train_start on a draft that is not ready → the reason, no suggestion', early.text.slice(0, 200));

  const fillA = await mcp.tool('mia_train_prepare', { trainingId: A, captions: [{ file: 'img_11.png', text: 'standing in a garden' }, { file: 'img_12.png', text: 'profile, evening light' }] });
  check(!fillA.isError && fillA.json?.trainingId === A && fillA.json.ready === true && fillA.json.dataset?.captioned === 12 && fillA.json.steps === 600 && fillA.json.estimate && 'seconds' in fillA.json.estimate,
    'mia_train_prepare {trainingId, captions} completes the draft: ready, with an estimate', fillA.text.slice(0, 300));
  // no step yet: the 100-step mean is unknown, not a loss of zero
  const stDraft = await mcp.tool('mia_train_status', { trainingId: A });
  check(!stDraft.isError && stDraft.json?.loss && stDraft.json.loss.mean100 === null && stDraft.json.loss.last === null && stDraft.json.loss.trend === null && stDraft.json.pace?.sPerStep !== 0,
    'mia_train_status on a draft: loss.mean100, last and trend are null (never 0), no pace of 0', stDraft.json && [stDraft.json.loss, stDraft.json.pace]);

  const propA = await mcp.tool('mia_train_start', { trainingId: A });
  check(!propA.isError && propA.json?.awaitingUser === true && !propA.json?.started && docA()?.state === 'pret' && docA()?.proposal?.by === 'Claude',
    'mia_train_start only suggests: awaitingUser, nothing started, the suggestion is in train.json', propA.text.slice(0, 200));
  await sleep(500);
  // mia_train_prepare brought the screen on A (presence.js, showTraining): the suggestion is on its banner there
  const where = await cdpEval(`[window.__mia.state.view, (document.getElementById('view-train') || {}).dataset?.training || '']`).catch(() => null);
  check(Array.isArray(where) && where[0] === 'train' && where[1] === A && (await trainCards())?.length === 0,
    'the assistant’s draft is on screen: no card over its own screen', where);
  // the screen of that training open: no card over it (the banner says the same), one « Lancer », nothing covered
  const onA = await trainScreenWith(A, 'Lancer');
  check(onA && onA.card === 0 && onA.banner === true && onA.word === 1 && onA.covered.length === 0,
    'on the training’s own screen: no suggestion card over it, the banner alone carries « Lancer », nothing hidden', onA);
  await leaveTrainScreen();
  let cards = await trainCards();
  check(cards?.length === 1 && cards[0].id === A && cards[0].title === 'Claude propose un entraînement' && /Rosa test · Faux modèle \(test\) · 600 pas/.test(cards[0].sub)
    && cards[0].btns.slice(-3).join('|') === 'Refuser|Plus tard|Lancer', 'away from its screen, the card « Claude propose un entraînement »: name, model, steps; Refuser, Plus tard, Lancer', cards);
  check(cards?.length === 1 && cards[0].id === A, '… back home: the card is there again', cards);
  let pend = await mcp.tool('mia_pending');
  const stA = await mcp.tool('mia_train_status', { trainingId: A });
  check(pend.json?.training?.trainingId === A && pend.json.training.state === 'waiting' && stA.json?.proposal?.state === 'waiting', 'mia_pending → training waiting', pend.json?.training);

  // any change to the draft cancels the suggestion (here the user's own change; it also sets the fake tool's pace)
  await cdpEval(`window.mia.train.update(${JSON.stringify(A)}, { settings: { fake: { msPerStep: 40, sampleMs: 300, encodeMs: 200, loadMs: 200 } } }).then((r) => r.ok)`);
  await sleep(500);
  cards = await trainCards();
  pend = await mcp.tool('mia_pending');
  check(cards?.length === 0 && pend.json?.training?.state === 'changed' && !docA()?.proposal, 'the draft changed after the suggestion: the card leaves, mia_pending says « changed »', { cards, t: pend.json?.training });

  // a second draft, suggested too; and the big set (case 30)
  const prepB = await mcp.tool('mia_train_prepare', { name: 'Lena test', base: 'fake', trigger: 'lna style', kind: 'style', folder: setB, steps: 40, advanced: { saveEvery: 20, sampleEvery: 0 } });
  const B = prepB.json?.trainingId;
  check(!prepB.isError && B && B !== A && prepB.json.ready === true && prepB.json.dataset?.captioned === 12, 'a second draft (captions read from the .txt files)', prepB.text.slice(0, 200));
  await cdpEval(`window.mia.train.update(${JSON.stringify(B)}, { settings: { fake: { msPerStep: 40, encodeMs: 100, loadMs: 100 } } }).then((r) => r.ok)`);
  const tooMany = await mcp.tool('mia_train_prepare', { name: 'Gros jeu', base: 'fake', trigger: 'big', images: big });
  check(tooMany.isError && /300 fichiers au plus/.test(tooMany.text), '301 images in one call → refused (300 at most)', tooMany.text.slice(0, 120));
  const t300 = Date.now();
  const prepC = await mcp.tool('mia_train_prepare', { name: 'Gros jeu', base: 'fake', trigger: 'big', images: big.slice(0, 300) }, 160000);
  check(!prepC.isError && prepC.json?.dataset?.count === 300 && prepC.json.importing === false && prepC.json.dataset.missing.length === 300,
    `mia_train_prepare with 300 images (${Math.round((Date.now() - t300) / 1000)} s): imported, no 60 s cut`, prepC.text.slice(0, 200));

  const propB = await mcp.tool('mia_train_start', { trainingId: B });
  const propA2 = await mcp.tool('mia_train_start', { trainingId: A });
  await sleep(500);
  cards = await trainCards();
  check(!propB.isError && !propA2.isError && cards?.length === 2 && cards.map((c) => c.id).sort().join() === [A, B].sort().join(), 'two suggestions: two cards', cards);
  const shot = await mcp.tool('mia_snapshot');
  const img = shot.content.find((c) => c.type === 'image');
  if (img) {
    const f = path.join(DEV, 'snapshot-train-cards.png');
    fs.writeFileSync(f, Buffer.from(img.data, 'base64'));
    console.log('  snapshot →', f);
  }

  // « Plus tard » folds a card into a chip; a reload rebuilds everything from train.json (case 17)
  await clickCard(A, 'later');
  const chip = await cdpEval(`(() => { const c = document.querySelector('.gl-train-chip'); const t = c && c.textContent; if (c) c.click(); return t; })()`);
  check(/Claude propose un entraînement/.test(chip || '') && (await trainCards())?.length === 2, '« Plus tard » leaves a chip; a click brings the card back', chip);
  await cdpEval('setTimeout(() => location.reload(), 50)');
  await sleep(1500);
  for (let i = 0; i < 80; i++) {
    cards = await trainCards().catch(() => null);
    if (cards && cards.length === 2) break;
    await sleep(250);
  }
  check(cards?.length === 2 && cards.some((c) => c.id === A && /600 pas/.test(c.sub)) && cards.some((c) => c.id === B && /Lena test/.test(c.sub)),
    'after a reload of the window the two cards are back, as they were', cards);

  // the user's click starts it (door 2)
  await clickCard(A, 'start');
  await sleep(600);
  cards = await trainCards();
  check(['attente', 'preparation', 'entrainement'].includes(docA()?.state) && docA()?.startedBy === 'user' && docA()?.proposedBy === 'Claude' && cards?.length === 1 && cards[0].id === B,
    '« Lancer »: the training starts — suggested by Claude, started by the user', { state: docA()?.state, by: docA()?.startedBy, cards });
  // case 29: the click on another card while a training runs is refused, with the reason; the card stays
  await clickCard(B, 'start');
  await sleep(600);
  cards = await trainCards();
  check(cards?.length === 1 && cards[0].id === B && /Un autre entraînement est en cours/.test(cards[0].err) && readJson(path.join(prepB.json.dir, 'train.json'))?.state === 'pret',
    '« Lancer » on a second card while a training runs: refused with the reason, the card stays', cards);

  // the reload took the green light away (it is kept in the window): ask again, as an assistant would hours later
  const lost = await mcp.tool('mia_train_control', { trainingId: A, action: 'pause' });
  check(lost.isError && /mia_request/.test(lost.text), 'a green light that ended: mia_train_control asks for mia_request again', lost.text.slice(0, 100));
  const again = await answerRequest(mcp, { title: 'Suivre l’entraînement', training: true }, true);
  check(again.answer.json?.state === 'accepted', 'green light again', again.answer.text.slice(0, 100));
  const busy = await mcp.tool('mia_train_start', { trainingId: B });
  check(busy.isError && /Un entraînement est déjà en cours : « Rosa test » \(pas [\d\s  ]+ \/ 600\)/.test(busy.text), 'mia_train_start while a training runs → « Un entraînement est déjà en cours : « Rosa test » (pas n / 600) »', busy.text);
  pend = await mcp.tool('mia_pending');
  check(pend.json?.training?.trainingId === A && pend.json.training.state === 'started', 'mia_pending → training started', pend.json?.training);
  const mst = await mcp.tool('mia_status');
  check(mst.json?.training?.trainingId === A && mst.json.training.steps === 600, 'mia_status → training (the active one)', mst.json?.training);

  // following it: wait for a sample, read, note, control
  const smp = await mcp.tool('mia_train_wait', { trainingId: A, until: 'sample', timeoutS: 60 }, 95000);
  const s0 = smp.json?.samples?.[smp.json.samples.length - 1];
  check(!smp.isError && smp.json?.reached === true && s0 && path.isAbsolute(s0.file) && fs.existsSync(s0.file) && smp.json.step >= 150,
    'mia_train_wait {until:sample} → the sample file (absolute path, on disk)', smp.text.slice(0, 300));
  const live = await mcp.tool('mia_train_status');
  check(!live.isError && live.json?.trainingId === A && ['entrainement', 'essai'].includes(live.json.state) && typeof live.json.loss?.last === 'number' && live.json.checkpoints?.length >= 1
    && path.isAbsolute(live.json.checkpoints[0].file) && Array.isArray(live.json.logTail) && live.json.dir === dirA && !('curve' in live.json),
    'mia_train_status without an id → the active training: step, loss, checkpoints, log', live.text.slice(0, 300));
  check(docA()?.lastWatch?.by === 'Claude', 'reading notes who is watching (« CLAUDE REGARDE »)', docA()?.lastWatch);
  const note1 = await mcp.tool('mia_train_note', { trainingId: A, text: 'Visage stable sur le premier essai.' });
  const note2 = await mcp.tool('mia_train_note', { trainingId: A, text: 'Encore une.' });
  check(!note1.isError && note1.json?.noted === true && docA()?.notes?.some((n) => n.by === 'Claude' && /Visage stable/.test(n.text)) && note2.isError && /Une note par minute/.test(note2.text),
    'mia_train_note: a signed note; a second one within the minute is refused', [note1.text.slice(0, 100), note2.text]);
  const badAct = await mcp.tool('mia_train_control', { trainingId: A, action: 'resume' });
  const badAct2 = await mcp.tool('mia_train_control', { trainingId: A, action: 'stop' });
  check(badAct.isError && /mia_train_start \{resume:true\}/.test(badAct.text) && badAct2.isError && ['entrainement', 'essai'].includes(docA()?.state),
    'mia_train_control {action: resume | stop} is refused: neither resume nor stop through this tool', [badAct.text.slice(0, 160), badAct2.text.slice(0, 60)]);
  const pause = await mcp.tool('mia_train_control', { trainingId: A, action: 'pause' });
  const paused = await mcp.tool('mia_train_wait', { trainingId: A, until: 'end', timeoutS: 60 }, 95000);
  check(!pause.isError && pause.json?.pending === 'pause' && paused.json?.reached === true && paused.json.state === 'pause' && paused.json.pause === 'user' && paused.json.step < 600,
    'mia_train_control pause → a checkpoint, then « pause » (does not resume by itself)', [pause.text.slice(0, 120), paused.json && [paused.json.state, paused.json.pause, paused.json.step]]);
  check(docA()?.notes?.some((n) => n.act === 'pause' && n.by === 'Claude'), 'the pause is a signed line of the events', (docA()?.notes || []).slice(-3));
  const add = await mcp.tool('mia_train_control', { trainingId: A, action: 'add_to_loras' });
  check(!add.isError && add.json?.file && fs.existsSync(add.json.file) && /^mia\\/.test(add.json.comfyName || '') && fs.existsSync(add.json.file.replace(/\.safetensors$/, '.mia.json'))
    && (EXTERNAL || path.resolve(add.json.file).toLowerCase().startsWith(path.resolve(USERDATA).toLowerCase())),
    'mia_train_control add_to_loras → the checkpoint and its card, in the test Mia’s own LoRA folder', add.text.slice(0, 300));

  // resuming is a suggestion too
  const resume = await mcp.tool('mia_train_start', { trainingId: A, resume: true });
  await sleep(500);
  cards = await trainCards();
  const cardA = (cards || []).find((c) => c.id === A);
  check(!resume.isError && resume.json?.awaitingUser === true && docA()?.state === 'pause' && cardA && /^Claude propose de reprendre Rosa test au pas \d/.test(cardA.title) && cardA.btns[cardA.btns.length - 1] === 'Reprendre',
    'mia_train_start {resume:true} → the card « Claude propose de reprendre Rosa test au pas n », nothing resumed', cardA || resume.text);
  // on the paused instrument: no card over ÉVÈNEMENTS — « Reprendre » twice (the banner, the foot), not three times
  const onPause = await trainScreenWith(A, 'Reprendre');
  check(onPause && onPause.card === 0 && onPause.banner === true && onPause.word === 2 && onPause.covered.length === 0,
    'the paused instrument with a resume suggested: no card over ÉVÈNEMENTS, « Reprendre » in the banner and the foot only', onPause);
  await leaveTrainScreen();
  await clickCard(A, 'start');
  const end = await mcp.tool('mia_train_wait', { trainingId: A, until: 'end', timeoutS: 90 }, 125000);
  check(!end.isError && end.json?.reached === true && end.json.state === 'fini' && end.json.step === 600 && end.json.lora?.file && fs.existsSync(end.json.lora.file) && end.json.lora.trigger === 'rsa woman',
    '« Reprendre » → it goes on to the end; mia_train_status gives lora {file, comfyName, trigger}', end.json && [end.json.state, end.json.step, end.json.lora]);
  const late = await mcp.tool('mia_train_wait', { trainingId: A, until: 'sample', timeoutS: 30 });
  check(!late.isError && late.json?.ended === true && late.json.reached === false && !late.json.timedOut, 'mia_train_wait for a sample of a training that ended → ended:true at once', late.json && [late.json.ended, late.json.reached]);
  const noWait = await mcp.tool('mia_train_wait', { trainingId: B, until: 'checkpoint', timeoutS: 1 });
  check(!noWait.isError && noWait.json?.timedOut === true && /mia_train_wait/.test(noWait.json.hint || ''), 'mia_train_wait on a draft → timedOut with a hint', noWait.text.slice(-200));

  // « Refuser »
  await clickCard(B, 'decline');
  await sleep(500);
  const stB = await mcp.tool('mia_train_status', { trainingId: B });
  check((await trainCards())?.length === 0 && stB.json?.proposal?.state === 'declined' && stB.json.state === 'pret', '« Refuser »: the card leaves, the assistant reads « declined », nothing started', stB.json?.proposal);

  // ── case 27 (second half): without a green light, reading and noting pass and light nothing in the title bar
  const closed = await answerRequest(mcp, { title: 'Autre chose', training: true }, false);
  check(closed.answer.json?.state === 'declined', 'the green light is taken back (a new request, declined)', closed.answer.text.slice(0, 80));
  const noAdd = await mcp.tool('mia_train_control', { trainingId: A, action: 'add_to_loras', step: 50 });
  check(noAdd.isError && /mia_request/.test(noAdd.text), 'no green light: mia_train_control is refused', noAdd.text.slice(0, 80));
  await sleep(9600);                                   // the title bar pill of the calls above has faded
  const pill0 = await pillOn();
  const r1 = await mcp.tool('mia_train_options');
  const r2 = await mcp.tool('mia_train_status', { trainingId: A });
  const r3 = await mcp.tool('mia_train_wait', { trainingId: A, until: 'end', timeoutS: 2 });
  const pill1 = await pillOn();
  check(!r1.isError && !r2.isError && r2.json?.state === 'fini' && !r3.isError && r3.json?.reached === true && pill0 === false && pill1 === false,
    'no green light: options, status and wait pass, and the « pilote Mia » pill stays off', { pill0, pill1, r3: r3.text.slice(0, 80) });
  const freeNote = await mcp.tool('mia_train_note', { trainingId: B, text: 'Note sans feu vert.' });
  check(!freeNote.isError && freeNote.json?.noted === true && (await pillOn()) === true, 'mia_train_note needs no green light (and, as a gesture, lights the pill)', freeNote.text.slice(0, 100));

  // « Demander mon feu vert » off: mia_train_start starts at once, signed by the assistant
  await askGo(false);
  const direct = await mcp.tool('mia_train_start', { trainingId: B });
  const endB = await mcp.tool('mia_train_wait', { trainingId: B, until: 'end', timeoutS: 60 }, 95000);
  check(!direct.isError && direct.json?.started === true && !direct.json.awaitingUser && endB.json?.state === 'fini' && endB.json.startedBy === 'Claude' && (await trainCards())?.length === 0,
    'setting off: mia_train_start starts it (« LANCÉ PAR CLAUDE »), no card', [direct.text.slice(0, 120), endB.json && [endB.json.state, endB.json.startedBy]]);
  const after = await mcp.tool('mia_status');
  check(after.json?.training === null, 'mia_status → training null once nothing runs', after.json?.training);
}

// Several assistants at once (SPEC §13.5) and what is open in Mia (tabs, selection, blocks in view).
async function testParallel(mcp, image) {
  console.log('· several workers at once (as), what is open');
  const made = await mcp.tool('mia_create_project', { name: `Parallèle ${STAMP}` });
  const pid = made.json?.boardId;
  check(!made.isError && pid, 'a board for the workers', made.text.slice(0, 200));
  await sleep(4600);                                   // the plain cursor has faded: only the workers count below
  const lane = async (as) => {
    const t0 = Date.now();
    const im = await mcp.tool('mia_import_media', { paths: [image], as });
    const src = im.json?.blocks?.[0]?.nodeId;
    const dep = await mcp.tool('mia_add_block', { type: 'depth', near: src, as });
    const wire = await mcp.tool('mia_connect', { from: { node: src }, to: { node: dep.json?.nodeId }, as });
    const said = await mcp.tool('mia_say', { text: `Plan ${as} prêt.`, as });
    return { ms: Date.now() - t0, errors: [im, dep, wire, said].filter((r) => r.isError).map((r) => r.text.slice(0, 160)), y: im.json?.blocks?.[0]?.y };
  };
  const t0 = Date.now();
  const seen = (async () => { await sleep(1200); return cdpEval(`[...document.querySelectorAll('.pr-cursor.on')].map((c) => (c.dataset.c || '0') + ' ' + c.querySelector('.pr-label').textContent)`); })();
  const res = await Promise.all([lane(1), lane(2), lane('Plan 03')]);
  const total = Date.now() - t0;
  const live = await seen;
  check(res.every((r) => !r.errors.length), 'three workers: every action succeeded', res.map((r) => r.errors));
  check(total < res.reduce((a, r) => a + r.ms, 0) * 0.6, 'three workers act at the same time', { total, each: res.map((r) => r.ms) });
  check(Array.isArray(live) && live.length === 3 && new Set(live.map((x) => x.split(' ')[0])).size === 3
    && live.includes('1 Claude 1') && live.includes('2 Claude 2') && live.some((x) => /^[3-8] Claude · Plan 03$/.test(x)), 'three cursors, three colours, named « Claude 1 », « Claude 2 », « Claude · Plan 03 »', live);
  check(new Set(res.map((r) => r.y)).size === 3, 'each worker opens a row of its own', res.map((r) => r.y));
  const ui = await cdpEval(`(() => { const ed = window.__mia.editor; const g = ed.getGraph();
    const b = g.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: ed.nodeEl(n.id).offsetHeight }));
    const hits = []; for (const a of b) for (const c of b) if (a.id < c.id && a.x < c.x + c.w && a.x + a.w > c.x && a.y < c.y + c.h && a.y + a.h > c.y) hits.push(a.id + '/' + c.id);
    return { nodes: g.nodes.length, edges: g.edges.length, hits, pill: document.querySelector('.pr-pill-txt').textContent,
      chips: [...document.querySelectorAll('.pr-chip:not([hidden])')].map((c) => c.textContent),
      bubbles: document.querySelectorAll('.pr-bubble.on').length }; })()`);
  check(ui && ui.nodes === 6 && ui.edges === 3 && ui.hits.length === 0, '6 blocks, 3 wires, none on top of another', ui);
  check(ui && /^3 Claude /.test(ui.pill) && ui.chips.join('|') === '1|2|Plan 03' && ui.bubbles === 3, 'title bar: « 3 Claude pilotent Mia », a chip each; three bubbles', ui);

  // the user picks who the camera follows (a click on a chip)
  await cdpEval(`document.querySelector('.pr-chip[data-c="2"]').click()`);
  await sleep(700);
  const cam0 = await cdpEval('JSON.stringify(window.__mia.editor.camera())');
  const far1 = await mcp.tool('mia_add_block', { type: 'depth', at: { x: 9000, y: 9000 }, as: 1 });
  const cam1 = await cdpEval('JSON.stringify(window.__mia.editor.camera())');
  check(!far1.isError && cam0 === cam1, 'camera on worker 2: a far action of worker 1 does not move it', [cam0, cam1]);
  const far2 = await mcp.tool('mia_add_block', { type: 'depth', at: { x: -9000, y: 9000 }, as: 2 });
  const cam2 = await cdpEval('JSON.stringify(window.__mia.editor.camera())');
  check(!far2.isError && cam2 !== cam1, 'camera on worker 2: its own far action moves it', [cam1, cam2]);
  await cdpEval(`document.querySelector('.pr-chip[data-c="2"]').click()`);
  const bad = await mcp.tool('mia_add_block', { type: 'depth', as: { n: 1 } });
  check(bad.isError && /as/.test(bad.text), '« as » must be a number or a short text', bad.text.slice(0, 160));

  // what is open: tabs in mia_status and mia_list_projects, selection and blocks in view in mia_get_board
  const st = await mcp.tool('mia_status');
  const tabs = st.json?.mia?.tabs || [];
  check(!st.isError && tabs.length >= 2 && tabs.filter((t) => t.active).length === 1 && tabs.find((t) => t.active)?.id === pid, 'mia_status: the open tabs, the one on screen', tabs);
  const pr = await mcp.tool('mia_list_projects');
  const boards = pr.json?.boards || [];
  check(!pr.isError && boards.filter((b) => b.active).map((b) => b.id).join() === pid && boards.filter((b) => b.open).length === tabs.length, 'mia_list_projects: open and active boards', boards.filter((b) => b.open).map((b) => b.id));
  await cdpEval(`(() => { const ed = window.__mia.editor; ed.select([${JSON.stringify(far2.json?.nodeId)}]); })()`);
  const gb = await mcp.tool('mia_get_board');
  check(!gb.isError && gb.json?.selection?.[0] === far2.json?.nodeId && Array.isArray(gb.json?.inView) && gb.json.inView.includes(far2.json?.nodeId) && !gb.json.inView.includes(far1.json?.nodeId)
    && Array.isArray(gb.json?.tabs), 'mia_get_board: selection, blocks in view, tabs', { sel: gb.json?.selection, inView: gb.json?.inView });

  // a worker opens another board: the one that was at work here comes back to its own board by itself
  const other = tabs.find((t) => !t.active)?.id;
  const sw = await mcp.tool('mia_open_project', { id: other, as: 2 });
  const back = await mcp.tool('mia_add_block', { type: 'depth', as: 1 });
  const st2 = await mcp.tool('mia_status');
  const gb2 = await mcp.tool('mia_get_board');
  check(!sw.isError && !back.isError && st2.json?.mia?.board?.id === pid && (gb2.json?.blocks || []).some((b) => b.id === back.json?.nodeId),
    'another worker changed the board: worker 1 goes back to its own before acting', { sw: sw.text.slice(0, 80), back: back.text.slice(0, 120), board: st2.json?.mia?.board });
}

async function testCloudModes(mcp, image) {
  console.log('· online Model blocks: mode, tier, notes, prompt tokens; LTX passes; a cp1252 body');
  const created = await mcp.tool('mia_create_project', { name: `Modes en ligne ${STAMP}` });
  check(!created.isError && created.json?.boardId, 'a board for the online modes', created.text);

  const cat = await mcp.tool('mia_catalog', { type: 'gen' });
  const gen = cat.json?.types?.[0];
  const k4 = (gen?.params || []).find((p) => p.id === 'model')?.choices?.find((c) => c.value === 'hf:kling-4-0');
  const edit = k4?.ways?.find((w) => /video-edit/.test(w.workflow));
  check(edit && Array.isArray(edit.settings) && edit.settings.some((s) => s.id === 'hf.duration' && s.min === 3 && s.max === 30)
    && edit.minSeconds?.video === 3 && edit.cite?.videoFrom === 2 && edit.price && Array.isArray(edit.notes) && edit.durationFromSource === 'video',
  'mia_catalog: Kling 4.0 « Modifier » with its own settings, minSeconds, cite, price, notes', edit);
  const k3 = (gen?.params || []).find((p) => p.id === 'model')?.choices?.find((c) => c.value === 'hf:kling-3-0');
  const k3i = k3?.ways?.find((w) => /image-to-video/.test(w.workflow));
  check(k3i?.settings?.some((s) => s.id === 'hf.sound' && Array.isArray(s.onlyTiers) && !s.onlyTiers.includes('turbo')) && k3i.portTiers?.end
    && k3i.promptRequiredTiers?.includes('turbo'), 'mia_catalog: Kling 3.0 tiers (onlyTiers, portTiers, promptRequiredTiers)', k3i);
  check(typeof gen?.howItWorks === 'string' && /params\.workflow/.test(gen.howItWorks) && /@video_2/.test(gen.howItWorks), 'howItWorks explains the online mode and the prompt tokens');

  const add = await mcp.tool('mia_add_block', { type: 'gen', params: { model: 'hf:kling-4-0' }, title: 'Kling test' });
  const k = add.json?.nodeId;
  check(!add.isError && k, 'mia_add_block gen hf:kling-4-0', add.text.slice(0, 300));
  check(add.json && !('lora' in (add.json.params || {})) && 'hf.duration' in (add.json.params || {}), 'add_block answers the online settings of its mode (hf.* defaults, no local lora)', add.json?.params);

  const forced = await mcp.tool('mia_set_params', { nodeId: k, params: { workflow: 'Animer une image' } });
  check(!forced.isError && forced.json?.params?.workflow === 'kling-video/v4.0/image-to-video' && /chosen/.test(forced.json?.model?.mode || '')
    && (forced.json?.model?.connect || []).includes('start'), 'set_params workflow by its label → mode chosen, says what it lacks', forced.text.slice(0, 500));
  check(forced.json && !('lora' in forced.json.params) && !('negative' in forced.json.params), 'set_params answers only the settings the block shows', forced.json?.params);

  const imp = await mcp.tool('mia_import_media', { paths: [image] });
  const img = imp.json?.blocks?.[0]?.nodeId;
  await mcp.tool('mia_set_params', { nodeId: k, params: { workflow: 'kling-video/v4.0/text-to-video' } });
  const w = await mcp.tool('mia_connect', { from: { node: img }, to: { node: k, port: 'start' } });
  check(!w.isError && w.json?.ignored === true && /image-to-video/.test(w.json?.note || ''), 'mia_connect into an input the chosen mode ignores → ignored:true + the mode that uses it', w.text);
  const k3t = (await mcp.tool('mia_add_block', { type: 'gen', params: { model: 'hf:kling-3-0', 'hf.tier': 'turbo' } })).json?.nodeId;
  await mcp.tool('mia_connect', { from: { node: img }, to: { node: k3t, port: 'start' } });
  const k3end = await mcp.tool('mia_connect', { from: { node: img }, to: { node: k3t, port: 'end' } });
  check(!k3end.isError && k3end.json?.ignored === true && /Turbo/.test(k3end.json?.note || '') && /hf\.tier/.test(k3end.json?.note || ''),
    'Kling 3.0 Turbo + end image: ignored because of the tier (not the mode), with the tier to pick', k3end.text);
  const auto = await mcp.tool('mia_set_params', { nodeId: k, params: { workflow: 'auto' } });
  check(!auto.isError && auto.json?.params?.workflow === '' && /auto/.test(auto.json?.model?.mode || '') && /image-to-video/.test(auto.json?.model?.workflow || ''),
    'workflow "auto" → back to the wires (start image → Animer)', auto.text.slice(0, 400));
  const bd = await mcp.tool('mia_get_board');
  const kb = (bd.json?.blocks || []).find((x) => x.id === k);
  check(kb?.model?.accepts?.includes('start') && kb.model.price && Array.isArray(kb.model.modes) && kb.model.modes.length === 4,
    'get_board: model.accepts, price, modes', kb?.model);

  const omni = await mcp.tool('mia_add_block', { type: 'gen', params: { model: 'hf:kling-omni', workflow: 'kling-video/omni/first-last-frame' } });
  const o = omni.json?.nodeId;
  const d7 = await mcp.tool('mia_set_params', { nodeId: o, params: { 'hf.duration': 7 } });
  check(!d7.isError && (d7.json?.notes || []).some((n) => /hf\.duration/.test(n)), 'Kling Omni: 7 s outside « Animer » is kept, with a note (no more first-wins refusal)', d7.text.slice(0, 400));
  const bad = await mcp.tool('mia_set_params', { nodeId: o, params: { 'hf.duration': 99 } });
  check(bad.isError, 'a value no mode allows is still refused', bad.text.slice(0, 200));

  const k3b = await mcp.tool('mia_add_block', { type: 'gen', params: { model: 'hf:kling-3-0' } });
  const t3 = await mcp.tool('mia_set_params', { nodeId: k3b.json?.nodeId, params: { 'hf.tier': 'turbo', 'hf.sound': true } });
  check(!t3.isError && (t3.json?.notes || []).some((n) => /hf\.sound/.test(n) && /turbo/.test(n)) && !('hf.sound' in (t3.json?.params || {})),
    'Kling 3.0 Turbo: sound kept with a tier note, not shown', t3.text.slice(0, 400));

  const ltx = await mcp.tool('mia_add_block', { type: 'gen', params: { model: 'fam:ltx' } });
  const ps = await mcp.tool('mia_set_params', { nodeId: ltx.json?.nodeId, params: { passes: '2 passes' } });
  check(!ps.isError && ps.json?.params?.passes === '2', 'LTX passes by its label « 2 passes » → "2"', ps.text.slice(0, 300));

  // a body in the Windows console code page (cp1252): « — » is byte 0x97, « é » 0xE9
  try {
    const info = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
    const title = 'Wan 3.0 — drone épique';
    const json = JSON.stringify({ method: 'rename_block', params: { nodeId: k, title }, client: 'test' });
    const bytes = Buffer.from([...json].map((ch) => (ch === '—' ? 0x97 : ch.charCodeAt(0))));
    const res = await new Promise((resolve, reject) => {
      const req = require('node:http').request({ host: '127.0.0.1', port: info.port, path: '/call', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length, Authorization: `Bearer ${info.token}` } }, (r) => {
        const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.end(bytes);
    });
    const got = JSON.stringify(res);
    check(got.includes(title) && !got.includes('�'), 'a cp1252 body is read back as windows-1252 (no « � » in the title)', got.slice(0, 300));
  } catch (e) { check(false, 'cp1252 body', String(e && e.message)); }
}

// ---------------------------------------------------------------- projects (folders) of boards, SPEC §18
async function testFolders(mcp, firstBoard) {
  console.log('· projects (folders) and boards');
  const hasApi = await cdpEval('!!(window.mia && window.mia.folders && typeof window.mia.folders.list === "function")').catch(() => false);
  if (!hasApi) {
    console.log('  SKIP this Mia has no mia.folders yet (preload without SPEC §18.2): projects not tested');
    const noApi = await mcp.tool('mia_create_folder', { name: `Projet test ${STAMP}` });
    check(noApi.isError && /projets/.test(noApi.text), 'mia_create_folder on a Mia without projects → French error', noApi.text);
    return;
  }
  const P1 = `Pont test ${STAMP}`;
  const P2 = `Pont test bis ${STAMP}`;

  const f1 = await mcp.tool('mia_create_folder', { name: P1, color: 'teal' });
  const fid = f1.json?.folderId;
  check(!f1.isError && /^f_/.test(fid || '') && f1.json.existed === false, 'mia_create_folder → f_…', f1.text);
  const again = await mcp.tool('mia_create_folder', { name: P1.toUpperCase() });
  check(!again.isError && again.json?.folderId === fid && again.json.existed === true, 'mia_create_folder twice (other case) → the same project, existed:true', again.text);
  const badColor = await mcp.tool('mia_create_folder', { name: `Couleur ${STAMP}`, color: 'violet' });
  check(badColor.isError && /Couleur/.test(badColor.text), 'unknown colour → French error listing the colours', badColor.text);

  const b1 = await mcp.tool('mia_create_project', { folder: P1, name: 'Plan 01' });
  const b1id = b1.json?.boardId;
  check(!b1.isError && b1id && b1.json.folder?.id === fid && b1.json.folder.created === false && !b1.json.notes, 'mia_create_project {folder: an existing project} → the board is filed in it', b1.text);

  const b2 = await mcp.tool('mia_create_project', { folder: P2, name: 'Plan 01', color: 'orange' });
  const b2id = b2.json?.boardId;
  const fid2 = b2.json?.folder?.id;
  check(!b2.isError && b2id && /^f_/.test(fid2 || '') && b2.json.folder.created === true, 'mia_create_project {folder: a new name} → project created, board in it', b2.text);

  const b3 = await mcp.tool('mia_create_project', { folder: fid, name: 'Plan 02' });
  const b3id = b3.json?.boardId;
  check(!b3.isError && b3id && b3.json?.folder?.id === fid, 'mia_create_project {folder: its f_… id}', b3.text);

  const noF = await mcp.tool('mia_create_project', { folder: 'f_inexistant', name: 'X' });
  check(noF.isError && /Aucun projet/.test(noF.text), 'an unknown project id → French error, nothing created', noF.text);

  // the list, and the disk: <root>\<project>\folder.json, <root>\<project>\<board>\project.json (folderId)
  const ls = await mcp.tool('mia_list_projects');
  const L = ls.json || {};
  const F1 = (L.folders || []).find((f) => f.id === fid);
  const F2 = (L.folders || []).find((f) => f.id === fid2);
  check(F1 && F1.boards === 2 && F1.color === 'teal' && F2 && F2.boards === 1 && F2.color === 'orange', 'mia_list_projects: both projects with their colour and board count', { F1, F2 });
  const B1 = (L.boards || []).find((b) => b.id === b1id);
  check(B1 && B1.folderId === fid && B1.folder === (F1 && F1.name), 'mia_list_projects: the board names its project', B1);
  if (B1 && B1.dir) {
    const fdir = path.dirname(B1.dir);
    let fj = null;
    let pj = null;
    try { fj = JSON.parse(fs.readFileSync(path.join(fdir, 'folder.json'), 'utf8')); } catch { /* checked below */ }
    try { pj = JSON.parse(fs.readFileSync(path.join(B1.dir, 'project.json'), 'utf8')); } catch { /* checked below */ }
    check(fj && fj.id === fid && pj && pj.folderId === fid, 'on disk: <project>\\<board>, folder.json + project.json folderId', { dir: B1.dir, fj, pj });
  }

  // reopen: « Projet / Planche », {folder, name}, a project alone, a project id
  const op = await mcp.tool('mia_open_project', { projectId: firstBoard });
  check(!op.isError && op.json?.boardId === firstBoard, 'mia_open_project {projectId} (deprecated alias of the board id)', op.text);
  const o1 = await mcp.tool('mia_open_project', { name: `${P1} / plan 01` });
  check(!o1.isError && o1.json?.boardId === b1id && o1.json.folder?.id === fid, 'mia_open_project "Projet / planche" (case ignored)', o1.text);
  const o2 = await mcp.tool('mia_open_project', { folder: P2, name: 'Plan 01' });
  check(!o2.isError && o2.json?.boardId === b2id, 'mia_open_project {folder, name}', o2.text);
  const o3 = await mcp.tool('mia_open_project', { folder: P1 });
  check(!o3.isError && o3.json?.folder?.id === fid && o3.json.boardId === b1id && o3.json.note, 'mia_open_project {folder} → its most recently opened board, the others listed', o3.text);
  const o4 = await mcp.tool('mia_open_project', { id: fid2 });
  check(!o4.isError && o4.json?.boardId === b2id, 'mia_open_project {id: f_…} → a board of that project', o4.text);
  const o5 = await mcp.tool('mia_open_project', { name: P1 });
  check(!o5.isError && o5.json?.folder?.id === fid, 'mia_open_project {name: a project} → its latest board', o5.text);

  const amb = await mcp.tool('mia_open_project', { name: 'Plan 01' });
  if (b1.json?.name === 'Plan 01' && b2.json?.name === 'Plan 01') {
    check(amb.isError && amb.text.includes(`${P1} / Plan 01`) && amb.text.includes(`${P2} / Plan 01`), 'two « Plan 01 » in two projects → an error listing « Projet / Planche »', amb.text);
  } else console.log('  note: the store renamed the second board:', b2.json?.name, '— ambiguity not tested');
  const miss = await mcp.tool('mia_open_project', { name: `${P1} / Plan 99` });
  check(miss.isError && /n’a pas de planche/.test(miss.text), 'a board its project does not have → French error with its boards', miss.text);

  // the open board knows its project
  await mcp.tool('mia_open_project', { id: b1id });
  const st = await mcp.tool('mia_status');
  check(!st.isError && st.json?.mia?.board?.id === b1id && st.json.mia.folder?.id === fid, 'mia_status: the open board and its project', st.json?.mia);
  const gb = await mcp.tool('mia_get_board');
  check(!gb.isError && gb.json?.board?.folder?.id === fid, 'mia_get_board: board.folder', gb.json?.board);
  const add = await mcp.tool('mia_add_block', { type: 'text', title: 'Note du plan 01' });
  check(!add.isError && add.json?.nodeId, 'a block on a board inside a project', add.text.slice(0, 200));

  // look at it (the group of tabs of the project)
  const shot = await mcp.tool('mia_snapshot');
  const img = shot.content.find((c) => c.type === 'image');
  if (img) {
    const f = path.join(DEV, 'snapshot-folders.png');
    fs.writeFileSync(f, Buffer.from(img.data, 'base64'));
    console.log('  snapshot →', f);
  }
  check(!shot.isError && img, 'mia_snapshot with boards of projects open');

  await testSameName(mcp, firstBoard);
}

// ---------------------------------------------------------------- one project per name, never « Court métrage 2 »
async function testSameName(mcp, firstBoard) {
  console.log('· the project of that name is reused (case, accents, spaces ignored)');
  // room in the tab strip (8 at most) for the boards made below
  await cdpEval('(async () => { const app = window.__mia.app; for (const id of app.tabs.ids()) await app.closeTab(id); return 1; })()').catch(() => null);
  const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const P3 = `Court métrage ${STAMP}`;
  const f3 = await mcp.tool('mia_create_folder', { name: P3 });
  const fid3 = f3.json?.folderId;
  check(!f3.isError && /^f_/.test(fid3 || '') && f3.json.name === P3, `mia_create_folder « ${P3} »`, f3.text);
  for (const q of [strip(P3).toUpperCase(), ` ${P3.toLowerCase()} `, `${P3.replace(' ', '  ')}.`]) {
    const r = await mcp.tool('mia_create_folder', { name: q });
    check(!r.isError && r.json?.folderId === fid3 && r.json.existed === true, `mia_create_folder « ${q} » → the same project, existed:true`, r.text);
  }
  const b4 = await mcp.tool('mia_create_project', { folder: strip(P3).toLowerCase(), name: 'Plan 03' });
  check(!b4.isError && b4.json?.folder?.id === fid3 && b4.json.folder.created === false, 'mia_create_project {folder: lower case, no accents} → the same project', b4.text);

  // three calls at once for a project nobody has yet → one project
  const P4 = `Simultané ${STAMP}`;
  const [c1, c2, c3] = await Promise.all([
    mcp.tool('mia_create_folder', { name: P4 }),
    mcp.tool('mia_create_project', { folder: strip(P4).toLowerCase(), name: 'Plan 01' }),
    mcp.tool('mia_create_folder', { name: P4.toUpperCase() })
  ]);
  const ids = new Set([c1.json?.folderId, c2.json?.folder?.id, c3.json?.folderId]);
  check(!c1.isError && !c2.isError && !c3.isError && ids.size === 1 && !ids.has(undefined), 'three calls at once → one project', [c1.text, c2.text, c3.text].map((s) => s.slice(0, 160)));

  // a project named like a board outside any project (such boards date from before projects existed)
  const twinName = (await mcp.tool('mia_list_projects')).json?.boards?.find((b) => b.id === firstBoard)?.name;
  if (twinName) {
    const f5 = await mcp.tool('mia_create_folder', { name: twinName });
    check(!f5.isError && f5.json?.name === twinName && f5.json.existed === false, `a project named like a board outside any project → « ${twinName} », not « … 2 »`, f5.text);
    check(/hors projet|outside any project/.test(f5.json?.note || ''), '… and the note says that board was left where it is', f5.json?.note);
    const again = await mcp.tool('mia_create_project', { folder: twinName, name: 'Plan 01' });
    check(!again.isError && again.json?.folder?.id === f5.json?.folderId && again.json.folder.created === false, '… then create_project {folder: that name} → that project', again.text);
  }
  const names = ((await mcp.tool('mia_list_projects')).json?.folders || []).map((f) => f.name);
  // « X 2 » … « X 99 » beside « X » (the stamps of the names are 6 digits: not a counter)
  const dup = names.filter((n) => / [1-9]\d?$/.test(n) && names.includes(n.replace(/ [1-9]\d?$/, '')));
  check(!dup.length && names.filter((n) => strip(n).toLowerCase() === strip(P3).toLowerCase()).length === 1, 'no project « … 2 », one « ' + P3 + ' »', names);
}

main();
