import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { Ajv } from 'ajv';
import { createReviews, normalizeReviewRequest, reviewContract } from './reviews.mjs';
import { filmHtml } from '../../src/film-doc.mjs';
import { snapshotFilm } from './export-snapshot.mjs';
import { exportReviewMapping, reviewFactsDigest } from './review-facts.mjs';
import { reviewOptionsOf } from '../../../../desirecore/cli.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
function png(w, h) {
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const b of body) { crc ^= b; for (let k = 0; k < 8; k++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    const out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((w + 1) * h))), chunk('IEND', Buffer.alloc(0))]);
}
const intent = JSON.stringify({ targetWidths: [180, 360], text: [{ role: 'essential', selector: '#title', description: '保留主题' }] });
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'review-refinement-')), project = { id: 'test-project', path: join(root, 'project') }; await mkdir(project.path);
  const value = { stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'scene', src: '中文-scene.html', at: 0, time: [0, 20], attrs: { 'data-review-intent': intent }, overrides: [{ at: '#human', lock: true, text: '人工文字' }] }] }] };
  const film = filmHtml(value); await writeFile(join(project.path, 'film.html'), film); await writeFile(join(project.path, '中文-scene.html'), '<div id="title">片名</div><div id="human">原文</div><script>window.film={width:320,height:180,duration:20,frame(t){}}</script>');
  const source = png(320, 180), jobs = [];
  const draw = async (_root, dir, ask) => {
    const file = join(dir, 'frame-0.png'); await writeFile(file, source);
    return { duration: 20, frames: [{ requestedTime: ask.times[0], actualTime: ask.times[0], actualPTS: null, timeBasis: 'project-seek', width: 320, height: 180, captureSha256: hash(source), captureBytes: source.length, file }], findings: [], coverage: [] };
  };
  const reviews = createReviews({ root: join(root, 'reviews'), jobs: () => jobs, drawProject: draw, decodeVideo: async (...args) => { const r = await draw(...args); return { ...r, timeOriginPTS: 0, timeOriginPTSTicks: '0', frames: r.frames.map((f) => ({ ...f, timeBasis: 'encoded-pts', actualPTS: f.actualTime, actualPTSTicks: String(Math.round(f.actualTime * 1000)), ptsTimeBase: '1/1000' })) }; }, resizePNG: async (_b, p) => png(p.actualWidth, p.actualHeight), composeGrid: async (_buffers, layout) => png(layout.width, layout.height) });
  try { await run({ root, project, value, film, reviews, jobs }); } finally { await reviews.close(); await rm(root, { recursive: true, force: true }); }
}
test('T4 pair同入口合同及CLI透传，不能混入新渲染参数', () => {
  const ask = { source: 'review-pair', before: { reviewId: 'a'.repeat(24), frameIndex: 0 }, after: { reviewId: 'b'.repeat(24), frameIndex: 1 } };
  assert.equal(normalizeReviewRequest(ask).count, undefined);
  assert.deepEqual(reviewOptionsOf({ source: 'review-pair', 'before-review': 'a'.repeat(24), 'after-review': 'b'.repeat(24), 'after-frame': '1' }).after, ask.after);
  assert.throws(() => normalizeReviewRequest({ ...ask, times: [0] })); assert.throws(() => normalizeReviewRequest({ source: 'review-pair', before: ask.before }));
  assert.throws(() => reviewOptionsOf({ source: 'current-project', 'before-frame': '0' }));
});
test('T4 标注意图来自冻结film，原字段摘要保留，兼容工程定位', () => fixture(async ({ reviews, project, film }) => {
  const r = await reviews.create(project, { source: 'current-project', times: [5] });
  assert.equal(r.sourceFacts.intents[0].value.text[0].role, 'essential');
  const p = await reviews.target(project, r.reviewId, 'frame', 0, true);
  assert.equal(p.engineering.status, 'verified-at-check'); assert.equal(p.engineering.timeMs, 5000);
  assert.equal(await readFile(join(project.path, 'film.html'), 'utf8'), film);
}));
test('T4 只改场景且film版本不变时也拒绝工程定位', () => fixture(async ({ reviews, project }) => {
  const r = await reviews.create(project, { source: 'current-project', times: [5] });
  await writeFile(join(project.path, '中文-scene.html'), 'changed scene without film edit');
  assert.equal((await reviews.target(project, r.reviewId, 'frame', 0, true)).engineering.reason, 'current-inputs-changed');
  assert.equal((await reviews.frame(project, r.reviewId, 0)).frame.sha256, r.frames[0].sha256);
}));
test('T4 两份已有图组合，无再渲染、不放大，回执与独立SHA可读', () => fixture(async ({ reviews, project, root }) => {
  const a = await reviews.create(project, { source: 'current-project', times: [5] });
  const b = await reviews.create(project, { source: 'current-project', times: [6], targetWidth: 64 });
  const pair = await reviews.create(project, { source: 'review-pair', before: { reviewId: a.reviewId, frameIndex: 0 }, after: { reviewId: b.reviewId, frameIndex: 0 }, targetWidth: 720 });
  assert.equal(pair.version, 4); assert.equal(pair.frames.length, 0); assert.equal(pair.filmRevision, null);
  const artifact = pair.artifacts[0]; assert.equal(artifact.presentation.actualCommonWidth, 64);
  assert.deepEqual(artifact.derivedFrom.map((f) => f.actualTime), [5, 6]); assert.equal(artifact.differences.preservedData.totalChanges, 0);
  const validate = new Ajv().compile(reviewContract.artifactSchema); assert.ok(validate(artifact), JSON.stringify(validate.errors));
  assert.equal(hash((await reviews.artifact(project, pair.reviewId, artifact.artifactId, artifact.sha256)).data), artifact.sha256);
  assert.deepEqual((await readdir(join(root, 'reviews', pair.reviewId))).sort(), ['artifact-revision-comparison.png', 'review.json']);
  await assert.rejects(reviews.create(project, { source: 'review-pair', before: { reviewId: a.reviewId, frameIndex: 0, expectedSha256: '0'.repeat(64) }, after: { reviewId: b.reviewId, frameIndex: 0 } }), (e) => e.code === 'digest-mismatch');
}));
test('T4 旧回执没有人工摘要时保留unknown，不能借live工程补造', () => fixture(async ({ reviews, project, root }) => {
  const a = await reviews.create(project, { source: 'current-project', times: [5] });
  const b = await reviews.create(project, { source: 'current-project', times: [5] });
  delete a.sourceFacts; await writeFile(join(root, 'reviews', a.reviewId, 'review.json'), JSON.stringify(a));
  const r = await reviews.create(project, { source: 'review-pair', before: { reviewId: a.reviewId, frameIndex: 0 }, after: { reviewId: b.reviewId, frameIndex: 0 } });
  assert.equal(r.artifacts[0].differences.preservedData.status, 'unknown');
}));
test('T4 新线性选区映射绑定提交输入，旧任务映射未知，视频改写拒绝', () => fixture(async ({ root, project, reviews, jobs }) => {
  const folder = join(root, 'capture'), snapshot = join(folder, 'input'); await mkdir(folder);
  const manifest = await snapshotFilm(project.path, snapshot);
  const out = join(root, 'movie.mp4'); await writeFile(out, 'original output bytes');
  const job = { id: 'a'.repeat(12), status: 'done', kind: 'video', out, outputs: [out], inputSnapshot: { filmRevision: manifest.filmRevision, manifest: join(folder, 'input-manifest.json'), reviewFactsSha256: reviewFactsDigest(manifest.reviewFacts), outputTimeToFilmTime: exportReviewMapping({ kind: 'video', range: [10, 12] }, manifest.filmRevision) } }; jobs.push(job);
  const r = await reviews.create(project, { source: 'export-job', job: job.id, times: [0.5] });
  assert.equal((await reviews.target(project, r.reviewId, 'frame', 0, true)).engineering.timeMs, 10500);
  const media = await reviews.video(project, r.reviewId, r.source.output.sha256); const chunks = [];
  for await (const chunk of media.handle.createReadStream({ start: 0, end: 7 })) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'original');
  await writeFile(out, 'modified output bytes');
  await assert.rejects(reviews.video(project, r.reviewId, r.source.output.sha256), (e) => e.code === 'stale');
  job.inputSnapshot.outputTimeToFilmTime = null;
  const old = await reviews.create(project, { source: 'export-job', job: job.id, times: [0.5] });
  assert.equal((await reviews.target(project, old.reviewId, 'frame', 0, true)).engineering.reason, 'time-mapping-unavailable');
}));
test('T4 编码点使用整数时间基，定位不向前舍入到上一帧', () => fixture(async ({ root, project, reviews, jobs }) => {
  const folder = join(root, 'fraction'), snapshot = join(folder, 'input'); await mkdir(folder);
  const manifest = await snapshotFilm(project.path, snapshot), out = join(root, 'fraction.mp4'); await writeFile(out, 'fixture bytes');
  jobs.push({ id: 'b'.repeat(12), status: 'done', kind: 'video', out, outputs: [out], inputSnapshot: { filmRevision: manifest.filmRevision, manifest: join(folder, 'input-manifest.json'), outputTimeToFilmTime: exportReviewMapping({ kind: 'video' }, manifest.filmRevision) } });
  const r = await reviews.create(project, { source: 'export-job', job: jobs[0].id, times: [.333333] });
  r.frames[0].actualPTSTicks = '4096'; r.frames[0].ptsTimeBase = '1/12288';
  await writeFile(join(root, 'reviews', r.reviewId, 'review.json'), JSON.stringify(r));
  const target = await reviews.target(project, r.reviewId, 'frame', 0, true);
  assert.equal(target.engineering.timeMs, 1000 / 3); assert.equal(target.playback.time, 1 / 3);
  delete r.timeOriginPTSTicks; await writeFile(join(root, 'reviews', r.reviewId, 'review.json'), JSON.stringify(r));
  const old = await reviews.target(project, r.reviewId, 'frame', 0, true); assert.equal(old.engineering.status, 'unavailable'); assert.equal(old.playback.canLocate, false);
}));
