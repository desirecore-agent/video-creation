import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVtt, projectSpeech, readTranscript, spokenLines, setLine, transcriptIsCurrent, translationsOf, vttOf, writeTranscript } from './transcripts.mjs';

const LINES = [{ text: 'Hello there.', startMs: 0, endMs: 1000 }];

/** A project, and a folder beside it that is not the project's (a `../` away), each with a sound and its transcript. */
function folders() {
  const scratch = mkdtempSync(join(tmpdir(), 'of-transcripts-'));
  const root = join(scratch, 'Film'), away = join(scratch, 'away');
  for (const dir of [join(root, 'assets'), away]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'assets', 'vo.mp3'), 'x');
  writeFileSync(join(root, 'assets', 'vo.vtt'), vttOf(LINES));
  writeFileSync(join(away, 'vo.mp3'), 'x');
  writeFileSync(join(away, 'vo.vtt'), vttOf(LINES));
  writeFileSync(join(away, 'vo.fr.vtt'), vttOf(LINES));
  return { root, away };
}

test('a transcript is read and written only inside the project, never at a `../` source', async () => {
  const { root, away } = folders();
  assert.equal((await readTranscript(root, 'assets/vo.mp3'))?.lines[0].text, 'Hello there.');
  for (const src of ['../away/vo.mp3', '../../x.mp3', '.film/vo.mp3']) {
    assert.equal(await readTranscript(root, src), null, src);
    assert.equal(await readTranscript(root, src, 'fr'), null, src);
    assert.equal(await transcriptIsCurrent(root, src), false, src);
    assert.deepEqual(await translationsOf(root, src), [], src);
    await assert.rejects(writeTranscript(root, src, { lines: LINES }), /not a path inside the project/, src);
    assert.equal(await setLine(root, src, 0, 'changed'), false, src);
  }
  /* a language is part of the file's name: it cannot lead out either */
  await assert.rejects(writeTranscript(root, 'assets/vo.mp3', { lines: LINES }, '/../../../away/x'), /not a path inside the project/);
  assert.equal(readFileSync(join(away, 'vo.vtt'), 'utf8'), vttOf(LINES), 'the transcript out there as it was');
  assert.ok(!existsSync(join(away, 'x.vtt')));
});

test('a link in the project to a folder out of it is not followed for transcripts', { skip: process.platform === 'win32' && 'links need Developer Mode on Windows' }, async () => {
  const { root, away } = folders();
  symlinkSync(away, join(root, 'assets', 'linked'));
  assert.equal(await readTranscript(root, 'assets/linked/vo.mp3'), null);
  assert.deepEqual(await translationsOf(root, 'assets/linked/vo.mp3'), []);
  assert.equal(await transcriptIsCurrent(root, 'assets/linked/vo.mp3'), false);
  await assert.rejects(writeTranscript(root, 'assets/linked/vo.mp3', { lines: [] }), /not a path inside the project/);
  /* a transcript that is itself a link out is not read as the project's speech */
  symlinkSync(join(away, 'vo.vtt'), join(root, 'assets', 'theirs.vtt'));
  writeFileSync(join(away, 'vo.vtt'), vttOf([{ text: 'Private words.', startMs: 0, endMs: 1000 }]));
  assert.equal(await projectSpeech(root), 'Hello there.');
});


test('ITN zero-match timing stays inside the measured speech interval and declares estimation', () => {
  const lines = spokenLines('100', [{ token: '一百', startSec: 10, endSec: 11 }]);
  assert.deepEqual(lines, [{ text: '100', startMs: 10000, endMs: 11000, timing: 'estimated', alignment: { matchedWords: 0, totalWords: 1 } }]);
  assert.deepEqual(parseVtt(vttOf(lines)).lines, lines);
  const withDuration = spokenLines('100', [{ token: '一百', startSec: 10, endSec: 11 }], 30000);
  assert.equal(withDuration[0].startMs, 10000);
  assert.equal(withDuration[0].endMs, 11000, 'media duration is not the spoken token end');
});

test('partial word matching keeps real anchors, estimates gaps, and never calls the entire result measured', () => {
  const words = [{ token: '一百', startSec: 10, endSec: 11 }, { token: '元', startSec: 11, endSec: 12 }];
  const [line] = spokenLines('100元', words);
  assert.equal(line.startMs, 10000);
  assert.equal(line.endMs, 12000);
  assert.equal(line.timing, 'estimated');
  assert.deepEqual(line.alignment, { matchedWords: 1, totalWords: 2 });
  assert.deepEqual(line.marks, [{ index: 3, startMs: 11000 }]);
  const roundTrip = parseVtt(vttOf([line])).lines[0];
  assert.equal(roundTrip.timing, 'estimated');
  assert.equal(roundTrip.marks.find((m) => m.index === 3).startMs, 11000);
  const pieces = spokenLines('100。元。', words);
  assert.deepEqual(pieces.map((p) => [p.startMs, p.endMs, p.timing]), [[10000, 11000, 'estimated'], [11000, 12000, 'estimated']]);
});

test('new measured word origins survive VTT, while legacy time tags remain unknown', () => {
  const lines = spokenLines('一百元', [{ token: '一百', startSec: 10, endSec: 11 }, { token: '元', startSec: 11, endSec: 12 }], 13000);
  assert.equal(lines[0].timing, 'measured');
  assert.deepEqual(parseVtt(vttOf(lines)).lines, lines);
  const unknown = parseVtt('WEBVTT\n\n00:00:10.000 --> 00:00:12.000\n一百<00:00:11.000>元\n');
  assert.equal(unknown.lines[0].timing, undefined);
  assert.equal(unknown.lines[0].alignment, undefined);
  const estimated = spokenLines('完全没有词时间', undefined, 2000);
  assert.equal(estimated[0].timing, 'estimated');
  assert.equal(estimated[0].alignment, undefined);
});

test('manual text corrections invalidate measured word provenance without retiming the whole line', async () => {
  const { root } = folders();
  const lines = spokenLines('One two.', [{ token: 'One', startSec: 0, endSec: 0.4 }, { token: 'two.', startSec: 0.4, endSec: 0.9 }], 1000);
  await writeTranscript(root, 'assets/vo.mp3', { lines });
  assert.equal((await readTranscript(root, 'assets/vo.mp3')).lines[0].timing, 'measured');
  await setLine(root, 'assets/vo.mp3', 0, 'One two.');
  assert.equal((await readTranscript(root, 'assets/vo.mp3')).lines[0].timing, 'measured', 'a no-op keeps origin');
  await setLine(root, 'assets/vo.mp3', 0, 'One hundred.');
  const after = (await readTranscript(root, 'assets/vo.mp3')).lines[0];
  assert.equal(after.timing, 'edited');
  assert.equal(after.startMs, lines[0].startMs);
  assert.equal(after.endMs, lines[0].endMs);
  assert.equal(after.marks, undefined);
  assert.equal(after.alignment, undefined);
});


test('known short cues are not mistaken for legacy word-cue files and keep their original coverage', async () => {
  const { root } = folders();
  const lines = [0, 1, 2].map((i) => ({ text: `${i}。`, startMs: 10000 + i * 1000, endMs: 11000 + i * 1000, timing: 'estimated', alignment: { matchedWords: 0, totalWords: 3 } }));
  await writeTranscript(root, 'assets/vo.mp3', { lines });
  assert.deepEqual((await readTranscript(root, 'assets/vo.mp3')).lines, lines);
  const [single] = spokenLines('元', [{ token: '元', startSec: 10, endSec: 11 }]);
  const body = vttOf([single]);
  assert.doesNotMatch(body, /\n<00:00:10\.000>/, 'the implicit first mark needs no start-equal timestamp tag');
  assert.deepEqual(parseVtt(body).lines, [single]);
});
