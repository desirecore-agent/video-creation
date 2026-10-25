/** 作品已有data属性中的可选审片意图；只读事实与摘要，不改变排版或再建一套锁。 */
import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import { readFilmFile } from '../../src/film-doc.mjs';

export const REVIEW_INTENT_ATTRIBUTE = 'data-review-intent';
export const reviewIntentSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false,
  description: '可选至多32KiB的JSON，存于片段attrs.data-review-intent。描述观看用途，不命令自动排版、不覆盖现有人工锁。',
  properties: {
    targetWidths: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'integer', minimum: 64, maximum: 4096 }, description: '希望观察的交付宽度；不保证响应式重排，也不是最低字号标准。' },
    text: { type: 'array', maxItems: 64, description: '作者或导演明确标注的信息角色；省略的文字不自动推断角色。', items: {
      type: 'object', additionalProperties: false, required: ['role', 'description'], properties: {
        role: { enum: ['essential', 'supporting', 'decorative'], description: '必要信息、辅助信息或装饰；取舍由导演依用途判断。' },
        selector: { type: 'string', minLength: 1, maxLength: 512, description: '可选的场景内CSS选择器；Canvas/WebGL或纯语义说明可以省略。未匹配不冒称已测量。' },
        description: { type: 'string', minLength: 1, maxLength: 1000, description: '这项信息需要传达什么，不是平台固定的业务路线。' },
      },
    } },
    note: { type: 'string', maxLength: 2000, description: '可选布局/阅读用途说明；原params、overrides及locks仍是各自事实源。' },
  },
};
const ajv = new Ajv({ allErrors: true });
const validIntent = ajv.compile(reviewIntentSchema);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const dataHash = (value) => hash(JSON.stringify(canonical(value ?? null)));

export const reviewFactsDigest = (value) => value ? dataHash(value) : null;

/** 只记录普通整片/线性选区的已知关系；单片段等其他出口不猜工程时间。 */
export function exportReviewMapping(ask, filmRevision) {
  if (ask.kind !== 'video' || ask.clip || !/^[a-f0-9]{16}$/.test(filmRevision)) return null;
  if (ask.range && (!Array.isArray(ask.range) || ask.range.length !== 2 || !ask.range.every(Number.isFinite) || ask.range[0] < 0 || ask.range[1] <= ask.range[0])) return null;
  return { version: 1, kind: 'linear-film-time', start: ask.range?.[0] ?? 0, rate: 1, filmRevision };
}

/** 同一冻结film字节提取有界意图和人工相关字段摘要；旧作品未标注可正常读。 */
export function reviewFacts(source) {
  try { return extractReviewFacts(source); }
  catch { return { status: 'unknown', reason: 'film-facts-unavailable' }; }
}

function extractReviewFacts(source) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  if (bytes.length > 4 * 1024 * 1024) return { status: 'unknown', reason: 'film-facts-budget' };
  const parsed = readFilmFile(bytes.toString('utf8'));
  if (!parsed.doc || parsed.problems.length) return { status: 'unknown', reason: 'film-parse' };
  const clips = [], tracks = [], intents = [];
  for (const [index, track] of parsed.doc.tracks.entries()) {
    tracks.push({ index, flagsSha256: dataHash({ locked: !!track.locked, hidden: !!track.hidden, muted: !!track.muted }) });
    for (const clip of track.clips) {
      if (clips.length >= 1000) return { status: 'unknown', reason: 'film-facts-clip-budget' };
      const { src, motion, overrides, attrs, ...other } = clip;
      const { params, locks, ...motionRest } = motion ?? {};
      const visualFieldsSha256 = dataHash({ ...other, motion: motionRest, attrs: Object.fromEntries(Object.entries(attrs ?? {}).filter(([key]) => key !== REVIEW_INTENT_ATTRIBUTE)) });
      clips.push({ id: clip.id, sourcePath: clip.src, visualFieldsSha256, paramsSha256: dataHash(clip.motion?.params), locksSha256: dataHash(clip.motion?.locks), overridesSha256: dataHash(clip.overrides) });
      const raw = clip.attrs?.[REVIEW_INTENT_ATTRIBUTE];
      if (raw === undefined) continue;
      let value;
      try {
        if (Buffer.byteLength(raw) > 32 * 1024) throw new Error('intent-budget');
        value = JSON.parse(raw);
      } catch { intents.push({ clipId: clip.id, status: 'invalid', reason: 'intent-json-or-budget' }); continue; }
      if (!validIntent(value)) { intents.push({ clipId: clip.id, status: 'invalid', reason: ajv.errorsText(validIntent.errors) }); continue; }
      intents.push({ clipId: clip.id, status: 'observed', value });
    }
  }
  const facts = { version: 1, status: 'observed', filmSha256: hash(bytes), intents, clips, tracks,
    limitations: ['字段摘要只说明数据是否相同，不能证明修改者身份或任意新代码仍消费参数/选择器。', '未标注意图不等于可省略，角色也不改变现有人工锁。'] };
  return Buffer.byteLength(JSON.stringify(facts)) <= 256 * 1024 ? facts : { status: 'unknown', reason: 'film-facts-receipt-budget' };
}

/** 对两个已捕获材料做可证明的差异，不从live工程补造旧版本。 */
export function compareReviewFacts(before, after) {
  const inputs = (r) => r.source?.inputs?.files;
  const a = inputs(before), b = inputs(after);
  let files = { status: 'unknown', reason: 'input-digests-unavailable' };
  if (Array.isArray(a) && Array.isArray(b) && [...a, ...b].every((f) => typeof f.path === 'string' && /^[a-f0-9]{64}$/.test(f.sha256))) {
    const left = new Map(a.map((f) => [f.path, f.sha256])), right = new Map(b.map((f) => [f.path, f.sha256]));
    const changes = [];
    for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      if (left.get(path) !== right.get(path)) changes.push({ path, kind: !left.has(path) ? 'input-added' : !right.has(path) ? 'input-removed' : 'input-changed', beforeSha256: left.get(path) ?? null, afterSha256: right.get(path) ?? null });
    }
    files = { status: 'observed', changes: changes.slice(0, 100), totalChanges: changes.length, detailsComplete: changes.length <= 100 };
  }
  const first = before.sourceFacts, last = after.sourceFacts;
  let preservedData = { status: 'unknown', reason: 'captured-facts-unavailable' };
  if (first?.version === 1 && last?.version === 1 && first.status === 'observed' && last.status === 'observed' && first.filmSha256?.slice(0, 16) === before.filmRevision && last.filmSha256?.slice(0, 16) === after.filmRevision && [first.clips, last.clips, first.tracks, last.tracks].every(Array.isArray)) {
    const fields = (f) => new Map([...f.clips.flatMap((c) => ['sourcePath', 'paramsSha256', 'locksSha256', 'overridesSha256', 'visualFieldsSha256'].map((key) => [`clip:${c.id}:${key}`, c[key]])), ...f.tracks.map((t) => [`track:${t.index}:flags`, t.flagsSha256])]);
    const left = fields(first), right = fields(last), changes = [];
    for (const field of [...new Set([...left.keys(), ...right.keys()])].sort()) if (left.get(field) !== right.get(field)) changes.push({ field, before: left.get(field) ?? null, after: right.get(field) ?? null });
    preservedData = { status: 'observed', changes: changes.slice(0, 100), totalChanges: changes.length, detailsComplete: changes.length <= 100 };
  }
  return { files, preservedData, limitations: ['输入集合移出不表示原文件被删除；没有对源文件做写入。', '字段相同不是视觉效果等价证明，像素不同也不是质量提升；两边实际时点与版本独立报告。'] };
}
