import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { PRODUCT } from './product.mjs';
import { studioHomeDir, libraryDefault } from './locations.mjs';
import { npmOpenfilm, newerOpenfilm, updateOpenfilm } from '../studio/client.mjs';

const CLI = fileURLToPath(new URL('../bin/openfilm.mjs', import.meta.url));

test('the independent product configuration validates and cannot select an upstream distribution channel', () => {
  const schema = JSON.parse(readFileSync(new URL('../product.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv().compile(schema);
  assert.equal(validate(PRODUCT), true, JSON.stringify(validate.errors));
  assert.equal(PRODUCT.id, 'video-creation');
  assert.equal(PRODUCT.displayName, '视频创作');
  assert.equal(PRODUCT.directorName, '视频导演');
  assert.equal(validate({ ...PRODUCT, managedUpdates: false }), false);
  assert.equal(validate({ ...PRODUCT, desktop: { updates: 'https://openfilm.dev/download/desktop' } }), false);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, '@desirecore-agent/video-creation');
  assert.equal(pkg.private, true);
  assert.deepEqual(Object.keys(pkg.bin), ['video-creation']);
  assert.equal(pkg.scripts.prepack, undefined, 'packing cannot select an official product feed');
});

test('managed updates ignore stale upstream cache and never make a registry request', async () => {
  const home = mkdtempSync(join(tmpdir(), 'video-creation-update-'));
  const previousHome = process.env.OPENFILM_HOME;
  const fetchBefore = globalThis.fetch;
  const cache = join(home, 'update.json');
  writeFileSync(cache, JSON.stringify({ latest: '99.0.0', checkedAt: Date.now() }));
  const cacheBefore = readFileSync(cache, 'utf8');
  process.env.OPENFILM_HOME = home;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('a managed app must not query npm'); };
  try {
    assert.deepEqual(await npmOpenfilm({ network: true, force: true }), { latest: null, checkedAt: null });
    assert.equal(await newerOpenfilm({ network: false }), null);
    assert.match((await updateOpenfilm()).lines.join('\n'), /managed by DesireCore/);
    assert.equal(requests, 0);
    assert.equal(readFileSync(cache, 'utf8'), cacheBefore);
  } finally {
    globalThis.fetch = fetchBefore;
    if (previousHome === undefined) delete process.env.OPENFILM_HOME;
    else process.env.OPENFILM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a source CLI invoked through npm exec still names this product and only describes managed updates', () => {
  const env = { ...process.env, npm_command: 'exec' };
  delete env.OPENFILM_RUN;
  delete env.VIDEO_CREATION_RUN;
  for (const args of [['--help'], [], ['update']]) {
    const run = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /npx (?:-y )?openfilm|npm install -g openfilm/);
    assert.match(run.stdout, args[0] === 'update' ? /managed by DesireCore/ : /视频创作/);
    if (args[0] === '--help') assert.match(run.stdout, /video-creation open/);
  }
});

test('default settings and project directories are separate from an installed upstream OpenFilm', () => {
  const saved = { home: process.env.OPENFILM_HOME, library: process.env.OPENFILM_LIBRARY };
  delete process.env.OPENFILM_HOME;
  delete process.env.OPENFILM_LIBRARY;
  try {
    assert.equal(studioHomeDir(), join(homedir(), '.video-creation'));
    assert.equal(libraryDefault(), join(studioHomeDir(), 'projects'));
  } finally {
    if (saved.home === undefined) delete process.env.OPENFILM_HOME; else process.env.OPENFILM_HOME = saved.home;
    if (saved.library === undefined) delete process.env.OPENFILM_LIBRARY; else process.env.OPENFILM_LIBRARY = saved.library;
  }
});
