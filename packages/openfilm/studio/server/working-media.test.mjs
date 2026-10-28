import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import Ajv from 'ajv';
import { probe } from './derived.mjs';
import { prepareWorkingMedia, workingMediaPlan, workingMediaRequestSchema } from './working-media.mjs';

const tools = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();
let scratch;
let realFfmpeg;
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const media = (name) => join(scratch, 'assets', name);

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'video-working-media-'));
  mkdirSync(join(scratch, 'assets'));
  writeFileSync(join(scratch, 'film.html'), '<!doctype html><title>人工工程不应被准备素材修改</title>');
  if (!tools) return;
  realFfmpeg = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=160x90:rate=30:duration=1.5',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.2', '-af', 'adelay=300:all=1,apad=whole_dur=1.2,asetpts=PTS+0.125/TB',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', media('delayed.mov')]);
});
after(() => rmSync(scratch, { recursive: true, force: true }));

test('工作副本请求Schema只收原片和短边，不提供隐式替换/裁剪/覆盖', () => {
  const validate = new Ajv().compile(workingMediaRequestSchema);
  assert.equal(validate({ src: 'assets/手机.mov' }), true);
  assert.equal(validate({ src: 'assets/手机.mov', shortEdge: 1080 }), true);
  for (const value of [{}, { src: 'x', shortEdge: 360 }, { src: 'x', out: 'film.html' }, { src: 'x', speed: 2 }, { src: 'assets/x.mp4#t=1,2' }, { src: 'assets\\x.mp4' }]) assert.equal(validate(value), false, JSON.stringify(value));
});

test('HLG/PQ显式转SDR，旋转后的画幅不放大，原声使用共同视频起点', () => {
  const facts = { duration: 606, codec: 'hevc', width: 2160, height: 3840, videoStartSeconds: 0, audio: true, audioStartSeconds: 1598 / 48000, color: { hdrTransfer: 'hlg' } };
  const hlg = workingMediaPlan(facts, 720);
  assert.deepEqual(hlg.size, { width: 720, height: 1280 });
  assert.match(hlg.videoFilter, /tonemap=tonemap=hable/);
  assert.match(hlg.videoFilter, /zscale=p=bt709:t=bt709:m=bt709/);
  assert.equal(hlg.originalAudioWaveformToWorkingOffsetSeconds, 1598 / 48000);
  assert.match(hlg.audioFilter, /asetpts=PTS-\(0\)\/TB,aresample=async=1:first_pts=0/);
  assert.equal(hlg.audioFilter.includes('STARTPTS'), false);
  const pq = workingMediaPlan({ ...facts, color: { hdrTransfer: 'pq' } }, 1080);
  assert.deepEqual(pq.size, { width: 1080, height: 1920 });
  assert.equal(pq.colorPolicy, 'pq-to-bt709-hable');
  const sdr = workingMediaPlan({ ...facts, width: 160, height: 90, color: { hdrTransfer: null }, videoStartSeconds: 5, audioStartSeconds: 5.125 });
  assert.deepEqual(sdr.size, { width: 160, height: 90 });
  assert.equal(sdr.videoFilter.includes('tonemap'), false);
  assert.equal(sdr.sourceTimeAtWorkingZero, 5);
  assert.equal(sdr.originalAudioWaveformToWorkingOffsetSeconds, 0.125);
  assert.match(sdr.audioFilter, /PTS-\(5\)/);
  assert.throws(() => workingMediaPlan({ ...facts, videoStartSeconds: null }), /起点未知/);
  assert.throws(() => workingMediaPlan({ ...facts, color: {}, dolbyVision: { profile: 8 } }), /转移函数/);
});

/** 在原媒体时钟中解码声音：补原容器中真实存在的起始空隙。 */
function onset(path) {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-copyts', '-i', path, '-vn', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-']);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const index = samples.findIndex((n) => Math.abs(n) > 2000);
  assert.ok(index > 0, '夹具应有延后响起的声音');
  return index / 48000;
}

test('整源副本原子发布且可复用：原声延后不被提前，源与影片均不变', { skip: !tools && 'no ffmpeg/ffprobe' }, async () => {
  const sourceHash = hash(media('delayed.mov')), filmHash = hash(join(scratch, 'film.html'));
  const sourceFacts = await probe(scratch, 'assets/delayed.mov');
  assert.ok(sourceFacts.audioStartSeconds > 0.1);
  const made = await prepareWorkingMedia(scratch, { src: 'assets/delayed.mov' });
  assert.equal(made.reused, false);
  assert.match(made.output.path, /^assets\/working\/[a-f0-9]{64}\/media\.mp4$/);
  assert.equal(made.source.sha256, sourceHash);
  assert.equal(made.mapping.sourceSecondsPerWorkingSecond, 1);
  assert.equal(made.mapping.originalAudioWaveformToWorkingOffsetSeconds, sourceFacts.audioStartSeconds);
  assert.deepEqual([made.output.facts.width, made.output.facts.height, made.output.facts.fps], [160, 90, 30]);
  assert.equal(made.output.facts.audioStartSeconds, 0);
  assert.ok(Math.abs(onset(media('delayed.mov')) - onset(join(scratch, made.output.path))) < 0.003, '输出声音应留在原媒体时钟，不能提前125ms');
  assert.deepEqual(readdirSync(join(scratch, 'assets/working')), [made.key], '没有本次临时目录残留');
  assert.equal(hash(media('delayed.mov')), sourceHash);
  assert.equal(hash(join(scratch, 'film.html')), filmHash);
  const reused = await prepareWorkingMedia(scratch, { src: 'assets/delayed.mov' });
  assert.equal(reused.reused, true);
  assert.equal(reused.output.sha256, made.output.sha256);
  assert.deepEqual(JSON.parse(readFileSync(join(scratch, made.provenancePath), 'utf8')).mapping, made.mapping);
  const changed = join(scratch, made.output.path);
  writeFileSync(changed, '人改了输出，不能覆盖');
  await assert.rejects(prepareWorkingMedia(scratch, { src: 'assets/delayed.mov' }), (error) => error.status === 409 && /字节已变更/.test(error.message));
  assert.equal(readFileSync(changed, 'utf8'), '人改了输出，不能覆盖');
});

test('实际HLG10bit输入转换为普通BT709 H264，而非仅改8bit标签', { skip: !tools && 'no ffmpeg/ffprobe' }, async () => {
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=30:duration=0.5',
    '-vf', 'format=yuv420p10le', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'pools=1:frame-threads=1:log-level=error',
    '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-an', media('hlg.mp4')], { stdio: 'pipe' });
  const before = await probe(scratch, 'assets/hlg.mp4');
  assert.equal(before.color.hdrTransfer, 'hlg');
  const made = await prepareWorkingMedia(scratch, { src: 'assets/hlg.mp4' });
  assert.equal(made.processing.colorPolicy, 'hlg-to-bt709-hable');
  assert.equal(made.output.facts.codec, 'h264');
  assert.equal(made.output.facts.pixfmt, 'yuv420p');
  assert.deepEqual(made.output.facts.color, { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv', hdrTransfer: null });
  assert.equal(made.output.facts.audio, false);
  execFileSync('ffmpeg', ['-v', 'error', '-i', join(scratch, made.output.path), '-f', 'null', '-'], { stdio: 'pipe' });
});

test('实际非方形像素按显示几何转为方像素工作副本，不只清SAR而挤压画面', { skip: !tools && 'no ffmpeg/ffprobe' }, async () => {
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=160x90:rate=30:duration=0.25',
    '-vf', 'setsar=2/1', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-an', media('wide-sar.mp4')], { stdio: 'pipe' });
  const source = await probe(scratch, 'assets/wide-sar.mp4');
  assert.deepEqual([source.codedWidth, source.codedHeight, source.width, source.height, source.sampleAspectRatio], [160, 90, 320, 90, '2:1']);
  const made = await prepareWorkingMedia(scratch, { src: 'assets/wide-sar.mp4' });
  assert.deepEqual([made.output.facts.width, made.output.facts.height, made.output.facts.sampleAspectRatio], [320, 90, '1:1']);
  assert.equal(made.processing.pipelineVersion, 2);
});

test('路径/参数及已取消请求在启动编码前拒绝', async () => {
  for (const input of [{ src: '../outside.mp4' }, { src: 'assets/delayed.mov#t=1,2' }, { src: 'assets/delayed.mov', out: 'assets/x.mp4' }]) await assert.rejects(prepareWorkingMedia(scratch, input));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareWorkingMedia(scratch, { src: 'assets/delayed.mov' }, { signal: controller.signal }), (error) => error.name === 'AbortError');
});

/** 仅在自有测试目录替换此子进程的ffmpeg入口，保留ffprobe为真实工具。 */
function wrapper(mode, sourceName) {
  const dir = join(scratch, `bin-${mode}`); mkdirSync(dir);
  const marker = join(dir, 'started');
  const file = join(dir, 'ffmpeg');
  writeFileSync(file, `#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');const{writeFileSync,appendFileSync}=require('node:fs');const a=process.argv.slice(2);const src=a[a.indexOf('-i')+1];if(a.includes('-copyts')&&src?.endsWith(${JSON.stringify(sourceName)})){writeFileSync(${JSON.stringify(marker)},'started');${mode === 'cancel' ? "setInterval(()=>{},1000);" : `const r=spawnSync(${JSON.stringify(realFfmpeg)},a,{stdio:'inherit'});if(r.status===0)appendFileSync(src,'source-changed');process.exit(r.status??1);`}}else{const r=spawnSync(${JSON.stringify(realFfmpeg)},a,{stdio:'inherit'});process.exit(r.status??1);}\n`, { mode: 0o700 });
  chmodSync(file, 0o700);
  return { dir, marker };
}

test('编码期间源变化拒绝发布，清理的只是本次隐藏目录', { skip: !tools || process.platform === 'win32' ? 'requires POSIX tool wrapper' : false }, async () => {
  copyFileSync(media('delayed.mov'), media('mutate.mov'));
  const own = wrapper('mutate', 'mutate.mov'), path = process.env.PATH;
  process.env.PATH = `${own.dir}${delimiter}${path}`;
  const before = readdirSync(join(scratch, 'assets/working')).sort();
  try { await assert.rejects(prepareWorkingMedia(scratch, { src: 'assets/mutate.mov', shortEdge: 1080 }), (error) => error.status === 409 && /原片发生变化/.test(error.message)); }
  finally { process.env.PATH = path; }
  assert.deepEqual(readdirSync(join(scratch, 'assets/working')).sort(), before);
});

test('在途取消终止本次子进程，同源并发明确拒绝且不遗留半产物', { skip: !tools || process.platform === 'win32' ? 'requires POSIX tool wrapper' : false }, async () => {
  copyFileSync(media('delayed.mov'), media('cancel.mov'));
  const own = wrapper('cancel', 'cancel.mov'), path = process.env.PATH;
  process.env.PATH = `${own.dir}${delimiter}${path}`;
  const before = readdirSync(join(scratch, 'assets/working')).sort(), sourceHash = hash(media('cancel.mov'));
  const controller = new AbortController();
  const first = prepareWorkingMedia(scratch, { src: 'assets/cancel.mov', shortEdge: 1080 }, { signal: controller.signal });
  const rejected = assert.rejects(first, (error) => error.name === 'AbortError');
  try {
    for (let i = 0; i < 150 && !existsSync(own.marker); i++) await new Promise((done) => setTimeout(done, 20));
    assert.equal(existsSync(own.marker), true, '应进入自有编码子进程');
    await assert.rejects(prepareWorkingMedia(scratch, { src: 'assets/cancel.mov', shortEdge: 1080 }), (error) => error.status === 409 && /正在准备/.test(error.message));
  } finally { controller.abort(); await rejected; process.env.PATH = path; }
  assert.deepEqual(readdirSync(join(scratch, 'assets/working')).sort(), before);
  assert.equal(hash(media('cancel.mov')), sourceHash);
});

test('最终源摘要读完后的取消仍拒绝发布，不能只在进入提交队列前检查', { skip: !tools && 'no ffmpeg/ffprobe' }, async () => {
  copyFileSync(media('delayed.mov'), media('publish-cancel.mov'));
  const source = media('publish-cancel.mov'), sourceHash = hash(source);
  const before = readdirSync(join(scratch, 'assets/working')).sort();
  const controller = new AbortController();
  const originalRead = fs.createReadStream, originalStat = fsp.stat;
  let sourceReads = 0, finalReadEnded = false, injected = false;
  fs.createReadStream = function (path, options) {
    const stream = originalRead.call(fs, path, options);
    if (String(path) === source && ++sourceReads === 2) stream.once('end', () => { finalReadEnded = true; });
    return stream;
  };
  fsp.stat = async function (path, options) {
    const value = await originalStat.call(fsp, path, options);
    if (String(path) === source && finalReadEnded && !injected) { injected = true; controller.abort(); }
    return value;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(prepareWorkingMedia(scratch, { src: 'assets/publish-cancel.mov', shortEdge: 1080 }, { signal: controller.signal }), (error) => error.name === 'AbortError'); }
  finally { fs.createReadStream = originalRead; fsp.stat = originalStat; syncBuiltinESMExports(); }
  assert.equal(injected, true, '取消必须发生在第二次源摘要已经读完、post-stat返回前');
  assert.equal(sourceReads, 2);
  assert.deepEqual(readdirSync(join(scratch, 'assets/working')).sort(), before, '没有新增发布目录或残留临时目录');
  assert.equal(hash(source), sourceHash);
});
