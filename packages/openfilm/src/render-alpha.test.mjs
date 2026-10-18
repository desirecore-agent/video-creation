import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { renderBlurFilter } from './render.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
function pixels(pixel, bits = 8) {
  const bytes = bits / 8;
  const data = Buffer.alloc(4 * 4 * bytes);
  for (let p = 0; p < 4; p++) for (let c = 0; c < 4; c++) {
    if (bits === 8) data[p * 4 + c] = pixel[c];
    else data.writeUInt16LE(pixel[c], (p * 4 + c) * 2);
  }
  return data;
}
function averaged(frames, bits = 8) {
  const format = bits === 8 ? 'rgba' : 'rgba64le';
  const result = spawnSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pixel_format', format, '-video_size', '2x2', '-framerate', '2', '-i', 'pipe:0', '-vf', renderBlurFilter(2, 1, true) + `format=${format}`, '-frames:v', '1', '-pix_fmt', format, '-f', 'rawvideo', 'pipe:1'], { input: Buffer.concat(frames.map((frame) => pixels(frame, bits))), maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString() ?? result.error?.message);
  return Array.from({ length: 4 }, (_, i) => bits === 8 ? result.stdout[i] : result.stdout.readUInt16LE(i * 2));
}

test('单采样和不透明滤镜维持既有输出', () => {
  assert.equal(renderBlurFilter(1, 30, true), '');
  assert.equal(renderBlurFilter(1, 30, false), '');
  assert.equal(renderBlurFilter(4, 30, false), "tmix=frames=4,select='eq(mod(n\\,4)\\,3)',setpts=N/(30*TB),");
});

test('真实FFmpeg透明平均保留白色与低alpha灰色，覆盖8和16位输入', { skip: !hasFfmpeg && '需要已准备的 FFmpeg' }, () => {
  const white8 = averaged([[255, 255, 255, 255], [0, 0, 0, 0]]);
  assert.deepEqual(white8, [255, 255, 255, 128]);
  const gray8 = averaged([[128, 128, 128, 1], [128, 128, 128, 1]]);
  assert.equal(gray8[3], 1);
  for (const channel of gray8.slice(0, 3)) assert.ok(Math.abs(channel - 128) <= 1, `低 alpha 灰色变暗：${gray8}`);
  const white16 = averaged([[65535, 65535, 65535, 65535], [0, 0, 0, 0]], 16);
  for (const channel of white16.slice(0, 3)) assert.ok(channel >= 65534, `16 位白色变暗：${white16}`);
  assert.ok(Math.abs(white16[3] - 32768) <= 1);
  const gray16 = averaged([[32768, 32768, 32768, 257], [32768, 32768, 32768, 257]], 16);
  assert.equal(gray16[3], 257);
  for (const channel of gray16.slice(0, 3)) assert.ok(Math.abs(channel - 32768) <= 128, `16 位低 alpha 灰色误差超过半个8位级：${gray16}`);
});
