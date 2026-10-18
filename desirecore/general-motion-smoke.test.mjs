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
test('视觉节拍测量读取视频实际帧，拒绝未显现和截断帧', () => {
  const rgb = Buffer.alloc(2 * 2 * 3 * 3); rgb.set([155, 230, 206], 2 * 2 * 3);
  assert.equal(firstVisibleBeat(rgb, 2, 2, { x: 0, y: 0 }).frame, 1);
  assert.throws(() => firstVisibleBeat(Buffer.alloc(12), 2, 2, { x: 0, y: 0 }));
  assert.throws(() => firstVisibleBeat(Buffer.alloc(13), 2, 2, { x: 0, y: 0 }));
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
