// @ts-check
/** 显式选句观察才流式读取媒体内容；只复用现有快照预算和前后文件fence，不持久化缓存。 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import { exportRuntimeSchema } from './export-snapshot.mjs';
import { inProject } from './files.mjs';
import { HttpError } from './http.mjs';

export const captionMediaObservationRequestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false,
  description: 'captions的显式媒体内容观察；默认不读取大媒体SHA。音频选句应使用该同次响应的filmRevision、cue/sourceRevision及对应mediaSnapshots原值。',
  properties: { withMediaDigests: { type: 'boolean', default: false, description: 'true才按distinct可听src流式计算SHA/bytes并核影片、字幕及媒体前后未变；有界且不生成音频、不转码。' } },
};
export const captionMediaSnapshotSchema = {
  type: 'object', additionalProperties: false, required: ['bytes', 'sha256'],
  description: '选句观察时实际媒体字节身份，不是VTT版本或mtime；原值随音频请求保存，冻结manifest和retry复核。',
  properties: {
    bytes: { type: 'integer', minimum: 1, maximum: exportRuntimeSchema.properties.snapshotMaxBytes.default, description: '同次实际流式读到的媒体字节数。' },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$', description: '上述完整媒体字节的SHA-256，不在提交时重新读取最新版代替。' },
  },
};
/** @typedef {{ bytes: number, sha256: string }} CaptionMediaSnapshot */
const stamp = (/** @type {import('node:fs').BigIntStats} */ s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const changed = () => new HttpError(409, '媒体在字幕观察期间改变，请重新读取同次字幕与媒体摘要。', { code: 'caption-media-changed' });

/** @param {string} root @param {string} src */
export function captionMediaFile(root, src) {
  const file = inProject(root, src);
  if (!file) throw new HttpError(422, '原声窗需要项目内可读的本地媒体。', { code: 'caption-media-unavailable' });
  return { file, path: relative(root, file).split(sep).join('/') };
}

/** @param {string} root @param {readonly string[]} sources */
export async function observeCaptionMedia(root, sources) {
  const distinct = [...new Set(sources)];
  if (distinct.length > exportRuntimeSchema.properties.snapshotMaxFiles.default)
    throw new HttpError(413, '字幕媒体摘要文件数超过既有快照预算。', { code: 'caption-media-over-budget' });
  /** @type {{src: string, snapshot: CaptionMediaSnapshot}[]} */
  const snapshots = [];
  /** @type {{file: string, stamp: string}[]} */
  const observed = [];
  let total = 0;
  for (const src of distinct) {
    const { file } = captionMediaFile(root, src);
    const before = await stat(file, { bigint: true }).catch(() => null);
    if (!before?.isFile() || before.size < 1n) throw new HttpError(422, '字幕媒体不是可读的非空本地文件。', { code: 'caption-media-unavailable' });
    const size = Number(before.size);
    total += size;
    if (!Number.isSafeInteger(total) || total > exportRuntimeSchema.properties.snapshotMaxBytes.default)
      throw new HttpError(413, '字幕媒体摘要超出既有快照字节预算；可明确选择已准备的工作媒体后重试。', { code: 'caption-media-over-budget' });
    const digest = createHash('sha256'); let bytes = 0;
    try { for await (const chunk of createReadStream(file)) { bytes += chunk.length; if (bytes > size) throw changed(); digest.update(chunk); } }
    catch { throw changed(); }
    const after = await stat(file, { bigint: true }).catch(() => null);
    if (bytes !== size || !after || stamp(after) !== stamp(before)) throw changed();
    snapshots.push({ src, snapshot: { bytes, sha256: digest.digest('hex') } });
    observed.push({ file, stamp: stamp(before) });
  }
  return { snapshots, async verify() {
    for (const row of observed) {
      const now = await stat(row.file, { bigint: true }).catch(() => null);
      if (!now || stamp(now) !== row.stamp) throw changed();
    }
  } };
}
