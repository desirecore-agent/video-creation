// @ts-check
/**
 * 显式准备可被影片引用的整源工作媒体。它与仅预览的 proxy 不同：调用者自己决定是否把返回路径写入
 * film.html；预览、正式渲染和审片随后读取同一文件。本模块不编辑影片、不调用 Provider、不另建作业系统。
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { MediaError, probe } from './derived.mjs';
import { inside, readable } from './files.mjs';
import { withProjectFilmEdit } from './film.mjs';

const PIPELINE_VERSION = 2;
const FPS = 30;
const PROVENANCE_LIMIT = 128 << 10;

export const workingMediaRequestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false, required: ['src'],
  description: '把已导入/链接的整段视频准备成可追溯的SDR工作副本，不裁剪、不改速、不自动修改film.html或字幕。',
  properties: {
    src: { type: 'string', minLength: 1, maxLength: 2048, pattern: String.raw`^[^?#\\\x00]+$`, description: '项目内原视频路径，不含query或时间fragment；已授权的媒体链接沿现有只读边界访问。' },
    shortEdge: { type: 'integer', enum: [720, 1080], default: 720, description: '工作副本短边上限，保持方向/画幅且不放大，固定30fps。720适合审片，1080适合竖屏交付。' },
  },
};

/** @param {unknown} input */
function requestOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MediaError('需要src和可选shortEdge。', 400);
  const ask = /** @type {{ src?: unknown, shortEdge?: unknown }} */ (input);
  if (Object.keys(input).some((key) => !['src', 'shortEdge'].includes(key)) || typeof ask.src !== 'string' || !ask.src || ask.src.length > 2048 || /[?#\\\0]/.test(ask.src)) {
    throw new MediaError('src必须是项目内不含query/fragment的视频路径。', 400);
  }
  const shortEdge = ask.shortEdge ?? 720;
  if (shortEdge !== 720 && shortEdge !== 1080) throw new MediaError('shortEdge只能为720或1080。', 400);
  return { src: ask.src, shortEdge };
}

/** @param {AbortSignal | undefined} signal */
function checkAbort(signal) {
  if (signal?.aborted) {
    const error = new MediaError('工作媒体准备已取消。', 499);
    error.name = 'AbortError';
    throw error;
  }
}

const sameStamp = (/** @type {import('node:fs').Stats} */ a, /** @type {import('node:fs').Stats} */ b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
/** 流式摘要不把长片载入内存；读取前后都核文件身份。
 * @param {string} file
 * @param {AbortSignal} [signal]
 */
async function fileSnapshot(file, signal) {
  checkAbort(signal);
  const before = await stat(file);
  checkAbort(signal);
  if (!before.isFile()) throw new MediaError('媒体必须是普通文件。', 422);
  const hash = createHash('sha256');
  const stream = createReadStream(file, { ...(signal ? { signal } : {}) });
  try { for await (const bytes of stream) { checkAbort(signal); hash.update(bytes); } }
  catch (error) { checkAbort(signal); throw error; }
  const after = await stat(file);
  checkAbort(signal);
  if (!sameStamp(before, after)) throw new MediaError('读取期间源媒体发生变化，请重试当前文件。', 409);
  return { sha256: hash.digest('hex'), bytes: before.size, stamp: before };
}

/** 只对明确HLG/PQ输入做tone mapping；未知转移函数不能冒充已校准SDR。
 * @param {any} facts
 */
export function workingMediaPlan(facts, shortEdge = 720) {
  const width = Number(facts.width), height = Number(facts.height);
  if (!(width > 0 && height > 0) || typeof facts.codec !== 'string' || !Number.isFinite(facts.duration) || !(facts.duration > 0)) throw new MediaError('需要有尺寸和时长的视频，不能准备静态图片或纯音频。', 422);
  const origin = facts.videoStartSeconds;
  if (typeof origin !== 'number' || !Number.isFinite(origin)) throw new MediaError('视频流起点未知，不能承诺工作副本的源时间映射。', 422);
  const transfer = facts.color?.hdrTransfer;
  if (facts.dolbyVision && !['hlg', 'pq'].includes(transfer)) throw new MediaError('Dolby Vision输入未报告可识别的HLG/PQ转移函数，请先确认颜色事实。', 422);
  const k = Math.min(1, shortEdge / Math.min(width, height));
  const even = (/** @type {number} */ n) => Math.max(2, Math.round(n / 2) * 2);
  const size = { width: even(width * k), height: even(height * k) };
  const picture = [`setpts=PTS-(${origin})/TB`, `fps=${FPS}`, `scale=${size.width}:${size.height}:flags=lanczos`];
  if (transfer === 'hlg' || transfer === 'pq') picture.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'tonemap=tonemap=hable:desat=0', 'zscale=p=bt709:t=bt709:m=bt709:r=tv');
  else picture.push('scale=out_color_matrix=bt709:out_range=tv');
  /* HDR/Dolby帧侧数据不能继续贴在转换后的SDR图像上；容器标签另由map_metadata清除。 */
  picture.push('setsar=1', 'sidedata=mode=delete', 'format=yuv420p');
  return { size, videoFilter: picture.join(','),
    /* 与视频减去同一个流起点，再补到0；不能把晚到的音轨用它自己的STARTPTS提前。 */
    audioFilter: `asetpts=PTS-(${origin})/TB,aresample=async=1:first_pts=0`,
    colorPolicy: transfer === 'hlg' ? 'hlg-to-bt709-hable' : transfer === 'pq' ? 'pq-to-bt709-hable' : 'no-hdr-transfer-reported-bt709-output',
    sourceTimeAtWorkingZero: origin,
    originalAudioWaveformToWorkingOffsetSeconds: facts.audio && typeof facts.audioStartSeconds === 'number' ? facts.audioStartSeconds - origin : null };
}

/** @type {Promise<unknown>} */
let encoding = Promise.resolve();
/** @type {Set<string>} */
const inFlight = new Set();
/** 单个编码进程，等待期间不占项目编辑队列。
 * @template T
 * @param {AbortSignal | undefined} signal
 * @param {() => Promise<T>} task
 */
async function encodeSerial(signal, task) {
  const next = encoding.catch(() => {}).then(() => { checkAbort(signal); return task(); });
  encoding = next;
  return next;
}

/** @param {string[]} args @param {AbortSignal} [signal] */
function encode(args, signal) {
  checkAbort(signal);
  return new Promise((done, fail) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let errorText = '';
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', (bytes) => { errorText = (errorText + String(bytes)).slice(-16384); });
    child.once('error', (error) => {
      signal?.removeEventListener('abort', abort);
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      fail(new MediaError(code === 'ENOENT' ? 'ffmpeg未安装，请先准备本应用运行依赖。' : error.message, code === 'ENOENT' ? 501 : 422));
    });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort);
      try { checkAbort(signal); } catch (error) { fail(error); return; }
      if (code === 0) done(undefined);
      else fail(new MediaError(errorText.trim() || `ffmpeg退出${code}。`, 422));
    });
    if (signal?.aborted) abort();
  });
}

/** 只接受完整、普通、摘要仍相同的已有产物。
 * @param {string} root
 * @param {string} directory
 * @param {string} key
 * @param {string} sourceSha
 * @param {{ source: { bytes: number }, facts: any, mapping: any, processing: any }} expected
 * @param {AbortSignal} [signal]
 */
async function existing(root, directory, key, sourceSha, expected, signal) {
  const folder = await lstat(inside(root, directory)).catch((error) => {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  });
  checkAbort(signal);
  if (!folder) return null;
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new MediaError('工作副本目录已被其他文件占用。', 409);
  const manifestPath = inside(root, `${directory}/provenance.json`);
  const manifestStat = await lstat(manifestPath).catch(() => null);
  const mediaPath = inside(root, `${directory}/media.mp4`);
  const mediaStat = await lstat(mediaPath).catch(() => null);
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > PROVENANCE_LIMIT || !mediaStat?.isFile() || mediaStat.isSymbolicLink()) throw new MediaError('已有工作副本不完整；保留现存目录，请人工检查后重试。', 409);
  let record;
  try { record = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { throw new MediaError('已有工作副本来源记录无效。', 409); }
  checkAbort(signal);
  if (record.contractVersion !== 1 || record.key !== key || record.source?.sha256 !== sourceSha || record.output?.path !== `${directory}/media.mp4`
    || typeof record.source.path !== 'string' || record.source.path.length > 2048 || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) throw new MediaError('已有工作副本来源记录与本次输入不符。', 409);
  if (!isDeepStrictEqual(record.source.facts, expected.facts) || record.source.bytes !== expected.source.bytes
    || !isDeepStrictEqual(record.mapping, expected.mapping) || !isDeepStrictEqual(record.processing, expected.processing)
    || record.provenancePath !== `${directory}/provenance.json`) throw new MediaError('已有工作副本处理或时间映射记录已变更。', 409);
  const output = await fileSnapshot(mediaPath, signal);
  if (record.output.sha256 !== output.sha256 || record.output.bytes !== output.bytes) throw new MediaError('已有工作副本字节已变更；未覆盖它。', 409);
  const actualFacts = await probe(root, `${directory}/media.mp4`, { fresh: true });
  checkAbort(signal);
  if (!isDeepStrictEqual(record.output.facts, actualFacts)) throw new MediaError('已有工作副本实际媒体事实与记录不符。', 409);
  /* 读取者只返回固定合同，不把人改JSON中的任意附加数据传播给调用方。 */
  return { contractVersion: 1, key, createdAt: record.createdAt,
    source: { path: record.source.path, sha256: sourceSha, bytes: expected.source.bytes, facts: expected.facts },
    output: { path: `${directory}/media.mp4`, sha256: output.sha256, bytes: output.bytes, facts: record.output.facts },
    mapping: expected.mapping, processing: expected.processing, provenancePath: `${directory}/provenance.json` };
}

/**
 * 请求断开可取消尚未发布的制作；成功后两文件位于同一发布目录。网络结果未知时先检查返回路径/来源文件，
 * 不重复创建另一份副本。原子目录rename不是跨进程文件系统锁，项目队列只协调本服务进程。
 * @param {string} root @param {unknown} input @param {{ signal?: AbortSignal }} [options]
 */
export async function prepareWorkingMedia(root, input, { signal } = {}) {
  const ask = requestOf(input);
  const sourcePath = readable(root, ask.src);
  const source = await fileSnapshot(sourcePath, signal);
  const facts = await probe(root, ask.src, { fresh: true });
  checkAbort(signal);
  const plan = workingMediaPlan(facts, ask.shortEdge);
  const recipe = { pipelineVersion: PIPELINE_VERSION, sourceSha256: source.sha256, shortEdge: ask.shortEdge, fps: FPS };
  const key = createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
  const directory = `assets/working/${key}`;
  const mapping = { basis: 'ffprobe-stream-start-pts', sourceTimeAtWorkingZero: plan.sourceTimeAtWorkingZero, sourceSecondsPerWorkingSecond: 1,
    originalAudioWaveformToWorkingOffsetSeconds: plan.originalAudioWaveformToWorkingOffsetSeconds };
  const processing = { ...recipe, colorPolicy: plan.colorPolicy, toneMappingIsCalibratedGrade: false };
  const expected = { source, facts, mapping, processing };
  const checkSource = async () => {
    const current = await fileSnapshot(readable(root, ask.src), signal);
    if (!sameStamp(source.stamp, current.stamp) || current.sha256 !== source.sha256) throw new MediaError('准备期间原片发生变化，未发布过时工作副本。', 409);
  };
  const ready = await existing(root, directory, key, source.sha256, expected, signal);
  if (ready) { await checkSource(); checkAbort(signal); return { ...ready, reused: true, requestedSource: ask.src }; }
  const taskKey = `${await realpath(root).catch(() => resolve(root))}\0${key}`;
  if (inFlight.has(taskKey)) throw new MediaError('同一工作副本正在准备，请等待原请求完成。', 409);
  inFlight.add(taskKey);
  try {
    return await encodeSerial(signal, async () => {
      const afterWait = await existing(root, directory, key, source.sha256, expected, signal);
      if (afterWait) { await checkSource(); checkAbort(signal); return { ...afterWait, reused: true, requestedSource: ask.src }; }
      const parent = inside(root, 'assets/working');
      await mkdir(parent, { recursive: true });
      const tempRel = `assets/working/.${key}.${randomBytes(6).toString('hex')}`;
      const temp = inside(root, tempRel);
      await mkdir(temp, { mode: 0o700 });
      const temporaryIdentity = await lstat(temp);
      try {
        const encoded = join(temp, 'media.mp4');
        const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '2', '-copyts', '-i', sourcePath,
          '-map', '0:v:0', ...(facts.audio ? ['-map', '0:a:0'] : []), '-sn', '-dn', '-vf', plan.videoFilter, '-filter_threads', '1',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', '2',
          ...(facts.audio ? ['-af', plan.audioFilter, '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'] : ['-an']),
          '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
          '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-n', encoded];
        await encode(args, signal);
        await chmod(encoded, 0o600);
        const outputFacts = await probe(root, `${tempRel}/media.mp4`, { fresh: true });
        checkAbort(signal);
        if (outputFacts.width !== plan.size.width || outputFacts.height !== plan.size.height || outputFacts.codec !== 'h264' || outputFacts.pixfmt !== 'yuv420p'
          || typeof outputFacts.videoStartSeconds !== 'number' || Math.abs(outputFacts.videoStartSeconds) > 1 / 48000 || outputFacts.fps !== FPS
          || outputFacts.audio !== facts.audio || (facts.audio && (typeof outputFacts.audioStartSeconds !== 'number' || Math.abs(outputFacts.audioStartSeconds) > 1 / 48000))
          || outputFacts.color?.primaries !== 'bt709' || outputFacts.color?.transfer !== 'bt709' || outputFacts.color?.matrix !== 'bt709'
          || outputFacts.dolbyVision !== null || outputFacts.rotationDegrees !== 0 || outputFacts.sampleAspectRatio !== '1:1') throw new MediaError('工作副本实际尺寸、编码或时钟不符合准备合同。', 422);
        const output = await fileSnapshot(encoded, signal);
        const record = { contractVersion: 1, key, createdAt: new Date().toISOString(),
          source: { path: ask.src, sha256: source.sha256, bytes: source.bytes, facts },
          output: { path: `${directory}/media.mp4`, sha256: output.sha256, bytes: output.bytes, facts: outputFacts },
          mapping, processing, provenancePath: `${directory}/provenance.json` };
        await writeFile(join(temp, 'provenance.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        return await withProjectFilmEdit(root, async () => {
          checkAbort(signal);
          await checkSource();
          checkAbort(signal);
          const target = inside(root, directory);
          const raced = await existing(root, directory, key, source.sha256, expected, signal);
          /* rename一旦提交可能已完成；这里只阻止尚未进入发布的已取消请求，不承诺OS原子取消。 */
          checkAbort(signal);
          if (raced) return { ...raced, reused: true, requestedSource: ask.src };
          try { await rename(temp, target); }
          catch (error) {
            if (['EEXIST', 'ENOTEMPTY'].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? '')) throw new MediaError('工作副本发布目录已存在，未覆盖它。', 409);
            throw error;
          }
          return { ...record, reused: false, requestedSource: ask.src };
        });
      } finally {
        const remaining = await lstat(temp).catch(() => null);
        if (remaining && remaining.dev === temporaryIdentity.dev && remaining.ino === temporaryIdentity.ino) await rm(temp, { recursive: true, force: true });
      }
    });
  } finally { inFlight.delete(taskKey); }
}
