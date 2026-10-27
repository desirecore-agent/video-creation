import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { filmHtml } from '../../src/film-doc.mjs';
import { filmCaptions } from './captions.mjs';
import { filmSubtitleShown, filmSubtitleSrt, filmSubtitleVtt } from './film-subtitle.mjs';
import { videoSidecarText } from './exports.mjs';

const firstVtt = 'WEBVTT\n\n00:00:00.200 --> 00:00:01.800\nFIRST_CUE\n';
const secondVtt = 'WEBVTT\n\n00:00:00.200 --> 00:00:01.800\nSECOND_CUE\n';
const noProbe = { duration: async () => undefined };
async function fixture(tracks, files, run) {
  const root = await mkdtemp(join(tmpdir(), 'vc-clip-sidecar-'));
  try {
    await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks }));
    for (const [path, value] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), value);
    }
    await run(root, await filmCaptions(root, noProbe));
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('a nonzero-at clip sidecar contains only that clip and starts on its local output clock', async () => {
  await fixture([{ clips: [
    { id: 'first', src: 'first.mp4', at: 0, time: [0, 2] },
    { id: 'second', src: 'second.mp4', at: 5, time: [0, 2] },
  ] }], { 'first.vtt': firstVtt, 'second.vtt': secondVtt }, async (_root, { cues }) => {
    const original = structuredClone(cues);
    const clip = { id: 'second', at: 5 };
    assert.equal(videoSidecarText(cues, 'srt', { clip }), '1\n00:00:00,200 --> 00:00:01,800\nSECOND_CUE\n');
    assert.equal(videoSidecarText(cues, 'vtt', { clip, range: [0, 1] }), 'WEBVTT\n\n00:00:00.200 --> 00:00:01.000\nSECOND_CUE\n');
    assert.deepEqual(cues, original, 'plain subtitle delivery must not mutate the film captions');
  });
});

test('source trim and speed are applied once; same-source instances do not leak into clip-local ranges', async () => {
  const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nOUTSIDE_SOURCE\n\n00:00:01.000 --> 00:00:03.000\nTRIMMED_TARGET\n\n00:00:03.000 --> 00:00:04.000\nLATER_SOURCE\n';
  await fixture([{ clips: [
    { id: 'other-copy', src: 'same.mp4', at: 10, time: [0, 1] },
    { id: 'target', src: 'same.mp4', at: 5, time: [1, 3], speed: 2 },
  ] }], { 'same.vtt': vtt }, async (_root, { cues }) => {
    const clip = { id: 'target', at: 5 };
    assert.equal(videoSidecarText(cues, 'srt', { clip }), '1\n00:00:00,000 --> 00:00:01,000\nTRIMMED_TARGET\n');
    assert.equal(videoSidecarText(cues, 'vtt', { clip, range: [0.25, 0.75] }), 'WEBVTT\n\n00:00:00.000 --> 00:00:00.500\nTRIMMED_TARGET\n');
    assert.equal(videoSidecarText(cues, 'srt', { clip, range: [1, 2] }), '', 'a range outside the spoken clip has no subtitle');
  });
});

test('whole-film sidecars retain their previous global-range semantics', async () => {
  await fixture([{ clips: [
    { id: 'first', src: 'first.mp4', at: 0, time: [0, 2] },
    { id: 'second', src: 'second.mp4', at: 5, time: [0, 2] },
  ] }], { 'first.vtt': firstVtt, 'second.vtt': secondVtt }, async (_root, { cues }) => {
    assert.equal(videoSidecarText(cues, 'srt'), filmSubtitleSrt(cues));
    assert.equal(videoSidecarText(cues, 'vtt'), filmSubtitleVtt(cues));
    assert.equal(videoSidecarText(cues, 'srt', { range: [5, 6] }), '1\n00:00:00,200 --> 00:00:01,000\nSECOND_CUE\n');
  });
});

test('an explicit sidecar keeps the chosen language even with preview captions switched off', async () => {
  await fixture([{ clips: [{ id: 'voice', src: 'voice.mp4', at: 8, time: [0, 2] }] }], {
    'voice.vtt': secondVtt, 'voice.fr.vtt': secondVtt.replace('SECOND_CUE', 'TEXTE_CHOISI'),
  }, async (_root, { cues }) => {
    const shown = filmSubtitleShown(cues, { on: false, language: 'fr', bilingual: false });
    assert.equal(videoSidecarText(shown, 'srt', { clip: { id: 'voice', at: 8 } }), '1\n00:00:00,200 --> 00:00:01,800\nTEXTE_CHOISI\n');
  });
});

test('silent clips and page clips do not receive captions from other audible film tracks', async () => {
  await fixture([
    { muted: true, clips: [{ id: 'muted', src: 'voice.mp4', at: 5, time: [0, 2] }] },
    { hidden: true, clips: [{ id: 'hidden', src: 'voice.mp4', at: 6, time: [0, 2] }] },
    { clips: [
      { id: 'zero-volume', src: 'voice.mp4', at: 7, time: [0, 2], volume: 0 },
      { id: 'audible', src: 'voice.mp4', at: 8, time: [0, 2] },
      { id: 'page', src: 'scene.html', at: 8, time: [0, 2] },
    ] },
  ], { 'voice.vtt': secondVtt }, async (_root, { cues }) => {
    for (const [id, at] of [['muted', 5], ['hidden', 6], ['zero-volume', 7], ['page', 8]]) {
      assert.equal(videoSidecarText(cues, 'srt', { clip: { id, at } }), '', id);
    }
    assert.match(videoSidecarText(cues, 'srt', { clip: { id: 'audible', at: 8 } }), /SECOND_CUE/);
    assert.equal(videoSidecarText([{ startMs: 8000, durMs: 1000, text: 'Unowned' }], 'srt', { clip: { id: 'audible', at: 8 } }), '', 'an untraced cue is not guessed to belong to the clip');
  });
});
