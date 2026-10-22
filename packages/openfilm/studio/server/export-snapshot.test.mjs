import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { snapshotFilm } from './export-snapshot.mjs';
import { filmHtml } from '../../src/film-doc.mjs';

test('render snapshot freezes its local film closure, excludes unrelated media, and records an inspectable manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vc-snapshot-'));
  const root = join(dir, 'project'), input = join(dir, 'job', 'input');
  try {
    await mkdir(join(root, 'scenes'), { recursive: true });
    await mkdir(join(root, 'assets'), { recursive: true });
    const film = filmHtml({ stage: { w: 640, h: 360 }, tracks: [{ clips: [{ id: 'intro', src: 'scenes/a.html' }] }] });
    await writeFile(join(root, 'film.html'), film);
    await writeFile(join(root, 'scenes', 'a.html'), '<img src="../assets/used.png">');
    await writeFile(join(root, 'assets', 'used.png'), 'original picture');
    await writeFile(join(root, 'assets', 'unused.mp4'), 'unrelated video');
    const manifest = await snapshotFilm(root, input);
    assert.deepEqual(manifest.files.map((f) => f.path).sort(), ['assets/used.png', 'film.html', 'scenes/a.html']);
    for (const file of manifest.files) {
      const copied = await readFile(join(input, file.path));
      assert.equal(file.bytes, copied.length);
      assert.equal(file.sha256, createHash('sha256').update(copied).digest('hex'));
    }
    const frozenSourceSha = manifest.files.find((file) => file.path === 'assets/used.png').sha256;
    await writeFile(join(root, 'assets', 'used.png'), 'human changed picture');
    await writeFile(join(root, 'film.html'), 'human changed film');
    assert.equal(await readFile(join(input, 'assets', 'used.png'), 'utf8'), 'original picture');
    assert.equal(frozenSourceSha, createHash('sha256').update('original picture').digest('hex'));
    assert.equal(await readFile(join(input, 'film.html'), 'utf8'), film);
    assert.equal(JSON.parse(await readFile(join(dir, 'job', 'input-manifest.json'), 'utf8')).filmRevision, manifest.filmRevision);
    assert.ok(manifest.limitations.length, 'static closure limits are explicit');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('oversized render inputs fail before copying rather than copying the whole project without a bound', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vc-snapshot-bound-'));
  try {
    await writeFile(join(dir, 'film.html'), filmHtml({ stage: { w: 640, h: 360 }, tracks: [{ clips: [{ id: 'a', src: 'a.html' }] }] }));
    await writeFile(join(dir, 'a.html'), 'a page');
    await assert.rejects(snapshotFilm(dir, join(dir, 'job', 'input'), { maxFiles: 1 }), /snapshot limit/);
    await assert.rejects(snapshotFilm(dir, join(dir, 'job', 'input'), { maxBytes: 1 }), /snapshot limit/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
