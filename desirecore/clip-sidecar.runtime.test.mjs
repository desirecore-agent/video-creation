import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filmHtml } from '../packages/openfilm/src/film-doc.mjs';
import { createExports } from '../packages/openfilm/studio/server/exports.mjs';
import { writeSubtitleStyle } from '../packages/openfilm/studio/server/captions.mjs';

// Explicit runtime lane: real Chromium and FFmpeg, never a mock renderer or paid media service.
const enabled = process.env.VIDEO_CREATION_CLIP_SIDECAR_RUNTIME === '1';
const terminal = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const command = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

async function fixture({ trimmed = false, captionsOff = false }, run) {
  const scratch = await mkdtemp(join(tmpdir(), 'vc-sidecar-real-'));
  const home = join(scratch, 'home'), path = join(scratch, 'project');
  const oldEnv = Object.fromEntries(['OPENFILM_HOME', 'OPENFILM_LIBRARY', 'APP_DATA_DIR'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { OPENFILM_HOME: home, OPENFILM_LIBRARY: join(home, 'projects'), APP_DATA_DIR: home });
  let queue;
  try {
    await mkdir(join(path, 'assets'), { recursive: true });
    for (const [name, color, hz, duration] of [['first', 'red', 330, 2], ['second', 'blue', 660, trimmed ? 3 : 2]]) {
      command('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=12:d=${duration}`,
        '-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000:duration=${duration}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(path, 'assets', `${name}.mp4`)]);
    }
    await writeFile(join(path, 'assets', 'first.vtt'), 'WEBVTT\n\n00:00:00.200 --> 00:00:01.800\nFIRST_CUE\n');
    const targetVtt = trimmed
      ? 'WEBVTT\n\n00:00:01.200 --> 00:00:02.800\nSECOND_CUE\n'
      : 'WEBVTT\n\n00:00:00.200 --> 00:00:01.800\nSECOND_CUE\n';
    await writeFile(join(path, 'assets', 'second.vtt'), targetVtt);
    const film = filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [
      { id: 'first', src: 'assets/first.mp4', at: 0, time: [0, 2] },
      { id: 'second', src: 'assets/second.mp4', at: 5, time: trimmed ? [1, 3] : [0, 2], ...(trimmed ? { speed: 2 } : {}) },
    ] }] });
    await writeFile(join(path, 'film.html'), film);
    if (captionsOff) await writeSubtitleStyle(path, { on: false });
    const project = { id: 'clip-sidecar-test', name: 'Clip sidecar', path };
    queue = createExports({ stateDir: join(home, 'jobs') });
    await run({ path, film, project, queue, output: join(scratch, 'output') });
    assert.equal(await readFile(join(path, 'film.html'), 'utf8'), film, 'export leaves the authored timeline unchanged');
  } finally {
    queue?.stopAll();
    if (queue) {
      const until = Date.now() + 5_000;
      while (queue.busy() && Date.now() < until) await new Promise((done) => setTimeout(done, 10));
      assert.equal(queue.busy(), false, 'the owned export worker exits before removing its fixture');
    }
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(scratch, { recursive: true, force: true });
  }
}

async function waitFor(queue, project, id) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const job = queue.list(project.id).find((item) => item.id === id);
    if (terminal.has(job.status)) return job;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error('the actual clip export did not finish');
}

async function verifyMedia(job, duration, audio) {
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.outputs.length, 2, 'the explicit subtitle file is part of the completed receipt');
  const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', job.out]));
  assert.ok(Math.abs(Number(probe.format.duration) - duration) < 1 / 12 + 0.01, 'the video uses the selected clip-local duration');
  assert.equal(probe.streams.some((stream) => stream.codec_type === 'audio'), audio);
  command('ffmpeg', ['-v', 'error', '-i', job.out, '-f', 'null', '-']);
  for (const item of job.outputSizes) assert.equal(item.bytes, (await stat(item.path)).size);
  assert.equal(job.bytes, job.outputSizes.reduce((sum, item) => sum + item.bytes, 0));
}

test('actual nonzero-at clip export writes only its SRT on the output clock from the frozen input', { skip: !enabled, timeout: 90_000 }, async () => {
  await fixture({}, async ({ path, project, queue, output }) => {
    const job = queue.start(project, { kind: 'video', codec: 'h264', clip: 'second', scale: 0.5,
      fps: 12, hardware: false, audio: true, sidecar: 'srt' }, { folder: output });
    await queue.prepare(job.id);
    await writeFile(join(path, 'assets', 'second.vtt'), 'WEBVTT\n\n00:00:00.200 --> 00:00:01.800\nLATE_SOURCE_EDIT\n');
    const done = await waitFor(queue, project, job.id);
    await verifyMedia(done, 2, true);
    assert.equal(await readFile(done.outputs.find((file) => file.endsWith('.srt')), 'utf8'), '1\n00:00:00,200 --> 00:00:01,800\nSECOND_CUE\n');
    assert.ok(done.inputSnapshot?.filmRevision, 'the receipt identifies its frozen authored version');
  });
});

test('actual trimmed double-speed clip plus local range keeps VTT even when preview CC and output audio are off', { skip: !enabled, timeout: 90_000 }, async () => {
  await fixture({ trimmed: true, captionsOff: true }, async ({ project, queue, output }) => {
    const job = queue.start(project, { kind: 'video', codec: 'h264', clip: 'second', scale: 0.5, range: [0.25, 0.75],
      fps: 12, hardware: false, audio: false, sidecar: 'vtt' }, { folder: output });
    await queue.prepare(job.id);
    const done = await waitFor(queue, project, job.id);
    await verifyMedia(done, 0.5, false);
    assert.equal(await readFile(done.outputs.find((file) => file.endsWith('.vtt')), 'utf8'), 'WEBVTT\n\n00:00:00.000 --> 00:00:00.500\nSECOND_CUE\n');
  });
});
