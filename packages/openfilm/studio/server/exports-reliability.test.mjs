import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
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
    assert.deepEqual(done.outputSizes, [{ path: done.out, bytes: (await readFile(done.out)).length }]);
    assert.equal(done.bytes, done.outputSizes[0].bytes);
    assert.ok(done.inputSnapshot.filmRevision && existsSync(done.inputSnapshot.manifest));
    for (let i = 0; i < 100 && queue.busy(); i++) await new Promise((done) => setTimeout(done, 5));
    assert.equal(existsSync(input), false, 'input copies are removed after this attempt');
    const reopened = createExports({ stateDir, captions });
    const receipt = reopened.list('project').find((j) => j.id === job.id);
    assert.equal(receipt.status, 'done');
    assert.deepEqual(receipt.outputSizes, done.outputSizes, 'per-output sizes survive a restart');
    assert.throws(() => reopened.retry(job.id), /only a stopped export/);
  } finally { queue?.stopAll(); await rm(dir, { recursive: true, force: true }); }
});

test('completed output accounting distinguishes the video from its subtitle sidecar', async () => {
  const { exportOutputSizes } = await import('./exports.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'vc-output-sizes-'));
  try {
    const movie = join(dir, '影片.mp4'), sidecar = join(dir, '影片.srt');
    const media = Buffer.alloc(128, 0x6d), subtitle = Buffer.from('1\n00:00:00,000 --> 00:00:01,000\n公司为什么存在？\n');
    await writeFile(movie, media);
    await writeFile(sidecar, subtitle);
    const measured = await exportOutputSizes([movie, sidecar]);
    assert.deepEqual(measured, [{ path: movie, bytes: media.length }, { path: sidecar, bytes: subtitle.length }]);
    assert.equal(measured.reduce((n, file) => n + file.bytes, 0), media.length + subtitle.length);
    await assert.rejects(exportOutputSizes([movie, join(dir, 'missing.srt')]), /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a completed project folder receipt counts nested file contents and persists the actual delivery size', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vc-folder-receipt-'));
  let queue;
  try {
    const project = await createProject(join(dir, 'project'));
    const payload = Buffer.from('可编辑场景\n'.repeat(400));
    await mkdir(join(project.path, 'scenes', 'nested'), { recursive: true });
    await writeFile(join(project.path, 'scenes', 'nested', 'title.html'), payload);
    const expected = (await readFile(join(project.path, 'film.html'))).length
      + (await readFile(join(project.path, '.film', 'subtitles.json'))).length + payload.length;
    const stateDir = join(dir, 'state');
    queue = createExports({ stateDir });
    const submitted = queue.start(project, { kind: 'project', as: 'folder' }, { folder: join(dir, 'output') });
    const done = await waitFor(queue, submitted.id);
    assert.equal(done.status, 'done', done.error);
    assert.deepEqual(await readFile(join(done.out, 'scenes', 'nested', 'title.html')), payload);
    assert.equal(done.bytes, expected, 'folder size is the exported contents, not the directory inode');
    assert.deepEqual(done.outputSizes, [{ path: done.out, bytes: expected }]);
    const receipt = createExportJobStore(stateDir).load().find((item) => item.job.id === done.id).job;
    assert.equal(receipt.bytes, expected);
    assert.deepEqual(receipt.outputSizes, done.outputSizes);
  } finally { queue?.stopAll(); await rm(dir, { recursive: true, force: true }); }
});

test('a delivery that disappears after its final rename cannot produce a done receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vc-missing-delivery-'));
  let queue, removed;
  const seen = [];
  try {
    const project = await createProject(join(dir, 'project'));
    const stateDir = join(dir, 'state');
    queue = createExports({ stateDir, onChange: (job) => {
      seen.push(job.status);
      /* An external removal after the exporter's real atomic delivery but before its receipt is finalized. */
      if (!removed && job.status === 'running' && job.out && existsSync(join(job.out, 'film.html'))) {
        removed = job.out;
        rmSync(job.out, { recursive: true });
      }
    } });
    const submitted = queue.start(project, { kind: 'project', as: 'folder' }, { folder: join(dir, 'output') });
    const failed = await waitFor(queue, submitted.id);
    assert.ok(removed, 'the test removed a successfully renamed output');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /ENOENT/);
    assert.equal(failed.bytes, null);
    assert.deepEqual(failed.outputSizes, []);
    assert.deepEqual(failed.outputs, []);
    assert.equal(seen.includes('done'), false);
    assert.equal(createExportJobStore(stateDir).load()[0].job.status, 'failed');
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
