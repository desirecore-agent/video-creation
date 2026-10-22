import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createReviews } from '../studio/server/reviews.mjs';
import { filmHtml } from './film-doc.mjs';

const sha = (data) => createHash('sha256').update(data).digest('hex');
const enabled = process.env.VIDEO_CREATION_REVIEW_RUNTIME === '1';

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
