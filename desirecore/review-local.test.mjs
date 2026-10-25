import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { startStudio } from '../packages/openfilm/studio/server/server.mjs';
import { projectClient } from './client.mjs';
import { command } from './cli.mjs';
import { copyReviewImages, reviewLocalOptionsOf } from './review-local.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzu0AAAAASUVORK5CYII=', 'base64');
const sha256 = createHash('sha256').update(png).digest('hex');
const id = 'abcdef0123456789abcdef01';
const receipt = { version: 4, reviewId: id, projectId: 'project', frames: [{ index: 0, bytes: png.length, sha256 }], artifacts: [{ artifactId: 'sequence', bytes: png.length, sha256 }] };
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'review-local-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test('本地选项明确区分读取/捕获，不把输出目录传给服务器', () => {
  assert.deepEqual(reviewLocalOptionsOf({ read: id, 'copy-to': '.' }), { read: id, copyTo: '.' });
  assert.throws(() => reviewLocalOptionsOf({ read: id, source: 'current-project' }), /不能同时/);
  assert.throws(() => reviewLocalOptionsOf({ read: '../wrong' }), /无效/);
});
test('显式副本核精确字节，复用同份图片且不覆盖用户冲突文件', () => fixture(async (root) => {
  let calls = 0;
  const client = { project: { id: 'project' }, reviewImage: async () => { calls++; return png; } };
  const before = JSON.stringify(receipt), first = await copyReviewImages(client, receipt, root);
  assert.equal(first.images.length, 2); assert.equal(calls, 2); assert.equal(first.permissionGranted, false);
  for (const image of first.images) { assert.deepEqual(await readFile(image.path), png); assert.equal((await stat(image.path)).mode & 0o777, 0o600); }
  assert.deepEqual(await copyReviewImages(client, receipt, root), first); assert.equal(calls, 2);
  await writeFile(first.images[0].path, png.subarray(0, 20));
  await assert.rejects(copyReviewImages(client, receipt, root)); assert.deepEqual(await readFile(first.images[0].path), png.subarray(0, 20));
  assert.equal(JSON.stringify(receipt), before);
}));
test('真实鉴权HTTP读取已有review后保存副本，未触发捕获且原PNG/回执不变', { timeout: 20_000 }, () => fixture(async (root) => {
  const keys = ['OPENFILM_HOME', 'VIDEO_CREATION_HOME', 'APP_DATA_DIR'], old = Object.fromEntries(keys.map((k) => [k, process.env[k]])), home = join(root, 'home'), project = join(root, 'project'), copies = join(root, 'copies');
  await mkdir(project); await mkdir(copies); for (const key of keys) process.env[key] = home;
  await writeFile(join(project, 'film.html'), '<meta name="viewport" content="width=1, height=1"><section></section>');
  const studio = await startStudio({ port: 0, advertise: true, openBrowser: () => {} });
  try {
    const client = await projectClient({ home }, project), dir = join(home, 'reviews', id); await mkdir(dir, { recursive: true });
    const forbiddenOutput = join(root, 'server-must-not-create');
    const invalid = await fetch(`${studio.origin}${client.base}/reviews`, { method: 'POST', headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, body: JSON.stringify({ source: 'current-project', times: [0], copyTo: forbiddenOutput }) });
    assert.equal(invalid.status, 400); await assert.rejects(stat(forbiddenOutput), (e) => e.code === 'ENOENT');
    const original = { ...receipt, projectId: client.project.id, frames: [{ ...receipt.frames[0], path: join(dir, 'frame-0.png'), width: 1, height: 1 }], artifacts: [] };
    await writeFile(original.frames[0].path, png); const text = JSON.stringify(original); await writeFile(join(dir, 'review.json'), text);
    const requests = [];
    const network = await projectClient({ home }, project, { request: (url, options) => { requests.push({ path: new URL(url).pathname, method: options.method }); return fetch(url, options); } });
    const fetched = await network.reviewReceipt(id); await copyReviewImages(network, fetched, copies);
    assert.ok(requests.some((r) => r.method === 'GET' && r.path.endsWith('/frames/0')));
    assert.ok(!requests.some((r) => r.method === 'POST' && r.path.endsWith('/reviews')));
    let output; await command(['review', project, '--read', id, '--copy-to', copies, '--home', home], (value) => { output = value; });
    assert.equal(output.reviewId, id); assert.deepEqual(await readFile(output.localCopies.images[0].path), png);
    assert.equal(await readFile(join(dir, 'review.json'), 'utf8'), text); assert.deepEqual(await readFile(original.frames[0].path), png);
    const corrupt = await projectClient({ home }, project, { request: async (url, options) => new URL(url).pathname.endsWith('/frames/0') ? new Response(Buffer.alloc(png.length), { headers: { 'content-type': 'image/png' } }) : fetch(url, options) });
    const second = join(root, 'second'); await mkdir(second); await assert.rejects(copyReviewImages(corrupt, fetched, second), /摘要/);
  } finally { await studio.close(); for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } }
}));
test('捕获携本地副本只提交一次；复制失败返回原ID供read恢复', () => fixture(async (root) => {
  const originalFetch = globalThis.fetch, home = join(root, 'home'), destination = join(root, 'images');
  const keys = ['OPENFILM_HOME', 'VIDEO_CREATION_HOME', 'APP_DATA_DIR'], old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  await mkdir(home); await mkdir(destination); await writeFile(join(home, 'run.json'), JSON.stringify({ origin: 'http://127.0.0.1:12233', key: 'a'.repeat(48) }));
  let captures = 0, corrupt = false;
  const one = { ...receipt, artifacts: [] };
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/api/health') return Response.json({ product: 'video-creation-studio', home: createHash('sha256').update(home).digest('hex') });
    if (path === '/api/projects') return Response.json({ project: { id: 'project', path: root } });
    if (path.endsWith('/reviews')) { captures++; assert.deepEqual(JSON.parse(options.body), { source: 'current-project', times: [0], maxEdge: 1280 }); return Response.json(one); }
    if (path.endsWith('/frames/0')) return new Response(corrupt ? Buffer.alloc(png.length) : png, { headers: { 'content-type': 'image/png' } });
    throw new Error('unexpected test request');
  };
  try {
    let output; await command(['review', root, '--source', 'current-project', '--times', '0', '--copy-to', destination, '--home', home], (value) => { output = value; });
    assert.equal(captures, 1); assert.equal(output.localCopies.images[0].sha256, sha256);
    corrupt = true; const next = join(root, 'next'); await mkdir(next);
    await assert.rejects(command(['review', root, '--source', 'current-project', '--times', '0', '--copy-to', next, '--home', home], (value) => { output = value; }), /--read/);
    assert.equal(captures, 2); assert.equal(output.reviewId, id); assert.equal(output.localCopies.status, 'failed');
  } finally { globalThis.fetch = originalFetch; for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } }
}));
