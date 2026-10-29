/** 显式CLI本地副本：复用既有鉴权GET、PNG预算和Read，不修改原回执或目录授权。 */
import Ajv from 'ajv';
import { mkdir, realpath, lstat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { reviewCLIOptionsSchema } from '../packages/openfilm/studio/server/review-contract.mjs';
import { readReviewPNG } from '../packages/openfilm/studio/server/reviews.mjs';
import { REVIEW_MAX_FRAMES, REVIEW_MAX_FRAME_BYTES, REVIEW_MAX_TOTAL_BYTES } from '../packages/openfilm/src/review-frames.mjs';

const validate = new Ajv({ allErrors: true }).compile(reviewCLIOptionsSchema);
const captureFlags = ['source', 'job', 'times', 'count', 'last', 'max-edge', 'target-width', 'first-last', 'sequence-start', 'sequence-end', 'sequence-count', 'compare-widths', 'compare-frame', 'safe-top', 'safe-bottom', 'before-review', 'before-frame', 'after-review', 'after-frame'];
export function reviewLocalOptionsOf(values) {
  const options = { ...(values.read !== undefined ? { read: values.read } : {}), ...(values['copy-to'] !== undefined ? { copyTo: values['copy-to'] } : {}) };
  if (!validate(options)) throw new Error('本地审片选项无效；--read须为24位review ID，--copy-to须为明确目录。');
  if (options.read && captureFlags.some((key) => values[key] !== undefined)) throw new Error('--read读取已有材料，不能同时申请捕获或组合。');
  return options;
}

export async function reviewCopyRoot(path) {
  const root = await realpath(resolve(path));
  if (!(await lstat(root)).isDirectory()) throw new Error('--copy-to需要已存在的已授权目录。');
  return root;
}

export async function copyReviewImages(client, receipt, destination) {
  if (!/^[a-f0-9]{24}$/.test(receipt.reviewId) || receipt.projectId !== client.project.id || !Array.isArray(receipt.frames)) throw new Error('本地副本的review/项目身份不匹配。');
  const artifacts = receipt.artifacts ?? [];
  if (!Array.isArray(artifacts) || artifacts.length > 1 || receipt.frames.length > REVIEW_MAX_FRAMES) throw new Error('本地副本超出已有审片图数预算。');
  const images = [...receipt.frames.map((f, index) => ({ bytes: f.bytes, sha256: f.sha256, frameIndex: index, filename: `frame-${index}.png` })), ...artifacts.map((a) => {
    if (!['first-last', 'sequence', 'size-comparison', 'revision-comparison'].includes(a.artifactId)) throw new Error('不支持的审片制品身份。');
    return { bytes: a.bytes, sha256: a.sha256, artifactId: a.artifactId, filename: `artifact-${a.artifactId}.png` };
  })];
  if (!images.length || images.some((i) => !Number.isSafeInteger(i.bytes) || i.bytes < 1 || i.bytes > REVIEW_MAX_FRAME_BYTES || !/^[a-f0-9]{64}$/.test(i.sha256)) || images.reduce((sum, i) => sum + i.bytes, 0) > REVIEW_MAX_TOTAL_BYTES) throw new Error('本地副本超出已有PNG字节预算或摘要无效。');
  const directory = join(await reviewCopyRoot(destination), `review-${receipt.reviewId}`);
  await mkdir(directory, { mode: 0o700 }).catch((e) => { if (e.code !== 'EEXIST') throw e; });
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('本地review子目录身份冲突，不覆盖。');
  const copies = [];
  for (const image of images) {
    const file = join(directory, image.filename);
    const matches = async () => {
      let observed;
      try { observed = await readReviewPNG(file); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
      if (observed.bytes !== image.bytes || observed.sha256 !== image.sha256) throw new Error('已有本地PNG与回执不同，不覆盖；请选其他目录。');
      return true;
    };
    if (!(await matches())) {
      const data = await client.reviewImage(receipt.reviewId, image);
      try { await writeFile(file, data, { flag: 'wx', mode: 0o600 }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      if (!(await matches())) throw new Error('副本写入后已不可读；原review保留，请读取原ID恢复。');
    }
    copies.push({ path: file, bytes: image.bytes, sha256: image.sha256, source: { reviewId: receipt.reviewId, ...(image.artifactId ? { artifactId: image.artifactId } : { frameIndex: image.frameIndex }) } });
  }
  return { directory, images: copies, permissionGranted: false, originalReceiptModified: false };
}
