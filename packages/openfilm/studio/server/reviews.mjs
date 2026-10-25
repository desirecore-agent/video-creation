/** 带来源的只读审片。派生材料属于应用数据根，影片、人工锁和导出记录均不改写。 */
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, lstat, open as openFile, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { addAbortSignal } from 'node:stream';
import { Ajv } from 'ajv';
import { studioHomeDir } from '../../src/locations.mjs';
import { reviewEncodedFrames, reviewProjectFrames, REVIEW_MAX_FRAMES, REVIEW_MAX_FRAME_BYTES, REVIEW_MAX_TOTAL_BYTES, pngSize } from '../../src/review-frames.mjs';
import { snapshotFilm } from './export-snapshot.mjs';
import { filmClosure, folderView } from './closure.mjs';
import { readProjectFilm } from './film.mjs';
import { reviewRequestSchema } from './review-contract.mjs';
import { reviewPresentation, downscaleReviewPNG, firstLastLayout, firstLastReviewPNG, observationGridPNG } from '../../src/review-derivatives.mjs';
import { cellLabel, labelBandHeight } from '../../src/review-labels.mjs';
import { reviewFacts, reviewFactsDigest, compareReviewFacts } from './review-facts.mjs';
import { sequenceWindow, sequenceLayout, comparisonLayout } from '../../src/review-sequence.mjs';
export { reviewRequestSchema, reviewContract } from './review-contract.mjs';

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(reviewRequestSchema);
const stamp = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
export class ReviewError extends Error {
  constructor(message, status = 422, code = 'review-failed') { super(message); this.status = status; this.code = code; }
}
export function normalizeReviewRequest(value) {
  if (!validate(value)) throw new ReviewError(`审片参数无效：${ajv.errorsText(validate.errors)}`, 400, 'invalid-request');
  if (value.source === 'review-pair') {
    if (!value.before || !value.after || Object.keys(value).some((key) => !['source', 'before', 'after', 'maxEdge', 'targetWidth'].includes(key))) throw new ReviewError('review-pair只接受before/after已有帧与观看尺寸。', 400, 'invalid-request');
    return { ...value, maxEdge: value.maxEdge ?? 1280 };
  }
  if (value.before || value.after) throw new ReviewError('before/after只用于review-pair。', 400, 'invalid-request');
  if ((value.source === 'export-job') !== Boolean(value.job)) throw new ReviewError('只有 export-job 需要且必须提供 job。', 400, 'invalid-request');
  if (value.times && value.count !== undefined) throw new ReviewError('times 与 count 不能同时提供。', 400, 'invalid-request');
  if ([Boolean(value.firstLast), Boolean(value.sequence), Boolean(value.compareWidths)].filter(Boolean).length > 1) throw new ReviewError('firstLast、sequence和compareWidths一次只能选择一种制品。', 400, 'invalid-request');
  if (value.compareFrame !== undefined && !value.compareWidths) throw new ReviewError('compareFrame需要compareWidths。', 400, 'invalid-request');
  if (value.sequence) { try { sequenceWindow(value.sequence); } catch (e) { throw new ReviewError(e.message, 400, 'invalid-request'); } }
  const request = { ...value, maxEdge: value.maxEdge ?? 1280 };
  if (request.firstLast) {
    if (request.times) request.times = request.times.includes(0) ? [...request.times] : [0, ...request.times];
    else if (!request.count) request.times = [0];
    request.last = true;
  }
  if (!request.times && !request.count && !request.last) request.count = 4;
  if ((request.times?.length ?? request.count ?? 0) + Number(Boolean(request.last)) > REVIEW_MAX_FRAMES) throw new ReviewError('times/count 与 last 合计最多六帧。', 400, 'over-budget');
  if (request.compareWidths && (request.compareFrame ?? 0) >= (request.times?.length ?? request.count ?? 0) + Number(Boolean(request.last))) throw new ReviewError('compareFrame不是本次实际timed frame index。', 400, 'invalid-request');
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
/** 编码定位用整数时间基，不能把已舍入的秒数推到帧边界之前。旧材料缺数据则未知。 */
function encodedPointSeconds(receipt, point) {
  if (!/^-?[0-9]+$/.test(receipt.timeOriginPTSTicks ?? '') || !/^-?[0-9]+$/.test(point.actualPTSTicks ?? '') || !/^[0-9]+\/[0-9]+$/.test(point.ptsTimeBase ?? '')) return null;
  const [num, den] = point.ptsTimeBase.split('/').map(Number);
  if (!(num > 0 && den > 0)) return null;
  const seconds = Number(BigInt(point.actualPTSTicks) - BigInt(receipt.timeOriginPTSTicks)) * num / den;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
const sameDigest = (a, b) => a.bytes === b.bytes && a.sha256 === b.sha256;

const pngDigest = (data) => {
  if (data.length > REVIEW_MAX_FRAME_BYTES) throw new ReviewError('单图超过 4 MiB 审片预算。', 422, 'over-budget');
  return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
};
export async function readReviewPNG(file, signal) {
  signal?.throwIfAborted();
  const before = await lstat(file), parent = await lstat(join(file, '..'));
  if (before.isSymbolicLink() || parent.isSymbolicLink() || !before.isFile() || before.size > REVIEW_MAX_FRAME_BYTES) throw new ReviewError('审片 PNG 被替换或超过原预算。', 409, 'digest-mismatch');
  const handle = await openFile(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let data;
  try {
    if (stamp(before) !== stamp(await handle.stat())) throw new ReviewError('审片 PNG 在打开期间变化。', 409, 'stale');
    // 最多读原大小加一字节，文件增长也不能令 readFile 无界分配。
    const buffer = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    data = buffer.subarray(0, offset);
    if (stamp(before) !== stamp(await handle.stat()) || stamp(before) !== stamp(await lstat(file)) || stamp(parent) !== stamp(await lstat(join(file, '..'))) || data.length !== before.size) throw new ReviewError('审片 PNG 在读取期间变化。', 409, 'stale');
  } finally { await handle.close(); }
  signal?.throwIfAborted();
  let dimensions;
  try { dimensions = pngSize(data); } catch { throw new ReviewError('审片 PNG 已损坏。', 409, 'digest-mismatch'); }
  return { data, identity: { dev: before.dev, ino: before.ino, stamp: stamp(before) }, ...pngDigest(data), ...dimensions };
}
async function rewriteReviewPNG(file, data, captured, signal) {
  // 先读写打开但不截断；同 inode 的并发修改也必须在覆盖前失败。
  const handle = await openFile(file, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    signal?.throwIfAborted();
    const actual = await handle.stat();
    if (stamp(actual) !== captured.identity.stamp || actual.dev !== captured.identity.dev || actual.ino !== captured.identity.ino || actual.size !== captured.bytes) throw new ReviewError('派生前原 PNG 身份或版本变化。', 409, 'stale');
    const buffer = Buffer.alloc(captured.bytes + 1); let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const original = buffer.subarray(0, offset);
    if (offset !== captured.bytes || createHash('sha256').update(original).digest('hex') !== captured.sha256 || stamp(await handle.stat()) !== captured.identity.stamp || stamp(await lstat(file)) !== captured.identity.stamp) throw new ReviewError('派生期间原 PNG 字节变化。', 409, 'stale');
    signal?.throwIfAborted();
    await handle.truncate(0); await handle.writeFile(data);
  } finally { await handle.close(); }
}

/** @param {{ root?: string, jobs?: (projectId: string) => import('./exports.mjs').ExportJob[], drawProject?: typeof reviewProjectFrames, decodeVideo?: typeof reviewEncodedFrames, resizePNG?: typeof downscaleReviewPNG, composePNG?: typeof firstLastReviewPNG, composeGrid?: typeof observationGridPNG, newId?: () => string }} [options] */
export function createReviews({ root = join(studioHomeDir(), 'reviews'), jobs, drawProject = reviewProjectFrames, decodeVideo = reviewEncodedFrames, resizePNG = downscaleReviewPNG, composePNG = firstLastReviewPNG, composeGrid = observationGridPNG, newId = () => randomBytes(12).toString('hex') } = {}) {
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
    if (receipt.reviewId !== id || receipt.projectId !== project.id || ![1, 2, 3, 4].includes(receipt.version) || !Array.isArray(receipt.frames) || receipt.frames.length < (receipt.version === 4 && receipt.sourceKind === 'review-pair' ? 0 : 1) || receipt.frames.length > REVIEW_MAX_FRAMES) throw new ReviewError('审片回执与项目或材料不匹配。', 409, 'receipt-mismatch');
    return receipt;
  };
  const exactPNG = async (id, declared, file, expectedSha256, missingCode) => {
    if (declared.path !== file || (expectedSha256 !== undefined && expectedSha256 !== declared.sha256)) throw new ReviewError('审片图片摘要与调用者期望不符。', 409, 'digest-mismatch');
    let observed;
    try { observed = await readReviewPNG(file); }
    catch (error) { if (error instanceof ReviewError) throw error; throw new ReviewError('审片图片已丢失或不可读。', 404, missingCode); }
    if (!sameDigest(observed, declared) || observed.width !== declared.width || observed.height !== declared.height) throw new ReviewError('审片图片字节或尺寸已改变。', 409, 'digest-mismatch');
    return { data: observed.data, frame: declared };
  };
  return {
    read,
    async list(project, offset = 0) {
      if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new ReviewError('材料分页参数无效。', 400, 'invalid-request');
      let entries;
      try { entries = await readdir(root, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return { reviews: [], limited: false, unavailable: 0, nextOffset: null }; throw e; }
      const ids = entries.filter((e) => e.isDirectory() && /^[a-f0-9]{24}$/.test(e.name));
      const dated = await Promise.all(ids.map(async (e) => ({ id: e.name, at: (await stat(directory(e.name))).birthtimeMs })));
      const summaries = []; let unavailable = 0;
      for (const row of dated.sort((a, b) => b.at - a.at).slice(offset, offset + 50)) {
        try {
          const r = await read(project, row.id);
          summaries.push({ reviewId: r.reviewId, createdAt: r.createdAt, sourceKind: r.sourceKind, filmRevision: r.filmRevision, frames: r.frames.map((f) => ({ index: f.index, actualTime: f.actualTime })), artifactKinds: (r.artifacts ?? []).map((a) => a.kind) });
        } catch (e) { if (e.code !== 'receipt-mismatch') unavailable++; }
      }
      return { reviews: summaries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))), limited: offset + 50 < ids.length, unavailable, nextOffset: offset + 50 < ids.length ? offset + 50 : null };
    },
    async target(project, id, kind, index, verifyEngineering = false) {
      const r = await read(project, id);
      const point = kind === 'frame' ? r.frames[index] : kind === 'sequence' ? r.artifacts?.find((a) => a.artifactId === 'sequence')?.derivedFrom[index] : null;
      if (!Number.isInteger(index) || index < 0 || !point || !Number.isFinite(point.actualTime)) throw new ReviewError('没有此审片观察点。', 404, 'missing-frame');
      const mapping = r.sourceKind === 'current-project' ? { start: 0, rate: 1, filmRevision: r.filmRevision }
        : r.source?.output?.outputTimeToFilmTime;
      const seconds = r.sourceKind === 'current-project' ? point.actualTime : encodedPointSeconds(r, point);
      const mapped = seconds !== null && mapping && (r.sourceKind === 'current-project' || (mapping.version === 1 && mapping.kind === 'linear-film-time')) && mapping.rate === 1 && mapping.start >= 0 && mapping.filmRevision === r.filmRevision;
      let engineering = { status: mapped ? 'requires-source-check' : 'unavailable', reason: mapped ? 'verify-current-inputs-before-seek' : 'time-mapping-unavailable' };
      if (mapped && verifyEngineering) {
        try {
          const current = await localInputs(project.path), film = await readProjectFilm(project.path), expected = r.source.inputs?.files;
          const rows = Array.isArray(expected) && expected.every((f) => /^[a-f0-9]{64}$/.test(f.sha256)) ? [...expected].map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : null;
          const oldDigest = rows ? createHash('sha256').update(JSON.stringify(rows)).digest('hex') : null;
          engineering = film.rev === r.filmRevision && oldDigest === current.sha256
            ? { status: 'verified-at-check', timeMs: (mapping.start + seconds) * 1000, filmRevision: film.rev, inputSha256: current.sha256 }
            : { status: 'unavailable', reason: 'current-inputs-changed' };
        } catch { engineering = { status: 'unavailable', reason: 'current-inputs-unavailable' }; }
      }
      return { reviewId: id, filmRevision: r.filmRevision, sourceKind: r.sourceKind, point,
        playback: r.sourceKind === 'export-job' ? { status: 'verify-at-media-open', url: `/api/projects/${encodeURIComponent(project.id)}/reviews/${id}/video?expected_sha256=${r.source.output.sha256}`, canLocate: seconds !== null && r.timeOriginPTSTicks === '0', time: seconds !== null && r.timeOriginPTSTicks === '0' ? seconds : null, limitation: seconds !== null && r.timeOriginPTSTicks === '0' ? null : 'media-origin-not-proven' } : null,
        engineering, limitations: ['历史图片始终归其捕获版本；工程定位前重新校验当前静态输入，本地未保存内容另由编辑器检查。', '播放来源在打开时核验摘要；外部写者之后的修改不属于文件系统快照或事务保证。'] };
    },
    async video(project, id, expectedSha256) {
      const r = await read(project, id), source = r.source?.output;
      const job = jobs?.(project.id)?.find((j) => j.id === r.source?.jobId);
      if (r.sourceKind !== 'export-job' || !source || expectedSha256 !== source.sha256 || job?.status !== 'done' || job.out !== source.path || !job.outputs.includes(source.path)) throw new ReviewError('历史成片引用与完成任务不符。', 409, 'stale');
      const handle = await openFile(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size !== source.bytes || before.size > 2 * 1024 ** 3) throw new ReviewError('历史成片已变化。', 409, 'stale');
        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
        if (hash.digest('hex') !== source.sha256 || stamp(before) !== stamp(await handle.stat()) || stamp(before) !== stamp(await lstat(source.path))) throw new ReviewError('历史成片字节已变化。', 409, 'stale');
        return { file: source.path, handle, size: before.size, mtimeMs: before.mtimeMs, etag: source.sha256 };
      } catch (error) { await handle.close(); throw error; }
    },
    busy: () => pending > 0,
    async close() { closed = true; for (const controller of active) controller.abort(); await tail; },
    async frame(project, id, index, expectedSha256) {
      const receipt = await read(project, id);
      if (!Number.isInteger(index) || index < 0 || index >= receipt.frames.length) throw new ReviewError('没有此审片帧。', 404, 'missing-frame');
      return exactPNG(id, receipt.frames[index], join(directory(id), `frame-${index}.png`), expectedSha256, 'missing-frame');
    },
    async artifact(project, id, artifactId, expectedSha256) {
      const receipt = await read(project, id);
      const declared = receipt.artifacts?.find((item) => item.artifactId === artifactId);
      if (!['first-last', 'sequence', 'size-comparison', 'revision-comparison'].includes(artifactId) || !declared) throw new ReviewError('没有此审片制品。', 404, 'missing-artifact');
      return exactPNG(id, declared, join(directory(id), `artifact-${artifactId}.png`), expectedSha256, 'missing-artifact');
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

  async function pair(project, request, reviewId, dir, signal) {
    const references = [request.before, request.after], captures = [], derivedFrom = [], originals = [];
    for (const [side, ref] of references.entries()) {
      signal.throwIfAborted();
      const r = await read(project, ref.reviewId), f = r.frames[ref.frameIndex];
      if (!f || !Number.isFinite(f.actualTime) || r.sourceKind === 'review-pair') throw new ReviewError('前后对照必须引用已有timed frame。', 400, 'invalid-request');
      const observed = await exactPNG(ref.reviewId, f, join(directory(ref.reviewId), `frame-${ref.frameIndex}.png`), ref.expectedSha256, 'missing-frame');
      captures.push(observed.data); originals.push(r);
      derivedFrom.push({ side: side === 0 ? 'before' : 'after', reviewId: r.reviewId, frameIndex: ref.frameIndex, filmRevision: r.filmRevision, sourceKind: r.sourceKind, source: { kind: r.source.kind, jobId: r.source.jobId, output: r.source.output ? { sha256: r.source.output.sha256, bytes: r.source.output.bytes, digestOrigin: r.source.output.digestOrigin, outputTimeToFilmTime: r.source.output.outputTimeToFilmTime } : undefined, inputs: { filmRevision: r.source.inputs?.filmRevision, sha256: r.source.inputs?.sha256, digestOrigin: r.source.inputs?.digestOrigin }, consistency: r.source.consistency }, actualTime: f.actualTime, actualPTS: f.actualPTS, actualPTSTicks: f.actualPTSTicks, ptsTimeBase: f.ptsTimeBase, timeBasis: f.timeBasis, sha256: f.sha256, bytes: f.bytes, width: f.width, height: f.height });
    }
    const band = labelBandHeight(request.maxEdge), target = Math.min(request.targetWidth ?? Infinity, ...derivedFrom.map((f) => f.width), Math.floor(request.maxEdge / 2));
    const factor = Math.min(1, (request.maxEdge - band) / Math.max(...derivedFrom.map((f) => f.height * target / f.width))), width = Math.max(1, Math.floor(target * factor));
    const cells = derivedFrom.map((f, i) => ({ x: i * width, y: band, width, height: Math.max(1, Math.floor(f.height * width / f.width)), sourceWidth: f.width, sourceHeight: f.height, scale: width / f.width, actualTime: f.actualTime, actualPTS: f.actualPTS, timeBasis: f.timeBasis,
      label: cellLabel(`${i} ${f.actualTime.toFixed(3)}s`, String(i), i * width, 0, width, band) }));
    const layout = { coordinateSpace: 'artifact-pixels', width: width * 2, height: Math.max(...cells.map((c) => c.height)) + band, maxEdge: request.maxEdge, labelBandHeight: band, cells };
    const png = await composeGrid(captures, layout, { signal }), digest = pngDigest(png), file = join(dir, 'artifact-revision-comparison.png');
    const actual = pngSize(png); if (actual.width !== layout.width || actual.height !== layout.height) throw new ReviewError('前后对照图尺寸不符。');
    await writeFile(file, png, { flag: 'wx', mode: 0o600 });
    const published = await readReviewPNG(file, signal);
    if (!sameDigest(published, digest) || published.width !== layout.width || published.height !== layout.height) throw new ReviewError('组合后PNG已变化。', 409, 'stale');
    // 组合结束再次核原图片，不以读过一次的旧摘要掩盖并发改写。
    for (const [i, ref] of references.entries()) {
      await exactPNG(ref.reviewId, originals[i].frames[ref.frameIndex], join(directory(ref.reviewId), `frame-${ref.frameIndex}.png`), derivedFrom[i].sha256, 'missing-frame');
      if (JSON.stringify(await read(project, ref.reviewId)) !== JSON.stringify(originals[i])) throw new ReviewError('组合期间来源回执变化。', 409, 'stale');
    }
    const artifact = { artifactId: 'revision-comparison', kind: 'revision-comparison', timeBasis: 'composite-not-timed-frame', path: file, ...digest, mimeType: 'image/png', url: `/api/projects/${encodeURIComponent(project.id)}/reviews/${reviewId}/artifacts/revision-comparison`, width: layout.width, height: layout.height, derivedFrom, layout, presentation: { requestedTargetWidth: request.targetWidth ?? null, actualCommonWidth: width, policy: 'smallest-existing-frame-and-artifact-cap-no-upscale' }, differences: compareReviewFacts(...originals), limitations: ['0=before、1=after；两侧时点由调用者选择，仅数值相同不证明语义对齐。', '复用已有PNG，只缩小，不重新渲染、自动判优或修改任何源。'] };
    const receipt = { version: 4, reviewId, projectId: project.id, sourceKind: 'review-pair', filmRevision: null, createdAt: new Date().toISOString(), request, source: { kind: 'review-pair', before: references[0], after: references[1] }, frames: [], artifacts: [artifact], findings: [], coverage: [], totalFrameBytes: 0, totalImageBytes: digest.bytes, observation: 'generated-not-viewed', observationNote: '须按此artifact自身SHA实际Read后再作视觉判断。' };
    signal.throwIfAborted();
    await writeFile(join(dir, 'review.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    signal.throwIfAborted();
    return receipt;
  }

  async function generate(project, request, signal) {
    signal.throwIfAborted();
    const reviewId = newId(), dir = directory(reviewId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    // 仅本次独占创建成功后才进入清理区间，碰撞不能覆盖或删除原审片。
    try { await mkdir(dir, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') throw new ReviewError('审片 ID 已存在，请重新请求。', 409, 'review-id-collision'); throw error; }
    let result, source, filmRevision, sourceFacts = { status: 'unknown', reason: 'captured-facts-unavailable' }, cleanup = [];
    try {
      signal.throwIfAborted();
      if (request.source === 'review-pair') return await pair(project, request, reviewId, dir, signal);
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
        if (manifest?.reviewFacts && job.inputSnapshot.reviewFactsSha256 && reviewFactsDigest(manifest.reviewFacts) === job.inputSnapshot.reviewFactsSha256 && manifest.reviewFacts.filmSha256?.slice(0, 16) === filmRevision) sourceFacts = manifest.reviewFacts;
        source = { kind: 'export-job', jobId: job.id, jobStatus: 'done', output: { path: job.out, ...copied, digestOrigin: 'observed-at-review', exportCompletionDigest: null, outputTimeToFilmTime: job.inputSnapshot.outputTimeToFilmTime ?? null },
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
        sourceFacts = manifest.reviewFacts ?? reviewFacts(await readFile(join(frozen, 'film.html')));
        source = { kind: 'current-project', inputs: { filmRevision, ...snapshot, digestOrigin: 'review-static-local-snapshot', limitations: manifest.limitations },
          consistency: 'local-snapshot-with-live-before-after-checks', limitations: ['静态本地依赖沿既有 filmClosure 冻结。远端资源、未解析的动态依赖和浏览器/字体环境不属于这个摘要，不能宣称原子冻结整个运行环境。'] };
        result = await drawProject(frozen, dir, request, film.doc.stage, { signal });
        if (!sameDigest(snapshot, await localInputs(project.path, signal)) || (await readProjectFilm(project.path)).rev !== filmRevision) throw new ReviewError('工程在审片期间变化，请按当前版本重新审片。', 409, 'stale');
      }
      cleanup.push(...(result.decodedFiles ?? []), ...(result.sequenceFiles ?? []));
      const expectedCount = (request.times?.length ?? request.count ?? 0) + Number(Boolean(request.last));
      if (result.frames.length !== expectedCount) throw new ReviewError('实际审片帧数与请求不一致。');
      let total = 0;
      const frames = [], buffers = [], captures = [];
      for (const [index, item] of result.frames.entries()) {
        if (item.file !== join(dir, `frame-${index}.png`)) throw new ReviewError('审片图片路径与本次身份不符。');
        const captured = await readReviewPNG(item.file, signal);
        if (captured.sha256 !== item.captureSha256 || captured.bytes !== item.captureBytes) throw new ReviewError('捕获后的 PNG 字节变化，不能派生成功材料。', 409, 'stale');
        if (captured.width !== item.width || captured.height !== item.height || Math.max(item.width, item.height) > request.maxEdge) throw new ReviewError('审片 PNG 实际尺寸与回执不符。');
        const presentation = reviewPresentation(captured, request, { width: item.sourceWidth ?? item.width, height: item.sourceHeight ?? item.height });
        captures.push(captured);
        const png = await resizePNG(captured.data, presentation, { signal });
        const digest = pngDigest(png); total += digest.bytes;
        if (png !== captured.data) await rewriteReviewPNG(item.file, png, captured, signal);
        if (total > REVIEW_MAX_TOTAL_BYTES) throw new ReviewError('PNG 总计超过 12 MiB 审片预算。', 422, 'over-budget');
        const { file, captureSha256, captureBytes, sourceWidth, sourceHeight, ...meta } = item;
        frames.push({ index, ...meta, width: presentation.actualWidth, height: presentation.actualHeight, presentation, path: file, ...digest, mimeType: 'image/png', url: `/api/projects/${encodeURIComponent(project.id)}/reviews/${reviewId}/frames/${index}` });
        buffers.push(png);
      }
      const artifacts = [];
      if (request.firstLast) {
        const first = frames.find((frame) => frame.requestedTime === 0), last = frames.find((frame) => frame.requestedTime === 'last');
        if (!first || !last) throw new ReviewError('首尾组合图缺少同次真实首尾帧。');
        const layout = firstLastLayout(first, last, request.maxEdge);
        const png = await composePNG(buffers[first.index], buffers[last.index], layout, { signal });
        const digest = pngDigest(png); total += digest.bytes;
        if (total > REVIEW_MAX_TOTAL_BYTES) throw new ReviewError('PNG 与组合图总计超过 12 MiB 审片预算。', 422, 'over-budget');
        const file = join(dir, 'artifact-first-last.png');
        await writeFile(file, png, { flag: 'wx', mode: 0o600 });
        artifacts.push({ artifactId: 'first-last', kind: 'first-last-composite', timeBasis: 'composite-not-timed-frame', width: layout.width, height: layout.height,
          path: file, ...digest, mimeType: 'image/png', url: `/api/projects/${encodeURIComponent(project.id)}/reviews/${reviewId}/artifacts/first-last`,
          derivedFrom: [first, last].map((frame) => ({ frameIndex: frame.index, sha256: frame.sha256, bytes: frame.bytes, actualTime: frame.actualTime, actualPTS: frame.actualPTS,
            timeBasis: frame.timeBasis, ...(frame.actualPTSTicks !== undefined ? { actualPTSTicks: frame.actualPTSTicks, ptsTimeBase: frame.ptsTimeBase } : {}) })),
          layout: { ...layout, maxEdge: request.maxEdge }, limitations: ['只组合本次两个真实帧，不代表连续过程、音频或整体审美；透明补边不属于原画面。'] });
      }
      if (request.sequence || request.compareWidths) {
        let layout, images, derivedFrom, textProjections = [];
        const artifactId = request.sequence ? 'sequence' : 'size-comparison';
        if (request.sequence) {
          const samples = result.sequence?.frames;
          if (samples?.length !== request.sequence.count) throw new ReviewError('序列观察图数与请求不一致。');
          images = [];
          for (const [i, item] of samples.entries()) {
            if (item.file !== join(dir, `sequence-${i}.png`)) throw new ReviewError('序列图片路径与本次身份不符。');
            const capture = await readReviewPNG(item.file, signal);
            if (capture.sha256 !== item.captureSha256 || capture.bytes !== item.captureBytes || capture.width !== item.width || capture.height !== item.height || Math.max(capture.width, capture.height) > request.maxEdge) throw new ReviewError('序列捕获字节或尺寸变化。', 409, 'stale');
            images.push(capture.data);
          }
          layout = sequenceLayout(samples, request.maxEdge);
          derivedFrom = samples.map((s, i) => ({ sequenceIndex: i, ...(s.frameIndex !== undefined ? { sourceFrameIndex: s.frameIndex } : {}),
            requestedTime: s.requestedTime, actualTime: s.actualTime, actualPTS: s.actualPTS, timeBasis: s.timeBasis,
            ...(s.actualPTSTicks !== undefined ? { actualPTSTicks: s.actualPTSTicks, ptsTimeBase: s.ptsTimeBase } : {}), sha256: s.captureSha256, bytes: s.captureBytes }));
        } else {
          const index = request.compareFrame ?? 0, capture = captures[index], frame = frames[index];
          layout = comparisonLayout(capture, request.compareWidths, request.maxEdge);
          images = request.compareWidths.map(() => capture.data);
          derivedFrom = [{ frameIndex: index, actualTime: frame.actualTime, actualPTS: frame.actualPTS, timeBasis: frame.timeBasis,
            captureSha256: capture.sha256, captureBytes: capture.bytes, captureWidth: capture.width, captureHeight: capture.height,
            publishedFrameSha256: frame.sha256, publishedFrameBytes: frame.bytes, method: 'same-captured-buffer-before-target-resize' }];
          textProjections = (result.findings ?? []).filter((f) => f.code === 'dom-text-size' && f.time?.actualTime === frame.actualTime).map((f) => ({ selector: f.selector, text: f.measurement.text,
            source: f.source, actualTime: frame.actualTime, method: 'same-seek-axis-aligned-font-projection',
            sizes: layout.cells.map((cell) => ({ requestedWidth: cell.requestedWidth, actualWidth: cell.width,
              targetFontSizePx: f.measurement.targetFontSizePx == null || !['fontSizeCssPx', 'localScaleY', 'outerScaleY', 'stageWidthCssPx'].every((key) => Number.isFinite(f.measurement[key]) && f.measurement[key] > 0)
                ? null : f.measurement.fontSizeCssPx * f.measurement.localScaleY * f.measurement.outerScaleY * cell.width / f.measurement.stageWidthCssPx })) }));
        }
        const png = await composeGrid(images, layout, { signal });
        const digest = pngDigest(png); total += digest.bytes;
        if (total > REVIEW_MAX_TOTAL_BYTES) throw new ReviewError('PNG与观察组合图总计超过12MiB预算。', 422, 'over-budget');
        const file = join(dir, `artifact-${artifactId}.png`);
        await writeFile(file, png, { flag: 'wx', mode: 0o600 });
        artifacts.push({ artifactId, kind: request.sequence ? 'sequence-contact-sheet' : 'size-comparison', timeBasis: 'composite-not-timed-frame',
          width: layout.width, height: layout.height, path: file, ...digest, mimeType: 'image/png', url: `/api/projects/${encodeURIComponent(project.id)}/reviews/${reviewId}/artifacts/${artifactId}`,
          derivedFrom, layout: { ...layout, maxEdge: request.maxEdge }, ...(request.compareWidths ? { textProjections } : {}),
          limitations: ['独立标签带不是源画面；秒数标签舍入三位小数，完整时间/整数PTS和尺寸以layout.cells及derivedFrom为准。小格可能简化/省略标签，透明空白不是视频黑帧。', '离散总览或尺寸投影不证明连续播放、声音、逐字可读性或整体审美；encoded不附当前DOM。'] });
      }
      // 派生读取固定 buffer；发布前再核落盘结果，期间替换不能留下成功回执。
      for (const item of [...frames, ...artifacts]) {
        const final = await readReviewPNG(item.path, signal);
        if (!sameDigest(final, item) || final.width !== item.width || final.height !== item.height) throw new ReviewError('派生期间审片 PNG 变化。', 409, 'stale');
      }
      const bind = (entry) => ({ ...entry, source: { ...entry.source, reviewId, filmRevision,
        inputSha256: source.inputs?.files?.find((file) => file.path === entry.source?.page)?.sha256 ?? null } });
      const limitations = ['编码帧不能提供 DOM 字号、裁切选择器或复杂背景对比度事实；没有 finding 不表示通过。'];
      const findings = request.source === 'export-job' ? [{ code: 'dom-analysis', severity: 'info', status: 'unknown', time: null, source: { kind: 'export-job' }, selector: null, bounds: null, measurement: {}, evidence: [], limitations }] : result.findings ?? [];
      const coverage = request.source === 'export-job' ? [{ code: 'dom-analysis', status: 'unknown', time: null, source: { kind: 'export-job' }, details: { measured: false, reason: 'encoded-output-has-no-current-dom' }, limitations }] : result.coverage ?? [];
      const temporal = result.sequence ? { ...result.sequence.temporal, source: { kind: request.source, reviewId, filmRevision, ...(source.output ? { outputSha256: source.output.sha256 } : { inputSha256: source.inputs.sha256 }) } } : null;
      const receipt = { version: request.sequence || request.compareWidths ? 3 : 2, sourceFacts, reviewId, sourceKind: request.source, projectId: project.id, filmRevision, createdAt: new Date().toISOString(), request, source,
        duration: result.duration, durationOrigin: result.durationOrigin ?? 'project-duration', timeOrigin: result.timeOrigin ?? 'project-timeline', timeOriginPTS: result.timeOriginPTS ?? null, ...(result.timeOriginPTSTicks !== undefined ? { timeOriginPTSTicks: result.timeOriginPTSTicks } : {}), ...(result.encodedRange ? { encodedRange: result.encodedRange } : {}), lastFramePolicy: result.lastFramePolicy,
        frames, artifacts, ...(temporal ? { temporal } : {}), findings: findings.map(bind), coverage: coverage.map(bind), totalFrameBytes: frames.reduce((n, frame) => n + frame.bytes, 0), totalImageBytes: total,
        observation: 'generated-not-viewed', observationNote: '回执只证明生成和测量。导演应通过 Read(path, expected_sha256) 实际读取必要图片；图片进入请求不证明模型理解。DOM 与 PNG 是同一求帧采样窗口，不是像素与 DOM 原子快照。' };
      signal.throwIfAborted();
      await writeFile(join(dir, 'review.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      signal.throwIfAborted();
      return receipt;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      if (signal.aborted) throw stopped();
      if (error instanceof ReviewError) throw error;
      throw new ReviewError(error.message);
    } finally { for (const file of cleanup) await rm(file, { recursive: true, force: true }); }
  }
}
