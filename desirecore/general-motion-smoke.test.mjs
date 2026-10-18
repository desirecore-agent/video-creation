import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyMotionProbe, pixelDifference, energyPeak, firstVisibleBeat, ownedServiceEntry, stopOwnedProcess, verifySampleLayout } from './general-motion-smoke.mjs';

const probe = () => ({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 320, height: 180, avg_frame_rate: '12/1', nb_read_frames: '24', pix_fmt: 'yuv420p' }, { codec_type: 'audio', codec_name: 'aac', sample_rate: '24000' }], format: { duration: '2.0' } });
test('媒体验收拒绝截断、错误编码、错误画幅、错误帧率与缺失声音', () => {
  assert.equal(verifyMotionProbe(probe(), { audio: true }).frames, 24);
  for (const patch of [{ codec_name: 'vp9' }, { width: 180 }, { height: 320 }, { avg_frame_rate: '30/1' }, { nb_read_frames: '2' }]) { const bad = probe(); Object.assign(bad.streams[0], patch); assert.throws(() => verifyMotionProbe(bad)); }
  const missingAudio = probe(); missingAudio.streams.pop(); assert.throws(() => verifyMotionProbe(missingAudio, { audio: true }));
  const wrongDuration = probe(); wrongDuration.format.duration = '3'; assert.throws(() => verifyMotionProbe(wrongDuration));
});
test('像素比较容忍低幅边缘噪声，但报告真实画面差异和尺寸错误', () => {
  assert.deepEqual(pixelDifference(Buffer.from([10, 10, 10]), Buffer.from([11, 12, 13])), { meanAbsolute: 2, changedRatio: 0, threshold: 4 });
  assert.equal(pixelDifference(Buffer.from([0, 0, 0, 0, 0, 0]), Buffer.from([255, 0, 0, 0, 0, 0])).changedRatio, .5);
  assert.throws(() => pixelDifference(Buffer.alloc(3), Buffer.alloc(6))); assert.throws(() => pixelDifference(Buffer.alloc(0), Buffer.alloc(0)));
});
test('音画测量从实际PCM取得能量峰，拒绝静音和无效样本', () => {
  const rate = 24000; const pcm = Buffer.alloc(rate * 2 * 4);
  for (let i = rate; i < rate + 240; i++) pcm.writeFloatLE(.5, i * 4);
  const peak = energyPeak(pcm, rate); assert.ok(peak.time >= 1 && peak.time < 1.02); assert.equal(peak.rms, .5);
  assert.throws(() => energyPeak(Buffer.alloc(rate * 2 * 4), rate));
  const invalid = Buffer.from(pcm); invalid.writeFloatLE(NaN, rate * 4); assert.throws(() => energyPeak(invalid, rate));
});
const beatFixture = (width = 8, height = 8, frames = 4) => {
  const rgb = Buffer.alloc(width * height * 3 * frames);
  const pixel = (frame, x, y, color = [155, 230, 206]) => rgb.set(color, (frame * width * height + y * width + x) * 3);
  const block = (frame, x, y, color) => { for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) pixel(frame, x + dx, y + dy, color); };
  return { rgb, pixel, block, read: (rect = { x: 1, y: 1, width: 5, height: 5 }) => firstVisibleBeat(rgb, width, height, rect) };
};
test('区域节拍检测返回持续显现的最初帧，中心不达阈值也读取真实邻域', () => {
  const image = beatFixture(); image.block(1, 2, 2); image.block(2, 2, 2);
  const found = image.read(); assert.equal(found.frame, 1); assert.equal(found.confirmedByFrame, 2); assert.deepEqual(found.block, { x: 2, y: 2, width: 2, height: 2 });
  const linux = beatFixture(32, 180, 33);
  linux.pixel(30, 21, 161, [182, 217, 232]); linux.pixel(31, 21, 161, [169, 204, 219]);
  for (const [frame, colors] of [[30, [[171, 219, 229], [161, 210, 219], [161, 210, 219], [167, 216, 225]]], [31, [[158, 214, 222], [165, 221, 229], [162, 218, 226], [161, 217, 225]]]]) colors.forEach((color, index) => linux.pixel(frame, 20 + index % 2, 162 + Math.floor(index / 2), color));
  const measured = linux.read({ x: 19.1875, y: 156.2344, width: 4, height: 9.5625 });
  assert.equal(measured.frame, 30); assert.equal(measured.confirmedByFrame, 31); assert.deepEqual(measured.point, { x: 20, y: 162 });
});
test('区域节拍检测拒绝单噪点、分散四点、边界外图标及跨边界色块', () => {
  const single = beatFixture(); single.pixel(1, 3, 3); single.pixel(2, 3, 3); assert.throws(() => single.read(), /没有连续两帧/);
  const scattered = beatFixture(); for (const frame of [1, 2]) for (const [x, y] of [[1, 1], [3, 1], [1, 3], [3, 3]]) scattered.pixel(frame, x, y); assert.throws(() => scattered.read(), /没有连续两帧/);
  const outside = beatFixture(); outside.block(0, 6, 6); outside.block(1, 6, 6); assert.throws(() => outside.read(), /没有连续两帧/);
  const clipped = beatFixture(); clipped.block(1, 0, 2); clipped.block(2, 0, 2); assert.throws(() => clipped.read(), /没有连续两帧/);
});
test('区域节拍检测排除单帧噪声且不平移随后真实显现的最初帧', () => {
  const image = beatFixture(8, 8, 6); image.block(0, 2, 2); image.block(3, 2, 2); image.block(4, 2, 2);
  assert.equal(image.read().frame, 3);
  const oneFrame = beatFixture(); oneFrame.block(1, 2, 2); assert.throws(() => oneFrame.read(), /没有连续两帧/);
  assert.throws(() => beatFixture().read(), /没有连续两帧/);
});
test('区域节拍检测保持每像素原阈值，拒绝刚好35色差或刚好110绿色', () => {
  for (const color of [[100, 135, 0], [0, 110, 0]]) {
    const image = beatFixture(); image.block(1, 2, 2, color); image.block(2, 2, 2, color); assert.throws(() => image.read(), /没有连续两帧/);
  }
});
test('区域节拍检测拒绝截断RGB、空帧、缺失和越界或不足2×2像素的ROI', () => {
  const roi = { x: 1, y: 1, width: 5, height: 5 };
  assert.throws(() => firstVisibleBeat(Buffer.alloc(8 * 8 * 3 + 1), 8, 8, roi), /帧不完整/);
  assert.throws(() => firstVisibleBeat(Buffer.alloc(0), 8, 8, roi), /帧不完整/);
  for (const rect of [null, { x: 1, y: 1 }, { ...roi, x: NaN }, { ...roi, y: Infinity }, { ...roi, x: -1 }, { ...roi, x: 6 }, { ...roi, width: 0 }, { ...roi, height: -1 }, { ...roi, width: 1 }, { x: 1.5, y: 1, width: 2, height: 3 }]) assert.throws(() => firstVisibleBeat(Buffer.alloc(8 * 8 * 3 * 3), 8, 8, rect));
});
test('布局验收拒绝越界、小字、文字互遮和覆盖无关主体，允许自身内容', () => {
  const good = () => ({ viewport: [320, 180], texts: [{ text: '标题', font: 20, rect: { x: 10, y: 10, w: 80, h: 24 }, subject: -1 }, { text: '卡片内容', font: 10, rect: { x: 20, y: 70, w: 80, h: 15 }, subject: 0 }], boxes: [{ kind: 'header', rect: { x: 10, y: 10, w: 300, h: 30 } }, { kind: 'scene', rect: { x: 10, y: 50, w: 300, h: 110 } }], subjects: [{ index: 0, rect: { x: 10, y: 50, w: 120, h: 100 } }] });
  assert.equal(verifySampleLayout(good()).texts, 2);
  const outside = good(); outside.texts[0].rect.x = 300; assert.throws(() => verifySampleLayout(outside));
  const tiny = good(); tiny.texts[0].font = 7; assert.throws(() => verifySampleLayout(tiny));
  const overlap = good(); overlap.texts[1].rect.y = 20; assert.throws(() => verifySampleLayout(overlap));
  const subject = good(); subject.texts[1].subject = -1; assert.throws(() => verifySampleLayout(subject));
  const regions = good(); regions.boxes[1].rect.y = 20; assert.throws(() => verifySampleLayout(regions));
});
test('普通清理通过stdin EOF正常exit0，渲染fork不继承额外Node执行参数', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'motion-owned-close-')); let proc;
  try {
    const module = join(dir, 'owned.mjs'), receipt = join(dir, 'closed.json');
    const forked = join(dir, 'forked.mjs'); await writeFile(forked, `process.send({execArgv:process.execArgv});process.disconnect();`);
    await writeFile(module, `import {createServer} from 'node:http';import {writeFile} from 'node:fs/promises';import {fork} from 'node:child_process';import {fileURLToPath} from 'node:url';export async function command(args){const child=fork(fileURLToPath(new URL('./forked.mjs',import.meta.url)),[],{stdio:['ignore','ignore','inherit','ipc']});const inherited=await new Promise((r,j)=>{child.once('message',r);child.once('error',j)});const server=createServer((req,res)=>res.end('owned'));await new Promise(r=>server.listen(0,'127.0.0.1',r));process.stdout.write(JSON.stringify({ready:true,pid:process.pid,port:server.address().port,execArgv:inherited.execArgv})+'\\n');return{async close(){await new Promise(r=>server.close(r));await writeFile(args[0],JSON.stringify({closed:true,pid:process.pid}));}}}`);
    proc = spawn(process.execPath, [ownedServiceEntry, pathToFileURL(module).href, receipt], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const exited = new Promise((done, fail) => { proc.once('exit', (code, signal) => done({ code, signal })); proc.once('error', fail); });
    const ready = await new Promise((done, fail) => { proc.stdout.once('data', (chunk) => done(JSON.parse(String(chunk)))); proc.once('error', fail); exited.then((status) => fail(new Error(`子进程提前结束：${JSON.stringify(status)}`))); });
    assert.equal(ready.pid, proc.pid);
    assert.deepEqual(ready.execArgv, []);
    const stopped = await stopOwnedProcess({ process: proc, exited });
    assert.deepEqual(stopped, { method: 'stdin-eof-close', code: 0, signal: null });
    assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), { closed: true, pid: proc.pid });
    await assert.rejects(fetch(`http://127.0.0.1:${ready.port}`, { signal: AbortSignal.timeout(2000) }));
  } finally { if (proc?.exitCode === null) proc.kill(); await rm(dir, { recursive: true, force: true }); }
});
