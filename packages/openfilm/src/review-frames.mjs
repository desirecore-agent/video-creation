/** 审片只复用 look 所用的 FilmPage 和 FFmpeg；工程预览与真实编码帧保持不同时间口径。 */
import { createHash } from 'node:crypto';
import { collectFrameFindings } from './review-findings.mjs';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { open, kill } from './shared.mjs';
import { sequencePoints, projectSequencePoints, lumaActivity, SEQUENCE_MAX_FRAMES } from './review-sequence.mjs';

export const REVIEW_MAX_FRAMES = 6;
export const REVIEW_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const REVIEW_MAX_TOTAL_BYTES = 12 * 1024 * 1024;

/** 直接读取 PNG 的真实像素尺寸，不把请求尺寸当作回执。 */
export function pngSize(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('审片帧不是有效 PNG。');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height) throw new Error('审片帧尺寸无效。');
  return { width, height };
}

/** 子进程输出和执行时间有界；不启动 shell、不继承输入，也不取消其他渲染。 */
export function runReviewProcess(program, args, { line, binary = false, inputs = [], timeoutMs = 120_000, maxBytes = 4 * 1024 * 1024, signal } = {}) {
  signal?.throwIfAborted();
  return new Promise((done, fail) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe', ...inputs.map(() => 'pipe')], windowsHide: true });
    let stdout = '', stderr = '', pending = '', bytes = 0, error;
    const chunks = [];
    const stop = (reason) => { error ??= new Error(reason); kill(child); };
    const abort = () => stop('审片已停止。');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(`${program} 审片超过 ${timeoutMs / 1000} 秒，未生成成功回执。`), timeoutMs);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) return stop(`${program} 审片输出超过预算。`);
      if (binary) chunks.push(chunk);
      else if (!line) stdout += chunk;
      else {
        pending += chunk;
        const parts = pending.split(/\r?\n/); pending = parts.pop();
        for (const value of parts) { try { line(value); } catch (e) { stop(e.message); } }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 1024 * 1024) stop(`${program} 审片诊断超过预算。`); });
    for (const [index, input] of inputs.entries()) {
      const pipe = child.stdio[index + 3];
      pipe.on('error', (e) => { error ??= e; kill(child); });
      pipe.end(input);
    }
    child.once('error', (e) => { error = e; });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (line && pending && !error) { try { line(pending); } catch (e) { error = e; } }
      if (error) fail(error);
      else if (code !== 0) fail(new Error(`${program} 审片失败：${stderr.trim() || code}`));
      else done({ stdout: binary ? Buffer.concat(chunks) : stdout, stderr });
    });
  });
}

/** 工程没有编码帧率，末态按 duration 前 1ms 求帧，绝不冒充编码末帧 PTS。 */
export async function reviewProjectFrames(root, dir, request, stage, { signal } = {}) {
  const scale = Math.min(1, request.maxEdge / Math.max(stage.w, stage.h));
  const session = await open(root, { scale, transparent: true, signal });
  try {
    const duration = session.film.meta.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('当前工程需要明确的正 duration 才能审片。');
    const lastTime = Math.max(0, duration - 0.001);
    const points = requestedPoints(request, duration, lastTime);
    const frames = [], findings = [], coverage = [];
    for (const [index, point] of points.entries()) {
      signal?.throwIfAborted();
      await session.film.seek(point.actualTime);
      const png = await session.film.capture({ format: 'png' });
      if (png.length > REVIEW_MAX_FRAME_BYTES) throw new Error('单帧 PNG 超过 4 MiB 审片预算。');
      const file = join(dir, `frame-${index}.png`);
      await writeFile(file, png, { flag: 'wx', mode: 0o600 });
      const time = { ...point, actualPTS: null, timeBasis: 'project-seek' };
      const dimensions = pngSize(png);
      const measured = await collectFrameFindings(session.film, { time, stage, targetWidth: Math.min(dimensions.width, request.targetWidth ?? dimensions.width), source: { kind: 'current-project', consistency: 'same-seek-capture-window-not-atomic' } });
      findings.push(...measured.findings); coverage.push(...measured.coverage);
      frames.push({ ...time, ...dimensions, sourceWidth: stage.w, sourceHeight: stage.h, captureSha256: createHash('sha256').update(png).digest('hex'), captureBytes: png.length, file });
    }
    let sequence;
    if (request.sequence) {
      const samples = [];
      for (const [i, point] of projectSequencePoints(duration, request.sequence).entries()) {
        signal?.throwIfAborted();
        await session.film.seek(point.actualTime);
        const png = await session.film.capture({ format: 'png' });
        if (png.length > REVIEW_MAX_FRAME_BYTES) throw new Error('序列观察图超过4MiB预算。');
        const file = join(dir, `sequence-${i}.png`);
        await writeFile(file, png, { flag: 'wx', mode: 0o600 });
        samples.push({ ...point, actualPTS: null, timeBasis: 'project-seek', ...pngSize(png), file,
          captureSha256: createHash('sha256').update(png).digest('hex'), captureBytes: png.length });
      }
      sequence = { frames: samples, temporal: { status: 'partial', method: 'discrete-project-seeks', requestedWindow: request.sequence,
        observedSamples: samples.length, limitations: ['工程预览只做离散seek；不能据此宣称区间每帧、连续播放或音频已检查。'] } };
    }
    return { duration, frames, findings, coverage, ...(sequence ? { sequence, sequenceFiles: sequence.frames.map((s) => s.file) } : {}), lastFramePolicy: 'project-duration-minus-0.001s' };
  } finally { await session.close(); }
}

/** 输入只能是本次独立副本。扫描真实 PTS，不从 duration×fps 猜 VFR、尾帧或目标时间。 */
export async function reviewEncodedFrames(file, dir, request, { signal } = {}) {
  const metadata = await runReviewProcess('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,time_base:format=duration', '-of', 'json', file], { signal });
  const info = JSON.parse(metadata.stdout), stream = info.streams?.[0];
  if (!stream?.width || !stream?.height) throw new Error('导出没有可解码的视频流。');
  const duration = Number(info.format?.duration);
  const timeBase = stream.time_base;
  if (!/^\d+\/\d+$/.test(timeBase ?? '')) throw new Error('视频流缺少可核验 time_base。');
  const timestamps = [], ticks = [];
  let index = 0, last = null;
  await runReviewProcess('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp,best_effort_timestamp_time', '-of', 'compact=p=0', file], {
    maxBytes: 32 * 1024 * 1024, signal,
    line(value) {
      if (!value.trim()) return;
      const fields = Object.fromEntries(value.split('|').map((field) => { const at = field.indexOf('='); return [field.slice(0, at), field.slice(at + 1)]; }));
      const token = fields.best_effort_timestamp_time, tick = fields.best_effort_timestamp;
      if (!/^[-+]?\d+(?:\.\d+)?$/.test(token ?? '') || !/^-?\d+$/.test(tick ?? '')) throw new Error('编码帧缺少可核验 PTS。');
      const pts = Number(token);
      if (last && pts < last.pts) throw new Error('编码帧 PTS 非递增，不能准确映射审片时间。');
      if (index >= 1_000_000) throw new Error('视频超过一百万帧审片预算。');
      timestamps.push(pts); ticks.push(tick);
      last = { index, pts }; index += 1;
    },
  });
  if (!last) throw new Error('视频没有可解码帧。');
  // 容器 duration 在 VFR/B 帧媒体中可能短于末帧 PTS，不能据此拒绝真实存在的画面。
  const { points, firstPTS } = selectReviewFrames(timestamps, request);
  const sequenceSelection = request.sequence ? sequencePoints(timestamps, request.sequence) : null;
  const indices = [...new Set([...points, ...(sequenceSelection?.points ?? [])].map((p) => p.index))].sort((a, b) => a - b);
  const filter = `select=${indices.map((n) => `eq(n\\,${n})`).join('+')},scale=w='min(iw,${request.maxEdge})':h='min(ih,${request.maxEdge})':force_original_aspect_ratio=decrease,showinfo`;
  const decoded = await runReviewProcess('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'info', '-copyts', '-i', file, '-map', '0:v:0', '-vf', filter, '-fps_mode', 'passthrough', '-frames:v', String(indices.length), '-start_number', '0', join(dir, 'decoded-%d.png')], { signal });
  // showinfo 的 pts_time 使用低精度显示，长时间戳只能核整数 pts 与对应 time_base。
  const decodedBase = /config in time_base:\s*(\d+\/\d+)/.exec(decoded.stderr)?.[1];
  const observed = [...decoded.stderr.matchAll(/\bn:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:/g)].map((m) => m[1]);
  if (observed.length !== indices.length) throw new Error('解码帧数与选择结果不一致。');
  const frames = [];
  for (const [frameIndex, point] of points.entries()) {
    const slot = indices.indexOf(point.index);
    if (!equalPTSTicks(ticks[point.index], timeBase, observed[slot], decodedBase)) throw new Error('解码帧 PTS 与探测结果不一致。');
    const png = await readFile(join(dir, `decoded-${slot}.png`));
    if (png.length > REVIEW_MAX_FRAME_BYTES) throw new Error('单帧 PNG 超过 4 MiB 审片预算。');
    const out = join(dir, `frame-${frameIndex}.png`);
    await writeFile(out, png, { flag: 'wx', mode: 0o600 });
    frames.push({ requestedTime: point.requestedTime, actualTime: relativePTS(point.pts, firstPTS), actualPTS: point.pts, actualPTSTicks: ticks[point.index], ptsTimeBase: timeBase, frameIndex: point.index, timeBasis: 'encoded-pts', ...pngSize(png), sourceWidth: stream.width, sourceHeight: stream.height, captureSha256: createHash('sha256').update(png).digest('hex'), captureBytes: png.length, file: out });
  }
  let sequence;
  if (sequenceSelection) {
    const samples = [];
    for (const [i, point] of sequenceSelection.points.entries()) {
      const slot = indices.indexOf(point.index);
      if (!equalPTSTicks(ticks[point.index], timeBase, observed[slot], decodedBase)) throw new Error('序列观察图实际PTS不符。');
      const png = await readFile(join(dir, `decoded-${slot}.png`)), file = join(dir, `sequence-${i}.png`);
      if (png.length > REVIEW_MAX_FRAME_BYTES) throw new Error('序列观察图超过4MiB预算。');
      await writeFile(file, png, { flag: 'wx', mode: 0o600 });
      samples.push({ requestedTime: point.requestedTime, actualTime: point.actualTime, actualPTS: point.pts,
        actualPTSTicks: ticks[point.index], ptsTimeBase: timeBase, frameIndex: point.index, timeBasis: 'encoded-pts', ...pngSize(png), file,
        captureSha256: createHash('sha256').update(png).digest('hex'), captureBytes: png.length });
    }
    const eligible = sequenceSelection.eligible, firstIndex = eligible[0].index, lastIndex = eligible.at(-1).index;
    const factor = Math.min(1, 96 / Math.max(stream.width, stream.height));
    const dimensions = { width: Math.max(1, Math.floor(stream.width * factor)), height: Math.max(1, Math.floor(stream.height * factor)) };
    const gray = await runReviewProcess('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'info', '-threads', '1', '-copyts', '-i', file, '-map', '0:v:0', '-vf',
      `select=between(n\\,${firstIndex}\\,${lastIndex}),scale=${dimensions.width}:${dimensions.height},format=gray,showinfo`,
      '-fps_mode', 'passthrough', '-frames:v', String(eligible.length), '-f', 'rawvideo', 'pipe:1'],
    { binary: true, maxBytes: SEQUENCE_MAX_FRAMES * 96 * 96, signal });
    const grayBase = /config in time_base:\s*(\d+\/\d+)/.exec(gray.stderr)?.[1];
    const grayTicks = [...gray.stderr.matchAll(/\bn:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:/g)].map((m) => m[1]);
    if (grayTicks.length !== eligible.length || eligible.some((p, i) => !equalPTSTicks(ticks[p.index], timeBase, grayTicks[i], grayBase))) throw new Error('逐帧灰度分析的实际PTS与探测不符。');
    sequence = { frames: samples, temporal: { status: 'observed', requestedWindow: request.sequence, timeBasis: 'encoded-pts',
      timeOriginPTS: firstPTS, firstActualPTSTicks: ticks[firstIndex], lastActualPTSTicks: ticks[lastIndex], ptsTimeBase: timeBase,
      analysisBytes: gray.stdout.length, analysisSha256: createHash('sha256').update(gray.stdout).digest('hex'),
      ...lumaActivity(gray.stdout, dimensions, eligible, request.sequence) } };
  }
  return { duration: Number.isFinite(duration) && duration > 0 ? duration : null, durationOrigin: 'container-format-metadata', timeOrigin: 'first-decoded-video-frame', timeOriginPTS: firstPTS, encodedRange: { firstPTS, lastPTS: last.pts }, frames,
    ...(sequence ? { sequence, sequenceFiles: sequence.frames.map((s) => s.file) } : {}), decodedFiles: indices.map((_, i) => join(dir, `decoded-${i}.png`)), lastFramePolicy: 'last-decoded-video-frame-pts' };
}

function requestedPoints(request, duration, lastTime) {
  const times = request.times ?? (request.count ? Array.from({ length: request.count }, (_, i) => duration * i / request.count) : []);
  if (times.some((t) => t >= duration)) throw new Error('请求时间超出工程范围；使用 last 读取末态。');
  return [...times.map((t) => ({ requestedTime: t, actualTime: t })), ...(request.last ? [{ requestedTime: 'last', actualTime: lastTime }] : [])];
}


// ffprobe 的 *_timestamp_time 以微秒小数报告；按该报告精度相减，避免 2.1 + .2 的浮点加法跳过 2.3 帧。
const relativePTS = (pts, origin) => Number((pts - origin).toFixed(6));
export function selectReviewFrames(timestamps, request) {
  if (!timestamps.length) throw new Error('视频没有可解码帧。');
  const firstPTS = timestamps[0], relative = timestamps.map((pts) => relativePTS(pts, firstPTS));
  const targets = request.times ?? (request.count ? Array.from({ length: request.count }, (_, i) => relative.at(-1) * i / request.count) : []);
  const points = targets.map((t) => {
    const index = relative.findIndex((time) => time >= t);
    if (index < 0) throw new Error('请求时间之后没有编码帧；使用 last 读取真实末帧。');
    return { requestedTime: t, index, pts: timestamps[index] };
  });
  if (request.last) points.push({ requestedTime: 'last', index: timestamps.length - 1, pts: timestamps.at(-1) });
  return { firstPTS, points };
}


/** 用整数交叉乘积核时间，不依赖诊断文本四舍五入，也不扩大容差。 */
export function equalPTSTicks(a, aBase, b, bBase) {
  if (!/^-?\d+$/.test(a ?? '') || !/^-?\d+$/.test(b ?? '') || !/^\d+\/[1-9]\d*$/.test(aBase ?? '') || !/^\d+\/[1-9]\d*$/.test(bBase ?? '')) return false;
  const [an, ad] = aBase.split('/').map(BigInt), [bn, bd] = bBase.split('/').map(BigInt);
  return an > 0n && bn > 0n && BigInt(a) * an * bd === BigInt(b) * bn * ad;
}
