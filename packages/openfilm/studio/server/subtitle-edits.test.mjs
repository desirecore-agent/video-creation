import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { captionRoutes, filmCaptions } from './captions.mjs';
import { HttpError, json } from './http.mjs';
import { cleanCues, readSourceSnapshot, restoreSourceFiles, sourceSnapshotRevision, sourceSubtitles, writeSourceSubtitles } from './subtitle-edits.mjs';
import { CUT_NOTE, readTranscript, vttOf } from './transcripts.mjs';
import { filmHtml } from '../../src/film-doc.mjs';

/* two sentences said as one line, timed word by word: Studio cuts it into two subtitles */
const TEXT = 'One two three. Four five six.';
const MARKS = [[0, 0], [4, 300], [8, 600], [15, 1200], [20, 1500], [25, 1800]].map(([index, startMs]) => ({ index, startMs }));
const ONE_LINE = vttOf([{ text: TEXT, startMs: 0, endMs: 2500, marks: MARKS }]);
const noProbe = { duration: async () => undefined };

/** A project folder: film.html from `tracks`, and `files` (path → text). */
function project(tracks, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'of-subtitle-edits-'));
  writeFileSync(join(root, 'film.html'), filmHtml({ stage: { w: 1920, h: 1080 }, tracks }));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

test('a source\'s subtitles are read as the film shows them, each named as its cue is', async () => {
  const root = project([{ clips: [{ id: 'vo', src: 'assets/vo.mp3', at: 10 }] }], {
    'assets/vo.mp3': 'x', 'assets/vo.vtt': ONE_LINE, 'assets/vo.fr.vtt': vttOf([{ text: 'Un deux trois. Quatre cinq six.', startMs: 0, endMs: 2500 }]),
  });
  const { cues } = await filmCaptions(root, noProbe);
  const source = await sourceSubtitles(root, 'assets/vo.mp3');
  assert.equal(source.cut, false);
  assert.deepEqual(source.cues.map((c) => [c.text, c.line, c.part]), [['One two three.', 0, 0], ['Four five six.', 0, 1]]);
  /* the same pieces the film shows, 10 s later */
  assert.deepEqual(cues.map((c) => [c.startMs - 10_000, c.line, c.part]), source.cues.map((c) => [c.startMs, c.line, c.part]));
  assert.deepEqual(source.cues.map((c) => c.alt?.fr), ['Un deux trois.', 'Quatre cinq six.']);
  assert.ok(source.cues[1].marks?.every((m) => m.index < source.cues[1].text.length));
  assert.deepEqual((await sourceSubtitles(root, 'assets/none.mp3')).cues, []);
});

test('written back, each subtitle is a cue of its own, cut by hand: Studio does not cut it again', async () => {
  const root = project([{ clips: [{ id: 'vo', src: 'assets/vo.mp3' }] }], { 'assets/vo.mp3': 'x', 'assets/vo.vtt': ONE_LINE });
  /* the two merged into one long line, which Studio would cut at the full stop */
  const { before, after } = await writeSourceSubtitles(root, 'assets/vo.mp3', [{ startMs: 0, endMs: 2500, text: TEXT }], await readSourceSnapshot(root, 'assets/vo.mp3'));
  assert.equal(before.files['assets/vo.vtt'], ONE_LINE);
  const body = readFileSync(join(root, 'assets/vo.vtt'), 'utf8');
  assert.equal(after.files['assets/vo.vtt'], body);
  assert.ok(body.startsWith(`WEBVTT\n\n${CUT_NOTE}\n\n`));
  assert.equal((await readTranscript(root, 'assets/vo.mp3'))?.cut, true);
  const { cues } = await filmCaptions(root, noProbe);
  assert.deepEqual(cues.map(({ startMs, durMs, text, part }) => ({ startMs, durMs, text, part })), [{ startMs: 0, durMs: 2500, text: TEXT, part: undefined }]);
  assert.equal((await sourceSubtitles(root, 'assets/vo.mp3')).cut, true);
});

test('cues are written in order, never overlapping, none empty', () => {
  assert.deepEqual(cleanCues([
    { startMs: 2000, endMs: 3000, text: 'b' },
    { startMs: 0, endMs: 2500, text: ' a  one ', marks: [{ index: 0, startMs: 0 }, { index: 3, startMs: 9000 }, { index: 99, startMs: 10 }] },
    { startMs: 3000, endMs: 3000, text: 'no length' },
    { startMs: 3100, endMs: 3500, text: '   ' },
    { startMs: 4000, endMs: 5000, text: 'c', alt: { fr: ' ç ', xx: 'nope' } },
  ]), [
    { startMs: 0, endMs: 2000, text: 'a one', marks: [{ index: 0, startMs: 0 }, { index: 3, startMs: 2000 }] },
    { startMs: 2000, endMs: 3000, text: 'b' },
    { startMs: 4000, endMs: 5000, text: 'c', alt: { fr: 'ç' } },
  ]);
  assert.throws(() => cleanCues('x'), HttpError);
  assert.throws(() => cleanCues([{ startMs: 'a', endMs: 1, text: 'x' }]), HttpError);
});

test('translations are written at the same times; undo puts every file back, and only over what it left', async () => {
  const root = project([{ clips: [{ id: 'vo', src: 'assets/vo.mp3' }] }], {
    'assets/vo.mp3': 'x', 'assets/vo.vtt': ONE_LINE, 'assets/vo.fr.vtt': vttOf([{ text: 'Un deux trois. Quatre cinq six.', startMs: 0, endMs: 2500 }]),
  });
  const { before, after } = await writeSourceSubtitles(root, 'assets/vo.mp3', [
    { startMs: 0, endMs: 1100, text: 'One two three.', alt: { fr: 'Un deux trois.' } },
    { startMs: 1300, endMs: 2500, text: 'Four five six.', alt: { de: 'Vier fünf sechs.' } },
  ], await readSourceSnapshot(root, 'assets/vo.mp3'));
  assert.deepEqual((await readTranscript(root, 'assets/vo.mp3', 'fr'))?.lines, [{ text: 'Un deux trois.', startMs: 0, endMs: 1100, timing: 'estimated' }]);
  assert.deepEqual((await readTranscript(root, 'assets/vo.mp3', 'de'))?.lines, [{ text: 'Vier fünf sechs.', startMs: 1300, endMs: 2500, timing: 'estimated' }]);
  assert.equal(before.files['assets/vo.de.vtt'], null, 'the German one is new');
  /* undo: as it was, the file this step made gone */
  await restoreSourceFiles(root, 'assets/vo.mp3', after, before);
  assert.equal(readFileSync(join(root, 'assets/vo.vtt'), 'utf8'), ONE_LINE);
  assert.ok(!existsSync(join(root, 'assets/vo.de.vtt')));
  /* redo, then a write from elsewhere: undo now refuses, and writes nothing */
  await restoreSourceFiles(root, 'assets/vo.mp3', before, after);
  writeFileSync(join(root, 'assets/vo.vtt'), vttOf([{ text: 'The agent wrote this.', startMs: 0, endMs: 900 }]));
  await assert.rejects(restoreSourceFiles(root, 'assets/vo.mp3', after, before), (e) => e instanceof HttpError && e.status === 409);
  assert.match(readFileSync(join(root, 'assets/vo.vtt'), 'utf8'), /The agent wrote this/);
  /* only a source's own transcripts are put back, inside the project */
  await assert.rejects(restoreSourceFiles(root, 'assets/vo.mp3', { files: {} }, { files: { 'film.html': 'x' } }), (e) => e instanceof HttpError && e.status === 400);
  await assert.rejects(restoreSourceFiles(root, 'assets/vo.mp3', { files: {} }, { files: { 'assets/other.vtt': 'x' } }), (e) => e instanceof HttpError && e.status === 400);
  await assert.rejects(writeSourceSubtitles(root, '../away.mp3', []), (e) => e instanceof HttpError && e.status === 400);
});

/** captionRoutes on a port of its own, for `root`. */
async function serve(root) {
  const server = createServer((req, res) => {
    const rest = new URL(req.url ?? '/', 'http://x').pathname.slice(1);
    captionRoutes(req, res, root, rest).then((done) => { if (!done) json(res, 404, {}); }, (e) => {
      json(res, e instanceof HttpError ? e.status : 500, { error: e.message, ...(e instanceof HttpError ? e.extra : {}) });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('the routes: a source\'s subtitles, written, and put back', async () => {
  const root = project([{ clips: [{ id: 'vo', src: 'assets/vo.mp3' }] }], { 'assets/vo.mp3': 'x', 'assets/vo.vtt': ONE_LINE });
  const { base, close } = await serve(root);
  const put = (path, body) => fetch(`${base}/${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const got = await (await fetch(`${base}/captions/source?src=${encodeURIComponent('assets/vo.mp3')}`)).json();
    assert.equal(got.cues.length, 2);
    assert.equal((await fetch(`${base}/captions/source?src=..%2Fx.mp3`)).status, 400);
    const res = await put('captions/source', { src: 'assets/vo.mp3', cues: [{ ...got.cues[0], endMs: 1400 }], from: got.snapshot });
    assert.equal(res.status, 200);
    const { before, after } = await res.json();
    assert.deepEqual((await readTranscript(root, 'assets/vo.mp3'))?.lines.map((l) => [l.text, l.startMs, l.endMs]), [['One two three.', 0, 1400]]);
    assert.equal((await put('captions/files', { src: 'assets/vo.mp3', from: after, to: before })).status, 200);
    assert.equal(readFileSync(join(root, 'assets/vo.vtt'), 'utf8'), ONE_LINE);
    const again = await put('captions/files', { src: 'assets/vo.mp3', from: after, to: before });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).code, 'changed');
    assert.equal((await put('captions/source', { cues: [] })).status, 400);
  } finally { close(); }
});

test('普通保存缺少所读快照即拒绝，不覆盖字幕', async () => {
  const root = project([], { 'assets/vo.mp3': 'x', 'assets/vo.vtt': ONE_LINE });
  const cues = [{ startMs: 0, endMs: 1000, text: 'Draft' }];
  await assert.rejects(writeSourceSubtitles(root, 'assets/vo.mp3', cues), (e) => e.status === 428 && e.extra.code === 'snapshot-required');
  await assert.rejects(writeSourceSubtitles(root, 'assets/vo.mp3', cues, { files: {} }), (e) => e.status === 428);
  assert.equal(readFileSync(join(root, 'assets/vo.vtt'), 'utf8'), ONE_LINE);
});

test('两个窗口以同一快照并发保存，只一份成功，另一份原草稿仍由调用方持有', async () => {
  const root = project([], { 'assets/vo.mp3': 'x', 'assets/vo.vtt': ONE_LINE });
  const read = await sourceSubtitles(root, 'assets/vo.mp3');
  assert.equal(read.sourceRevision, sourceSnapshotRevision(read.snapshot));
  const drafts = ['First window', 'Second window'].map((text) => [{ startMs: 0, endMs: 1500, text }]);
  const originalDrafts = structuredClone(drafts);
  const results = await Promise.allSettled(drafts.map((cues) => writeSourceSubtitles(root, 'assets/vo.mp3', cues, read.snapshot)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.status === 409).length, 1);
  // 文件读写的实际排队顺序不固定，核对真正成功的一方及仍保留的另一份草稿。
  const winner = results.findIndex((r) => r.status === 'fulfilled');
  const loser = results.findIndex((r) => r.status === 'rejected');
  assert.equal((await sourceSubtitles(root, 'assets/vo.mp3')).cues[0].text, originalDrafts[winner][0].text);
  assert.deepEqual(drafts[loser], originalDrafts[loser]);
});

test('ASR改写或翻译集合增删发生后，旧保存与旧撤销均不写任何文件', async () => {
  const root = project([], { 'assets/vo.mp3': 'x', 'assets/vo.vtt': ONE_LINE });
  const old = await sourceSubtitles(root, 'assets/vo.mp3');
  const changed = vttOf([{ text: 'A new transcription', startMs: 10, endMs: 1200 }]);
  writeFileSync(join(root, 'assets/vo.vtt'), changed);
  await assert.rejects(writeSourceSubtitles(root, 'assets/vo.mp3', old.cues, old.snapshot), (e) => e.status === 409);
  assert.equal(readFileSync(join(root, 'assets/vo.vtt'), 'utf8'), changed);
  const read = await sourceSubtitles(root, 'assets/vo.mp3');
  const french = vttOf([{ text: 'Nouveau', startMs: 10, endMs: 1200 }]);
  writeFileSync(join(root, 'assets/vo.fr.vtt'), french);
  await assert.rejects(writeSourceSubtitles(root, 'assets/vo.mp3', read.cues, read.snapshot), (e) => e.status === 409);
  await assert.rejects(restoreSourceFiles(root, 'assets/vo.mp3', read.snapshot, old.snapshot), (e) => e.status === 409);
  assert.equal(readFileSync(join(root, 'assets/vo.vtt'), 'utf8'), changed);
  assert.equal(readFileSync(join(root, 'assets/vo.fr.vtt'), 'utf8'), french);
  const withFrench = await sourceSubtitles(root, 'assets/vo.mp3');
  const { rmSync } = await import('node:fs');
  rmSync(join(root, 'assets/vo.fr.vtt'));
  await assert.rejects(writeSourceSubtitles(root, 'assets/vo.mp3', withFrench.cues, withFrench.snapshot), (e) => e.status === 409);
  assert.equal(existsSync(join(root, 'assets/vo.fr.vtt')), false);
});

test('单行HTTP入口也需要快照并拒绝旧版本', async () => {
  const root = project([{ clips: [{ id: 'vo', src: 'assets/vo.mp3' }] }], { 'assets/vo.mp3': 'x', 'assets/vo.vtt': ONE_LINE });
  const { base, close } = await serve(root);
  const put = (body) => fetch(`${base}/captions/line`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const got = await (await fetch(`${base}/captions/source?src=assets%2Fvo.mp3`)).json();
    const edit = { src: 'assets/vo.mp3', line: 0, part: 0, text: 'Corrected.' };
    assert.equal((await put(edit)).status, 428);
    assert.equal((await put({ ...edit, from: got.snapshot })).status, 200);
    const saved = readFileSync(join(root, 'assets/vo.vtt'), 'utf8');
    assert.equal((await put({ ...edit, text: 'Old window', from: got.snapshot })).status, 409);
    assert.equal(readFileSync(join(root, 'assets/vo.vtt'), 'utf8'), saved);
  } finally { close(); }
});

test('字幕保存保留未改实测来源，改字或改时不能继续冒称实测，译文只估时', async () => {
  const original = vttOf([{ text: 'One two.', startMs: 0, endMs: 1100, marks: [{ index: 0, startMs: 0 }, { index: 4, startMs: 500 }],
    timing: 'measured', alignment: { matchedWords: 2, totalWords: 2 } }]);
  const root = project([], { 'assets/vo.mp3': 'x', 'assets/vo.vtt': original });
  let read = await sourceSubtitles(root, 'assets/vo.mp3');
  await writeSourceSubtitles(root, 'assets/vo.mp3', read.cues, read.snapshot);
  read = await sourceSubtitles(root, 'assets/vo.mp3');
  assert.equal(read.cues[0].timing, 'measured');
  assert.deepEqual(read.cues[0].alignment, { matchedWords: 2, totalWords: 2 });
  await writeSourceSubtitles(root, 'assets/vo.mp3', [{ ...read.cues[0], text: 'One changed.', alt: { fr: 'Un changé.' } }], read.snapshot);
  const edited = (await readTranscript(root, 'assets/vo.mp3')).lines[0];
  assert.equal(edited.timing, 'edited');
  assert.equal(edited.alignment, undefined);
  assert.equal((await readTranscript(root, 'assets/vo.mp3', 'fr')).lines[0].timing, 'estimated');
});
