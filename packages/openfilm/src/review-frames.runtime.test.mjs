import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createReviews } from '../studio/server/reviews.mjs';
import { filmHtml } from './film-doc.mjs';
import { observationGridPNG } from './review-derivatives.mjs';
import { comparisonLayout, sequenceLayout } from './review-sequence.mjs';
import { reviewContract } from '../studio/server/review-contract.mjs';
import { Ajv } from 'ajv';

const sha = (data) => createHash('sha256').update(data).digest('hex');
const enabled = process.env.VIDEO_CREATION_REVIEW_RUNTIME === '1';

test('T3 真实标签组合不覆盖原画且保留未缩放区域的RGBA像素', { skip: !enabled, timeout: 60_000 }, async () => {
  const source = execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=0x234567@0.5:s=160x90,format=rgba', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']);
  const decode = (png, filter) => execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', ...(filter ? ['-vf', filter] : []), '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'], { input: png });
  const original = decode(source); assert.equal(original[3], 127);
  const sequence = Array.from({ length: 8 }, (_, i) => ({ width: 160, height: 90, actualTime: i / 3, requestedTime: i / 3 }));
  for (const layout of [comparisonLayout({ width: 160, height: 90 }, [80, 160], 640), sequenceLayout(sequence, 1280)]) {
    const combined = await observationGridPNG(layout.cells.map(() => source), layout), c = layout.cells.at(-1);
    assert.equal(c.width, 160); assert.equal(c.height, 90);
    assert.deepEqual(decode(combined, `crop=${c.width}:${c.height}:${c.x}:${c.y}`), original);
  }
});

test('T3 真实VFR窗口量化全部帧并合成8格实际PTS，重复格不伪造不同帧', { skip: !enabled, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-sequence-vfr-'));
  try {
    const out = join(root, 'vfr.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=1', '-vf', 'select=eq(n\\,0)+eq(n\\,1)+eq(n\\,4)+eq(n\\,9)', '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out], { timeout: 20_000 });
    const original = sha(await readFile(out)), project = { id: 'vfr-sequence', path: root };
    const job = { id: '123456abcdef', kind: 'video', status: 'done', out, outputs: [out], inputSnapshot: { filmRevision: 'a'.repeat(16), manifest: join(root, 'missing.json') } };
    const reviews = createReviews({ root: join(root, 'reviews'), jobs: () => [job] });
    const r = await reviews.create(project, { source: 'export-job', job: job.id, times: [0], maxEdge: 640, sequence: { start: 0, end: 1, count: 8 } });
    assert.equal(r.version, 3); assert.equal(r.temporal.decodedFrames, 4); assert.equal(r.temporal.status, 'observed');
    assert.equal(r.temporal.source.outputSha256, original); assert.equal(r.temporal.analysisRaster.width, 96);
    const validateTemporal = new Ajv().compile(reviewContract.temporalSchema);
    assert.ok(validateTemporal(r.temporal), JSON.stringify(validateTemporal.errors));
    const peak = r.temporal.windows[0].peakAdjacentPair;
    assert.ok(peak && peak.meanAbsoluteLumaDelta === r.temporal.windows[0].maxAbsoluteLumaDelta);
    assert.equal(peak.to.sourceFrameIndex, peak.from.sourceFrameIndex + 1);
    const [tickNumerator, tickDenominator] = peak.to.ptsTimeBase.split('/').map(Number);
    assert.equal(peak.from.ptsTimeBase, peak.to.ptsTimeBase);
    assert.equal(Number(peak.from.actualPTSTicks) * tickNumerator / tickDenominator, peak.from.actualTime);
    assert.equal(Number(peak.to.actualPTSTicks) * tickNumerator / tickDenominator, peak.to.actualTime);
    const a = r.artifacts[0]; assert.equal(a.derivedFrom.length, 8);
    // 时间均匀的格子并不等于覆盖每一VFR帧；0.1秒帧仍由全帧活动分析计入。
    assert.deepEqual(a.derivedFrom.map((x) => x.sourceFrameIndex), [0, 2, 2, 2, 3, 3, 3, 3]);
    assert.equal(a.derivedFrom.at(-1).actualPTS, 0.9); assert.ok(a.derivedFrom.every((x) => x.actualPTSTicks && x.ptsTimeBase));
    assert.equal(sha((await reviews.artifact(project, r.reviewId, 'sequence', a.sha256)).data), a.sha256);
    assert.deepEqual((await readdir(join(root, 'reviews', r.reviewId))).sort(), ['artifact-sequence.png', 'frame-0.png', 'review.json']);
    assert.equal(sha(await readFile(out)), original); await reviews.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('T3 真实工程序列只是离散seek，保留人工DOM和锁且不借编码全帧结论', { skip: !enabled, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-sequence-project-'));
  try {
    const project = { id: 'project-sequence', path: join(root, 'project') }; await mkdir(project.path);
    const scene = '<body style="margin:0;background:#123;color:white"><div id="title" style="font-size:24px">原文字</div><script>window.film={duration:1,width:320,height:180,frame(t){document.getElementById("title").style.opacity=t}}</script>';
    const film = filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ locked: true, clips: [{ id: 'scene', src: 'scene.html', at: 0, duration: 1, overrides: [{ at: '#title', text: '人工定稿' }] }] }] });
    await writeFile(join(project.path, 'film.html'), film); await writeFile(join(project.path, 'scene.html'), scene);
    const reviews = createReviews({ root: join(root, 'reviews') });
    const r = await reviews.create(project, { source: 'current-project', times: [0.5], maxEdge: 640, sequence: { start: 0, end: 1, count: 8 } });
    assert.equal(r.temporal.status, 'partial'); assert.equal(r.temporal.observedSamples, 8); assert.equal(r.temporal.decodedFrames, undefined);
    assert.ok(r.artifacts[0].derivedFrom.every((s) => s.actualPTS === null && s.timeBasis === 'project-seek'));
    assert.equal(r.artifacts[0].derivedFrom.at(-1).actualTime, 0.999);
    assert.equal(sha((await reviews.artifact(project, r.reviewId, 'sequence', r.artifacts[0].sha256)).data), r.artifacts[0].sha256);
    assert.equal(await readFile(join(project.path, 'film.html'), 'utf8'), film); assert.equal(await readFile(join(project.path, 'scene.html'), 'utf8'), scene);
    await reviews.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('T3 真实多尺寸PNG来自同一捕获，投影按每格实际宽度且SVG仍unknown', { skip: !enabled, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-comparison-'));
  try {
    const project = { id: 'size-compare', path: join(root, 'project') }; await mkdir(project.path);
    const scene = '<body style="margin:0;background:#123;color:white"><div id="title" style="font-size:24px">人工标题</div><svg viewBox="0 0 320 100" width="160" height="50"><text id="svg-title" x="10" y="30" fill="white" style="font-size:24px">SVG</text></svg><script>window.film={duration:1,width:320,height:180,frame(t){}}</script>';
    const film = filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ locked: true, clips: [{ id: 'scene', src: 'scene.html', at: 0, duration: 1 }] }] });
    await writeFile(join(project.path, 'film.html'), film); await writeFile(join(project.path, 'scene.html'), scene);
    const reviews = createReviews({ root: join(root, 'reviews') });
    const r = await reviews.create(project, { source: 'current-project', times: [0.5], targetWidth: 64, compareWidths: [80, 160, 320], maxEdge: 640 });
    const a = r.artifacts[0]; assert.deepEqual(a.layout.cells.map((x) => x.width), [80, 160, 320]);
    const title = a.textProjections.find((x) => x.selector === '#title'), svg = a.textProjections.find((x) => x.selector === '#svg-title');
    assert.deepEqual(title.sizes.map((x) => x.targetFontSizePx), [6, 12, 24]);
    assert.ok(svg.sizes.every((x) => x.targetFontSizePx === null)); assert.notEqual(a.derivedFrom[0].captureSha256, r.frames[0].sha256);
    assert.equal(sha((await reviews.artifact(project, r.reviewId, 'size-comparison', a.sha256)).data), a.sha256);
    assert.equal(await readFile(join(project.path, 'film.html'), 'utf8'), film); assert.equal(await readFile(join(project.path, 'scene.html'), 'utf8'), scene);
    await reviews.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('真实 VFR 视频按 PTS 选择指定时间与末帧，原任务版本不跟随当前工程', { skip: !enabled, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-review-encoded-'));
  try {
    const out = join(root, 'vfr.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=1', '-vf', 'select=eq(n\\,0)+eq(n\\,1)+eq(n\\,4)+eq(n\\,9)', '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out], { timeout: 20_000 });
    const original = sha(await readFile(out)), project = { id: 'vfr-project', path: join(root, 'unused-current') };
    const job = { id: '123456abcdef', project: project.id, kind: 'video', status: 'done', out, outputs: [out], inputSnapshot: { filmRevision: 'a'.repeat(16), manifest: join(root, 'historical-missing-manifest.json') } };
    const reviews = createReviews({ root: join(root, 'reviews'), jobs: () => [job] });
    const receipt = await reviews.create(project, { source: 'export-job', job: job.id, times: [0, 0.15], last: true, maxEdge: 128 });
    assert.equal(receipt.filmRevision, 'a'.repeat(16));
    assert.deepEqual(receipt.frames.map((f) => f.requestedTime), [0, 0.15, 'last']);
    assert.deepEqual(receipt.frames.map((f) => f.actualPTS), [0, 0.4, 0.9]);
    assert.deepEqual(receipt.frames.map((f) => f.frameIndex), [0, 2, 3]);
    for (const frame of receipt.frames) {
      assert.equal(frame.timeBasis, 'encoded-pts'); assert.equal(frame.width, 128); assert.equal(frame.height, 72);
      const read = await reviews.frame(project, receipt.reviewId, frame.index, frame.sha256);
      assert.equal(sha(read.data), frame.sha256); assert.equal(read.data.length, frame.bytes);
    }
    assert.equal(receipt.source.output.sha256, original);
    assert.equal(receipt.source.output.exportCompletionDigest, null);
    assert.equal(sha(await readFile(out)), original);
    assert.deepEqual((await readdir(join(root, 'reviews', receipt.reviewId))).sort(), ['frame-0.png', 'frame-1.png', 'frame-2.png', 'review.json']);
    await assert.rejects(reviews.create(project, { source: 'export-job', job: job.id, times: [1] }), /之后没有编码帧/);
    const nearEnd = await reviews.create(project, { source: 'export-job', job: job.id, times: [0.8] });
    assert.equal(nearEnd.frames[0].actualPTS, 0.9);
    assert.deepEqual(nearEnd.encodedRange, { firstPTS: 0, lastPTS: 0.9 });
    assert.equal(nearEnd.durationOrigin, 'container-format-metadata');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('真实 Chromium 工程预览保留人工 DOM/轨道锁并区分末态与编码 PTS', { skip: !enabled, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-review-preview-'));
  try {
    const project = { id: 'preview-project', path: join(root, 'project') }; await mkdir(project.path);
    const scene = '<!doctype html><body style="margin:0;background:#123;color:#ffbf69"><div id="title">源码标题</div><script>window.film={duration:1,width:320,height:180,frame(t){document.body.style.transform=`translateX(${t*10}px)`}}</script>';
    const film = filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ locked: true, clips: [{ id: 'scene', src: 'scene.html', at: 0, duration: 1, overrides: [{ at: '#title', text: '人工定稿' }] }] }] });
    await writeFile(join(project.path, 'film.html'), film); await writeFile(join(project.path, 'scene.html'), scene);
    const reviews = createReviews({ root: join(root, 'reviews') });
    const receipt = await reviews.create(project, { source: 'current-project', times: [0.25], last: true, maxEdge: 128 });
    assert.equal(receipt.sourceKind, 'current-project');
    assert.equal(receipt.observation, 'generated-not-viewed');
    assert.equal(receipt.lastFramePolicy, 'project-duration-minus-0.001s');
    assert.deepEqual(receipt.frames.map((f) => f.actualPTS), [null, null]);
    assert.deepEqual(receipt.frames.map((f) => f.actualTime), [0.25, 0.999]);
    assert.equal(receipt.source.inputs.files.find((f) => f.path === 'scene.html').sha256, sha(scene));
    for (const frame of receipt.frames) { assert.equal(frame.width, 128); assert.equal(frame.height, 72); assert.equal(sha((await reviews.frame(project, receipt.reviewId, frame.index)).data), frame.sha256); }
    assert.equal(await readFile(join(project.path, 'film.html'), 'utf8'), film);
    assert.equal(await readFile(join(project.path, 'scene.html'), 'utf8'), scene);
    assert.deepEqual((await readdir(join(root, 'reviews', receipt.reviewId))).sort(), ['frame-0.png', 'frame-1.png', 'review.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('非零起始 PTS 明确映射到首视频帧相对播放时间，保留原始 PTS 而不冒充原 film 时间', { skip: !enabled, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-review-offset-'));
  try {
    const out = join(root, 'offset.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=4:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-output_ts_offset', '2', out], { timeout: 20_000 });
    const project = { id: 'offset-project', path: join(root, 'unused-current') };
    const job = { id: '123456abcdef', project: project.id, kind: 'video', status: 'done', ask: { kind: 'video', range: [5, 6] }, out, outputs: [out], inputSnapshot: { filmRevision: 'b'.repeat(16), manifest: join(root, 'historical-missing-manifest.json') } };
    const reviews = createReviews({ root: join(root, 'reviews'), jobs: () => [job] });
    const receipt = await reviews.create(project, { source: 'export-job', job: job.id, times: [0, 0.1], last: true, maxEdge: 128 });
    assert.equal(receipt.timeOrigin, 'first-decoded-video-frame');
    assert.equal(receipt.timeOriginPTS, 2);
    assert.deepEqual(receipt.frames.map((f) => f.requestedTime), [0, 0.1, 'last']);
    assert.deepEqual(receipt.frames.map((f) => f.actualTime), [0, 0.25, 0.75]);
    assert.deepEqual(receipt.frames.map((f) => f.actualPTS), [2, 2.25, 2.75]);
    assert.equal(receipt.source.output.outputTimeToFilmTime, null);
    assert.deepEqual(receipt.encodedRange, { firstPTS: 2, lastPTS: 2.75 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('大 PTS 三帧只核整数时间基，精确画面不会因 showinfo 浮点显示被误拒', { skip: !enabled, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-review-large-pts-'));
  try {
    const out = join(root, 'large.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=0.1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-output_ts_offset', '10000', out], { timeout: 20_000 });
    const original = sha(await readFile(out)), project = { id: 'large-pts', path: root };
    const job = { id: '123456abcdef', project: project.id, kind: 'video', status: 'done', out, outputs: [out], inputSnapshot: { filmRevision: 'c'.repeat(16), manifest: join(root, 'missing-manifest.json') } };
    const reviews = createReviews({ root: join(root, 'reviews'), jobs: () => [job] });
    const receipt = await reviews.create(project, { source: 'export-job', job: job.id, times: [0, 0.02], last: true, maxEdge: 128 });
    assert.deepEqual(receipt.frames.map((frame) => frame.actualPTS), [10000, 10000.033333, 10000.066667]);
    assert.deepEqual(receipt.frames.map((frame) => frame.actualPTSTicks), ['153600000', '153600512', '153601024']);
    assert.ok(receipt.frames.every((frame) => frame.ptsTimeBase === '1/15360'));
    assert.equal(sha(await readFile(out)), original);
    await reviews.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('真实单例 Chromium 审片在 ready 等待期间关闭会释放自有资源并清临时输入', { skip: !enabled, timeout: 30_000 }, async () => {
  const { createServer } = await import('node:http');
  const root = await mkdtemp(join(tmpdir(), 'video-review-close-'));
  let observer, reviews;
  try {
    let entered;
    const ready = new Promise((done) => { entered = done; });
    observer = createServer((_request, response) => { response.end('ready'); entered(); });
    await new Promise((done) => observer.listen(0, '127.0.0.1', done));
    const port = observer.address().port, project = { id: 'closing-preview', path: join(root, 'project') }; await mkdir(project.path);
    const scene = `<!doctype html><script>window.film={duration:1,width:160,height:90,async ready(){await fetch('http://127.0.0.1:${port}/entered',{mode:'no-cors'});await new Promise(()=>{});},frame(t){}}</script>`;
    const film = filmHtml({ stage: { w: 160, h: 90 }, tracks: [{ locked: true, clips: [{ id: 'scene', src: 'scene.html', at: 0, duration: 1 }] }] });
    await writeFile(join(project.path, 'film.html'), film); await writeFile(join(project.path, 'scene.html'), scene);
    const reviewRoot = join(root, 'reviews'); reviews = createReviews({ root: reviewRoot });
    const pending = reviews.create(project, { source: 'current-project', times: [0] }).then(() => null, (error) => error);
    await ready;
    assert.equal(reviews.busy(), true); await reviews.close();
    assert.equal((await pending).code, 'review-stopped'); assert.equal(reviews.busy(), false);
    assert.deepEqual(await readdir(reviewRoot), []);
    assert.equal(await readFile(join(project.path, 'film.html'), 'utf8'), film);
    assert.equal(await readFile(join(project.path, 'scene.html'), 'utf8'), scene);
  } finally {
    await reviews?.close();
    if (observer) { observer.closeAllConnections(); await new Promise((done) => observer.close(done)); }
    await rm(root, { recursive: true, force: true });
  }
});

test('P1真实编码目标图和首尾组合只派生固定PNG，整图cap与整数PTS来源可复核', { skip: !enabled, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-review-p1-encoded-'));
  let reviews;
  try {
    const out = join(root, 'encoded.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=4:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-output_ts_offset', '2', out], { timeout: 20_000 });
    const original = sha(await readFile(out)), project = { id: 'p1-encoded', path: root };
    const job = { id: '123456abcdef', kind: 'video', status: 'done', out, outputs: [out], inputSnapshot: { filmRevision: 'd'.repeat(16), manifest: join(root, 'missing.json') } };
    reviews = createReviews({ root: join(root, 'reviews'), jobs: () => [job] });
    const receipt = await reviews.create(project, { source: 'export-job', job: job.id, targetWidth: 96, firstLast: true, maxEdge: 128 });
    assert.deepEqual(receipt.frames.map((frame) => frame.requestedTime), [0, 'last']);
    assert.deepEqual(receipt.frames.map((frame) => frame.actualPTS), [2, 2.75]);
    assert.deepEqual(receipt.frames.map((frame) => frame.actualTime), [0, 0.75]);
    assert.ok(receipt.frames.every((frame) => frame.actualPTSTicks && frame.ptsTimeBase));
    assert.ok(receipt.frames.every((frame) => frame.width === 96 && frame.height === 54 && frame.presentation.sourceWidth === 320 && frame.presentation.captureWidth === 128));
    const artifact = receipt.artifacts[0];
    assert.equal(artifact.width, 128); assert.equal(artifact.height, 36); assert.equal(artifact.layout.maxEdge, 128);
    assert.deepEqual(artifact.layout.cells.map((cell) => [cell.width, cell.height, cell.x]), [[64, 36, 0], [64, 36, 64]]);
    assert.equal(artifact.timeBasis, 'composite-not-timed-frame');
    assert.deepEqual(artifact.derivedFrom.map((frame) => frame.sha256), receipt.frames.map((frame) => frame.sha256));
    for (const [index, frame] of receipt.frames.entries()) {
      const reference = execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-i', frame.path, '-vf', 'scale=64:36:flags=lanczos,format=rgba', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
      const cell = execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-i', artifact.path, '-vf', `crop=64:36:${index * 64}:0,format=rgba`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
      assert.equal(sha(cell), sha(reference));
      assert.equal(sha((await reviews.frame(project, receipt.reviewId, index, frame.sha256)).data), frame.sha256);
    }
    assert.equal(sha((await reviews.artifact(project, receipt.reviewId, 'first-last', artifact.sha256)).data), artifact.sha256);
    assert.equal(receipt.findings[0].status, 'unknown'); assert.equal(receipt.coverage[0].status, 'unknown');
    assert.equal(sha(await readFile(out)), original);
    assert.deepEqual((await readdir(join(root, 'reviews', receipt.reviewId))).sort(), ['artifact-first-last.png', 'frame-0.png', 'frame-1.png', 'review.json']);
  } finally { await reviews?.close(); await rm(root, { recursive: true, force: true }); }
});

test('P1真实Chromium在同求帧窗口测文字与裁切，目标图和组合不改人工锁', { skip: !enabled, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-review-p1-dom-'));
  let reviews;
  try {
    const project = { id: 'p1-dom', path: join(root, 'project') }; await mkdir(project.path);
    const scene = '<!doctype html><body style="margin:0;background:#123;color:white"><div id="tiny" style="position:absolute;left:8px;top:8px;font-size:8px">细字</div><div id="title" style="position:absolute;left:310px;top:20px;white-space:nowrap;font-size:16px">原始标题</div><canvas width="40" height="20"></canvas><svg width="80" height="40" viewBox="0 0 40 20" style="position:absolute;left:80px;top:80px"><text id="svg-title" x="0" y="12" font-size="8">SVG</text></svg><script>window.film={duration:1,width:320,height:180,frame(t){document.body.style.background=t>0.5?"#234":"#123"}}</script>';
    const film = filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ locked: true, clips: [{ id: 'scene', src: 'scene.html', at: 0, duration: 1, overrides: [{ at: '#title', text: '人工定稿' }] }] }] });
    await writeFile(join(project.path, 'film.html'), film); await writeFile(join(project.path, 'scene.html'), scene);
    reviews = createReviews({ root: join(root, 'reviews') });
    const receipt = await reviews.create(project, { source: 'current-project', firstLast: true, targetWidth: 96, maxEdge: 128 });
    assert.equal(receipt.observation, 'generated-not-viewed'); assert.equal(receipt.frames.length, 2); assert.equal(receipt.artifacts.length, 1);
    assert.ok(receipt.findings.some((finding) => finding.source.clipId === 'scene' && finding.selector === '#tiny' && finding.status === 'observed'));
    assert.ok(receipt.findings.some((finding) => finding.selector === '#title' && finding.severity === 'warning'));
    assert.ok(receipt.coverage.some((item) => item.status === 'unknown'));
    assert.ok(receipt.findings.filter((finding) => finding.source.page === 'scene.html').every((finding) => finding.source.inputSha256 === sha(scene) && finding.source.filmRevision === receipt.filmRevision));
    assert.equal(receipt.artifacts[0].timeBasis, 'composite-not-timed-frame');
    const svg = receipt.findings.filter((item) => item.selector === '#svg-title' && item.code === 'dom-text-size');
    assert.equal(svg.length, 2);
    assert.ok(svg.every((item) => item.status === 'observed' && item.measurement.fontSizeCssPx === 8 && item.measurement.targetFontSizePx === null && item.bounds.width > 0));
    assert.ok(receipt.findings.some((item) => item.selector === '#tiny' && item.code === 'dom-text-size' && item.measurement.targetFontSizePx === 2.4));
    assert.ok(receipt.coverage.some((item) => item.code === 'text-target-projection' && item.status === 'unknown' && item.details.projectedSamples < item.details.textSamples));
    const { look } = await import('./look.mjs');
    const inspected = await look([project.path, '0'], { targetWidth: 96, offline: true, root: project.path });
    assert.equal(typeof inspected.ok, 'boolean'); assert.ok(Array.isArray(inspected.lines)); assert.ok(Array.isArray(inspected.files));
    assert.ok(inspected.findings.some((item) => item.code === 'dom-text-size' && item.source.kind === 'live-check' && item.source.consistency === 'live-files-unfenced'));
    assert.ok(inspected.coverage.some((item) => item.code === 'source-version' && item.details.frozen === false));
    assert.ok(inspected.findings.some((item) => item.selector === '#svg-title' && item.measurement.targetFontSizePx === null));
    for (const image of [...receipt.frames, ...receipt.artifacts]) { assert.ok(Math.max(image.width, image.height) <= 128); assert.equal(sha(await readFile(image.path)), image.sha256); }
    assert.equal(await readFile(join(project.path, 'film.html'), 'utf8'), film); assert.equal(await readFile(join(project.path, 'scene.html'), 'utf8'), scene);
  } finally { await reviews?.close(); await rm(root, { recursive: true, force: true }); }
});


test('P0 真实完整工程图含隔离字幕和强调，测完整边界/同刻信息碰撞并保留锁与原字节', { skip: !enabled, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-review-composition-'));
  try {
    const project = { id: 'complete-picture', path: join(root, 'project') }; await mkdir(project.path); await mkdir(join(project.path, '.film'));
    execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', join(project.path, 'voice.wav')]);
    const scene = '<body style="margin:0;background:#123"><div id="info" style="position:absolute;left:40px;top:500px;width:240px;height:50px;background:#345;color:white">锁定的信息</div><script>window.film={duration:1,width:320,height:640,frame(t){}}</script>';
    const intent = JSON.stringify({ text: [{ role: 'essential', selector: '#info', description: '必要图解' }] });
    const film = filmHtml({ stage: { w: 320, h: 640 }, tracks: [{ locked: true, clips: [{ id: 'scene', src: 'scene.html', at: 0, duration: 1, attrs: { 'data-review-intent': intent }, overrides: [{ at: '#info', text: '人工锁定信息' }] }] }, { clips: [{ id: 'voice', src: 'voice.wav', time: [0, 1], at: 0 }] }] });
    const vtt = 'WEBVTT\n\n00:00.000 --> 00:00.600\nOne <c.emphasis>KEYWORD</c.emphasis>\n';
    const style = JSON.stringify({ on: true, pos: { x: .5, y: .82 }, font: { sizePct: 10 }, stroke: { widthEm: .1, color: '#000000' }, shadow: { dxEm: 0, dyEm: .1, blurEm: .1, color: '#000000' }, karaoke: null });
    await writeFile(join(project.path, 'film.html'), film); await writeFile(join(project.path, 'scene.html'), scene); await writeFile(join(project.path, 'voice.vtt'), vtt); await writeFile(join(project.path, '.film/subtitles.json'), style);
    const reviews = createReviews({ root: join(root, 'reviews') });
    const r = await reviews.create(project, { source: 'current-project', times: [.3, .8], maxEdge: 640, informationSafeArea: { top: .15, bottom: .15 }, compareWidths: [180, 320] });
    assert.equal(r.source.subtitles.enabled, true); assert.equal(r.source.subtitles.cueCount, 1); assert.equal(r.source.subtitles.styleInput.sha256, sha(style));
    assert.equal(r.source.inputs.files.find((f) => f.path === 'voice.vtt').sha256, sha(vtt));
    const caption = r.findings.find((f) => f.code === 'subtitle-information-bounds');
    assert.equal(caption.status, 'observed'); assert.equal(caption.bounds.coordinateSpace, 'film-pixels'); assert.equal(caption.measurement.safeAreaRelation, 'outside'); assert.equal(caption.severity, 'warning');
    assert.ok(r.findings.some((f) => f.code === 'subtitle-information-overlap'));
    assert.ok(r.coverage.some((c) => c.code === 'studio-subtitle-layer' && c.details.rendered === true));
    assert.ok(r.coverage.some((c) => c.code === 'studio-subtitle-layer' && c.details.reason === 'no-active-cue'));
    const active = await reviews.frame(project, r.reviewId, 0), silent = await reviews.frame(project, r.reviewId, 1);
    assert.notEqual(sha(active.data), sha(silent.data));
    const rgba = execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'], { input: active.data });
    let yellow = 0; for (let i = 0; i < rgba.length; i += 4) if (rgba[i] > 180 && rgba[i + 1] > 130 && rgba[i + 2] < 80 && rgba[i + 3] > 200) yellow++;
    assert.ok(yellow > 20, `semantic emphasis yellow pixels=${yellow}`);
    for (const [name, original] of [['film.html', film], ['scene.html', scene], ['voice.vtt', vtt], ['.film/subtitles.json', style]]) assert.equal(await readFile(join(project.path, name), 'utf8'), original);
    await reviews.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('P0 字幕关闭与空字幕明确覆盖，序列合成不遗漏外置字幕且不受场景CSS污染', { skip: !enabled, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-review-composition-state-'));
  try {
    const project = { id: 'complete-picture-states', path: join(root, 'project') }; await mkdir(project.path); await mkdir(join(project.path, '.film'));
    execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', join(project.path, 'voice.wav')]);
    await writeFile(join(project.path, 'film.html'), filmHtml({ stage: { w: 320, h: 640 }, tracks: [{ clips: [{ id: 'page', src: 'scene.html', at: 0, duration: 1 }] }, { clips: [{ id: 'voice', src: 'voice.wav', time: [0, 1], at: 0 }] }] }).replace('</head>', '<style>html{opacity:.2;filter:blur(4px)}</style></head>'));
    await writeFile(join(project.path, 'scene.html'), '<style>div,span{font-size:99px!important;color:lime!important}</style><body style="margin:0;background:#123"><script>window.film={duration:1,width:320,height:640,frame(t){}}</script>');
    await writeFile(join(project.path, 'voice.vtt'), 'WEBVTT\n\n00:00.000 --> 00:01.000\nA <c.emphasis>word</c.emphasis>\n');
    await writeFile(join(project.path, '.film/subtitles.json'), JSON.stringify({ on: false }));
    const reviews = createReviews({ root: join(root, 'reviews') });
    const off = await reviews.create(project, { source: 'current-project', times: [.5], maxEdge: 640 });
    assert.ok(off.coverage.some((c) => c.code === 'studio-subtitle-layer' && c.details.reason === 'subtitles-off'));
    await writeFile(join(project.path, '.film/subtitles.json'), JSON.stringify({ on: true }));
    const sequence = await reviews.create(project, { source: 'current-project', times: [.5], maxEdge: 640, sequence: { start: 0, end: 1, count: 8 } });
    assert.equal(sequence.coverage.filter((c) => c.code === 'studio-subtitle-layer' && c.details.rendered).length, 9);
    assert.equal(sequence.artifacts[0].derivedFrom.length, 8);
    const bounds = sequence.findings.filter((f) => f.code === 'subtitle-information-bounds'); assert.equal(bounds.length, 9);
    assert.ok(bounds.every((f) => f.bounds.width < 180 && f.bounds.y > 400));
    assert.notEqual(sequence.frames[0].sha256, off.frames[0].sha256);
    const composed = (await reviews.frame(project, sequence.reviewId, 0)).data;
    const rgba = execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'], { input: composed });
    let yellow = 0; for (let i = 0; i < rgba.length; i += 4) if (rgba[i] > 180 && rgba[i + 1] > 130 && rgba[i + 2] < 80 && rgba[i + 3] > 200) yellow++;
    assert.ok(yellow > 10, `film root opacity/filter must not attenuate Studio subtitle pixels: ${yellow}`);
    await writeFile(join(project.path, 'voice.vtt'), 'WEBVTT\n');
    const empty = await reviews.create(project, { source: 'current-project', times: [.5], maxEdge: 640 });
    assert.ok(empty.coverage.some((c) => c.code === 'studio-subtitle-layer' && c.details.reason === 'no-cues'));
    assert.equal(empty.frames[0].sha256, off.frames[0].sha256);
    await reviews.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('P0 SVG零高度线条描边越界不能被遗漏后判为inside', { skip: !enabled, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-review-degenerate-stroke-'));
  try {
    const project = { id: 'svg-stroke', path: join(root, 'project') }; await mkdir(project.path);
    const intent = JSON.stringify({ text: [{ role: 'essential', selector: '#info', description: '含水平描边的信息图' }] });
    await writeFile(join(project.path, 'film.html'), filmHtml({ stage: { w: 320, h: 640 }, tracks: [{ clips: [{ id: 'scene', src: 'scene.html', duration: 1, attrs: { 'data-review-intent': intent } }] }] }));
    await writeFile(join(project.path, 'scene.html'), '<body style="margin:0;background:#123"><svg id="info" width="100" height="50" style="position:absolute;left:40px;top:500px;overflow:visible"><line x1="0" y1="48" x2="100" y2="48" stroke="white" stroke-width="20" stroke-linecap="round"/></svg><script>window.film={duration:1,width:320,height:640,frame(t){}}</script>');
    const reviews = createReviews({ root: join(root, 'reviews') });
    const r = await reviews.create(project, { source: 'current-project', times: [.5], maxEdge: 640, informationSafeArea: { top: 0, bottom: 85 / 640 } });
    const info = r.findings.find((f) => f.code === 'information-bounds' && f.selector === '#info');
    assert.equal(info.status, 'unknown'); assert.equal(info.measurement.safeAreaRelation, 'unknown'); assert.equal(info.measurement.reason, 'degenerate-svg-stroke');
    assert.equal(info.bounds.y + info.bounds.height, 550); // 真正可见stroke到558；此几何盒不能冒充完整绘制范围。
    await reviews.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
