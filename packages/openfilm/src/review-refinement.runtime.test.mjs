import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { filmHtml } from './film-doc.mjs';
import { createReviews } from '../studio/server/reviews.mjs';
import { createExports } from '../studio/server/exports.mjs';
import { startStudio } from '../studio/server/server.mjs';
import { projectClient } from '../../../desirecore/client.mjs';
import { command } from '../../../desirecore/cli.mjs';
import { callTool } from '../../../desirecore/mcp.mjs';
const enabled = process.env.VIDEO_CREATION_REVIEW_RUNTIME === '1';
const scene = '<body style="margin:0;background:red"><div id="title" style="color:white">人工片名</div><script>window.film={duration:1,width:160,height:90,frame(t){document.body.style.background=t<.5?"red":"blue"}}</script>';
const value = { stage: { w: 160, h: 90 }, tracks: [{ clips: [{ id: 'scene', src: 'scene.html', at: 0, time: [0, 1], overrides: [{ at: '#title', text: '人工片名', lock: true }] }] }] };
test('T4 真实工程意图不驱动排版，对照复用已有PNG并保留人工字段', { skip: !enabled, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-intent-real-')), project = { id: 'intent-project', path: join(root, 'project') }; await mkdir(project.path);
  const original = filmHtml(value); await writeFile(join(project.path, 'film.html'), original); await writeFile(join(project.path, 'scene.html'), scene);
  const oldHome = process.env.OPENFILM_HOME, home = join(root, 'home'); process.env.OPENFILM_HOME = home;
  let studio;
  try {
    studio = await startStudio({ port: 0, advertise: true, openBrowser: () => {} });
    const client = await projectClient({ home }, project.path);
    const before = await callTool({ home }, project.path, 'video_review', { source: 'current-project', times: [.5], maxEdge: 640 });
    const next = structuredClone(value); next.tracks[0].clips[0].attrs = { 'data-review-intent': JSON.stringify({ targetWidths: [180, 360], text: [{ role: 'essential', selector: '#title', description: '保持片名' }] }) };
    const annotated = filmHtml(next, original); await writeFile(join(project.path, 'film.html'), annotated);
    const after = await client.review({ source: 'current-project', times: [.5], maxEdge: 640 });
    assert.notEqual(before.filmRevision, after.filmRevision); assert.equal(before.frames[0].sha256, after.frames[0].sha256);
    assert.equal(after.sourceFacts.intents[0].value.text[0].role, 'essential');
    let paired;
    await command(['review', project.path, '--source', 'review-pair', '--before-review', before.reviewId, '--after-review', after.reviewId, '--max-edge', '640', '--home', home], (value) => { paired = value; });
    assert.equal(paired.artifacts[0].differences.preservedData.totalChanges, 0); assert.equal(paired.artifacts[0].differences.files.totalChanges, 1);
    assert.equal(paired.artifacts[0].width, 320); assert.equal(paired.artifacts[0].height, 108);
    assert.equal(await readFile(join(project.path, 'film.html'), 'utf8'), annotated); assert.equal(await readFile(join(project.path, 'scene.html'), 'utf8'), scene);
  } finally { await studio?.close(); if (oldHome === undefined) delete process.env.OPENFILM_HOME; else process.env.OPENFILM_HOME = oldHome; await rm(root, { recursive: true, force: true }); }
});
test('T4 真实线性选区输出绑定原工程时点，未知旧映射不跳转', { skip: !enabled, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-time-real-')), project = { id: 'time-project', name: 'test range', path: join(root, 'project') }; await mkdir(project.path);
  await writeFile(join(project.path, 'film.html'), filmHtml(value)); await writeFile(join(project.path, 'scene.html'), scene);
  const exports = createExports({ stateDir: join(root, 'jobs') }), reviews = createReviews({ root: join(root, 'reviews'), jobs: () => exports.list(project.id) });
  let id;
  try {
    id = exports.start(project, { kind: 'video', codec: 'h264', width: 160, height: 90, fps: 4, range: [.25, .75], audio: false, hardware: false }, { folder: join(root, 'output') }).id;
    await exports.prepare(id); const end = Date.now() + 60_000; let job;
    do { job = exports.list(project.id).find((job) => job.id === id); if (!['waiting', 'running'].includes(job.status)) break; await new Promise((done) => setTimeout(done, 30)); } while (Date.now() < end);
    assert.equal(job.status, 'done', job.error); assert.equal(job.inputSnapshot.outputTimeToFilmTime.start, .25);
    const r = await reviews.create(project, { source: 'export-job', job: id, times: [.25], maxEdge: 640 });
    const target = await reviews.target(project, r.reviewId, 'frame', 0, true); assert.equal(target.engineering.status, 'verified-at-check'); assert.equal(target.engineering.timeMs, 500);
    const png = await readFile(r.frames[0].path), pixels = execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: png });
    const last = pixels.subarray(pixels.length - 3); assert.ok(last[2] > 200 && last[0] < 25, `expected the .5s blue frame, got ${[...last]}`);
    assert.equal(r.sourceFacts.status, 'observed');
  } finally {
    exports.stopAll(); await reviews.close();
    if (id) { const end = Date.now() + 5000; while (['waiting', 'running'].includes(exports.list(project.id).find((job) => job.id === id)?.status) && Date.now() < end) await new Promise((done) => setTimeout(done, 30)); }
    await rm(root, { recursive: true, force: true });
  }
});
