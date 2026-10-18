import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createExports } from './exports.mjs';
import { createExportJobStore } from './export-job-store.mjs';
import { filmHtml } from '../../src/film-doc.mjs';
import { parseFilmSubtitleStyle } from './film-subtitle.mjs';

const terminal = new Set(['done', 'failed', 'cancelled', 'interrupted']);
async function waitFor(queue, id, predicate = (job) => terminal.has(job.status)) {
  for (let i = 0; i < 300; i++) {
    const job = queue.list('project').find((item) => item.id === id);
    if (predicate(job)) return job;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`export ${id} did not reach expected status`);
}
const createProject = async (root) => {
  await mkdir(join(root, '.film'), { recursive: true });
  await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 640, h: 360 }, tracks: [] }));
  await writeFile(join(root, '.film', 'subtitles.json'), JSON.stringify({ text: 'original saved words' }));
  return { id: 'project', name: 'Video', path: root };
};
const captions = async (root) => ({ cues: [{ startMs: 0, durMs: 1000, text: JSON.parse(await readFile(join(root, '.film', 'subtitles.json'), 'utf8')).text }], style: parseFilmSubtitleStyle(null) });

test('a real export reads its frozen input after the source changes, persists its receipt, and releases large copies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vc-export-receipt-'));
  const stateDir = join(dir, 'state'), output = join(dir, 'output');
  let queue;
  try {
    const project = await createProject(join(dir, 'project'));
    let entered;
    const started = new Promise((done) => { entered = done; });
    let resume;
    const paused = new Promise((done) => { resume = done; });
    queue = createExports({ stateDir, captions: async (input) => { entered(input); await paused; return captions(input); } });
    const job = queue.start(project, { kind: 'subtitles', format: 'txt' }, { folder: output });
    const input = await started;
    assert.notEqual(input, project.path, 'the exporter was handed an independent local input');
    await writeFile(join(project.path, '.film', 'subtitles.json'), JSON.stringify({ text: 'later human edit' }));
    resume();
    const done = await waitFor(queue, job.id);
    assert.equal(done.status, 'done', done.error);
    assert.match(await readFile(done.out, 'utf8'), /original saved words/);
    assert.ok(done.inputSnapshot.filmRevision && existsSync(done.inputSnapshot.manifest));
    for (let i = 0; i < 100 && queue.busy(); i++) await new Promise((done) => setTimeout(done, 5));
    assert.equal(existsSync(input), false, 'input copies are removed after this attempt');
    const reopened = createExports({ stateDir, captions });
    assert.equal(reopened.list('project').find((j) => j.id === job.id).status, 'done');
    assert.throws(() => reopened.retry(job.id), /only a stopped export/);
  } finally { queue?.stopAll(); await rm(dir, { recursive: true, force: true }); }
});

test('a killed process leaves an interrupted receipt after restart, and explicit retry produces a fresh completed export', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vc-export-restart-'));
  const stateDir = join(dir, 'state'), output = join(dir, 'output');
  let child;
  try {
    const project = await createProject(join(dir, 'project'));
    const moduleUrl = new URL('./exports.mjs', import.meta.url).href;
    const code = `import { createExports } from ${JSON.stringify(moduleUrl)};
      const queue = createExports({ stateDir: ${JSON.stringify(stateDir)}, captions: async () => { process.stdout.write('PAUSED\\n'); await new Promise(() => {}); } });
      const job = queue.start(${JSON.stringify(project)}, { kind: 'subtitles' }, { folder: ${JSON.stringify(output)} });
      process.stdout.write(job.id + '\\n'); setInterval(() => {}, 1000);`;
    child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const paused = new Promise((done, fail) => {
      child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.includes('PAUSED')) done(); });
      child.once('error', fail);
      child.once('exit', (code) => { if (!stdout.includes('PAUSED')) fail(new Error(`child exited ${code}: ${stderr}`)); });
    });
    await paused;
    const id = stdout.split('\n')[0];
    const receipt = JSON.parse(readFileSync(join(stateDir, `${id}.json`), 'utf8'));
    assert.equal(receipt.job.status, 'running');
    child.kill('SIGKILL');
    await once(child, 'exit');
    child = null;
    const queue = createExports({ stateDir, captions });
    const recovered = queue.list(project.id).find((j) => j.id === id);
    assert.equal(recovered.status, 'interrupted');
    assert.match(recovered.error, /Retry starts a new export/);
    assert.equal(queue.busy(), false, 'no automatic re-execution of an interrupted job');
    await writeFile(join(project.path, '.film', 'subtitles.json'), JSON.stringify({ text: 'saved before retry' }));
    const retry = queue.retry(id);
    assert.notEqual(retry.id, id);
    assert.equal(retry.retryOf, id);
    const done = await waitFor(queue, retry.id);
    assert.equal(done.status, 'done', done.error);
    assert.match(await readFile(done.out, 'utf8'), /saved before retry/);
    assert.equal(queue.list(project.id).find((j) => j.id === id).status, 'interrupted');
    for (let i = 0; i < 100 && queue.busy(); i++) await new Promise((done) => setTimeout(done, 5));
  } finally { child?.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});

test('an unreadable durable receipt fails visibly instead of silently losing export history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vc-receipt-corrupt-'));
  try {
    await writeFile(join(dir, '000000000001.json'), '{broken');
    assert.throws(() => createExportJobStore(dir).load(), /Export receipt could not be read/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a queued request freezes before acknowledgement while an older export blocks, and later edits cannot change its output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vc-export-queued-input-'));
  let queue, resume;
  try {
    const project = await createProject(join(dir, 'project'));
    let entered;
    const firstEntered = new Promise((done) => { entered = done; });
    const firstPaused = new Promise((done) => { resume = done; });
    let calls = 0;
    queue = createExports({ stateDir: join(dir, 'state'), captions: async (input) => {
      if (++calls === 1) { entered(input); await firstPaused; }
      return captions(input);
    } });
    const first = queue.start(project, { kind: 'subtitles', format: 'txt', label: 'first' }, { folder: join(dir, 'output') });
    const firstInput = await firstEntered;
    await writeFile(join(project.path, '.film', 'subtitles.json'), JSON.stringify({ text: 'second request at acknowledgement' }));
    const second = queue.start(project, { kind: 'subtitles', format: 'txt', label: 'second' }, { folder: join(dir, 'output') });
    const acknowledged = await queue.prepare(second.id);
    assert.equal(acknowledged.status, 'waiting', 'only the first exporter is running');
    assert.equal(calls, 1, 'input copying never starts a second renderer');
    assert.ok(acknowledged.inputSnapshot.filmRevision);
    const secondInput = join(dir, 'state', second.id, 'input');
    assert.match(await readFile(join(secondInput, '.film', 'subtitles.json'), 'utf8'), /second request at acknowledgement/);
    await writeFile(join(project.path, '.film', 'subtitles.json'), JSON.stringify({ text: 'human edited after acknowledgement' }));
    /* Cancelling a third prepared job removes only that input, never either earlier attempt's files. */
    const cancelled = queue.start(project, { kind: 'subtitles', format: 'txt' }, { folder: join(dir, 'output') });
    await queue.prepare(cancelled.id);
    queue.cancel(cancelled.id);
    for (let i = 0; i < 100 && existsSync(join(dir, 'state', cancelled.id, 'input')); i++) await new Promise((done) => setTimeout(done, 5));
    assert.equal(existsSync(join(dir, 'state', cancelled.id, 'input')), false);
    assert.equal(existsSync(firstInput), true);
    assert.equal(existsSync(secondInput), true);
    resume();
    const secondDone = await waitFor(queue, second.id);
    assert.equal(secondDone.status, 'done', secondDone.error);
    assert.match(await readFile(secondDone.out, 'utf8'), /second request at acknowledgement/);
    assert.doesNotMatch(await readFile(secondDone.out, 'utf8'), /human edited/);
    assert.equal((await waitFor(queue, first.id)).status, 'done');
    assert.equal(queue.list('project').find((j) => j.id === cancelled.id).status, 'cancelled');
    for (let i = 0; i < 100 && queue.busy(); i++) await new Promise((done) => setTimeout(done, 5));
  } finally { resume?.(); queue?.stopAll(); await rm(dir, { recursive: true, force: true }); }
});

test('queued input preparation failure is reported before submission acknowledgement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vc-export-prepare-failure-'));
  try {
    const project = await createProject(join(dir, 'project'));
    const queue = createExports({ stateDir: join(dir, 'state'), snapshotMaxBytes: 1 });
    const job = queue.start(project, { kind: 'subtitles' }, { folder: join(dir, 'output') });
    await assert.rejects(queue.prepare(job.id), (error) => error.status === 422 && /snapshot limit/.test(error.message));
    assert.equal((await waitFor(queue, job.id)).status, 'failed');
    for (let i = 0; i < 100 && queue.busy(); i++) await new Promise((done) => setTimeout(done, 5));
    assert.equal(existsSync(join(dir, 'state', job.id, 'input')), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
