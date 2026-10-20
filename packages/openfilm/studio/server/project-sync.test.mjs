import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio } from './server.mjs';

/** A real project socket, retained across rename, with bounded waits rather than polling the API. */
function stream(studio, projectId) {
  const socket = new WebSocket(`${studio.origin.replace(/^http/, 'ws')}/api/projects/${projectId}/events`, { headers: { 'x-studio-key': studio.key } });
  const events = [], waiting = new Set();
  socket.addEventListener('message', (event) => {
    events.push(JSON.parse(String(event.data)));
    for (const check of waiting) check();
  });
  return {
    socket, events,
    until(predicate) {
      return new Promise((resolve, reject) => {
        const finish = () => { clearTimeout(timer); waiting.delete(check); };
        const check = () => { const found = events.find(predicate); if (found) { finish(); resolve(found); } };
        const timer = setTimeout(() => { finish(); reject(new Error(`missing project event: ${JSON.stringify(events)}`)); }, 5000);
        waiting.add(check); check();
      });
    },
  };
}

test('API rename synchronizes the already-open project and keeps watching its new directory', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'vc-project-sync-'));
  const oldHome = process.env.OPENFILM_HOME, oldLibrary = process.env.OPENFILM_LIBRARY;
  process.env.OPENFILM_HOME = join(scratch, 'home');
  process.env.OPENFILM_LIBRARY = join(scratch, 'projects');
  const studio = await startStudio({ port: 0 });
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`${studio.origin}/api/${path}`, {
      method, headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  let first, reconnect;
  try {
    const { project } = await api('projects', 'POST', { name: 'Draft' });
    const film = await api(`projects/${project.id}`);
    const original = readFileSync(join(project.path, 'film.html'), 'utf8');
    first = stream(studio, project.id);
    await once(first.socket, 'open');
    const initial = await first.until((event) => event.type === 'project');
    assert.equal(initial.project.path, project.path);
    const { project: renamed } = await api(`projects/${project.id}`, 'PATCH', { name: 'Final' });
    const changed = await first.until((event) => event.type === 'project' && event.project.name === 'Final');
    assert.equal(changed.project.id, project.id, 'identity stays stable');
    assert.equal(changed.project.path, renamed.path);
    assert.equal(changed.folder, film.folder, 'the preview address does not reload');
    assert.equal(readFileSync(join(renamed.path, 'film.html'), 'utf8'), original, 'rename does not rewrite the work');
    assert.equal((await api(`projects/${project.id}`)).rev, film.rev);

    mkdirSync(join(renamed.path, 'scenes'));
    writeFileSync(join(renamed.path, 'scenes', 'after-rename.html'), '<p>new material</p>');
    await first.until((event) => event.type === 'files' && event.paths?.includes('scenes/after-rename.html'));
    /* A replaced film is seen through the original socket too, on Linux as well as native recursive watchers. */
    writeFileSync(join(renamed.path, 'film.next'), `${original}\n<!-- changed after rename -->`);
    renameSync(join(renamed.path, 'film.next'), join(renamed.path, 'film.html'));
    await first.until((event) => event.type === 'film' && event.rev !== film.rev);

    /* A page disconnected while the rename happened receives the current path when it returns. */
    reconnect = stream(studio, project.id);
    const restored = await reconnect.until((event) => event.type === 'project');
    assert.equal(restored.project.path, renamed.path);
    assert.equal(restored.folder, film.folder);
  } finally {
    for (const watched of [first, reconnect]) if (watched) watched.socket.close();
    await studio.close();
    if (oldHome === undefined) delete process.env.OPENFILM_HOME; else process.env.OPENFILM_HOME = oldHome;
    if (oldLibrary === undefined) delete process.env.OPENFILM_LIBRARY; else process.env.OPENFILM_LIBRARY = oldLibrary;
    rmSync(scratch, { recursive: true, force: true });
  }
});
