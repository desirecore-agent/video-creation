import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat, utimes, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filmHtml } from '../../src/film-doc.mjs';
import { readProjectFilm } from './film.mjs';
import { filmCaptions } from './captions.mjs';
import { captionAudioContract, normalizeCaptionAudioRequest, planCaptionAudio } from './caption-audio.mjs';

const vtt = 'WEBVTT\n\nopenfilm-timing:measured\n00:00:02.000 --> 00:00:03.000\n<00:00:02.000>需要核听\n';
async function fixture({ time = [0, 10], at = 0, speed = 1, locked = false, transcript = vtt } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'caption-audio-'));
  await writeFile(join(root, 'voice.wav'), 'only source identity fixture');
  await writeFile(join(root, 'voice.vtt'), transcript);
  await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 720, h: 1280 }, tracks: [{ locked, clips: [{ id: 'voice', src: 'voice.wav', time, at, speed }] }] }));
  const seen = await filmCaptions(root, { duration: async () => time[1], withMediaDigests: true });
  const cue = seen.cues.find((c) => c.clip === 'voice' && c.line === 2000);
  return { root, ask: { base: seen.filmRevision, clip: 'voice', sourceRevision: cue.sourceRevision, mediaSnapshot: seen.mediaSnapshots[0].snapshot, cue: { line: 2000 } }, close: () => rm(root, { recursive: true, force: true }) };
}
const duration = async () => 10;

test('原声窗按真实字幕标识定位并按入点、起点及变速换算两套时钟', async () => {
  const f = await fixture({ time: [1, 9], at: 5, speed: 2 });
  try {
    const { selection, exportAsk } = await planCaptionAudio(f.root, f.ask, { duration });
    assert.deepEqual(selection.range, { filmStartMs: 5000, filmEndMs: 7000, sourceStartMs: 1000, sourceEndMs: 5000 });
    assert.deepEqual(selection.cue, { line: 2000, part: 0, text: '需要核听', filmStartMs: 5500, filmEndMs: 6000, timing: 'measured' });
    assert.deepEqual(exportAsk.range, [5, 7]);
    assert.equal(exportAsk.kind, 'audio'); assert.equal(exportAsk.format, 'wav');
    assert.equal(exportAsk.captionAudio.base, f.ask.base);
    assert.equal(exportAsk.captionAudio.sourceRevision, f.ask.sourceRevision);
    assert.match(selection.limitations.join(' '), /不是ASR置信度/);
  } finally { await f.close(); }
});

test('只读原声定位不修改影片、字幕或既有人工轨道锁', async () => {
  const f = await fixture({ locked: true });
  try {
    const before = await Promise.all(['film.html', 'voice.vtt', 'voice.wav'].map((n) => readFile(join(f.root, n))));
    const out = await planCaptionAudio(f.root, { ...f.ask, contextSeconds: 0 }, { duration });
    assert.deepEqual(out.exportAsk.range, [2, 3]);
    const after = await Promise.all(['film.html', 'voice.vtt', 'voice.wav'].map((n) => readFile(join(f.root, n))));
    assert.deepEqual(after, before);
    assert.equal((await readProjectFilm(f.root)).doc.tracks[0].locked, true);
  } finally { await f.close(); }
});

test('旧影片、旧字幕、错误句标识和参数不能定位成另一句', async () => {
  const f = await fixture();
  try {
    for (const ask of [{ ...f.ask, base: '0000000000000000' }, { ...f.ask, sourceRevision: '0'.repeat(64) }])
      await assert.rejects(planCaptionAudio(f.root, ask, { duration }), (e) => e.status === 409);
    await assert.rejects(planCaptionAudio(f.root, { ...f.ask, cue: { line: 9999 } }, { duration }), (e) => e.status === 400);
    await assert.rejects(planCaptionAudio(f.root, { ...f.ask, cue: { line: 2000, part: 99 } }, { duration }), (e) => e.status === 400);
    for (const raw of [{ ...f.ask, contextSeconds: -1 }, { ...f.ask, contextSeconds: 3 }, { ...f.ask, src: '../other.wav' }, { ...f.ask, base: '' }])
      assert.throws(() => normalizeCaptionAudioRequest(raw), (e) => e.status === 400);
    await writeFile(join(f.root, 'voice.vtt'), vtt.replace('需要核听', '人已校订'));
    await assert.rejects(planCaptionAudio(f.root, f.ask, { duration }), (e) => e.status === 409);
  } finally { await f.close(); }
});

test('定位期间另一个写入者改变字幕或影片，返回冲突而不借新版本续用旧句', async () => {
  for (const file of ['voice.vtt', 'film.html']) {
    const f = await fixture();
    try {
      let changed = false;
      await assert.rejects(planCaptionAudio(f.root, f.ask, { duration: async () => {
        if (!changed) { changed = true; await writeFile(join(f.root, file), file === 'voice.vtt' ? vtt.replace('需要核听', '外部改字') : (await readFile(join(f.root, file), 'utf8')) + '\n'); }
        return 10;
      } }), (e) => e.status === 409);
    } finally { await f.close(); }
  }
});

test('上下文夹在同一片段边界，过长句拒绝而非截断或拉整片', async () => {
  const f = await fixture({ time: [1.8, 3.2], at: 10 });
  try {
    const out = await planCaptionAudio(f.root, { ...f.ask, contextSeconds: 2 }, { duration });
    assert.deepEqual(out.exportAsk.range, [10, 11.4]);
    assert.deepEqual(out.selection.range, { filmStartMs: 10000, filmEndMs: 11400, sourceStartMs: 1800, sourceEndMs: 3200 });
  } finally { await f.close(); }
  const long = await fixture({ time: [0, 40], transcript: vtt.replace('00:00:03.000', '00:00:39.000') });
  try { await assert.rejects(planCaptionAudio(long.root, long.ask, { duration: async () => 40 }), (e) => e.status === 400 && /30秒/.test(e.message)); }
  finally { await long.close(); }
  assert.equal(captionAudioContract.output.maximumSeconds, 30);
  assert.equal(captionAudioContract.output.maximumBytes, 6 * 1024 * 1024);
});

test('媒体内容观察显式opt-in且按distinct src一次返回，默认GET保持原shape', async () => {
  const f = await fixture();
  try {
    const normal = await filmCaptions(f.root, { duration });
    assert.equal('mediaSnapshots' in normal, false); assert.equal('filmRevision' in normal, false);
    const film = (await readProjectFilm(f.root)).doc;
    film.tracks[0].clips.push({ ...film.tracks[0].clips[0], id: 'second', at: 12 });
    await writeFile(join(f.root, 'film.html'), filmHtml(film));
    const observed = await filmCaptions(f.root, { duration, withMediaDigests: true });
    assert.equal(observed.mediaSnapshots.length, 1);
    assert.equal(observed.cues.length, 2);
    assert.deepEqual(observed.mediaSnapshots[0], { src: 'voice.wav', snapshot: f.ask.mediaSnapshot });
    const missingMedia = { ...f.ask }; delete missingMedia.mediaSnapshot;
    assert.throws(() => normalizeCaptionAudioRequest(missingMedia), (e) => e.status === 400);
  } finally { await f.close(); }
});

test('媒体摘要观察末端fence拒绝同长同mtime换音、字幕或影片同期变化', async () => {
  for (const changed of ['voice.wav', 'voice.vtt', 'film.html']) {
    const f = await fixture();
    try {
      const before = await stat(join(f.root, changed)); let done = false;
      await assert.rejects(filmCaptions(f.root, { withMediaDigests: true, duration: async () => {
        if (!done) {
          done = true; const old = await readFile(join(f.root, changed));
          await writeFile(join(f.root, changed), changed === 'voice.wav' ? Buffer.alloc(old.length, 120) : Buffer.concat([old, Buffer.from('\n')]));
          if (changed === 'voice.wav') await utimes(join(f.root, changed), before.atime, before.mtime);
        }
        return 10;
      } }), (e) => e.status === 409);
    } finally { await f.close(); }
  }
});

test('显式媒体摘要在流读前拒绝超过原快照字节预算的稀疏文件', async () => {
  const f = await fixture();
  try {
    await truncate(join(f.root, 'voice.wav'), 20 * 2 ** 30 + 1);
    await assert.rejects(filmCaptions(f.root, { duration, withMediaDigests: true }), (e) => e.status === 413 && /预算/.test(e.message));
  } finally { await f.close(); }
});
