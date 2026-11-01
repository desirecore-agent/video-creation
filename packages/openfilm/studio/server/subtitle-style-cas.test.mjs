import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { captionRoutes, saveSubtitleStyle } from './captions.mjs';
import { readSubtitleStyleInfo, SUBTITLE_STYLE_FILE, SUBTITLE_STYLE_WRITE_SCHEMA } from './subtitle-layout.mjs';
import { HttpError, json } from './http.mjs';
import { withProjectFilmEdit } from './film.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'subtitle-style-cas-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'film.html'), '<!doctype html><html><head><meta name="viewport" content="width=1080, height=1920"></head><body></body></html>');
  await writeFile(join(root, 'voice.vtt'), 'WEBVTT\n\n00:00.000 --> 00:01.000\n人工切句\n');
  return root;
}
const status = (n) => (e) => e.status === n;

test('missing/malformed preconditions write nothing; missing file uses explicit null', async (t) => {
  const root = await fixture(t);
  await assert.rejects(saveSubtitleStyle(root, { style: { on: false } }), status(428));
  await assert.rejects(saveSubtitleStyle(root, { style: { on: false }, from: null }), status(428));
  const observed = await readSubtitleStyleInfo(root);
  assert.equal(observed.from.styleSha256, null);
  await assert.rejects(saveSubtitleStyle(root, { style: {}, from: { filmRevision: observed.from.filmRevision } }), status(400));
  await assert.rejects(access(join(root, SUBTITLE_STYLE_FILE)));
  const validate = new Ajv().compile(SUBTITLE_STYLE_WRITE_SCHEMA);
  assert.equal(validate({ style: {}, from: observed.from }), true);
  assert.equal(validate({ style: {} }), false);
  const kept = await saveSubtitleStyle(root, { style: { pos: { x: .5, y: .795 } }, from: observed.from });
  const bytes = await readFile(join(root, SUBTITLE_STYLE_FILE));
  assert.equal(kept.from.styleSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual((await readSubtitleStyleInfo(root)).from, kept.from);
});

test('stale and concurrent old saves cannot replace winner; fresh version succeeds and preserves film/VTT', async (t) => {
  const root = await fixture(t);
  const film = await readFile(join(root, 'film.html')), vtt = await readFile(join(root, 'voice.vtt'));
  const { from } = await readSubtitleStyleInfo(root);
  const results = await Promise.allSettled([
    saveSubtitleStyle(root, { style: { pos: { x: .5, y: .795 } }, from }),
    saveSubtitleStyle(root, { style: { pos: { x: .5, y: .9 } }, from }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  const winner = await readFile(join(root, SUBTITLE_STYLE_FILE));
  await assert.rejects(saveSubtitleStyle(root, { style: { on: false }, from }), status(409));
  await assert.rejects(saveSubtitleStyle(root, { style: { on: false } }), status(428));
  assert.deepEqual(await readFile(join(root, SUBTITLE_STYLE_FILE)), winner);
  const fresh = await readSubtitleStyleInfo(root);
  await saveSubtitleStyle(root, { style: { ...fresh.style, on: false }, from: fresh.from });
  assert.equal((await readSubtitleStyleInfo(root)).style.on, false);
  assert.deepEqual(await readFile(join(root, 'film.html')), film);
  assert.deepEqual(await readFile(join(root, 'voice.vtt')), vtt);
});

for (const existing of [false, true]) test(`occupied project queue admits only one same-from save (${existing ? 'existing hash' : 'missing null'})`, async (t) => {
  const root = await fixture(t);
  const file = join(root, SUBTITLE_STYLE_FILE);
  if (existing) {
    const initial = await readSubtitleStyleInfo(root);
    await saveSubtitleStyle(root, { style: { pos: { x: .5, y: .8 }, on: true }, from: initial.from });
  }
  const { from } = await readSubtitleStyleInfo(root);
  assert.equal(from.styleSha256 === null, !existing);
  const before = existing ? await readFile(file) : null;
  const film = await readFile(join(root, 'film.html')), vtt = await readFile(join(root, 'voice.vtt'));
  let entered, release;
  const ready = new Promise((r) => { entered = r; });
  const gate = new Promise((r) => { release = r; });
  const occupied = withProjectFilmEdit(root, async () => { entered(); await gate; });
  await ready;
  let settled = 0;
  const requests = [
    saveSubtitleStyle(root, { style: { pos: { x: .5, y: .795 } }, from }),
    saveSubtitleStyle(root, { style: { pos: { x: .5, y: .9 } }, from }),
  ];
  const resultsPending = Promise.allSettled(requests.map((p) => p.finally(() => { settled++; })));
  try {
    // Keep the real queue occupied through an I/O turn; do not assume request creation order picks a winner.
    if (existing) assert.deepEqual(await readFile(file), before);
    else await assert.rejects(access(file));
    assert.equal(settled, 0, 'neither save can complete while the project writer holds the gate');
  } finally { release(); }
  await occupied;
  const results = await resultsPending;
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  const winner = results.find((r) => r.status === 'fulfilled').value;
  const winnerBytes = await readFile(file);
  assert.deepEqual(JSON.parse(winnerBytes), winner.style);
  assert.equal(createHash('sha256').update(winnerBytes).digest('hex'), winner.from.styleSha256);
  await assert.rejects(saveSubtitleStyle(root, { style: { on: false }, from }), status(409));
  await assert.rejects(saveSubtitleStyle(root, { style: { on: false } }), status(428));
  await assert.rejects(saveSubtitleStyle(root, { style: { on: false }, from: null }), status(428));
  await assert.rejects(saveSubtitleStyle(root, { style: { on: false }, from: { ...winner.from, styleSha256: null } }), status(409));
  assert.deepEqual(await readFile(file), winnerBytes, 'stale, missing and false absent-file preconditions preserve winner bytes');
  assert.deepEqual(await readFile(join(root, 'film.html')), film);
  assert.deepEqual(await readFile(join(root, 'voice.vtt')), vtt);
});

test('film changed in existing project queue rejects old style without side effects', async (t) => {
  const root = await fixture(t);
  const { from } = await readSubtitleStyleInfo(root);
  let entered, release;
  const ready = new Promise((r) => { entered = r; });
  const gate = new Promise((r) => { release = r; });
  const edit = withProjectFilmEdit(root, async () => {
    entered();
    await gate;
    await writeFile(join(root, 'film.html'), '<html><body><section></section></body></html>');
  });
  await ready; // queue entry, not promise creation order, determines serialization
  const save = saveSubtitleStyle(root, { style: {}, from });
  release();
  await edit;
  await assert.rejects(save, status(409));
  await assert.rejects(access(join(root, SUBTITLE_STYLE_FILE)));
});

test('HTTP legacy PUT has no implicit token; GET/PUT preserve the same guard', async (t) => {
  const root = await fixture(t);
  const server = createServer((req, res) => {
    captionRoutes(req, res, root, 'subtitles').catch((e) => json(res, e instanceof HttpError ? e.status : 500, { error: e.message }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}/subtitles`;
  const put = (body) => fetch(url, { method: 'PUT', body: JSON.stringify(body) });
  const old = await (await fetch(url)).json();
  assert.equal((await put({ style: {} })).status, 428);
  await assert.rejects(access(join(root, SUBTITLE_STYLE_FILE)));
  const ok = await put({ style: { on: false }, from: old.from });
  assert.equal(ok.status, 200);
  const saved = await ok.json();
  assert.equal((await put({ style: { on: true }, from: old.from })).status, 409);
  assert.deepEqual((await (await fetch(url)).json()).from, saved.from);
});
