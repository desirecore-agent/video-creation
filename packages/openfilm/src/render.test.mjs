import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultWorkers, renderWorkers, render } from './render.mjs';

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('an encoder that fails to start fails the render with ffmpeg\'s error, instead of waiting forever', { skip: !hasFfmpeg && 'no ffmpeg', timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-render-fails-'));
  try {
    /* noise: frames too big for the pipe to take while no one reads it */
    writeFileSync(join(dir, 'index.html'), '<!doctype html><body style="margin:0"><canvas width="1280" height="720"></canvas><script>'
      + 'const c = document.querySelector("canvas").getContext("2d"), img = c.createImageData(1280, 720);'
      + 'window.film = { duration: 1, width: 1280, height: 720, frame(t) { let s = 1 + Math.round(t * 30);'
      + 'for (let i = 0; i < img.data.length; i++) { s = (s * 1103515245 + 12345) % 2147483648; img.data[i] = i % 4 === 3 ? 255 : s & 255; }'
      + 'c.putImageData(img, 0, 0); } };</script>');
    await assert.rejects(render([dir], { out: join(dir, 'out.mp4'), workers: 1, format: { video: ['-c:v', 'no_such_encoder'] } }), /^Error: ffmpeg: .*no_such_encoder/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('render defaults to one browser, while explicit parallelism stays within CPU, memory and hard ceilings', () => {
  const GB = 2 ** 30;
  assert.equal(defaultWorkers(), 1);
  assert.equal(renderWorkers(undefined, 100, 32, 128 * GB), 1);
  assert.equal(renderWorkers(2, 100, 10, 16 * GB), 2);
  assert.equal(renderWorkers(8, 100, 8, 8 * GB), 2, 'memory first');
  assert.equal(renderWorkers(8, 100, 32, 128 * GB), 4, 'hard ceiling');
  assert.equal(renderWorkers(2, 100, 2, 4 * GB), 1);
  assert.equal(renderWorkers(4, 1, 32, 128 * GB), 1, 'no idle browsers');
  for (const n of [0, -1, 1.5, NaN, Infinity, 'many', 9]) assert.throws(() => renderWorkers(n, 100), /workers must/);
});
