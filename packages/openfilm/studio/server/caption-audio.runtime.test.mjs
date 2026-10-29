import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filmHtml } from '../../src/film-doc.mjs';
import { readProjectFilm } from './film.mjs';
import { parseFilmSubtitleStyle } from './film-subtitle.mjs';
import { filmCaptions } from './captions.mjs';
import { createExports } from './exports.mjs';
import { planCaptionAudio } from './caption-audio.mjs';

const runtime = { skip: process.env.VIDEO_CREATION_REVIEW_RUNTIME !== '1' && 'explicit existing runtime entry required', timeout: 60_000 };
const vtt = 'WEBVTT\n\nopenfilm-timing:measured\n00:00:02.000 --> 00:00:03.000\n<00:00:02.000>需要核听\n';
function tone(changed = false) {
  const samples = 4 * 48000, out = Buffer.alloc(44 + samples * 2);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(48000, 24); out.writeUInt32LE(96000, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(samples * 2, 40);
  for (let n = 0; n < samples; n++) out.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * (changed ? 123 : 220 * (Math.floor(n / 48000) + 1)) * n / 48000)), 44 + n * 2);
  return out;
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'caption-audio-runtime-'));
  const project = { id: 'project', name: 'Caption audio fixture', path: join(root, 'project') };
  await mkdir(project.path);
  await writeFile(join(project.path, 'voice.wav'), tone());
  await writeFile(join(project.path, 'voice.vtt'), vtt);
  await writeFile(join(project.path, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ locked: true, clips: [{ id: 'voice', src: 'voice.wav', time: [0, 4] }] }] }));
  const seen = await filmCaptions(project.path, { withMediaDigests: true });
  const ask = { base: seen.filmRevision, clip: 'voice', sourceRevision: seen.cues[0].sourceRevision, mediaSnapshot: seen.mediaSnapshots[0].snapshot, cue: { line: 2000 }, contextSeconds: .25 };
  return { root, project, ask, stateDir: join(root, 'state'), output: join(root, 'output'), close: () => rm(root, { recursive: true, force: true }) };
}
const terminal = new Set(['done', 'failed', 'cancelled', 'interrupted']);
async function ended(queue, id) {
  for (let n = 0; n < 1500; n++) {
    const job = queue.list('project').find((x) => x.id === id);
    if (job && terminal.has(job.status)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('short audio fixture did not finish');
}
async function settled(queue) {
  for (let n = 0; n < 500 && queue.busy(); n++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(queue.busy(), false);
}
function pcm(file, range) {
  return execFileSync('ffmpeg', ['-v', 'error', ...(range ? ['-ss', String(range[0])] : []), '-i', file,
    ...(range ? ['-t', String(range[1])] : []), '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
}
function correlation(a, b) {
  assert.equal(a.length, b.length);
  let xx = 0, yy = 0, xy = 0;
  for (let n = 0; n < a.length; n += 4) { const x = a.readFloatLE(n), y = b.readFloatLE(n); xx += x * x; yy += y * y; xy += x * y; }
  return xy / Math.sqrt(xx * yy);
}
async function assertOutput(done, expected, sourceFile) {
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.outputs.length, 1); assert.match(done.outputs[0], /\.wav$/);
  const bytes = await readFile(done.outputs[0]);
  assert.deepEqual(done.outputDigests, [{ path: done.outputs[0], bytes: bytes.length, sha256: sha(bytes) }]);
  assert.deepEqual(done.inputSnapshot.captionAudio.range, expected.selection.range);
  const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration', '-of', 'json', done.outputs[0]], { encoding: 'utf8' }));
  assert.equal(metadata.streams[0].codec_name, 'pcm_s16le');
  assert.ok(Math.abs(Number(metadata.format.duration) - 1.5) <= 1 / 48000);
  assert.ok(correlation(pcm(done.outputs[0]), pcm(sourceFile, [1.75, 1.5])) > .999, 'actual output contains the selected old source window');
}

test('P1字幕原声窗实际生成带源映射和字节摘要的短WAV，原文和人工锁不变', runtime, async () => {
  const f = await fixture(); let queue;
  try {
    const before = await Promise.all(['film.html', 'voice.wav', 'voice.vtt'].map((name) => readFile(join(f.project.path, name))));
    const plan = await planCaptionAudio(f.project.path, f.ask);
    assert.deepEqual(plan.selection.range, { filmStartMs: 1750, filmEndMs: 3250, sourceStartMs: 1750, sourceEndMs: 3250 });
    queue = createExports({ stateDir: f.stateDir });
    const job = queue.start(f.project, plan.exportAsk, { folder: f.output });
    const prepared = await queue.prepare(job.id);
    assert.equal(prepared.inputSnapshot.captionAudio.base, f.ask.base);
    const done = await ended(queue, job.id);
    await assertOutput(done, plan, join(f.project.path, 'voice.wav'));
    await settled(queue);
    assert.deepEqual(await Promise.all(['film.html', 'voice.wav', 'voice.vtt'].map((name) => readFile(join(f.project.path, name)))), before);
    assert.equal((await readProjectFilm(f.project.path)).doc.tracks[0].locked, true);
    assert.equal(existsSync(join(f.stateDir, job.id, 'input')), false);
  } finally { queue?.stopAll(); await f.close(); }
});

test('P1排队原声窗使用提交时冻结字节，渲染等待期间后来的改片和换音不串入', runtime, async () => {
  const f = await fixture(); let queue, release;
  try {
    let enter; const entered = new Promise((r) => { enter = r; });
    const gate = new Promise((r) => { release = r; });
    queue = createExports({ stateDir: f.stateDir, captions: async () => { enter(); await gate; return { cues: [{ startMs: 0, durMs: 1000, text: 'block fixture' }], style: parseFilmSubtitleStyle(null) }; } });
    const first = queue.start(f.project, { kind: 'subtitles', format: 'txt' }, { folder: f.output });
    await entered;
    const plan = await planCaptionAudio(f.project.path, f.ask);
    const job = queue.start(f.project, plan.exportAsk, { folder: f.output });
    const prepared = await queue.prepare(job.id);
    assert.equal(prepared.status, 'waiting');
    const reference = join(f.root, 'old-reference.wav'); await writeFile(reference, await readFile(join(f.project.path, 'voice.wav')));
    await writeFile(join(f.project.path, 'voice.wav'), tone(true));
    await writeFile(join(f.project.path, 'voice.vtt'), vtt.replace('需要核听', '后来人工改字'));
    await writeFile(join(f.project.path, 'film.html'), (await readFile(join(f.project.path, 'film.html'), 'utf8')) + '\n');
    release();
    assert.equal((await ended(queue, first.id)).status, 'done');
    await assertOutput(await ended(queue, job.id), plan, reference);
    await settled(queue);
  } finally { release?.(); queue?.stopAll(); await f.close(); }
});

test('P1冻结时拒绝旧影片、旧字幕、同长同mtime换音或伪造区间，持久retry仍守原内容', runtime, async () => {
  for (const changed of ['film.html', 'voice.vtt', 'voice.wav', 'range']) {
    const f = await fixture(); let queue;
    try {
      const plan = await planCaptionAudio(f.project.path, f.ask);
      if (changed === 'voice.wav') {
        const before = await stat(join(f.project.path, changed));
        await writeFile(join(f.project.path, changed), tone(true));
        await utimes(join(f.project.path, changed), before.atime, before.mtime);
        assert.equal((await stat(join(f.project.path, changed))).size, f.ask.mediaSnapshot.bytes);
      }
      else if (changed !== 'range') await writeFile(join(f.project.path, changed), (await readFile(join(f.project.path, changed), 'utf8')) + '\n');
      else plan.exportAsk.range = [0, 1];
      queue = createExports({ stateDir: f.stateDir });
      const job = queue.start(f.project, plan.exportAsk, { folder: f.output });
      await assert.rejects(queue.prepare(job.id), (e) => e.status === 409);
      assert.equal((await ended(queue, job.id)).status, 'failed');
      assert.deepEqual(queue.list('project').find((x) => x.id === job.id).outputs, []);
      await settled(queue); queue.stopAll();
      queue = createExports({ stateDir: f.stateDir });
      const retried = queue.retry(job.id);
      assert.equal(retried.ask.captionAudio.sourceRevision, f.ask.sourceRevision);
      assert.deepEqual(retried.ask.captionAudio.mediaSnapshot, f.ask.mediaSnapshot);
      await assert.rejects(queue.prepare(retried.id), (e) => e.status === 409);
      assert.equal((await ended(queue, retried.id)).status, 'failed');
      await settled(queue);
      assert.equal(existsSync(join(f.stateDir, retried.id, 'input')), false);
    } finally { queue?.stopAll(); await f.close(); }
  }
});

test('P1正式HTTP原声入口沿原鉴权和jobs返回可追溯WAV，不把准备回执当已听', runtime, async () => {
  const f = await fixture(); let studio;
  const previous = { home: process.env.OPENFILM_HOME, library: process.env.OPENFILM_LIBRARY, app: process.env.APP_DATA_DIR };
  try {
    const home = join(f.root, 'http-home');
    process.env.OPENFILM_HOME = home; process.env.OPENFILM_LIBRARY = join(home, 'projects'); process.env.APP_DATA_DIR = home;
    const { startStudio } = await import('./server.mjs');
    studio = await startStudio({ port: 0, key: 'a'.repeat(48), stays: true, openBrowser: () => {} });
    const headers = { 'x-studio-key': studio.key, 'content-type': 'application/json' };
    const registered = await (await fetch(`${studio.origin}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ path: f.project.path, create: false }) })).json();
    const base = `${studio.origin}/api/projects/${registered.project.id}`;
    const seen = await (await fetch(`${base}/captions?withMediaDigests=1`, { headers })).json();
    assert.equal(seen.filmRevision, f.ask.base);
    assert.deepEqual(seen.mediaSnapshots[0], { src: 'voice.wav', snapshot: f.ask.mediaSnapshot });
    assert.equal((await fetch(`${base}/captions?withMediaDigests=true`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/captions/audio`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f.ask) })).status, 401);
    const response = await fetch(`${base}/captions/audio`, { method: 'POST', headers, body: JSON.stringify(f.ask) });
    assert.equal(response.status, 200); const submitted = await response.json();
    assert.equal(submitted.selection.base, f.ask.base);
    assert.equal(submitted.export.inputSnapshot.captionAudio.source.revision, f.ask.sourceRevision);
    assert.match(submitted.selection.limitations.join(' '), /不能据WAV二进制声称已听/);
    let done;
    for (let n = 0; n < 1500; n++) {
      const rows = await (await fetch(`${base}/exports?statusOnly=1`, { headers })).json();
      done = rows.exports.find((job) => job.id === submitted.export.id);
      if (terminal.has(done?.status)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await assertOutput(done, await planCaptionAudio(f.project.path, f.ask), join(f.project.path, 'voice.wav'));
    assert.equal((await readProjectFilm(f.project.path)).doc.tracks[0].locked, true);
  } finally {
    await studio?.close();
    for (const [key, value] of [['OPENFILM_HOME', previous.home], ['OPENFILM_LIBRARY', previous.library], ['APP_DATA_DIR', previous.app]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await f.close();
  }
});
