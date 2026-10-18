import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportsRoot, libraryRoot, savedRoot, usableFolder } from '../../src/locations.mjs';
import { createProject, listProjects, openProject } from './projects.mjs';
import { listLibrary, saveFile } from './saved.mjs';
import { readPrefs, writePrefs } from './prefs.mjs';

const KEYS = ['OPENFILM_HOME', 'OPENFILM_LIBRARY', 'OPENFILM_EXPORTS', 'OPENFILM_SAVED'];
let previous;
let scratch;
let home;
beforeEach(() => {
  previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  scratch = mkdtempSync(join(tmpdir(), 'video-creation-data-'));
  home = join(scratch, 'formal');
  process.env.OPENFILM_HOME = home;
});
afterEach(() => {
  for (const key of KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  rmSync(scratch, { recursive: true, force: true });
});

test('formal and preview homes keep newly created projects, saved files and preferences separate', async () => {
  const formal = home;
  const preview = join(scratch, 'preview');
  const first = await createProject('Demo');
  assert.equal(first.path, join(realpathSync(formal), 'projects', 'Demo'));
  writeFileSync(join(first.path, 'formal.txt'), 'formal only');
  await saveFile(first.path, 'formal.txt');
  writePrefs({ proxies: { on: false } });
  assert.equal(exportsRoot(), join(formal, 'exports'));
  assert.equal(savedRoot(), join(formal, 'saved'));

  process.env.OPENFILM_HOME = preview;
  assert.deepEqual(await listProjects(), []);
  assert.deepEqual((await listLibrary()).files, []);
  assert.equal(readPrefs().proxies.on, true);
  const second = await createProject('Demo');
  assert.equal(second.path, join(realpathSync(preview), 'projects', 'Demo'));
  assert.notEqual(second.id, first.id);
  writeFileSync(join(second.path, 'preview.txt'), 'preview only');
  await saveFile(second.path, 'preview.txt');
  assert.deepEqual((await listLibrary()).files.map((file) => file.path), ['saved/preview.txt']);
  assert.equal(exportsRoot(), join(preview, 'exports'));

  process.env.OPENFILM_HOME = formal;
  assert.deepEqual((await listProjects()).map((project) => project.id), [first.id]);
  assert.deepEqual((await listLibrary()).files.map((file) => file.path), ['saved/formal.txt']);
  assert.equal(readFileSync(join(formal, 'saved', 'formal.txt'), 'utf8'), 'formal only');
  assert.ok(!existsSync(join(formal, 'saved', 'preview.txt')));
  assert.equal(readPrefs().proxies.on, false);
});

test('projects may live under home/projects while keys and runtime state remain protected before any write', async () => {
  const project = await openProject(join(home, 'projects', 'demo'));
  assert.equal(project.path, join(realpathSync(home), 'projects', 'demo'));
  assert.ok(existsSync(join(project.path, 'film.html')));
  writeFileSync(join(home, 'key'), 'keep-this-key');
  for (const internal of ['', 'key', 'prefs.json', 'settings', 'export-jobs', 'runtime', 'runtime-config.json', 'saved', 'exports']) {
    const target = internal ? join(home, internal) : home;
    await assert.rejects(openProject(target), /own files/, internal || 'data root');
    assert.ok(!existsSync(join(target, '.film')), 'no project metadata is written to a refused location');
  }
  assert.equal(readFileSync(join(home, 'key'), 'utf8'), 'keep-this-key');
  await assert.rejects(openProject(join(home, 'projects')), /own files/, 'the library itself is not one project');
});

test('explicit external project preferences stay supported but cannot make an internal state directory a library', async () => {
  const external = join(scratch, 'external');
  process.env.OPENFILM_LIBRARY = join(scratch, 'env-library');
  const fromEnv = await createProject('Environment');
  assert.equal(fromEnv.path, join(realpathSync(scratch), 'env-library', 'Environment'));
  writePrefs({ projectsFolder: usableFolder(external) });
  const chosen = await createProject('Chosen');
  assert.equal(chosen.path, join(realpathSync(scratch), 'external', 'Chosen'));
  assert.equal(libraryRoot(), external, 'the explicit preference comes before the environment default');
  writePrefs({ projectsFolder: join(home, 'runtime', 'library') });
  await assert.rejects(createProject('Blocked'), /own files/);
  assert.ok(!existsSync(join(home, 'runtime')), 'the root is checked before mkdir');
});

test('realpath aliases cannot redirect home/projects into internal runtime state', { skip: process.platform === 'win32' }, async () => {
  mkdirSync(join(home, 'runtime'), { recursive: true });
  const alias = join(scratch, 'alias');
  symlinkSync(home, alias);
  const allowed = await openProject(join(alias, 'projects', 'demo'));
  assert.equal(allowed.path, join(realpathSync(home), 'projects', 'demo'));
  await assert.rejects(openProject(join(alias, 'runtime', 'blocked')), /own files/);
  assert.ok(!existsSync(join(home, 'runtime', 'blocked')));

  const redirected = join(home, 'projects', 'redirected');
  symlinkSync(join(home, 'runtime'), redirected);
  await assert.rejects(openProject(join(redirected, 'blocked')), /own files/);
  assert.ok(!existsSync(join(home, 'runtime', 'blocked')));
});
