/** 本地场景原字节读取与明确新版本修订；影片仍只有 film.html 这一事实源。 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, extname, relative, sep } from 'node:path';
import { inside } from './files.mjs';
import { readProjectFilm, withProjectFilmSourceEdit } from './film.mjs';
import { motionManifestFromHtml } from './motion-manifest.mjs';
import { validateMotionInputs } from '../../src/motion.mjs';

export const SCENE_SOURCE_LIMITS = Object.freeze({ rawBytes: 4 * 1024 * 1024, contentBytes: 256 * 1024, inputBytes: 768 * 1024, receiptBytes: 480 * 1024, sharedReferences: 100 });
export const SCENE_INPUT_JSON_MAX_BYTES = SCENE_SOURCE_LIMITS.inputBytes;
const id = { type: 'string', minLength: 1, maxLength: 512, description: 'inspect 返回的真实稳定片段 ID。' };
const path = { type: 'string', minLength: 1, maxLength: 2048, description: '项目内本地 .html/.htm 路径，不带 URL query 或播放 fragment；不允许 .film、越界或影片自身。' };
export const SCENE_READ_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'urn:desirecore:video-creation:scene-read:v1',
  title: '场景原字节读取 v1', type: 'object', additionalProperties: false, required: ['clipId'],
  description: '同一个有界 Buffer 计算完整 SHA256/bytes 并以 fatal UTF-8 解码。前后核影片和源码，只是观察窗口，不是原子快照。全文超过回执预算时明确 textIncluded:false，绝不静默截断。',
  properties: { clipId: id },
};
export const SCENE_REVISE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'urn:desirecore:video-creation:scene-revise:v1',
  title: '场景新版本修订 v1', type: 'object', additionalProperties: false,
  required: ['base', 'sourcePath', 'expectedSourceSha256', 'clipIds', 'targetPath', 'content'],
  description: '严格影片 base 与调用者原源码 SHA256 双前置条件；完整新文件 no-replace 发布后仅切换明确选定的同源片段 src。发布前确认完整 changed 元数据可容纳于有限回执，超限明确拒绝。不是两文件事务或 OS CAS；客户端超时不证明撤销，先 fresh inspect。保留自主 HTML/SVG/Canvas/WebGL、人工锁及所有非 src 字段。',
  properties: {
    base: { type: 'string', pattern: '^[a-f0-9]{16}$', description: '最新 inspect/scene-read 的 filmRevision，必须严格相等，不自动 rebase。' },
    sourcePath: { ...path, description: 'scene-read 返回的 source.path；同一物理普通源文件，可明确选择其部分或全部共享实例。' },
    expectedSourceSha256: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'scene-read 对原始 Buffer 算出的完整小写 SHA256，不能拿 filmRevision 或旧字符串 motion digest 代替。' },
    clipIds: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: id, description: '明确且不重复的待切换实例；每个必须仍指向同一实际原源。未选实例保留。' },
    targetPath: { ...path, description: '明确新版本路径；不能别名原源或 film.html。现存同字节普通文件可 reuse，不覆盖不同字节或符号链接。父目录必须已存在。' },
    content: { type: 'string', maxLength: SCENE_SOURCE_LIMITS.contentBytes, description: '完整 UTF-8 新源码，实际 UTF-8 至多 256 KiB，完整 JSON 输入至多 768 KiB；不截断、不执行任意脚本。' },
  },
};
const LIMITATIONS = Object.freeze([
  'film.html 与场景文件不是两资源事务；同进程队列不排除外部写者，最后校验与 rename 间及父路径替换仍存在窗口。',
  '只静态校验可选 film-motion 与每个实例输入；未执行任意 JavaScript，不能证明新代码消费人工参数、DOM 选择器存在或画面语义相同。',
  '不删除已发布版本；失败或断联先 fresh inspect/scene-read，再决定是否重试，不承诺 exactly-once。',
]);
export function sceneSourceContract() {
  return { contractVersion: 1, read: SCENE_READ_SCHEMA, revise: SCENE_REVISE_SCHEMA, limits: SCENE_SOURCE_LIMITS, limitations: LIMITATIONS };
}
export class SceneSourceError extends Error {
  constructor(message, kind = 'invalid', recovery) {
    super(message); this.name = 'SceneSourceError'; this.kind = kind;
    this.status = kind === 'invalid' ? 422 : kind === 'unsupported' ? 503 : 409;
    if (recovery) this.recovery = recovery;
  }
}
/** 仅投影本领域有限错误，不透传任意 Error.details、源码或系统错误正文。 */
export function sceneSourceErrorReceipt(error) {
  if (!(error instanceof SceneSourceError)) return null;
  return projectSceneSourceErrorReceipt({ sceneSourceError: true, error: error.message.slice(0, 4096), kind: error.kind, ...(error.recovery ? { recovery: error.recovery } : {}) });
}
/** HTTP 反序列化后仍只承认声明的有限领域字段，不扩散通用 details。 */
export function projectSceneSourceErrorReceipt(body) {
  if (!body || body.sceneSourceError !== true || typeof body.error !== 'string' || body.error.length > 4096 || !['invalid', 'conflict', 'unsupported', 'recovery'].includes(body.kind)) return null;
  const result = { sceneSourceError: true, error: body.error, kind: body.kind };
  if (body.recovery !== undefined) {
    const r = body.recovery, p = r?.publication;
    if (!r || r.outcome !== 'published-film-state-requires-inspection' || r.action !== 'fresh-inspect-before-retry' || !p || typeof p.path !== 'string' || p.path.length > 2048 || !/^[a-f0-9]{64}$/.test(p.sha256 ?? '') || !Number.isInteger(p.bytes) || p.bytes < 0 || p.bytes > SCENE_SOURCE_LIMITS.contentBytes || !['created', 'reused'].includes(p.disposition) || !(r.filmRevision === null || typeof r.filmRevision === 'string' && /^[a-f0-9]{16}$/.test(r.filmRevision)) || typeof r.mappingsComplete !== 'boolean' || !Array.isArray(r.selectedMappings) || r.selectedMappings.length > 100 || r.selectedMappings.some((row) => !row || typeof row.clipId !== 'string' || row.clipId.length > 512 || !(row.src === null || typeof row.src === 'string' && row.src.length <= 2048))) return null;
    result.recovery = { outcome: r.outcome, publication: { path: p.path, sha256: p.sha256, bytes: p.bytes, disposition: p.disposition }, filmRevision: r.filmRevision, selectedMappings: r.selectedMappings.map(({ clipId, src }) => ({ clipId, src })), mappingsComplete: r.mappingsComplete, action: r.action };
  }
  return result;
}
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameStamp = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const clipRows = (film) => film.value.tracks.flatMap((track, trackIndex) => track.clips.map((clip) => ({ clip, trackIndex })));
const sourcePart = (src) => { const at = src.indexOf('#'); return { path: at < 0 ? src : src.slice(0, at), suffix: at < 0 ? '' : src.slice(at) }; };
function localPath(root, value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[?#\\\0]/.test(value) || !/\.html?$/i.test(value)) throw new SceneSourceError('场景必须使用项目内不带 query/fragment 的 .html/.htm 路径。');
  let absolute;
  try { absolute = inside(root, value); } catch { throw new SceneSourceError('场景路径不在项目允许范围内。'); }
  return { absolute, path: relative(root, absolute).split(sep).join('/') };
}
function checkBody(input, revise) {
  const schema = revise ? SCENE_REVISE_SCHEMA : SCENE_READ_SCHEMA;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !Object.hasOwn(schema.properties, key)) || schema.required.some((key) => !Object.hasOwn(input, key))) throw new SceneSourceError('场景请求缺少必需字段或包含未知字段。');
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(input)); } catch { throw new SceneSourceError('场景请求必须是可序列化 JSON。'); }
  if (bytes > SCENE_SOURCE_LIMITS.inputBytes) throw new SceneSourceError('场景 JSON 输入超过 768 KiB。');
  const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512;
  if (!revise) { if (!validId(input.clipId)) throw new SceneSourceError('scene-read 需要真实 clipId。'); return; }
  if (typeof input.base !== 'string' || typeof input.expectedSourceSha256 !== 'string' || !/^[a-f0-9]{16}$/.test(input.base) || !/^[a-f0-9]{64}$/.test(input.expectedSourceSha256)) throw new SceneSourceError('scene-revise 需要真实 base 与完整小写 expectedSourceSha256。');
  if (!Array.isArray(input.clipIds) || !input.clipIds.length || input.clipIds.length > 100 || input.clipIds.some((value) => !validId(value)) || new Set(input.clipIds).size !== input.clipIds.length) throw new SceneSourceError('clipIds 必须是 1–100 个不重复真实 ID。');
  if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > SCENE_SOURCE_LIMITS.contentBytes || Buffer.from(input.content).toString('utf8') !== input.content) throw new SceneSourceError('新源码必须是完整有效 UTF-8，且不超过 256 KiB。');
}
async function ordinary(root, value, maximum = SCENE_SOURCE_LIMITS.rawBytes) {
  const selected = localPath(root, value);
  let handle;
  try {
    const leaf = await fs.lstat(selected.absolute);
    if (!leaf.isFile() || leaf.isSymbolicLink()) throw new SceneSourceError('场景来源必须是普通本地文件，不能是符号链接。', 'conflict');
    handle = await fs.open(selected.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || !sameFile(leaf, before) || before.size > maximum) throw new SceneSourceError('场景来源已变化、不是普通文件或超过读取预算。', 'conflict');
    const buffer = Buffer.alloc(Math.min(maximum + 1, before.size + 1));
    let length = 0;
    while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat(), current = await fs.lstat(selected.absolute);
    if (length !== before.size || !sameStamp(before, after) || !sameStamp(after, current) || current.isSymbolicLink()) throw new SceneSourceError('场景在读取期间发生变更，请重读。', 'conflict');
    const raw = buffer.subarray(0, length);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); } catch { throw new SceneSourceError('场景不是有效 UTF-8，未返回替换字符或不完整正文。'); }
    return { ...selected, buffer: raw, text, bytes: raw.length, sha256: sha256(raw), stamp: after };
  } catch (error) {
    if (error instanceof SceneSourceError) throw error;
    throw new SceneSourceError('场景文件不存在、不可读或读取期间发生变更。', 'conflict');
  } finally { await handle?.close(); }
}
async function filmReady(root, base) {
  const film = await readProjectFilm(root);
  if (!film.value) throw new SceneSourceError('film.html 当前不可解析，请先修复影片。');
  if (base !== undefined && film.rev !== base) throw new SceneSourceError('film.html 已变更，请重读后决定修订。', 'conflict');
  return film;
}
async function assertSource(root, before) {
  const now = await ordinary(root, before.path);
  if (!sameFile(before.stamp, now.stamp) || before.sha256 !== now.sha256 || before.bytes !== now.bytes) throw new SceneSourceError('原场景在准备期间发生变更，请重新读取。', 'conflict');
  return now;
}
async function references(root, film, source) {
  const result = [];
  for (const { clip, trackIndex } of clipRows(film)) {
    let candidate;
    try { candidate = localPath(root, sourcePart(clip.src).path); } catch { continue; }
    try {
      const stamp = await fs.stat(candidate.absolute);
      if (sameFile(source.stamp, stamp)) result.push({ clipId: clip.id, src: clip.src, path: candidate.path, trackIndex });
    } catch { /* 不可读的其他来源不被冒称共享或不共享。 */ }
  }
  return result;
}
function sharedReceipt(rows, selected = []) {
  const chosen = new Set(selected);
  const projected = rows.filter((row) => row.clipId.length <= 512 && row.src.length <= 2048 && row.path.length <= 2048).slice(0, SCENE_SOURCE_LIMITS.sharedReferences).map((row) => ({ ...row, selected: chosen.has(row.clipId) }));
  return { total: rows.length, selectedTotal: rows.filter((row) => chosen.has(row.clipId)).length, references: projected, complete: projected.length === rows.length, scope: 'known-current-film-physical-file-references' };
}
function boundedRead(receipt, text) {
  receipt.source.textIncluded = true; receipt.source.text = text;
  if (Buffer.byteLength(JSON.stringify(receipt)) > SCENE_SOURCE_LIMITS.receiptBytes) { delete receipt.source.text; receipt.source.textIncluded = false; receipt.source.omissionReason = 'complete-source-exceeds-receipt-budget'; }
  while (Buffer.byteLength(JSON.stringify(receipt)) > SCENE_SOURCE_LIMITS.receiptBytes && receipt.shared.references.length) { receipt.shared.references.pop(); receipt.shared.complete = false; }
  if (Buffer.byteLength(JSON.stringify(receipt)) > SCENE_SOURCE_LIMITS.receiptBytes) throw new SceneSourceError('场景元数据超过有限回执预算。');
  return receipt;
}
function boundedShared(shared, maximum = 96 * 1024) {
  while (Buffer.byteLength(JSON.stringify(shared)) > maximum && shared.references.length) { shared.references.pop(); shared.complete = false; }
  return shared;
}
export async function readSceneSource(root, input) {
  checkBody(input, false);
  const film = await filmReady(root);
  const clip = clipRows(film).find((row) => row.clip.id === input.clipId)?.clip;
  if (!clip) throw new SceneSourceError('找不到此真实影片片段。', 'conflict');
  const source = await ordinary(root, sourcePart(clip.src).path);
  const filmStamp = await fs.stat(inside(root, 'film.html'));
  if (sameFile(source.stamp, filmStamp)) throw new SceneSourceError('场景不能别名 film.html。');
  const shared = await references(root, film, source);
  await assertSource(root, source);
  await filmReady(root, film.rev);
  return boundedRead({ contractVersion: 1, filmRevision: film.rev, clipId: clip.id, src: clip.src, source: { path: source.path, sha256: source.sha256, bytes: source.bytes, encoding: 'utf-8' }, shared: sharedReceipt(shared), limitations: LIMITATIONS }, source.text);
}

/** 先私有完整落盘，再以 link no-replace 发布；不支持时绝不回退覆盖 rename。 */
async function publish(root, target, content, source, filmStamp) {
  const expected = sha256(content);
  const parent = await fs.realpath(dirname(target.absolute));
  const parentStamp = await fs.lstat(parent);
  if (!parentStamp.isDirectory()) throw new SceneSourceError('新版本父路径不是已有普通目录。');
  const reuse = async () => {
    const current = await ordinary(root, target.path, SCENE_SOURCE_LIMITS.contentBytes);
    if (sameFile(current.stamp, source.stamp) || sameFile(current.stamp, filmStamp)) throw new SceneSourceError('新版本路径不能别名原源或 film.html。', 'conflict');
    if (current.sha256 !== expected || !current.buffer.equals(content)) throw new SceneSourceError('目标已有不同内容，已保留原文件。', 'conflict');
    return { path: target.path, sha256: expected, bytes: content.length, disposition: 'reused', stamp: current.stamp };
  };
  try { await fs.lstat(target.absolute); return await reuse(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${target.absolute}.scene-${randomUUID()}.tmp`;
  let handle, ownedStamp, publicationFact;
  try {
    handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
    ownedStamp = await handle.stat();
    await handle.writeFile(content); await handle.sync();
    const stamp = await handle.stat();
    // writeFile 已移动当前位置；显式位置重读同一私有 inode，核完整内容后才发布。
    const buffer = Buffer.alloc(content.length + 1); let length = 0;
    while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    if (stamp.size !== content.length || length !== content.length || sha256(buffer.subarray(0, length)) !== expected || !sameStamp(stamp, await handle.stat()) || !sameStamp(stamp, await fs.lstat(temporary))) throw new SceneSourceError('新版本私有文件未完整写入或已变化。', 'conflict');
    if ((await fs.realpath(dirname(target.absolute))) !== parent || !sameFile(parentStamp, await fs.lstat(parent)) || inside(root, target.path) !== target.absolute) throw new SceneSourceError('新版本父路径在准备期间发生变更。', 'conflict');
    try { await fs.link(temporary, target.absolute); publicationFact = { path: target.path, sha256: expected, bytes: content.length, disposition: 'created', stamp }; }
    catch (error) {
      if (error.code === 'EEXIST') { publicationFact = await reuse(); return publicationFact; }
      if (['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(error.code)) throw new SceneSourceError('文件系统不支持完整 no-replace 发布，未退回覆盖写入。', 'unsupported');
      throw error;
    }
    const published = await ordinary(root, target.path, SCENE_SOURCE_LIMITS.contentBytes);
    if (!sameFile(stamp, published.stamp) || published.sha256 !== expected || !published.buffer.equals(content)) throw new SceneSourceError('发布路径在核验期间发生变更，已保留供检查。', 'conflict');
    return publicationFact;
  } catch (error) {
    if (publicationFact) error.publication = publicationFact;
    throw error;
  } finally {
    // 只清理由此请求随机创建的私有 temp；发布路径永不按推测归属删除。
    try {
      if (ownedStamp) {
        const current = await fs.lstat(temporary).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (current && !sameFile(ownedStamp, current)) throw new Error('private temporary identity changed');
        if (current) await fs.unlink(temporary);
      }
    } catch {
      const failure = new SceneSourceError('私有临时文件已变化或清理失败；现存路径保留供检查。', 'conflict');
      if (publicationFact) failure.publication = publicationFact;
      throw failure;
    } finally {
      try { await handle?.close(); }
      catch {
        const failure = new SceneSourceError('私有句柄关闭失败；已发布路径保留供检查。', 'conflict');
        if (publicationFact) failure.publication = publicationFact;
        throw failure;
      }
    }
  }
}
function publicPublication(value) { const { stamp: _stamp, ...publicValue } = value; return publicValue; }
async function recovery(root, input, publication) {
  let filmRevision = null, mappings = [], complete = false;
  try {
    const film = await readProjectFilm(root); filmRevision = film.rev;
    if (film.value) {
      mappings = clipRows(film).filter(({ clip }) => input.clipIds.includes(clip.id)).map(({ clip }) => ({ clipId: clip.id, src: clip.src.length <= 2048 ? clip.src : null }));
      complete = mappings.length === input.clipIds.length && mappings.every((row) => row.src !== null);
      while (Buffer.byteLength(JSON.stringify(mappings)) > 128 * 1024 && mappings.length) { mappings.pop(); complete = false; }
    }
  } catch { /* 回执不把不可观测状态伪造为未写入。 */ }
  return { outcome: 'published-film-state-requires-inspection', publication: publicPublication(publication), filmRevision, selectedMappings: mappings, mappingsComplete: complete, action: 'fresh-inspect-before-retry' };
}
export async function reviseSceneSource(root, input) {
  checkBody(input, true);
  const sourcePath = localPath(root, input.sourcePath), target = localPath(root, input.targetPath);
  const content = Buffer.from(input.content, 'utf8');
  if (sourcePath.absolute === target.absolute) throw new SceneSourceError('新版本路径必须不同于原场景。', 'conflict');
  let publication, original, sharedBefore, manifest, changed, verifySources, shared;
  try {
    const edited = await withProjectFilmSourceEdit(root, input.base, async (film) => {
      original = await ordinary(root, sourcePath.path);
      if (original.sha256 !== input.expectedSourceSha256) throw new SceneSourceError('原源码 SHA256 已变更，filmRevision 相同也不能覆盖。', 'conflict');
      const filmStamp = await fs.stat(inside(root, 'film.html'));
      if (sameFile(original.stamp, filmStamp)) throw new SceneSourceError('原场景不能别名 film.html。');
      const selected = input.clipIds.map((clipId) => clipRows(film).find((row) => row.clip.id === clipId)?.clip);
      if (selected.some((clip) => !clip)) throw new SceneSourceError('选定片段已不存在，请重读。', 'conflict');
      for (const clip of selected) {
        const actual = await ordinary(root, sourcePart(clip.src).path);
        if (!sameFile(actual.stamp, original.stamp) || actual.sha256 !== original.sha256) throw new SceneSourceError('clipIds 并非全部仍指向同一实际原源。', 'conflict');
      }
      try { manifest = motionManifestFromHtml(input.content); } catch (error) { throw new SceneSourceError(error.message); }
      for (const clip of selected) {
        const problems = validateMotionInputs(manifest, clip.motion);
        if (problems.length) throw new SceneSourceError(`${clip.id}: ${problems.join('\n')}`);
      }
      sharedBefore = await references(root, film, original);
      changed = selected.map((clip) => ({ clipId: clip.id, before: clip.src, after: `${target.path}${sourcePart(clip.src).suffix}` }));
      shared = boundedShared(sharedReceipt(sharedBefore, input.clipIds));
      if (Buffer.byteLength(JSON.stringify({ changed, shared })) > 256 * 1024) throw new SceneSourceError('完整 changed 元数据超过有限回执预算；未发布新版本，请减少本次明确选择的实例。');
      await assertSource(root, original); await filmReady(root, input.base);
      publication = await publish(root, target, content, original, filmStamp);
      verifySources = async () => {
        await assertSource(root, original);
        const next = await ordinary(root, target.path, SCENE_SOURCE_LIMITS.contentBytes);
        if (!sameFile(next.stamp, publication.stamp) || next.sha256 !== publication.sha256 || next.bytes !== publication.bytes) throw new SceneSourceError('新版本在提交前发生变更，已保留路径供检查。', 'conflict');
      };
      const verify = async () => { await verifySources(); await filmReady(root, input.base); };
      await verify();
      return { ops: changed.map((row) => ({ op: 'set', clip: row.clipId, field: 'src', value: row.after })), verify, verifyCommitted: async (written) => { await verifySources(); await filmReady(root, written.rev); } };
    });
    const receipt = { contractVersion: 1, outcome: 'completed', beforeFilmRevision: input.base, filmRevision: edited.rev, source: { path: original.path, sha256: original.sha256, bytes: original.bytes }, publication: publicPublication(publication), changed, shared, compatibility: { manifest: manifest ? 'validated-each-selected-instance' : 'not-declared-free-scene', dynamicSemantics: 'unknown', domTargets: 'unknown', nonSrcFields: 'preserved' }, limitations: LIMITATIONS };
    if (Buffer.byteLength(JSON.stringify(receipt)) > SCENE_SOURCE_LIMITS.receiptBytes) throw new SceneSourceError('修订已提交，但有限回执需要重新检查。', 'recovery');
    return receipt;
  } catch (error) {
    publication ??= error.publication;
    if (publication) throw new SceneSourceError('新版本已发布并保留；影片切换未取得完整成功回执，请先检查当前状态。', 'recovery', await recovery(root, input, publication));
    if (error instanceof SceneSourceError) throw error;
    if (error.kind === 'conflict' || error.kind === 'invalid') throw new SceneSourceError(error.message, error.kind);
    throw new SceneSourceError('场景修订准备失败，未取得发布成功事实。', 'conflict');
  }
}
