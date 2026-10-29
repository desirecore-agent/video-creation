import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { projectClient, reviewListRequestSchema, REVIEW_RESPONSE_MAX_BYTES } from './client.mjs';
import { MAX_LOCAL_JSON_BYTES } from './local-json-request.mjs';
import { command } from './cli.mjs';
import { callTool } from './mcp.mjs';

/** 私有回环夹具只验证传输与入口，不执行影片、FFmpeg或模型。 */
async function fixture(t, action) {
  const home = await mkdtemp(join(tmpdir(), 'review-recovery-'));
  const folder = join(home, 'project'), sockets = new Set(), calls = [];
  const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const parts = []; for await (const part of req) parts.push(part);
      const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : undefined;
      calls.push({ path: url.pathname, query: url.search, method: req.method, body, key: req.headers['x-studio-key'] });
      if (url.pathname === '/api/health') return json(res, { product: 'video-creation-studio', home: createHash('sha256').update(resolve(home)).digest('hex') });
      if (url.pathname === '/api/projects') return json(res, { project: { id: 'fixture', path: folder } });
      await action({ req, res, url, body, json });
    })().catch((error) => res.destroy(error));
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await writeFile(join(home, 'run.json'), JSON.stringify({ origin, key: 'a'.repeat(48) }));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((done) => server.close(done)); await rm(home, { recursive: true, force: true }); });
  return { home, folder, origin, calls };
}

test('默认review使用有界本地长传输，256KiB以上真实JSON仍可取得且媒体准备预算不变', async (t) => {
  const payload = 'x'.repeat(MAX_LOCAL_JSON_BYTES + 1024);
  const f = await fixture(t, async ({ res, body, json, url }) => {
    await new Promise((done) => setTimeout(done, 40));
    json(res, { reviewId: '1'.repeat(24), payload, source: body?.source, route: url.pathname });
  });
  const nativeFetch = globalThis.fetch;
  const nativeTimeout = AbortSignal.timeout, timeouts = [];
  t.mock.method(AbortSignal, 'timeout', (ms) => { timeouts.push(ms); return nativeTimeout(ms); });
  let reviewFetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.pathname.includes('/reviews') || url.searchParams.has('withMediaDigests')) { reviewFetchCalls++; throw new Error('不应使用fetch的响应头等待'); }
    return nativeFetch(url, init);
  });
  const client = await projectClient({ home: f.home }, f.folder);
  const result = await client.review({ source: 'current-project' });
  assert.equal(result.payload.length, payload.length);
  assert.equal(timeouts.at(-1), 10 * 60_000);
  assert.equal((await client.reviewReceipt(result.reviewId)).payload.length, payload.length);
  assert.equal(timeouts.at(-1), 30_000);
  assert.equal((await client.captions({ withMediaDigests: true })).payload.length, payload.length);
  assert.equal(timeouts.at(-1), 15 * 60_000);
  assert.equal((await client.captions()).payload.length, payload.length);
  assert.equal(timeouts.at(-1), 30_000);
  assert.equal(reviewFetchCalls, 0);
  assert.equal(f.calls.filter((c) => c.path.endsWith('/reviews')).length, 1);
  assert.ok(f.calls.every((c) => c.key === 'a'.repeat(48)));
  await assert.rejects(client.prepareMedia({ src: 'fixture.mp4' }), /超出回执预算/);
});

test('review声明或流式超过8MiB均有界失败并保留结果未知，不自动重捕获', async (t) => {
  const knownId = 'c'.repeat(24);
  const f = await fixture(t, ({ res, body, url }) => {
    if (url.pathname.endsWith('/' + knownId)) { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"payload":"'); res.write('x'.repeat(REVIEW_RESPONSE_MAX_BYTES)); res.end('"}'); return; }
    if (body.count === 1) { res.writeHead(200, { 'content-length': REVIEW_RESPONSE_MAX_BYTES + 1 }); res.end('x'); }
    else if (body.count === 3) { res.writeHead(409, { 'content-length': REVIEW_RESPONSE_MAX_BYTES + 1 }); res.end('x'); }
    else if (body.count === 4) { res.writeHead(429, { 'content-type': 'application/json' }); res.write('{"error":'); setTimeout(() => res.destroy(), 10); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"payload":"'); res.write('x'.repeat(REVIEW_RESPONSE_MAX_BYTES)); res.end('"}'); }
  });
  const client = await projectClient({ home: f.home }, f.folder);
  for (const count of [1, 2]) await assert.rejects(client.review({ source: 'current-project', count }), (e) => /结果未知.*8MiB.*reviews.*勿直接重复捕获/.test(e.message) && e.cause?.code === 'LOCAL_JSON_RESPONSE_BUDGET');
  await assert.rejects(client.review({ source: 'current-project', count: 3 }), (e) => e.status === 409 && e.code === 'LOCAL_JSON_RESPONSE_BUDGET' && !/结果未知/.test(e.message));
  await assert.rejects(client.review({ source: 'current-project', count: 4 }), (e) => e.status === 429 && !/结果未知/.test(e.message));
  await assert.rejects(client.reviewReceipt(knownId), (e) => e.message.includes(knownId) && /读取未完成.*8MiB.*勿重新捕获/.test(e.message) && !/结果未知/.test(e.message) && e.cause?.code === 'LOCAL_JSON_RESPONSE_BUDGET');
  assert.equal(f.calls.filter((c) => c.path.endsWith('/reviews')).length, 4);
});

test('审片断连后沿既有列表和ID恢复，CLI/MCP不产生第二次捕获', async (t) => {
  const reviewId = 'b'.repeat(24), receipt = { reviewId, sourceKind: 'current-project', request: { source: 'current-project' }, observation: 'generated-not-viewed', frames: [] };
  let saved = false, posts = 0;
  const f = await fixture(t, ({ req, res, url, json }) => {
    if (url.pathname.endsWith('/reviews') && req.method === 'POST') { posts++; saved = true; res.destroy(); }
    else if (url.pathname.endsWith('/reviews')) json(res, { reviews: saved ? [{ reviewId, sourceKind: receipt.sourceKind }] : [], limited: true, unavailable: 1, nextOffset: 50 });
    else if (url.pathname.endsWith('/' + reviewId)) json(res, receipt);
    else json(res, { error: 'fixture missing' }, 404);
  });
  const config = { home: f.home }, client = await projectClient(config, f.folder);
  await assert.rejects(client.review({ source: 'current-project' }), /结果未知.*reviews/);
  const list = await client.reviews();
  assert.equal(list.nextOffset, 50); assert.equal(list.unavailable, 1);
  assert.deepEqual(await client.reviewReceipt(list.reviews[0].reviewId), receipt);
  assert.deepEqual(await callTool(config, f.folder, 'video_reviews', { offset: 50 }), list);
  assert.deepEqual(await callTool(config, f.folder, 'video_review_read', { reviewId }), receipt);
  let cli;
  const savedEnv = process.env.APP_DATA_DIR; process.env.APP_DATA_DIR = f.home;
  try { await command(['reviews', f.folder, '--offset', '50', '--home', f.home], (v) => { cli = v; }); }
  finally { if (savedEnv === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = savedEnv; }
  assert.deepEqual(cli, list);
  assert.ok(f.calls.some((c) => c.query === '?offset=50'));
  assert.equal(posts, 1);
  await assert.rejects(callTool(config, f.folder, 'video_reviews', { offset: -1 }), /参数无效/);
  assert.throws(() => client.reviews(0.5), /分页offset/);
});

test('review沿原AbortSignal停止本次等待并保留结果未知', async (t) => {
  const controller = new AbortController(); let posts = 0;
  const f = await fixture(t, ({ req, res }) => { if (req.method === 'POST') { posts++; controller.abort(new DOMException('fixture stopped', 'AbortError')); } });
  const client = await projectClient({ home: f.home }, f.folder);
  const limits = []; t.mock.method(AbortSignal, 'timeout', (ms) => { limits.push(ms); return controller.signal; });
  await assert.rejects(client.review({ source: 'current-project' }), (e) => /结果未知/.test(e.message) && e.cause?.name === 'AbortError');
  assert.deepEqual(limits, [10 * 60_000]); assert.equal(posts, 1);
});

test('review保留自定义request与明确HTTP错误，不把409或非JSON500改成未知成功', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'review-injected-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'run.json'), JSON.stringify({ origin: 'http://127.0.0.1:1234', key: 'a'.repeat(48) }));
  let mode = 'conflict', posts = 0;
  const client = await projectClient({ home }, home, { request: async (url, init) => {
    if (url.pathname === '/api/health') return Response.json({ product: 'video-creation-studio', home: createHash('sha256').update(resolve(home)).digest('hex') });
    if (url.pathname === '/api/projects') return Response.json({ project: { id: 'fixture', path: home } });
    posts++; assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    if (mode === 'conflict') return Response.json({ error: '源已改变', code: 'stale' }, { status: 409 });
    if (mode === 'null-error') return Response.json(null, { status: 404 });
    return new Response('not-json', { status: 500 });
  } });
  await assert.rejects(client.review({ source: 'current-project' }), (e) => e.status === 409 && e.details.code === 'stale' && !/结果未知/.test(e.message));
  mode = 'bad-error';
  await assert.rejects(client.review({ source: 'current-project' }), (e) => e.status === 500 && /500/.test(e.message) && !/结果未知/.test(e.message));
  mode = 'null-error';
  await assert.rejects(client.review({ source: 'current-project' }), (e) => e.status === 404 && e.details === null && !/结果未知/.test(e.message));
  assert.equal(posts, 3);
});

test('新增只读布局和字幕原声窗包装保留服务回执与失败边界', async (t) => {
  const mediaSnapshot = { bytes: 1234, sha256: 'c'.repeat(64) };
  const cue = { clip: 'talk', src: 'source.mp4', line: 1000, sourceRevision: 'b'.repeat(64) };
  const selection = { base: 'a'.repeat(16), clip: 'talk', range: { filmStartMs: 1000, filmEndMs: 3000 } };
  const job = { id: 'a'.repeat(12), status: 'done', outputDigests: [{ path: '/fixture/window.wav', bytes: 1024, sha256: 'b'.repeat(64) }] };
  let failAudio = false, failObservation = false;
  const f = await fixture(t, ({ res, url, json }) => {
    if (url.pathname.endsWith('/subtitles')) return json(res, { style: null, layout: { status: 'computed', stage: { w: 1080, h: 1920 } } });
    if (url.pathname.endsWith('/captions')) { if (failObservation) return res.destroy(); return json(res, { cues: [cue], ...(url.searchParams.get('withMediaDigests') === '1' ? { filmRevision: selection.base, mediaSnapshots: [{ src: cue.src, snapshot: mediaSnapshot }] } : {}) }); }
    if (url.pathname.endsWith('/captions/audio')) { if (failAudio) return res.destroy(); return json(res, { selection, export: { id: job.id, status: 'preparing' } }); }
    if (url.pathname.endsWith('/exports')) return json(res, { exports: [job] });
    json(res, { error: 'fixture missing' }, 404);
  });
  const config = { home: f.home, prepareTimeoutMs: 120_000 }, client = await projectClient(config, f.folder);
  assert.equal((await client.subtitleStyle()).layout.stage.h, 1920);
  assert.equal((await callTool(config, f.folder, 'video_subtitle_style')).style, null);
  assert.equal((await client.captions()).mediaSnapshots, undefined);
  const observed = await callTool(config, f.folder, 'video_captions', { withMediaDigests: true });
  const ask = { base: observed.filmRevision, clip: cue.clip, sourceRevision: cue.sourceRevision, mediaSnapshot: observed.mediaSnapshots.find((m) => m.src === cue.src).snapshot, cue: { line: cue.line } };
  const nativeTimeout = AbortSignal.timeout, timeouts = [];
  t.mock.method(AbortSignal, 'timeout', (ms) => { timeouts.push(ms); return nativeTimeout(ms); });
  assert.deepEqual(await callTool(config, f.folder, 'video_caption_audio', ask), { selection, export: { id: job.id, status: 'preparing' } });
  assert.equal(timeouts.at(-1), config.prepareTimeoutMs);
  assert.deepEqual(f.calls.find((c) => c.path.endsWith('/captions/audio')).body.mediaSnapshot, mediaSnapshot);
  const file = join(f.home, 'ask.json'); await writeFile(file, JSON.stringify(ask));
  const savedEnv = process.env.APP_DATA_DIR; process.env.APP_DATA_DIR = f.home;
  let actual, cliCaptions;
  try {
    await command(['captions', f.folder, '--with-media-digests', '--home', f.home], (v) => { cliCaptions = v; });
    await command(['caption-audio', f.folder, '--args', file, '--wait', '--home', f.home], (v) => { actual = v; });
  }
  finally { if (savedEnv === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = savedEnv; }
  assert.deepEqual(cliCaptions.mediaSnapshots, observed.mediaSnapshots);
  assert.throws(() => client.captions({ withMediaDigests: 'yes' }), /必须是布尔/);
  assert.deepEqual(actual, { selection, export: job });
  let waiting;
  process.env.APP_DATA_DIR = f.home;
  try {
    await assert.rejects(command(['caption-audio', f.folder, '--args', file, '--wait', '--timeout', '0', '--home', f.home], (v) => { waiting = v; }), /已取得导出.*jobs.*勿直接重复提交/);
  } finally { if (savedEnv === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = savedEnv; }
  assert.deepEqual(waiting.selection, selection);
  assert.equal(waiting.export.id, job.id); assert.equal(waiting.wait.status, 'not-completed');
  assert.equal(f.calls.filter((c) => c.path.endsWith('/captions/audio')).length, 3);
  failAudio = true;
  await assert.rejects(client.captionAudio(ask), /结果未知.*jobs.*勿直接重复提交/);
  failObservation = true;
  await assert.rejects(client.captions({ withMediaDigests: true }), (e) => /读取未完成.*完整观察.*重读当前版本/.test(e.message) && !/结果未知/.test(e.message));
});

test('列表、布局及原声窗Schema可离线发现且分页参数不会被静默纠正', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'review-offline-')), absent = join(home, 'not-created');
  t.after(() => rm(home, { recursive: true, force: true }));
  const savedEnv = process.env.APP_DATA_DIR; process.env.APP_DATA_DIR = absent;
  try {
    const schemas = {};
    for (const name of ['reviews', 'subtitle-style', 'caption-audio', 'captions']) await command([name, '--schema', '--home', absent], (v) => { schemas[name] = v; });
    assert.deepEqual(schemas.reviews, reviewListRequestSchema);
    assert.equal(schemas['subtitle-style'].$schema, 'http://json-schema.org/draft-07/schema#');
    for (const key of ['base', 'clip', 'sourceRevision', 'mediaSnapshot', 'cue']) assert.ok(schemas['caption-audio'].requestSchema.required.includes(key));
    assert.equal(schemas.captions.properties.withMediaDigests.type, 'boolean');
    await assert.rejects(access(absent));
    await assert.rejects(command(['reviews', '/unused', '--offset=-1', '--home', absent]), /分页offset/);
  } finally { if (savedEnv === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = savedEnv; }
});
