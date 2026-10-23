import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { startStudio } from '../packages/openfilm/studio/server/server.mjs';
import { projectClient } from './client.mjs';
import { command } from './cli.mjs';
import { callTool } from './mcp.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzu0AAAAASUVORK5CYII=', 'base64');
const sha256 = createHash('sha256').update(png).digest('hex');

test('受管 HTTP/CLI/MCP 发现同一审片合同，帧下载沿原鉴权并核精确字节', { timeout: 20_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'video-review-http-'));
  const env = { home: process.env.OPENFILM_HOME, library: process.env.OPENFILM_LIBRARY, app: process.env.APP_DATA_DIR };
  const home = join(scratch, 'home'), project = join(scratch, 'project');
  process.env.OPENFILM_HOME = home; process.env.OPENFILM_LIBRARY = join(home, 'projects'); process.env.APP_DATA_DIR = home;
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'film.html'), '<meta name="viewport" content="width=640, height=360"><section><iframe id="intro" src="scene.html#t=0,1"></iframe></section>');
  await writeFile(join(project, 'scene.html'), '<script>window.film={duration:1,frame(t){}}</script>');
  let studio;
  try {
    studio = await startStudio({ port: 0, advertise: true, openBrowser: () => {} });
    const config = { home }, client = await projectClient(config, project);
    const base = `${studio.origin}${client.base}/reviews`;
    const headers = { 'x-studio-key': studio.key, 'content-type': 'application/json' };
    assert.equal((await fetch(`${studio.origin}/api/review-schema`)).status, 401);
    const contract = await (await fetch(`${studio.origin}/api/review-schema`, { headers })).json();
    assert.equal(contract.contractVersion, 3); assert.ok(contract.requestSchema.properties.firstLast);
    let offline; await command(['review', '--schema'], (value) => { offline = value; });
    assert.deepEqual(contract, offline);
    assert.equal((await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"source":"current-project","times":[0]}' })).status, 401);
    const invalid = await fetch(base, { method: 'POST', headers, body: '{"source":"current-project","times":[0],"count":1}' });
    assert.equal(invalid.status, 400); assert.equal((await invalid.json()).code, 'invalid-request');
    await assert.rejects(command(['review', project, '--source', 'current-project', '--count', '6', '--last', '--home', home]), /最多六帧/);
    await assert.rejects(callTool(config, project, 'video_review', { source: 'export-job', job: '123456abcdef', last: true }), (e) => e.status === 404 && e.details.code === 'missing-job');
    // 下载合同使用人工 fixture；此项不宣称浏览器求帧或真实导出已经运行。
    const reviewId = 'abcdef0123456789abcdef01', dir = join(home, 'reviews', reviewId), file = join(dir, 'frame-0.png');
    await mkdir(dir, { recursive: true }); await writeFile(file, png);
    await writeFile(join(dir, 'review.json'), JSON.stringify({ version: 1, projectId: client.project.id, reviewId, observation: 'generated-not-viewed', frames: [{ index: 0, path: file, bytes: png.length, width: 1, height: 1, sha256 }] }));
    const artifactFile = join(dir, 'artifact-first-last.png'); await writeFile(artifactFile, png);
    const manifest = JSON.parse(await readFile(join(dir, 'review.json'), 'utf8'));
    manifest.artifacts = [{ artifactId: 'first-last', path: artifactFile, bytes: png.length, width: 1, height: 1, sha256 }];
    await writeFile(join(dir, 'review.json'), JSON.stringify(manifest));
    assert.equal((await fetch(`${base}/${reviewId}/artifacts/first-last`)).status, 401);
    const artifact = await fetch(`${base}/${reviewId}/artifacts/first-last?expected_sha256=${sha256}`, { headers });
    assert.equal(artifact.status, 200); assert.equal(artifact.headers.get('etag'), `"sha256-${sha256}"`);
    assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), png);
    for (const artifactId of ['sequence', 'size-comparison']) {
      const path = join(dir, `artifact-${artifactId}.png`); await writeFile(path, png);
      manifest.version = 3; manifest.artifacts = [{ artifactId, path, bytes: png.length, width: 1, height: 1, sha256 }];
      await writeFile(join(dir, 'review.json'), JSON.stringify(manifest));
      assert.equal((await fetch(`${base}/${reviewId}/artifacts/${artifactId}`)).status, 401);
      const actual = await fetch(`${base}/${reviewId}/artifacts/${artifactId}?expected_sha256=${sha256}`, { headers });
      assert.equal(actual.status, 200); assert.deepEqual(Buffer.from(await actual.arrayBuffer()), png);
      assert.equal((await fetch(`${base}/${reviewId}/artifacts/${artifactId}?expected_sha256=${'a'.repeat(64)}`, { headers })).status, 409);
      await writeFile(path, 'changed'); assert.equal((await fetch(`${base}/${reviewId}/artifacts/${artifactId}`, { headers })).status, 409);
    }
    manifest.artifacts = [{ artifactId: 'first-last', path: artifactFile, bytes: png.length, width: 1, height: 1, sha256 }];
    await writeFile(join(dir, 'review.json'), JSON.stringify(manifest));
    assert.equal((await fetch(`${base}/${reviewId}/artifacts/not-a-path`, { headers })).status, 404);
    await writeFile(artifactFile, 'changed artifact');
    assert.equal((await fetch(`${base}/${reviewId}/artifacts/first-last`, { headers })).status, 409);
    assert.equal((await client.reviewReceipt(reviewId)).observation, 'generated-not-viewed');
    assert.equal((await fetch(`${base}/${reviewId}/frames/0`)).status, 401);
    const image = await fetch(`${base}/${reviewId}/frames/0?expected_sha256=${sha256}`, { headers });
    assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png'); assert.equal(image.headers.get('cache-control'), 'no-store'); assert.equal(image.headers.get('etag'), `"sha256-${sha256}"`);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    assert.equal((await fetch(`${base}/${reviewId}/frames/0?expected_sha256=${'a'.repeat(64)}`, { headers })).status, 409);
    await writeFile(file, 'changed');
    const changed = await fetch(`${base}/${reviewId}/frames/0`, { headers });
    assert.equal(changed.status, 409); assert.equal((await changed.json()).code, 'digest-mismatch');
    assert.equal((await readFile(join(project, 'scene.html'), 'utf8')), '<script>window.film={duration:1,frame(t){}}</script>');
  } finally {
    await studio?.close();
    for (const [key, value] of [['OPENFILM_HOME', env.home], ['OPENFILM_LIBRARY', env.library], ['APP_DATA_DIR', env.app]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(scratch, { recursive: true, force: true });
  }
});
