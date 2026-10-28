import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTimelinePlan } from '../../../../scripts/build-motion-sdk.mjs';
import { filmHtml } from '../../src/film-doc.mjs';
import { readProjectFilm, editProjectFilm } from './film.mjs';
import { sourceSubtitles } from './subtitle-edits.mjs';
import { planSpeechCut, speechCutApplySchema } from './speech-cut.mjs';
import Ajv from 'ajv';

await buildTimelinePlan();
const vtt = 'WEBVTT\n\nopenfilm-timing:measured\n00:00:02.000 --> 00:00:03.000\n<00:00:02.000>应删的一句\n\nopenfilm-timing:measured\n00:00:04.000 --> 00:00:05.000\n<00:00:04.000>保留的一句\n';
const duration = async () => 10;
async function fixture(tracks) {
  const root = await mkdtemp(join(tmpdir(), 'speech-cut-'));
  await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 720, h: 1280 }, tracks: tracks ?? [{ clips: [{ id: 'voice', src: 'voice.wav', time: [0, 10] }] }] }));
  await writeFile(join(root, 'voice.wav'), 'fixture');
  await writeFile(join(root, 'voice.vtt'), vtt);
  const film = await readProjectFilm(root), source = await sourceSubtitles(root, 'voice.wav');
  const ask = { base: film.rev, clip: 'voice', sourceRevision: source.sourceRevision, first: { line: 2000 }, last: { line: 2000 } };
  return { root, film, source, ask, close: () => rm(root, { recursive: true, force: true }) };
}

test('文稿生成同源波纹ops，提交一次删除声画而源字幕原字节保留', async () => {
  const f = await fixture();
  try {
    const plan = await planSpeechCut(f.root, f.ask, { duration });
    assert.deepEqual(plan.range, { sourceStartMs: 2000, sourceEndMs: 3000, filmStartMs: 2000, filmEndMs: 3000 });
    assert.deepEqual(plan.timing, ['measured']);
    assert.equal(plan.shortMs, 0);
    assert.equal(new Ajv().compile(speechCutApplySchema)({ base: plan.base, ops: plan.ops, preconditions: plan.preconditions }), true);
    const after = await editProjectFilm(f.root, plan.base, plan.ops, plan.preconditions);
    assert.deepEqual(after.doc.tracks[0].clips.map((c) => [c.at ?? 0, c.time]), [[0, [0, 2]], [2, [3, 10]]]);
    assert.equal(await readFile(join(f.root, 'voice.vtt'), 'utf8'), vtt);
  } finally { await f.close(); }
});

test('剪辑按片段入点、起点及变速映射，调整不能越过原片段', async () => {
  const f = await fixture([{ clips: [{ id: 'voice', src: 'voice.wav', time: [1, 9], at: 5, speed: 2 }] }]);
  try {
    const plan = await planSpeechCut(f.root, { ...f.ask, adjust: { startMs: -100, endMs: 100 } }, { duration });
    assert.deepEqual(plan.range, { sourceStartMs: 1800, sourceEndMs: 3200, filmStartMs: 5400, filmEndMs: 6100 });
    await assert.rejects(planSpeechCut(f.root, { ...f.ask, adjust: { startMs: -3000, endMs: 0 } }, { duration }), (e) => e.kind === 'invalid');
  } finally { await f.close(); }
});

test('目标轨道、关联声音及会被移动的人工锁均不被精剪绕过', async () => {
  for (const tracks of [
    [{ locked: true, clips: [{ id: 'voice', src: 'voice.wav', time: [0, 10] }] }],
    [{ clips: [{ id: 'voice', src: 'voice.wav', time: [0, 10], attrs: { 'data-link': 'pair' } }] }, { locked: true, clips: [{ id: 'sound', src: 'voice.wav', time: [0, 10], attrs: { 'data-link': 'pair' } }] }],
    [{ clips: [{ id: 'voice', src: 'voice.wav', time: [0, 10] }] }, { clips: [{ id: 'manual', src: 'manual.html', time: [0, 10], overrides: [{ at: '#manual', lock: true, text: '人工文字' }] }] }],
  ]) {
    const f = await fixture(tracks);
    try { await assert.rejects(planSpeechCut(f.root, f.ask, { duration }), (e) => e.kind === 'invalid'); }
    finally { await f.close(); }
  }
});

test('预览后字幕改时/改字则旧计划拒绝，影片原字节不变', async () => {
  const f = await fixture();
  try {
    const plan = await planSpeechCut(f.root, f.ask, { duration });
    const before = await readFile(join(f.root, 'film.html'), 'utf8');
    await writeFile(join(f.root, 'voice.vtt'), vtt.replace('应删的一句', '外部已经改字'));
    await assert.rejects(editProjectFilm(f.root, plan.base, plan.ops, plan.preconditions), (e) => e.kind === 'conflict' && /字幕/.test(e.message));
    assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), before);
    await assert.rejects(planSpeechCut(f.root, f.ask, { duration }), (e) => e.kind === 'conflict');
  } finally { await f.close(); }
});

test('预览后即使是无关字段改变，严格base也不重新贴新影片', async () => {
  const f = await fixture();
  try {
    const plan = await planSpeechCut(f.root, f.ask, { duration });
    await editProjectFilm(f.root, plan.base, [{ op: 'set', clip: 'voice', field: 'volume', value: .5 }]);
    await assert.rejects(editProjectFilm(f.root, plan.base, plan.ops, plan.preconditions), (e) => e.kind === 'conflict');
    const after = await readProjectFilm(f.root);
    assert.equal(after.doc.tracks[0].clips.length, 1);
    assert.equal(after.doc.tracks[0].clips[0].volume, .5);
  } finally { await f.close(); }
});

test('非实际首末句和未见版本不能生成剪辑，旧字幕无来源明确标记unknown', async () => {
  const f = await fixture();
  try {
    await assert.rejects(planSpeechCut(f.root, { ...f.ask, first: { line: 999 } }, { duration }), (e) => e.kind === 'invalid');
    await assert.rejects(planSpeechCut(f.root, { ...f.ask, first: { line: 4000 }, last: { line: 2000 } }, { duration }), (e) => e.kind === 'invalid');
    await writeFile(join(f.root, 'voice.vtt'), vtt.replaceAll('openfilm-timing:measured\n', ''));
    const source = await sourceSubtitles(f.root, 'voice.wav');
    const plan = await planSpeechCut(f.root, { ...f.ask, sourceRevision: source.sourceRevision }, { duration });
    assert.deepEqual(plan.timing, ['unknown']);
  } finally { await f.close(); }
});


test('原创页面仅声明原生duration且无time.end，沿页面事实resolver参与同一精剪', async () => {
  const f = await fixture([{ clips: [{ id: 'voice', src: 'voice.wav', time: [0, 10] }] }, { clips: [{ id: 'diagram', src: 'diagram.html' }] }]);
  try {
    await writeFile(join(f.root, 'diagram.html'), '<!doctype html><script>window.film={duration:8,frame(){}}</script>');
    const seen = [];
    const plan = await planSpeechCut(f.root, f.ask, { duration: async (src) => { seen.push(src); return src === 'diagram.html' ? 8 : 10; } });
    assert.ok(seen.includes('diagram.html'));
    assert.ok(plan.affected.includes('diagram'));
    const next = await editProjectFilm(f.root, plan.base, plan.ops, plan.preconditions);
    assert.equal(next.doc.tracks.flatMap((t) => t.clips).filter((c) => c.src === 'diagram.html').length, 2);
  } finally { await f.close(); }
});
