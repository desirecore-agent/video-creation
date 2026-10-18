import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportsRoot, libraryDefault, libraryRoot, locations, savedRoot, usableFolder } from './locations.mjs';

const KEYS = ['OPENFILM_HOME', 'OPENFILM_LIBRARY', 'OPENFILM_EXPORTS', 'OPENFILM_SAVED'];
let saved;
let home;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  home = mkdtempSync(join(tmpdir(), 'of-locations-'));
  process.env.OPENFILM_HOME = home;
  delete process.env.OPENFILM_LIBRARY;
  delete process.env.OPENFILM_EXPORTS;
  delete process.env.OPENFILM_SAVED;
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
const prefs = (value) => writeFileSync(join(home, 'prefs.json'), JSON.stringify(value));

test('new projects go to the folder chosen, before any default', () => {
  process.env.OPENFILM_LIBRARY = join(home, 'lib');
  assert.equal(libraryRoot(), join(home, 'lib'), 'the default: what the build set');
  const projects = join(tmpdir(), 'D', 'OpenFilm', 'Projects');
  prefs({ proxies: { on: true }, projectsFolder: projects });
  assert.equal(libraryRoot(), projects);
  assert.equal(libraryDefault(), join(home, 'lib'), 'the default stays what it was');
  /* a value that is not a full path is no choice */
  prefs({ projectsFolder: 'relative/folder' });
  assert.equal(libraryRoot(), join(home, 'lib'));
});

test('exports go to the default: no folder kept in prefs.json moves them (the export dialog picks one)', () => {
  process.env.OPENFILM_EXPORTS = join(home, 'out');
  prefs({ exportsFolder: join(tmpdir(), 'D', 'OpenFilm', 'Exports') });
  assert.equal(exportsRoot(), join(home, 'out'));
});

test('without an explicit choice projects, exports and saved media belong to this instance home', () => {
  assert.equal(exportsRoot(), join(home, 'exports'));
  assert.equal(libraryRoot(), join(home, 'projects'));
  assert.equal(savedRoot(), join(home, 'saved'));
  process.env.OPENFILM_SAVED = join(home, '..', 'explicit-saved');
  assert.equal(savedRoot(), process.env.OPENFILM_SAVED, 'an explicit saved library remains supported');
});

test('each folder for Settings: where it is, its default, whether chosen, and free space on its disk', () => {
  const projects = join(home, 'work', 'Projects');
  prefs({ projectsFolder: projects });
  const now = locations();
  assert.equal(now.projects.path, projects);
  assert.equal(now.projects.chosen, true);
  assert.notEqual(now.projects.default, projects);
  assert.ok(now.projects.free > 0, 'measured on the disk above a folder not made yet');
  assert.deepEqual(Object.keys(now), ['projects'], 'only where new projects go is a setting');
});

test('a folder offered is made and kept by its full path; a disk, Studio\'s own home or a relative path is refused', () => {
  const folder = join(home, '..', `of-pick-${process.pid}`, 'Projects');
  const kept = usableFolder(folder);
  assert.ok(existsSync(kept));
  assert.throws(() => usableFolder('Projects'), /full path/);
  assert.throws(() => usableFolder(process.platform === 'win32' ? 'C:\\' : '/'), /not the disk itself/);
  assert.throws(() => usableFolder(join(home, 'inside')), /own settings/);
  assert.equal(usableFolder(join(home, 'projects')), join(home, 'projects'));
  assert.equal(usableFolder(join(home, 'projects', 'series')), join(home, 'projects', 'series'));
  for (const internal of ['key', 'prefs.json', 'settings', 'runtime', 'export-jobs', 'saved', 'exports']) {
    assert.throws(() => usableFolder(join(home, internal, 'as-library')), /own settings/, internal);
    assert.ok(!existsSync(join(home, internal)), 'a refused path must not be created');
  }
});

test('library validation follows aliases before allowing a path in the home projects tree', { skip: process.platform === 'win32' }, () => {
  mkdirSync(join(home, 'runtime'));
  symlinkSync(join(home, 'runtime'), join(home, 'projects'));
  assert.throws(() => usableFolder(join(home, 'projects', 'escaped')), /own settings/);
  assert.ok(!existsSync(join(home, 'runtime', 'escaped')));
  const alias = join(home, '..', `home-alias-${process.pid}-${Date.now()}`);
  symlinkSync(home, alias);
  assert.throws(() => usableFolder(join(alias, 'runtime', 'escaped')), /own settings/);
});
