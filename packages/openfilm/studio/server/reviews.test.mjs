import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { snapshotFilm } from './export-snapshot.mjs';
import { createReviews, normalizeReviewRequest } from './reviews.mjs';
import { reviewOptionsOf } from '../../../../desirecore/cli.mjs';
import { selectReviewFrames } from '../../src/review-frames.mjs';
import { tools } from '../../../../desirecore/mcp.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzu0AAAAASUVORK5CYII=', 'base64');
const hash = (data) => createHash('sha256').update(data).digest('hex');
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'video-review-'));
  const path = join(root, 'project'); await mkdir(path);
  const film = '<meta name="viewport" content="width=640, height=360"><section><iframe id="intro" src="scene.html#t=0,1"></iframe></section>';
  const scene = '<div id="title">人工标题</div><script>window.film={duration:1,frame(t){}}</script>';
  await writeFile(join(path, 'film.html'), film); await writeFile(join(path, 'scene.html'), scene);
  try { await run({ root, project: { id: 'project1', path }, film, scene }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const result = async (dir, requestedTime = 0, actualPTS = null) => {
  const file = join(dir, 'frame-0.png'); await writeFile(file, png);
  return { duration: 1, lastFramePolicy: actualPTS === null ? 'project-duration-minus-0.001s' : 'last-decoded-video-frame-pts', frames: [{ requestedTime, actualTime: 0, actualPTS, width: 1, height: 1, timeBasis: actualPTS === null ? 'project-seek' : 'encoded-pts', captureSha256: hash(png), captureBytes: png.length, file }] };
};

test('审片 CLI/MCP 共用精确来源和六帧预算，不接受任意输出路径或混用来源', () => {
  assert.deepEqual(reviewOptionsOf({ source: 'export-job', job: '123456abcdef', times: '0,2.5', last: true, 'max-edge': '720' }), { source: 'export-job', job: '123456abcdef', times: [0, 2.5], last: true, maxEdge: 720 });
  assert.equal(tools.find((tool) => tool.name === 'video_review').inputSchema.required[0], 'source');
  for (const ask of [{}, { source: 'file', path: '/a.mp4' }, { source: 'export-job' }, { source: 'current-project', job: '123456abcdef' }, { source: 'export-job', job: '../movie.mp4' }, { source: 'current-project', times: [0], count: 1 }, { source: 'current-project', count: 6, last: true }, { source: 'current-project', times: [-1] }, { source: 'current-project', times: [0, 0] }, { source: 'current-project', maxEdge: 4000 }]) assert.throws(() => normalizeReviewRequest(ask));
  assert.throws(() => reviewOptionsOf({ source: 'current-project', times: '0,' }));
  assert.equal(normalizeReviewRequest({ source: 'current-project' }).count, 4);
});

test('工程审片冻结真实本地输入并保留人工源，不把 PNG 指针说成已看图', () => fixture(async ({ root, project, film, scene }) => {
  const reviews = createReviews({ root: join(root, 'reviews'), drawProject: async (snapshot, dir) => {
    assert.notEqual(snapshot, project.path);
    assert.equal(await readFile(join(snapshot, 'scene.html'), 'utf8'), scene);
    return result(dir);
  } });
  const first = await reviews.create(project, { source: 'current-project', times: [0] });
  const second = await reviews.create(project, { source: 'current-project', times: [0] });
  assert.notEqual(first.reviewId, second.reviewId);
  assert.equal(first.observation, 'generated-not-viewed');
  assert.equal(first.sourceKind, 'current-project');
  assert.equal(first.filmRevision, hash(film).slice(0, 16));
  assert.equal(first.source.inputs.files.find((f) => f.path === 'scene.html').sha256, hash(scene));
  assert.equal(first.source.consistency, 'local-snapshot-with-live-before-after-checks');
  assert.equal(first.frames[0].actualPTS, null);
  assert.equal(first.frames[0].sha256, hash(png));
  assert.deepEqual((await reviews.frame(project, first.reviewId, 0, hash(png))).data, png);
  assert.equal(await readFile(join(project.path, 'film.html'), 'utf8'), film);
  assert.equal(await readFile(join(project.path, 'scene.html'), 'utf8'), scene);
  await assert.rejects(stat(join(root, 'reviews', first.reviewId, 'input')));
  await assert.rejects(reviews.read({ id: 'other' }, first.reviewId), (e) => e.code === 'receipt-mismatch');
  await assert.rejects(reviews.frame(project, first.reviewId, 1), (e) => e.code === 'missing-frame');
  await assert.rejects(reviews.frame(project, first.reviewId, 0, 'a'.repeat(64)), (e) => e.code === 'digest-mismatch');
  await writeFile(first.frames[0].path, Buffer.from('tampered'));
  await assert.rejects(reviews.frame(project, first.reviewId, 0), (e) => e.code === 'digest-mismatch');
  await rm(second.frames[0].path);
  await assert.rejects(reviews.frame(project, second.reviewId, 0), (e) => e.code === 'missing-frame');
}));

test('工程或场景在审片期间改变明确 stale，失败材料不发布', () => fixture(async ({ root, project }) => {
  const reviewRoot = join(root, 'reviews');
  const reviews = createReviews({ root: reviewRoot, drawProject: async (_snapshot, dir) => {
    await writeFile(join(project.path, 'scene.html'), '<h1>新的人工编辑</h1>');
    return result(dir);
  } });
  await assert.rejects(reviews.create(project, { source: 'current-project', times: [0] }), (e) => e.code === 'stale' && e.status === 409);
}));

test('旧完成导出只解码独立字节副本，来源版本不跟随当前工程、历史摘要不伪造', () => fixture(async ({ root, project }) => {
  const out = join(root, 'original.mp4'); await writeFile(out, 'encoded fixture');
  const job = { id: '123456abcdef', project: project.id, kind: 'video', status: 'done', out, outputs: [out], inputSnapshot: { filmRevision: 'fedcba9876543210', manifest: join(root, 'old-manifest.json'), limitations: ['static only'] } };
  let frozen;
  const reviews = createReviews({ root: join(root, 'reviews'), jobs: () => [job], decodeVideo: async (file, dir) => {
    frozen = file; assert.notEqual(file, out); assert.equal(await readFile(file, 'utf8'), 'encoded fixture');
    await writeFile(out, 'new unrelated bytes');
    await writeFile(join(project.path, 'film.html'), 'new current project');
    return result(dir, 'last', 0);
  } });
  const receipt = await reviews.create(project, { source: 'export-job', job: job.id, last: true });
  assert.equal(receipt.filmRevision, 'fedcba9876543210');
  assert.equal(receipt.source.output.sha256, hash('encoded fixture'));
  assert.equal(receipt.source.output.digestOrigin, 'observed-at-review');
  assert.equal(receipt.source.output.exportCompletionDigest, null);
  assert.equal(receipt.source.inputs.files, null);
  assert.equal(receipt.frames[0].requestedTime, 'last');
  assert.equal(receipt.frames[0].actualPTS, 0);
  await assert.rejects(stat(frozen));
  assert.deepEqual((await reviews.frame(project, receipt.reviewId, 0)).data, png);
}));

test('未完成、跨项目、非视频、无原版本的任务都不降级为当前工程', () => fixture(async ({ root, project }) => {
  let job = { id: '123456abcdef', kind: 'video', status: 'waiting', outputs: [] };
  const reviews = createReviews({ root: join(root, 'reviews'), jobs: (id) => id === project.id ? [job] : [], decodeVideo: () => { throw new Error('must not decode'); } });
  await assert.rejects(reviews.create(project, { source: 'export-job', job: job.id }), (e) => e.code === 'job-not-complete');
  await assert.rejects(reviews.create({ id: 'other' }, { source: 'export-job', job: job.id }), (e) => e.code === 'missing-job');
  job = { ...job, status: 'done', kind: 'audio' };
  await assert.rejects(reviews.create(project, { source: 'export-job', job: job.id }), (e) => e.code === 'unsupported-job');
  job = { ...job, kind: 'video', out: join(root, 'video.mp4'), outputs: [join(root, 'video.mp4')] };
  await assert.rejects(reviews.create(project, { source: 'export-job', job: job.id }), (e) => e.code === 'missing-source-version');
}));

test('帧文件改为其他文件链接也失败，不返回替代文件', () => fixture(async ({ root, project }) => {
  const reviews = createReviews({ root: join(root, 'reviews'), drawProject: (_s, dir) => result(dir) });
  const receipt = await reviews.create(project, { source: 'current-project', times: [0] });
  const other = join(root, 'other.png'); await writeFile(other, png);
  await rm(receipt.frames[0].path); await symlink(other, receipt.frames[0].path);
  await assert.rejects(reviews.frame(project, receipt.reviewId, 0), (e) => e.code === 'digest-mismatch');
}));


test('新完成导出沿提交时冻结清单返回场景和资源摘要，不从当前工程补历史摘要', () => fixture(async ({ root, project, scene }) => {
  const input = join(root, 'job', 'input'), snapshot = await snapshotFilm(project.path, input);
  const out = join(root, 'output.mp4'); await writeFile(out, 'encoded fixture');
  const job = { id: '123456abcdef', project: project.id, kind: 'video', status: 'done', out, outputs: [out], inputSnapshot: { filmRevision: snapshot.filmRevision, manifest: join(root, 'job', 'input-manifest.json'), limitations: snapshot.limitations } };
  await writeFile(join(project.path, 'scene.html'), 'new human scene');
  const reviews = createReviews({ root: join(root, 'reviews'), jobs: () => [job], decodeVideo: (_file, dir) => result(dir, 'last', 0) });
  const receipt = await reviews.create(project, { source: 'export-job', job: job.id, last: true });
  assert.equal(receipt.source.inputs.files.find((f) => f.path === 'scene.html').sha256, hash(scene));
  assert.equal(receipt.filmRevision, snapshot.filmRevision);
  assert.equal(receipt.source.output.outputTimeToFilmTime, null);
}));


test('相对 PTS 选择不受 2.1+.2 的浮点误差影响，也不误选真实更早的报告帧', () => {
  assert.ok(2.1 + 0.2 > 2.3);
  const chosen = selectReviewFrames([2.1, 2.299999, 2.3, 2.4], { times: [0.2], last: true });
  assert.equal(chosen.firstPTS, 2.1);
  assert.deepEqual(chosen.points, [{ requestedTime: 0.2, index: 2, pts: 2.3 }, { requestedTime: 'last', index: 3, pts: 2.4 }]);
  assert.equal(selectReviewFrames([2.1, 2.3, 2.4], { times: [0.2000000001] }).points[0].pts, 2.4);
  assert.equal(selectReviewFrames([-0.2, -0.1, 0, 0.1], { times: [0.2] }).points[0].pts, 0);
});

test('审片目录碰撞不能覆盖或清理既有回执与帧', () => fixture(async ({ root, project }) => {
  const reviewId = 'a'.repeat(24), reviewRoot = join(root, 'reviews'), existing = join(reviewRoot, reviewId);
  await mkdir(existing, { recursive: true });
  await writeFile(join(existing, 'review.json'), 'previous receipt'); await writeFile(join(existing, 'frame-0.png'), png);
  const reviews = createReviews({ root: reviewRoot, newId: () => reviewId, drawProject: () => { throw new Error('must not render'); } });
  await assert.rejects(reviews.create(project, { source: 'current-project', times: [0] }), (e) => e.code === 'review-id-collision');
  assert.equal(await readFile(join(existing, 'review.json'), 'utf8'), 'previous receipt');
  assert.deepEqual(await readFile(join(existing, 'frame-0.png')), png);
}));

test('关闭只取消本store在途与等待审片，清独占暂存并拒绝新请求', { timeout: 3000 }, () => fixture(async ({ root, project }) => {
  let entered;
  const began = new Promise((done) => { entered = done; });
  const reviewRoot = join(root, 'reviews');
  let drawings = 0;
  const reviews = createReviews({ root: reviewRoot, drawProject: async (_root, _dir, _request, _stage, { signal }) => {
    drawings += 1; entered();
    await new Promise((done, fail) => { signal.addEventListener('abort', () => fail(new Error('cancelled this review')), { once: true }); });
  } });
  const first = reviews.create(project, { source: 'current-project', times: [0] }).then(() => null, (e) => e);
  const queued = reviews.create(project, { source: 'current-project', times: [0] }).then(() => null, (e) => e);
  await began; assert.equal(reviews.busy(), true);
  await reviews.close(); await reviews.close();
  assert.equal((await first).code, 'review-stopped'); assert.equal((await queued).code, 'review-stopped');
  assert.equal(drawings, 1); assert.equal(reviews.busy(), false);
  assert.deepEqual(await (await import('node:fs/promises')).readdir(reviewRoot), []);
  await assert.rejects(reviews.create(project, { source: 'current-project', times: [0] }), (e) => e.code === 'review-stopped');
}));

test('整数 PTS/time_base 精确核大时间戳，不用 showinfo 的低精度显示放宽门槛', async () => {
  const { equalPTSTicks } = await import('../../src/review-frames.mjs');
  assert.equal(equalPTSTicks('153600512', '1/15360', '153600512', '1/15360'), true);
  assert.equal(equalPTSTicks('153600512', '1/15360', '307201024', '1/30720'), true);
  assert.equal(equalPTSTicks('153600512', '1/15360', '153600513', '1/15360'), false);
  assert.equal(equalPTSTicks('-12', '1/30', '-24', '1/60'), true);
  assert.equal(equalPTSTicks('12', '1/0', '12', '1/30'), false);
});

test('open 在 launch 等待期间取消会关闭刚返回的本次 browser 且不进入 FilmPage', { timeout: 3000 }, () => fixture(async ({ project }) => {
  const { chromium } = await import('playwright-core');
  const { EventEmitter } = await import('node:events');
  const { open } = await import('../../src/shared.mjs');
  const original = chromium.launch, controller = new AbortController();
  let entered, release, closes = 0;
  const began = new Promise((done) => { entered = done; });
  const released = new Promise((done) => { release = done; });
  const browser = new EventEmitter();
  browser.close = async () => { closes += 1; browser.emit('disconnected'); };
  chromium.launch = async () => { entered(); await released; return browser; };
  try {
    const opened = open(project.path, { signal: controller.signal }).then(() => null, (error) => error);
    await began; controller.abort(); release();
    assert.equal((await opened).name, 'AbortError'); assert.equal(closes, 1);
    const preAborted = new AbortController(); preAborted.abort();
    await assert.rejects(open(project.path, { signal: preAborted.signal }), (error) => error.name === 'AbortError');
    assert.equal(closes, 1);
  } finally { release(); chromium.launch = original; }
}));

test('firstLast规范补首尾且仍受六帧预算，CLI及MCP发现同源P1合同', async () => {
  const { reviewContract, reviewRequestSchema } = await import('./review-contract.mjs');
  const { command } = await import('../../../../desirecore/cli.mjs');
  let contract; await command(['review', '--schema'], (value) => { contract = value; });
  assert.equal(contract, reviewContract); assert.equal(contract.contractVersion, 3);
  assert.equal(tools.find((tool) => tool.name === 'video_review').inputSchema, reviewRequestSchema);
  assert.deepEqual(reviewOptionsOf({ source: 'current-project', 'first-last': true, 'target-width': '390' }), { source: 'current-project', firstLast: true, targetWidth: 390, times: [0], last: true, maxEdge: 1280 });
  assert.deepEqual(normalizeReviewRequest({ source: 'current-project', times: [0.25], firstLast: true }).times, [0, 0.25]);
  assert.equal(normalizeReviewRequest({ source: 'current-project', count: 5, firstLast: true }).count, 5);
  assert.throws(() => normalizeReviewRequest({ source: 'current-project', count: 6, firstLast: true }), (error) => error.code === 'over-budget');
  for (const targetWidth of [0, 63, 4097, 390.5]) assert.throws(() => normalizeReviewRequest({ source: 'current-project', targetWidth }));
});

test('首尾制品只消费本次精确帧buffer并保留真实时间，旧导出无当前DOM推论', () => fixture(async ({ root, project }) => {
  const out = join(root, 'encoded.mp4'); await writeFile(out, 'encoded');
  const job = { id: '123456abcdef', status: 'done', kind: 'video', out, outputs: [out], inputSnapshot: { filmRevision: 'a'.repeat(16) } };
  const combined = Buffer.from(png); combined.writeUInt32BE(2, 16);
  const reviews = createReviews({ root: join(root, 'reviews'), jobs: () => [job], decodeVideo: async (_file, dir) => {
    const first = await result(dir, 0, 2.1);
    const file = join(dir, 'frame-1.png'); await writeFile(file, png);
    first.frames[0].actualPTSTicks = '21'; first.frames[0].ptsTimeBase = '1/10';
    first.frames.push({ ...first.frames[0], requestedTime: 'last', actualTime: 0.2, actualPTS: 2.3, actualPTSTicks: '23', file });
    // 旧编码来源即便错误携带mock DOM结果，store也不得发表当前DOM结论。
    return { ...first, findings: [{ code: 'fake-current-dom' }] };
  }, composePNG: async (first, last, layout) => {
    assert.deepEqual(first, png); assert.deepEqual(last, png); assert.equal(layout.width, 2); return combined;
  } });
  const receipt = await reviews.create(project, { source: 'export-job', job: job.id, firstLast: true, targetWidth: 390 });
  assert.equal(receipt.frames.length, 2); assert.equal(receipt.artifacts.length, 1);
  assert.equal(receipt.frames[0].presentation.actualWidth, 1);
  assert.deepEqual(receipt.frames[0].presentation.limitedBy, ['source-no-upscale']);
  assert.equal(receipt.findings[0].status, 'unknown'); assert.equal(receipt.findings.some((f) => f.code === 'fake-current-dom'), false);
  const { reviewContract } = await import('./review-contract.mjs');
  const { Ajv } = await import('ajv'); const ajv = new Ajv({ allErrors: true });
  const validateArtifact = ajv.compile(reviewContract.artifactSchema), validateFinding = ajv.compile(reviewContract.findingSchema), validateCoverage = ajv.compile(reviewContract.coverageSchema);
  for (const artifact of receipt.artifacts) assert.equal(validateArtifact(artifact), true, JSON.stringify(validateArtifact.errors));
  for (const finding of receipt.findings) assert.equal(validateFinding(finding), true, JSON.stringify(validateFinding.errors));
  for (const coverage of receipt.coverage) assert.equal(validateCoverage(coverage), true, JSON.stringify(validateCoverage.errors));
  const artifact = receipt.artifacts[0];
  assert.equal(artifact.timeBasis, 'composite-not-timed-frame'); assert.equal(artifact.width, 2);
  assert.deepEqual(artifact.derivedFrom.map((frame) => frame.actualPTSTicks), ['21', '23']);
  assert.equal(receipt.totalImageBytes, png.length * 2 + combined.length);
  assert.deepEqual((await reviews.artifact(project, receipt.reviewId, 'first-last', artifact.sha256)).data, combined);
  await assert.rejects(reviews.artifact(project, receipt.reviewId, 'other'), (e) => e.code === 'missing-artifact');
  await assert.rejects(reviews.artifact(project, receipt.reviewId, 'first-last', 'a'.repeat(64)), (e) => e.code === 'digest-mismatch');
  const other = join(root, 'other.png'); await writeFile(other, combined);
  await rm(artifact.path); await symlink(other, artifact.path);
  await assert.rejects(reviews.artifact(project, receipt.reviewId, 'first-last'), (e) => e.code === 'digest-mismatch');
}));

test('捕获后的源PNG篡改或派生期间落盘变化均失败且不发布回执', () => fixture(async ({ root, project }) => {
  const captureChanged = createReviews({ root: join(root, 'reviews-a'), drawProject: async (_s, dir) => {
    const answer = await result(dir); await writeFile(answer.frames[0].file, 'changed'); return answer;
  } });
  await assert.rejects(captureChanged.create(project, { source: 'current-project', times: [0] }));
  const changedDuring = createReviews({ root: join(root, 'reviews-b'), drawProject: (_s, dir) => result(dir), resizePNG: async (buffer) => {
    const { readdir } = await import('node:fs/promises'); const reviewId = (await readdir(join(root, 'reviews-b')))[0];
    await writeFile(join(root, 'reviews-b', reviewId, 'frame-0.png'), 'changed during derivation'); return buffer;
  } });
  await assert.rejects(changedDuring.create(project, { source: 'current-project', times: [0] }), (e) => ['stale', 'digest-mismatch'].includes(e.code));
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(join(root, 'reviews-a')), []); assert.deepEqual(await readdir(join(root, 'reviews-b')), []);
}));

test('首尾制品与timed帧共用总字节预算，超界整体失败而非静默丢图', () => fixture(async ({ root, project }) => {
  const large = Buffer.alloc(3 * 1024 * 1024 + 128); png.copy(large);
  const reviews = createReviews({ root: join(root, 'reviews'), drawProject: async (_s, dir, request) => {
    const frames = [];
    for (const [index, requestedTime] of [...request.times, 'last'].entries()) {
      const file = join(dir, `frame-${index}.png`); await writeFile(file, large);
      frames.push({ requestedTime, actualTime: typeof requestedTime === 'number' ? requestedTime : 0.999, actualPTS: null, timeBasis: 'project-seek', width: 1, height: 1, captureSha256: hash(large), captureBytes: large.length, file });
    }
    return { duration: 1, frames };
  }, composePNG: async () => { const wide = Buffer.from(large); wide.writeUInt32BE(2, 16); return wide; } });
  await assert.rejects(reviews.create(project, { source: 'current-project', times: [0, 0.25], firstLast: true }), (e) => e.code === 'over-budget');
  assert.deepEqual(await (await import('node:fs/promises')).readdir(join(root, 'reviews')), []);
}));


test('公开review Schema离线发现不创建home或项目，也不读取无效运行配置', () => fixture(async ({ root }) => {
  const { command } = await import('../../../../desirecore/cli.mjs');
  const home = join(root, 'must-not-create'); let schema;
  await command(['review', '--schema', '--home', home], (value) => { schema = value; });
  assert.equal(schema.contractVersion, 3); assert.equal(schema.requestSchema.properties.source.enum[1], 'export-job');
  await assert.rejects(stat(home));
}));


test('resize返回新buffer时同inode原PNG变化在truncate前stale，不覆盖并发字节或发布回执', () => fixture(async ({ root, project }) => {
  const reviewRoot = join(root, 'reviews'), changed = Buffer.from(png); changed[changed.length - 1] ^= 1;
  let sameInode = false, directory;
  const reviews = createReviews({ root: reviewRoot, drawProject: async (_snapshot, dir) => { directory = dir; return result(dir); },
    resizePNG: async (buffer) => {
      const file = join(directory, 'frame-0.png'), before = await stat(file);
      await link(file, join(root, 'concurrent-writer.png'));
      await writeFile(file, changed); const after = await stat(file);
      sameInode = before.dev === after.dev && before.ino === after.ino;
      // 返新对象确保真正进入rewrite分支，而不是原buffer的发布前检查分支。
      return Buffer.from(buffer);
    },
  });
  // 自有临时hard link只用于在清理后核原inode字节，不能把已变化输入重写回旧PNG。
  await assert.rejects(reviews.create(project, { source: 'current-project', times: [0] }), (error) => {
    assert.equal(error.code, 'stale'); assert.match(error.message, /派生前原 PNG|派生期间原 PNG/); return true;
  });
  assert.equal(sameInode, true);
  assert.deepEqual(await readFile(join(root, 'concurrent-writer.png')), changed);
  assert.deepEqual(await (await import('node:fs/promises')).readdir(reviewRoot), []);
}));
