/** 带来源的只读审片。派生材料属于应用数据根，影片、人工锁和导出记录均不改写。 */
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, lstat, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { addAbortSignal } from 'node:stream';
import { Ajv } from 'ajv';
import { studioHomeDir } from '../../src/locations.mjs';
import { reviewEncodedFrames, reviewProjectFrames, REVIEW_MAX_FRAMES, REVIEW_MAX_FRAME_BYTES, REVIEW_MAX_TOTAL_BYTES, pngSize } from '../../src/review-frames.mjs';
import { snapshotFilm } from './export-snapshot.mjs';
import { filmClosure, folderView } from './closure.mjs';
import { readProjectFilm } from './film.mjs';

export const reviewRequestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false, required: ['source'],
  properties: {
    source: { enum: ['current-project', 'export-job'], description: 'current-project 是当前工程的浏览器求帧预览；export-job 只解码此工程已经完成的真实视频导出。' },
    job: { type: 'string', pattern: '^[a-f0-9]{12}$', description: 'export-job 必须指定 video_jobs 返回的 done 视频任务 ID；不是任意输出文件路径。' },
    times: { type: 'array', minItems: 1, maxItems: REVIEW_MAX_FRAMES, uniqueItems: true, items: { type: 'number', minimum: 0, maximum: 86400 }, description: '明确的秒数；编码视频以首个真实视频帧为播放零点，选择不早于请求的第一帧，另报原始实际 PTS。与 count 互斥。' },
    last: { type: 'boolean', description: '额外读取真实编码末帧；当前工程则读取 duration 前 1ms 的预览末态，两者不能混称。' },
    count: { type: 'integer', minimum: 1, maximum: REVIEW_MAX_FRAMES, description: '未指定 times 时均匀取样的帧数；与 last 合计最多六帧。' },
    maxEdge: { type: 'integer', minimum: 128, maximum: 1920, default: 1280, description: '派生 PNG 最长边上限；保持画幅且不放大，回执记录实际尺寸。' },
  },
};
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(reviewRequestSchema);
const stamp = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
export class ReviewError extends Error {
  constructor(message, status = 422, code = 'review-failed') { super(message); this.status = status; this.code = code; }
}
export function normalizeReviewRequest(value) {
  if (!validate(value)) throw new ReviewError(`审片参数无效：${ajv.errorsText(validate.errors)}`, 400, 'invalid-request');
  if ((value.source === 'export-job') !== Boolean(value.job)) throw new ReviewError('只有 export-job 需要且必须提供 job。', 400, 'invalid-request');
  if (value.times && value.count !== undefined) throw new ReviewError('times 与 count 不能同时提供。', 400, 'invalid-request');
  const request = { ...value, maxEdge: value.maxEdge ?? 1280 };
  if (!request.times && !request.count && !request.last) request.count = 4;
  if ((request.times?.length ?? request.count ?? 0) + Number(Boolean(request.last)) > REVIEW_MAX_FRAMES) throw new ReviewError('times/count 与 last 合计最多六帧。', 400, 'over-budget');
  return request;
}

/** 流式摘要绑定已打开的字节；检查同一路径是否在读取期间替换或变化。 */
export async function digestFile(file, maxBytes = 2 * 1024 ** 3, signal) {
  signal?.throwIfAborted();
  const before = await stat(file);
  if (!before.isFile() || before.size > maxBytes) throw new ReviewError(`审片输入不是普通文件或超过 ${maxBytes} 字节预算。`, 422, 'over-budget');
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of signal ? addAbortSignal(signal, createReadStream(file)) : createReadStream(file)) { bytes += chunk.length; if (bytes > maxBytes) throw new ReviewError('审片输入超过字节预算。', 422, 'over-budget'); hash.update(chunk); }
  if (stamp(before) !== stamp(await stat(file)) || bytes !== before.size) throw new ReviewError('审片读取期间来源发生变化。', 409, 'stale');
  return { bytes, sha256: hash.digest('hex') };
}
async function localInputs(root, signal) {
  signal?.throwIfAborted();
  const closure = await filmClosure(folderView(root));
  if (closure.size > 10000) throw new ReviewError('工程静态依赖超过一万文件预算。', 422, 'over-budget');
  const files = []; let bytes = 0;
  for (const name of [...closure.keys()].sort()) {
    const digest = await digestFile(join(root, ...name.split('/')), 2 * 1024 ** 3, signal);
    bytes += digest.bytes;
    if (bytes > 2 * 1024 ** 3) throw new ReviewError('工程静态依赖超过 2 GiB 审片预算。', 422, 'over-budget');
    files.push({ path: name, ...digest });
  }
  return { files, bytes, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
const sameDigest = (a, b) => a.bytes === b.bytes && a.sha256 === b.sha256;

/** @param {{ root?: string, jobs?: (projectId: string) => import('./exports.mjs').ExportJob[], drawProject?: typeof reviewProjectFrames, decodeVideo?: typeof reviewEncodedFrames, newId?: () => string }} [options] */
export function createReviews({ root = join(studioHomeDir(), 'reviews'), jobs, drawProject = reviewProjectFrames, decodeVideo = reviewEncodedFrames, newId = () => randomBytes(12).toString('hex') } = {}) {
  let tail = Promise.resolve(), closed = false, pending = 0;
  const active = new Set();
  const stopped = () => new ReviewError('审片已停止，此服务不再接收新审片。', 409, 'review-stopped');
  const directory = (id) => {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new ReviewError('审片 ID 无效。', 400, 'invalid-request');
    return join(root, id);
  };
  const read = async (project, id) => {
    let receipt;
    try { receipt = JSON.parse(await readFile(join(directory(id), 'review.json'), 'utf8')); }
    catch (e) { if (e instanceof ReviewError) throw e; throw new ReviewError('找不到可读取的审片回执。', 404, 'missing-review'); }
    if (receipt.reviewId !== id || receipt.projectId !== project.id || receipt.version !== 1 || !Array.isArray(receipt.frames) || receipt.frames.length < 1 || receipt.frames.length > REVIEW_MAX_FRAMES) throw new ReviewError('审片回执与项目或材料不匹配。', 409, 'receipt-mismatch');
    return receipt;
  };
  return {
    read,
    busy: () => pending > 0,
    async close() { closed = true; for (const controller of active) controller.abort(); await tail; },
    async frame(project, id, index, expectedSha256) {
      const receipt = await read(project, id);
      if (!Number.isInteger(index) || index < 0 || index >= receipt.frames.length) throw new ReviewError('没有此审片帧。', 404, 'missing-frame');
      const declared = receipt.frames[index], file = join(directory(id), `frame-${index}.png`);
      if (declared.path !== file || (expectedSha256 !== undefined && expectedSha256 !== declared.sha256)) throw new ReviewError('审片帧摘要与调用者期望不符。', 409, 'digest-mismatch');
      let data;
      try {
        if ((await lstat(file)).isSymbolicLink() || (await lstat(directory(id))).isSymbolicLink()) throw new ReviewError('审片帧被替换为目录链接。', 409, 'digest-mismatch');
        if ((await stat(file)).size > REVIEW_MAX_FRAME_BYTES) throw new ReviewError('审片帧超过原预算。', 409, 'digest-mismatch');
        data = await readFile(file);
      } catch (error) { if (error instanceof ReviewError) throw error; throw new ReviewError('审片帧已丢失或不可读。', 404, 'missing-frame'); }
      if (data.length !== declared.bytes || createHash('sha256').update(data).digest('hex') !== declared.sha256) throw new ReviewError('审片帧字节已改变，不能返回其他材料代替。', 409, 'digest-mismatch');
      let dimensions;
      try { dimensions = pngSize(data); } catch { throw new ReviewError('审片帧已不是有效 PNG。', 409, 'digest-mismatch'); }
      if (dimensions.width !== declared.width || dimensions.height !== declared.height) throw new ReviewError('审片帧尺寸与回执不一致。', 409, 'digest-mismatch');
      return { data, frame: declared };
    },
    create(project, ask) {
      if (closed) return Promise.reject(stopped());
      const request = normalizeReviewRequest(ask);
      pending += 1;
      const next = tail.then(async () => {
        if (closed) throw stopped();
        const controller = new AbortController(); active.add(controller);
        try { return await generate(project, request, controller.signal); }
        finally { active.delete(controller); }
      });
      tail = next.then(() => { pending -= 1; }, () => { pending -= 1; });
      return next;
    },
  };

  async function generate(project, request, signal) {
    signal.throwIfAborted();
    const reviewId = newId(), dir = directory(reviewId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    // 仅本次独占创建成功后才进入清理区间，碰撞不能覆盖或删除原审片。
    try { await mkdir(dir, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') throw new ReviewError('审片 ID 已存在，请重新请求。', 409, 'review-id-collision'); throw error; }
    let result, source, filmRevision, cleanup = [];
    try {
      signal.throwIfAborted();
      if (request.source === 'export-job') {
        const job = jobs?.(project.id)?.find((j) => j.id === request.job);
        if (!job) throw new ReviewError('找不到此项目的导出任务。', 404, 'missing-job');
        if (job.status !== 'done') throw new ReviewError(`导出 ${job.id} 的状态为 ${job.status}，尚无完成成片可审。`, 409, 'job-not-complete');
        if (job.kind !== 'video' || !job.out || !job.outputs.includes(job.out) || !/\.(mp4|mov|webm|m4v|mkv|avi)$/i.test(job.out)) throw new ReviewError('此任务不是可解码的视频成片。', 422, 'unsupported-job');
        if (!/^[a-f0-9]{16}$/.test(job.inputSnapshot?.filmRevision ?? '')) throw new ReviewError('旧导出缺少原始输入版本，不能绑定到当前影片冒充来源。', 409, 'missing-source-version');
        const original = await digestFile(job.out, 2 * 1024 ** 3, signal);
        const frozen = join(dir, 'encoded-source' + /\.[^.]+$/.exec(job.out)[0]); cleanup.push(frozen);
        await copyFile(job.out, frozen, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
        await chmod(frozen, 0o400);
        const copied = await digestFile(frozen, 2 * 1024 ** 3, signal);
        if (!sameDigest(original, copied) || !sameDigest(original, await digestFile(job.out, 2 * 1024 ** 3, signal))) throw new ReviewError('复制真实成片期间输出变化。', 409, 'stale');
        let manifest = null;
        try { manifest = JSON.parse(await readFile(job.inputSnapshot.manifest, 'utf8')); } catch {}
        if (manifest && manifest.filmRevision !== job.inputSnapshot.filmRevision) throw new ReviewError('任务输入清单版本不匹配。', 409, 'receipt-mismatch');
        filmRevision = job.inputSnapshot.filmRevision;
        source = { kind: 'export-job', jobId: job.id, jobStatus: 'done', output: { path: job.out, ...copied, digestOrigin: 'observed-at-review', exportCompletionDigest: null, outputTimeToFilmTime: null },
          inputs: { filmRevision, manifest: job.inputSnapshot.manifest, files: manifest?.files ?? null, digestOrigin: 'export-input-manifest',
            limitations: [...(job.inputSnapshot.limitations ?? []), '新输入清单逐项 SHA-256 来自提交时冻结副本；旧清单可能只有 path/bytes，没有摘要时不能证明导出时每个场景或资源的 SHA-256。输出摘要在本次审片复制时观察，不是导出完成时的摘要。输出的播放相对时间不等于原 film 时间；range/clip 等导出不提供隐式全局时间映射。'] },
          consistency: 'independent-output-copy-checked-against-observed-source' };
        result = await decodeVideo(frozen, dir, request, { signal });
        if (!sameDigest(copied, await digestFile(frozen, 2 * 1024 ** 3, signal))) throw new ReviewError('解码使用的独立成片副本变化。', 409, 'stale');
      } else {
        const frozen = join(dir, 'input'); cleanup.push(frozen, join(dir, 'input-manifest.json'));
        const manifest = await snapshotFilm(project.path, frozen, { maxFiles: 10000, maxBytes: 2 * 1024 ** 3, signal });
        const snapshot = await localInputs(frozen, signal), before = await localInputs(project.path, signal);
        if (!sameDigest(snapshot, before)) throw new ReviewError('工程在冻结输入后变化，请重新审片。', 409, 'stale');
        const film = await readProjectFilm(frozen);
        if (!film.doc || film.problems?.length) throw new ReviewError('工程结构无效，不能生成审片。');
        filmRevision = manifest.filmRevision;
        source = { kind: 'current-project', inputs: { filmRevision, ...snapshot, digestOrigin: 'review-static-local-snapshot', limitations: manifest.limitations },
          consistency: 'local-snapshot-with-live-before-after-checks', limitations: ['静态本地依赖沿既有 filmClosure 冻结。远端资源、未解析的动态依赖和浏览器/字体环境不属于这个摘要，不能宣称原子冻结整个运行环境。'] };
        result = await drawProject(frozen, dir, request, film.doc.stage, { signal });
        if (!sameDigest(snapshot, await localInputs(project.path, signal)) || (await readProjectFilm(project.path)).rev !== filmRevision) throw new ReviewError('工程在审片期间变化，请按当前版本重新审片。', 409, 'stale');
      }
      cleanup.push(...(result.decodedFiles ?? []));
      const expectedCount = (request.times?.length ?? request.count ?? 0) + Number(Boolean(request.last));
      if (result.frames.length !== expectedCount) throw new ReviewError('实际审片帧数与请求不一致。');
      let total = 0;
      const frames = [];
      for (const [index, item] of result.frames.entries()) {
        if (item.file !== join(dir, `frame-${index}.png`)) throw new ReviewError('审片图片路径与本次身份不符。');
        const digest = await digestFile(item.file, REVIEW_MAX_FRAME_BYTES, signal); total += digest.bytes;
        const dimensions = pngSize(await readFile(item.file));
        if (dimensions.width !== item.width || dimensions.height !== item.height || Math.max(item.width, item.height) > request.maxEdge) throw new ReviewError('审片 PNG 实际尺寸与回执不符。');
        if (total > REVIEW_MAX_TOTAL_BYTES) throw new ReviewError('PNG 总计超过 12 MiB 审片预算。', 422, 'over-budget');
        const { file, ...meta } = item;
        frames.push({ index, ...meta, path: file, ...digest, mimeType: 'image/png', url: `/api/projects/${encodeURIComponent(project.id)}/reviews/${reviewId}/frames/${index}` });
      }
      const receipt = { version: 1, reviewId, sourceKind: request.source, projectId: project.id, filmRevision, createdAt: new Date().toISOString(), request, source,
        duration: result.duration, durationOrigin: result.durationOrigin ?? 'project-duration', timeOrigin: result.timeOrigin ?? 'project-timeline', timeOriginPTS: result.timeOriginPTS ?? null, ...(result.encodedRange ? { encodedRange: result.encodedRange } : {}), lastFramePolicy: result.lastFramePolicy, frames, totalFrameBytes: total, observation: 'generated-not-viewed',
        observationNote: '本回执只证明生成指定来源的图片。导演应通过 Read(path, expected_sha256) 实际读取必要图片；图片进入请求不证明模型理解。' };
      signal.throwIfAborted();
      await writeFile(join(dir, 'review.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      return receipt;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      if (signal.aborted) throw stopped();
      if (error instanceof ReviewError) throw error;
      throw new ReviewError(error.message);
    } finally { for (const file of cleanup) await rm(file, { recursive: true, force: true }); }
  }
}
