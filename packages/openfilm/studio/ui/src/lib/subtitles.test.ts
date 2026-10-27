import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SNAP_X, SNAP_Y, SUBTITLE_DEFAULT, SUBTITLE_HOME_Y, joinColor, nearestSizeId, snapAxis, splitColor, subtitleCss,
  saveSourceSubtitles, saveSubtitleLine, unchangedSourceCue, unchangedSourceRevision } from './subtitles.ts';
import { subtitleDraftRows, subtitleLineId } from './subtitles.ts';

test('a dragged subtitle snaps within 6 screen pixels, whatever the size of the picture', () => {
  assert.deepEqual(snapAxis(0.505, 1000, SNAP_X), { value: 0.5, guide: 0.5 });
  assert.deepEqual(snapAxis(0.51, 1000, SNAP_X), { value: 0.51, guide: null });
  /* the same fraction off is within reach on a small preview */
  assert.deepEqual(snapAxis(0.51, 300, SNAP_X), { value: 0.5, guide: 0.5 });
  assert.equal(snapAxis(SUBTITLE_HOME_Y - 0.003, 1080, SNAP_Y).value, SUBTITLE_HOME_Y);
  assert.equal(snapAxis(1 - SUBTITLE_HOME_Y + 0.002, 1080, SNAP_Y).guide, 1 - SUBTITLE_HOME_Y);
});

test('a color splits into hue and alpha and joins back', () => {
  assert.deepEqual(splitColor('rgba(0,0,0,0.84)'), { hex: '#000000', alpha: 0.84 });
  assert.deepEqual(splitColor('#FFF'), { hex: '#ffffff', alpha: 1 });
  assert.deepEqual(splitColor('tomato'), { hex: '#000000', alpha: 1 });
  assert.equal(joinColor('#ff8000', 0.5), 'rgba(255,128,0,0.5)');
  assert.equal(joinColor('#ff8000', 1), '#ff8000');
});

test('the preview sizes subtitles by the frame box, never below 11px', () => {
  assert.equal(subtitleCss(SUBTITLE_DEFAULT).text.fontSize, 'max(11px, 4cqmin)');
  assert.equal(nearestSizeId(5), 'lg');
  assert.equal(nearestSizeId(3.5), 'sm');
});

test('保存发送读取到的完整快照，409保留调用者的草稿', async () => {
  const oldFetch = globalThis.fetch;
  const from = { files: { 'voice.vtt': 'Original VTT', 'voice.fr.vtt': null } };
  const cues = [{ startMs: 0, endMs: 1000, text: 'My draft' }];
  let sent: unknown;
  globalThis.fetch = async (_url, options) => {
    sent = JSON.parse(String(options?.body));
    return new Response(JSON.stringify({ error: 'These subtitles changed elsewhere.' }), { status: 409 });
  };
  try {
    await assert.rejects(saveSourceSubtitles('project', 'voice.wav', cues, from), /changed elsewhere/);
    assert.deepEqual(sent, { src: 'voice.wav', cues, from });
    assert.equal(cues[0]!.text, 'My draft');
  } finally { globalThis.fetch = oldFetch; }
});

test('单行保存携带source GET快照，且必须与开始编辑时所见版本相同', async () => {
  const oldFetch = globalThis.fetch;
  const snapshot = { files: { 'voice.vtt': 'Original VTT' } };
  const seen = { startMs: 0, durMs: 1000, text: 'Old words', line: 0, src: 'voice.wav', sourceRevision: 'read-revision' };
  const change = { src: 'voice.wav', line: 0, text: 'New words' };
  const requests: { url: string; body: unknown }[] = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: options?.body ? JSON.parse(String(options.body)) : null });
    return new Response(JSON.stringify(options?.method === 'PUT' ? { ok: true } : {
      src: 'voice.wav', cut: true, cues: [{ startMs: 0, endMs: 1000, text: 'Old words', line: 0 }], snapshot, sourceRevision: 'read-revision',
    }));
  };
  try {
    await saveSubtitleLine('project', change, seen);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1]!.body, { ...change, from: snapshot });
    requests.length = 0;
    await assert.rejects(saveSubtitleLine('project', change, { ...seen, sourceRevision: 'stale' }), /draft has not been saved/);
    assert.equal(requests.length, 1, '版本不同不发起写入，不能用刚读取的版本冒充所见基线');
    requests.length = 0;
    await assert.rejects(saveSubtitleLine('project', change, { ...seen, sourceRevision: undefined }), /need refreshing/);
    assert.equal(requests.length, 1);
  } finally { globalThis.fetch = oldFetch; }
});

test('字幕定位使用来源line/part，显示文字不当原字节；源变化由摘要拒绝', () => {
  const seen = { startMs: 0, durMs: 1000, text: 'Old words', line: 0, alt: { fr: 'Avant' } };
  assert.equal(unchangedSourceCue([{ startMs: 0, endMs: 1000, text: 'Old words', line: 0 }], seen), 0);
  assert.equal(unchangedSourceCue([{ startMs: 0, endMs: 1000, text: 'A whole source phrase', line: 0 }], seen), 0);
  assert.throws(() => unchangedSourceCue([{ startMs: 0, endMs: 1000, text: 'Old words', line: 0, part: 1 }], seen), /draft has not been saved/);
  assert.throws(() => unchangedSourceRevision('new', 'old'), /draft has not been saved/);
  assert.throws(() => unchangedSourceRevision('new', undefined), /need refreshing/);
});

test('原cue改时、重分段或被删后，唯一草稿仍持有原文字、时点、语言和摘要', () => {
  const cue = { startMs: 300, durMs: 600, text: 'Shown words', line: 0, src: 'voice.wav', clip: 'first', sourceRevision: 'old', alt: { fr: 'Ancien' } };
  const draft = { cue, text: 'Not saved yet', language: 'fr' };
  const later = { ...cue, startMs: 450, sourceRevision: 'new' };
  const rows = subtitleDraftRows([later], draft);
  assert.deepEqual(rows, [later, cue]);
  assert.equal(rows[1], draft.cue);
  assert.deepEqual(subtitleDraftRows([], draft), [cue]);
  assert.deepEqual(subtitleDraftRows([{ ...cue, text: 'New text', sourceRevision: 'new' }], draft), [cue]);
  assert.deepEqual(subtitleDraftRows([], null), []);
  assert.notEqual(subtitleLineId(cue), subtitleLineId({ ...cue, clip: 'second' }), '同音频的另一片段不是草稿目标');
  assert.equal(draft.text, 'Not saved yet');
  assert.equal(draft.language, 'fr');
  assert.equal(draft.cue.sourceRevision, 'old');
});

test('真实trim与speed映射出的显示字幕可正常改字，不以显示清理文字误判源冲突', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createServer } = await import('node:http');
  const { filmHtml } = await import('../../../../src/film-doc.mjs');
  const { vttOf } = await import('../../../server/transcripts.mjs');
  const { filmCaptions, captionRoutes } = await import('../../../server/captions.mjs');
  const { sourceSubtitles } = await import('../../../server/subtitle-edits.mjs');
  const { HttpError, json } = await import('../../../server/http.mjs');
  const root = await mkdtemp(join(tmpdir(), 'subtitle-ui-trim-'));
  const oldFetch = globalThis.fetch;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets/voice.wav'), 'local media placeholder; duration supplied');
    await writeFile(join(root, 'assets/voice.vtt'), vttOf([{ text: 'One two three.', startMs: 0, endMs: 1600,
      marks: [{ index: 0, startMs: 0 }, { index: 4, startMs: 400 }, { index: 8, startMs: 900 }] }]));
    await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 1280, h: 720 }, tracks: [{ clips: [
      { id: 'vo', src: 'assets/voice.wav', at: 4, time: [0.4, 1.6], speed: 2 },
    ] }] }));
    const captions = await filmCaptions(root, { duration: async () => 1.6 });
    const seen = captions.cues[0]!;
    const source = await sourceSubtitles(root, 'assets/voice.wav');
    assert.equal(seen.text, 'two three.');
    assert.equal(seen.startMs, 4000);
    assert.equal(seen.durMs, 600);
    assert.equal(source.cues[0]!.text, 'One two three.');
    assert.equal(seen.sourceRevision, source.sourceRevision);
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://local').pathname.split('/project/')[1] ?? '';
      captionRoutes(req, res, root, path).then((done) => { if (!done) json(res, 404, {}); }, (e) => json(res, e instanceof HttpError ? e.status : 500, { error: e.message }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    globalThis.fetch = (url, options) => oldFetch(`${base}${url}`, options);
    await saveSubtitleLine('project', { src: 'assets/voice.wav', line: seen.line!, text: 'One two corrected.' }, seen);
    assert.equal((await sourceSubtitles(root, 'assets/voice.wav')).cues[0]!.text, 'One two corrected.');
  } finally {
    globalThis.fetch = oldFetch;
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
    await rm(root, { recursive: true, force: true });
  }
});
