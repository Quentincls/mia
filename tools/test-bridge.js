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
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'mia-mcp.js')], {
    env: { ...process.env, MIA_BRIDGE_FILE: BRIDGE_FILE, MIA_NO_LAUNCH: '1' },
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

// ---------------------------------------------------------------- run
async function main() {
  fs.mkdirSync(DEV, { recursive: true });
  const image = path.join(DEV, 'test-scene.png');
  makePng(image);
  let mia = null;
  if (EXTERNAL) {
    console.log('· test Mia already running: bridge', BRIDGE_FILE, '· CDP port', CDP_PORT);
  } else {
    // a fresh projects folder for each run (only the test's own folder)
    fs.rmSync(PROJECTS, { recursive: true, force: true });
    fs.mkdirSync(PROJECTS, { recursive: true });
    try { fs.unlinkSync(BRIDGE_FILE); } catch { /* none */ }
    console.log('· launching a hidden Mia (CDP port', CDP_PORT, ')');
    mia = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${CDP_PORT}`], {
      env: { ...process.env, MIA_HEADLESS: '1', MIA_USERDATA: USERDATA, MIA_PROJECTS_ROOT: PROJECTS },
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
      'mia_set_params', 'mia_rename_block', 'mia_remove_blocks', 'mia_import_media', 'mia_insert_recipe', 'mia_arrange', 'mia_run', 'mia_wait', 'mia_jobs',
      'mia_cancel', 'mia_get_output', 'mia_snapshot', 'mia_focus', 'mia_add_section', 'mia_say'];
    check(expected.every((n) => names.includes(n)) && names.length === expected.length, `tools/list: ${names.length} tools`, names);
    check((list.result?.tools || []).every((t) => t.inputSchema && t.inputSchema.type === 'object' && t.description), 'every tool has a schema and a description');
    // before SPEC §18 a board was a « project »: projectId stays accepted (deprecated) beside boardId
    const aliased = (list.result?.tools || []).filter((t) => ['mia_open_project', 'mia_get_board', 'mia_run', 'mia_wait'].includes(t.name));
    check(aliased.length === 4 && aliased.every((t) => t.inputSchema.properties?.projectId?.deprecated === true && t.inputSchema.properties?.boardId),
      'open_project, get_board, run, wait: boardId + projectId (deprecated alias) in the schema', aliased.map((t) => [t.name, Object.keys(t.inputSchema.properties || {})]));
    const instr = init.result?.instructions || '';
    check(/BOARD/.test(instr) && /planche/.test(instr) && /PROJECT/.test(instr) && /folder/.test(instr), 'the instructions explain projects (folders) and boards');
    const pong = await mcp.request('ping', {});
    check(pong.result && !pong.error, 'ping');

    const st = await mcp.tool('mia_status');
    check(!st.isError && st.json?.mia?.interfaceReady === true, 'mia_status (interface ready)', st.text);

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
    check(!done.isError && done.json?.state === 'done' && outFile && fs.existsSync(outFile), 'mia_wait → done, output file on disk', done.text.slice(0, 400));
    check(done.json?.boardId === pid && done.json?.projectId === pid, 'mia_wait → boardId and projectId', done.text.slice(0, 300));
    const jl = await mcp.tool('mia_jobs');
    const jj = (jl.json || []).find((j) => j.jobId === jobId);
    check(jj && jj.boardId === pid && jj.projectId === pid, 'mia_jobs → boardId and projectId', jj || jl.text.slice(0, 300));
    // the deprecated alias in the calls themselves
    const gp = await mcp.tool('mia_get_board', { projectId: pid });
    check(!gp.isError && gp.json?.board?.id === pid, 'mia_get_board {projectId} (deprecated alias of boardId)', gp.text.slice(0, 200));
    const wp = await mcp.tool('mia_wait', { nodeId: resizeId, projectId: pid, timeoutS: 5 });
    check(!wp.isError && wp.json?.jobId === jobId && wp.json.state === 'done', 'mia_wait {nodeId, projectId}', wp.text.slice(0, 300));
    const go = await mcp.tool('mia_get_output', { nodeId: resizeId });
    check(!go.isError && go.json?.outputs?.[0]?.meta?.w === 384, 'mia_get_output: the half-size image (384 px)', go.text.slice(0, 300));

    // a recipe beside the rest, then removed (Ctrl+Z-able, no file deleted)
    const rec = await mcp.tool('mia_insert_recipe', { recipe: 'depth-video' });
    const recIds = (rec.json?.blocks || []).map((x) => x.nodeId);
    check(!rec.isError && recIds.length === 4 && rec.json.blocks.some((x) => x.waitsFor), 'mia_insert_recipe depth-video (4 blocks, one waits for a video)', rec.text.slice(0, 300));
    const gone = await mcp.tool('mia_remove_blocks', { nodeIds: recIds });
    check(!gone.isError && gone.json?.removed?.length === 4, 'mia_remove_blocks', gone.text.slice(0, 200));

    const arr = await mcp.tool('mia_arrange');
    check(!arr.isError && arr.json?.arranged === 3, 'mia_arrange', arr.text);

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
