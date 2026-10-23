import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { sequenceWindow, sequencePoints, projectSequencePoints, lumaActivity, sequenceLayout, comparisonLayout } from './review-sequence.mjs';
import { createReviews, normalizeReviewRequest } from '../studio/server/reviews.mjs';
import { reviewContract } from '../studio/server/review-contract.mjs';
import { reviewOptionsOf } from '../../../desirecore/cli.mjs';
import { filmHtml } from './film-doc.mjs';
import { Ajv } from 'ajv';

const hash = (b) => createHash('sha256').update(b).digest('hex');
// 真实最小PNG，避免以只改尺寸头的坏编码充当组合输出。
function png(width, height) {
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const b of body) { crc ^= b; for (let k = 0; k < 8; k++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    const out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height, 0))), chunk('IEND', Buffer.alloc(0))]);
}

test('T3 窗口与CLI合同有界，三种制品互斥且旧请求仍兼容', () => {
  assert.equal(reviewContract.contractVersion, 3);
  assert.deepEqual(reviewOptionsOf({ source: 'current-project', times: '0', 'sequence-start': '0', 'sequence-end': '3', 'sequence-count': '8' }).sequence, { start: 0, end: 3, count: 8 });
  assert.deepEqual(reviewOptionsOf({ source: 'current-project', times: '0', 'compare-widths': '180,360', 'compare-frame': '0' }).compareWidths, [180, 360]);
  for (const ask of [{ start: 0, end: 31, count: 8 }, { start: 1, end: 1, count: 8 }, { start: 0, end: 1, count: 25 }]) assert.throws(() => sequenceWindow(ask));
  for (const ask of [
    { sequence: { start: 0, end: 3, count: 8 }, firstLast: true }, { sequence: { start: 0, end: 3, count: 8 }, compareWidths: [180, 360] },
    { compareWidths: [180, 180] }, { compareWidths: [180] }, { compareFrame: 0 }, { times: [0], compareWidths: [180, 360], compareFrame: 1 },
  ]) assert.throws(() => normalizeReviewRequest({ source: 'current-project', ...ask }));
  assert.throws(() => reviewOptionsOf({ source: 'current-project', 'sequence-start': '0' }));
  assert.equal(normalizeReviewRequest({ source: 'current-project', firstLast: true }).last, true);
});

test('T3 VFR和非零PTS按相对半开时间窗选择，重复观察点诚实保留，帧预算不隐式降采样', () => {
  const s = sequencePoints([2, 2.4, 2.9], { start: 0, end: 1, count: 8 });
  assert.deepEqual(s.eligible.map((x) => x.index), [0, 1, 2]);
  assert.equal(s.points.length, 8); assert.equal(s.points.at(-1).pts, 2.9);
  assert.equal(new Set(s.points.map((x) => x.index)).size, 3);
  assert.equal(sequencePoints([0, 0.1, 0.2], { start: 0.1, end: 0.2, count: 8 }).eligible.length, 1);
  assert.throws(() => sequencePoints([0], { start: 1, end: 2, count: 8 }), /没有实际/);
  assert.throws(() => sequencePoints(Array.from({ length: 1801 }, (_, i) => i / 100), { start: 0, end: 20, count: 8 }), /1800/);
  assert.throws(() => projectSequencePoints(1, { start: 0, end: 2, count: 8 }), /duration/);
});

test('T3 全选灰度事实保留真实间隔，不将相同像素和缺失相邻对打成失败或美学分', () => {
  const ask = { start: 0, end: 3, count: 8 }, pts = [{ time: 0 }, { time: 0.4 }, { time: 1.7 }];
  const value = lumaActivity(Buffer.from([0, 0, 0, 0, 255, 255]), { width: 2, height: 1 }, pts, ask);
  assert.equal(value.decodedFrames, 3); assert.equal(value.identicalAdjacentPairs, 1);
  assert.equal(value.windows[0].meanAbsoluteLumaDelta, 0); assert.equal(value.windows[1].maxAbsoluteLumaDelta, 1);
  assert.equal(value.windows[1].maximumFrameGapSeconds, 1.2999999999999998);
  assert.equal('qualityScore' in value, false); assert.equal('failed' in value, false);
  assert.throws(() => lumaActivity(Buffer.alloc(1), { width: 2, height: 1 }, pts, ask), /帧数/);
});

test('T3 同源尺寸布局不放大并明确整图cap，序列每格有时点且不超cap', () => {
  const c = comparisonLayout({ width: 320, height: 180 }, [180, 360, 720], 640);
  assert.ok(c.width <= 640 && c.height <= 640); assert.deepEqual(c.cells.map((x) => x.width), [180, 320, 320]);
  assert.ok(c.cells[1].limitedBy.includes('captured-source-no-upscale'));
  const capped = comparisonLayout({ width: 1280, height: 720 }, [180, 360, 720], 128);
  assert.ok(capped.cells.every((x) => x.limitedBy.includes('artifact-max-edge')));
  const s = sequenceLayout(Array.from({ length: 24 }, (_, i) => ({ width: 320, height: 180, actualTime: i / 3, requestedTime: i / 3, actualPTS: i / 3, timeBasis: 'encoded-pts' })), 640);
  assert.ok(s.width <= 640 && s.height <= 640); assert.equal(s.cells.length, 24); assert.equal(s.cells[23].actualTime, 23 / 3);
  assert.throws(() => sequenceLayout([{ width: 320, height: 180 }, { width: 160, height: 160 }], 640), /尺寸/);
});

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'review-observation-')), path = join(root, 'project'); await mkdir(path);
  const source = '<div id="title">人工标题</div><script>window.film={duration:3,width:320,height:180,frame(t){}}</script>';
  const film = filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ locked: true, clips: [{ id: 'scene', src: 'scene.html', at: 0, duration: 3, overrides: [{ at: '#title', text: '人工定稿' }] }] }] });
  await writeFile(join(path, 'film.html'), film); await writeFile(join(path, 'scene.html'), source);
  const original = png(320, 180);
  const drawProject = async (_snapshot, dir, request) => {
    await writeFile(join(dir, 'frame-0.png'), original);
    const item = { requestedTime: 0, actualTime: 0, actualPTS: null, timeBasis: 'project-seek', width: 320, height: 180, sourceWidth: 320, sourceHeight: 180, captureSha256: hash(original), captureBytes: original.length, file: join(dir, 'frame-0.png') };
    const sequence = request.sequence ? { frames: [], temporal: { status: 'partial', method: 'discrete-project-seeks' } } : null;
    if (sequence) for (let i = 0; i < request.sequence.count; i++) { const file = join(dir, `sequence-${i}.png`); await writeFile(file, original); sequence.frames.push({ ...item, requestedTime: i / 3, actualTime: i / 3, file }); }
    return { duration: 3, lastFramePolicy: 'project-duration-minus-0.001s', frames: [item], ...(sequence ? { sequence, sequenceFiles: sequence.frames.map((s) => s.file) } : {}) };
  };
  try { await run({ root, project: { id: 'fixture', path }, film, source, original, drawProject }); } finally { await rm(root, { recursive: true, force: true }); }
}

test('T3 序列回执绑定捕获摘要、时间与单独制品，清理私有中间图并保留人工源', () => fixture(async ({ root, project, film, source, original, drawProject }) => {
  const reviews = createReviews({ root: join(root, 'reviews'), drawProject, composeGrid: async (buffers, layout) => {
    assert.equal(buffers.length, 8); assert.ok(buffers.every((b) => hash(b) === hash(original))); return png(layout.width, layout.height);
  } });
  const r = await reviews.create(project, { source: 'current-project', times: [0], sequence: { start: 0, end: 3, count: 8 }, maxEdge: 640 });
  assert.equal(r.version, 3); assert.equal(r.temporal.status, 'partial'); assert.equal(r.temporal.source.filmRevision, r.filmRevision);
  assert.equal(r.artifacts[0].derivedFrom.length, 8); assert.equal(r.artifacts[0].derivedFrom[7].actualTime, 7 / 3);
  assert.equal(r.artifacts[0].artifactId, 'sequence'); assert.equal(r.artifacts[0].timeBasis, 'composite-not-timed-frame');
  const validate = new Ajv().compile(reviewContract.artifactSchema); assert.ok(validate(r.artifacts[0]), JSON.stringify(validate.errors));
  const a = await reviews.artifact(project, r.reviewId, 'sequence', r.artifacts[0].sha256); assert.equal(hash(a.data), r.artifacts[0].sha256);
  assert.deepEqual((await readdir(join(root, 'reviews', r.reviewId))).sort(), ['artifact-sequence.png', 'frame-0.png', 'review.json']);
  assert.equal(await readFile(join(project.path, 'film.html'), 'utf8'), film); assert.equal(await readFile(join(project.path, 'scene.html'), 'utf8'), source);
  await writeFile(r.artifacts[0].path, png(3, 2)); await assert.rejects(reviews.artifact(project, r.reviewId, 'sequence'), (e) => e.code === 'digest-mismatch');
}));

test('T3 尺寸对照使用缩小前同一捕获，不把已缩成64的帧放大到256', () => fixture(async ({ root, project, original, drawProject }) => {
  const reviews = createReviews({ root: join(root, 'reviews'), drawProject, resizePNG: async (_b, p) => png(p.actualWidth, p.actualHeight), composeGrid: async (buffers, layout) => {
    assert.ok(buffers.every((b) => hash(b) === hash(original))); assert.deepEqual(layout.cells.map((x) => x.width), [64, 128, 256]); return png(layout.width, layout.height);
  } });
  const r = await reviews.create(project, { source: 'current-project', times: [0], targetWidth: 64, compareWidths: [64, 128, 256], maxEdge: 640 });
  assert.equal(r.frames[0].width, 64); const a = r.artifacts[0]; assert.equal(a.kind, 'size-comparison');
  assert.equal(a.derivedFrom[0].captureSha256, hash(original)); assert.notEqual(a.derivedFrom[0].captureSha256, r.frames[0].sha256);
  assert.equal(a.derivedFrom[0].publishedFrameSha256, r.frames[0].sha256); assert.equal(a.textProjections.length, 0);
  const validate = new Ajv().compile(reviewContract.artifactSchema); assert.ok(validate(a), JSON.stringify(validate.errors));
  assert.equal(hash((await reviews.artifact(project, r.reviewId, 'size-comparison', a.sha256)).data), a.sha256);
  await assert.rejects(reviews.artifact(project, r.reviewId, '../sequence'), (e) => e.code === 'missing-artifact');
}));

test('T3 关闭会中断新组合并等候队列结束，不保留半成回执或删除其他review', () => fixture(async ({ root, project, drawProject }) => {
  let entered;
  const ready = new Promise((done) => { entered = done; });
  const storage = join(root, 'reviews'); await mkdir(storage); await mkdir(join(storage, 'unrelated'));
  await writeFile(join(storage, 'unrelated', 'keep.txt'), '原审片');
  const reviews = createReviews({ root: storage, drawProject, composeGrid: (_buffers, _layout, { signal }) => new Promise((_done, fail) => {
    entered(); signal.addEventListener('abort', () => fail(new Error('本观察停止')), { once: true });
  }) });
  const pending = reviews.create(project, { source: 'current-project', times: [0], sequence: { start: 0, end: 3, count: 8 }, maxEdge: 640 });
  const rejected = assert.rejects(pending, (e) => e.code === 'review-stopped');
  await ready; assert.equal(reviews.busy(), true); await reviews.close(); await rejected;
  assert.equal(reviews.busy(), false); assert.deepEqual(await readdir(storage), ['unrelated']);
  assert.equal(await readFile(join(storage, 'unrelated', 'keep.txt'), 'utf8'), '原审片');
}));
