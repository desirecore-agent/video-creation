import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revOf } from './film.mjs';
import { createWatchers, watchTree } from './watch.mjs';

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

test('film.html changes come with their revision, other files as one files event; .film/ is not watched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'of-watch-'));
  writeFileSync(join(root, 'film.html'), '{"stage":{"w":1,"h":1},"tracks":[]}');
  mkdirSync(join(root, '.film'));
  mkdirSync(join(root, 'assets'));
  const watchers = createWatchers();
  const seen = [];
  const stop = watchers.subscribe(root, (e) => seen.push(e));
  try {
  /* macOS reports the folder's own creation a moment late: let it pass before the writes this test counts */
  await settle(600);
  seen.length = 0;

  const text = '{"stage":{"w":2,"h":2},"tracks":[]}';
  writeFileSync(join(root, 'film.html'), text);
  writeFileSync(join(root, 'assets', 'a.wav'), 'x');
  writeFileSync(join(root, 'assets', 'b.wav'), 'y');
  await settle();
  assert.deepEqual(seen.find((e) => e.type === 'film'), { type: 'film', rev: revOf(text) });
  assert.equal(seen.filter((e) => e.type === 'files').length, 1, 'several files settle into one event');

  seen.length = 0;
  writeFileSync(join(root, 'film.html'), text);
  writeFileSync(join(root, '.film', 'cache'), 'z');
  await settle();
  assert.deepEqual(seen, [], 'the same text again, and Studio\'s own folder, are no change');

  /* Studio's own half-written siblings (atomic.mjs, the asset index) */
  writeFileSync(join(root, 'film.html.0123456789ab.tmp'), text);
  writeFileSync(join(root, 'assets', 'index.jsonl.123e4567-e89b-12d3-a456-426614174000.tmp'), '');
  await settle();
  assert.deepEqual(seen, [], 'Studio\'s own half-written files are no change');
  } finally {
    stop();
    watchers.closeAll();
  }
});

test('watching folder by folder (Linux): a file replaced by a rename is seen every time, and new folders are taken in', async () => {
  const root = mkdtempSync(join(tmpdir(), 'of-tree-'));
  writeFileSync(join(root, 'film.html'), '{}');
  mkdirSync(join(root, 'node_modules'));
  const names = new Set();
  const close = watchTree(root, (name) => names.add(name), false);
  try {
    for (const n of [1, 2]) {
      writeFileSync(join(root, `film.html.${n}.tmp`), `{"n":${n}}`);
      renameSync(join(root, `film.html.${n}.tmp`), join(root, 'film.html'));
      await settle(150);
      assert.ok(names.has('film.html'), `replacement ${n} seen`);
      names.clear();
    }
    mkdirSync(join(root, 'scenes'));
    await settle(150);
    writeFileSync(join(root, 'scenes', 'a.html'), '<p>');
    writeFileSync(join(root, 'node_modules', 'x.js'), '');
    await settle(150);
    assert.ok(names.has('scenes/a.html'), 'a file in a folder made while watching');
    assert.ok(![...names].some((n) => n?.startsWith('node_modules/')), 'ignored folders are not watched');
  } finally {
    close();
  }
});

test('a renamed project keeps its existing streams and their cleanup follows the new folder', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'of-watch-move-'));
  const root = join(scratch, 'Draft'), to = join(scratch, 'Final');
  mkdirSync(root);
  writeFileSync(join(root, 'film.html'), '{}');
  const watchers = createWatchers(), first = [], second = [];
  const stopFirst = watchers.subscribe(root, (event) => first.push(event));
  const stopSecond = watchers.subscribe(root, (event) => second.push(event));
  try {
    await settle();
    renameSync(root, to);
    watchers.move(root, to);
    assert.deepEqual(watchers.roots(), [to]);
    await settle();
    first.length = second.length = 0;
    writeFileSync(join(to, 'film.html'), '{"stage":{"w":2,"h":2},"tracks":[]}');
    writeFileSync(join(to, 'new-page.html'), '<p>after rename</p>');
    await settle();
    assert.ok(first.some((event) => event.type === 'film'));
    assert.ok(first.some((event) => event.type === 'files' && event.paths.includes('new-page.html')));
    assert.deepEqual(first, second, 'both already-open pages receive changes at the renamed path');
    stopFirst();
    assert.deepEqual(watchers.roots(), [to], 'one page remains');
    stopSecond();
    assert.deepEqual(watchers.roots(), [], 'old cleanup closures also release the relocated watcher');
  } finally { watchers.closeAll(); rmSync(scratch, { recursive: true, force: true }); }
});
