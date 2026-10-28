// @ts-check
/** 文稿只选择声画区间；复用同源时间线计划器和既有 edit/撤销，不写第二份工程。 */
import Ajv from 'ajv';
import { clipSpan, kindOf } from '../../src/film-doc.mjs';
import { readProjectFilm, EditError } from './film.mjs';
import { filmCaptions } from './captions.mjs';
import { readSourceSnapshot, sourceSnapshotRevision } from './subtitle-edits.mjs';
import { probe } from './derived.mjs';
import { timelineOpsSchema } from './op-schema.mjs';

const revision = { type: 'string', pattern: '^[a-f0-9]{16}$', description: '所见影片的真实 revision；不把旧剪辑提案重放到新影片。' };
const sourceRevision = { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'GET captions 所见完整源字幕集合的 sourceRevision，不是影片 revision。' };
const cue = { type: 'object', additionalProperties: false, required: ['line'], description: '原语言实际字幕行标识，来自 captions 的 line/part，不是列表数组位置。', properties: {
  line: { type: 'integer', minimum: 0, description: '字幕原行的源媒体起始毫秒。' }, part: { type: 'integer', minimum: 0, description: '该原行的分句编号，省略等于0。' },
} };
export const speechCutPreconditionsSchema = {
  type: 'object', additionalProperties: false, required: ['strictBase', 'subtitles'],
  description: '提交前在既有影片写入队列内同时核影片和字幕版本，外部文件写入仍是乐观检测，不承诺OS事务。',
  properties: {
    strictBase: { const: true, description: '必须严格匹配提案 base，禁止字段级自动重放。' },
    subtitles: { type: 'array', minItems: 1, maxItems: 64, description: '该提案实际读取的源字幕版本。', items: {
      type: 'object', additionalProperties: false, required: ['src', 'revision'], properties: {
        src: { type: 'string', minLength: 1, maxLength: 2048, description: '项目内媒体来源，不是VTT文件本身。' }, revision: sourceRevision,
      },
    } },
  },
};
export const speechCutRequestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'urn:desirecore:video-creation:speech-cut:v1',
  title: '文稿精剪区间提案', type: 'object', additionalProperties: false,
  description: '按所见原语言连续字幕选择一个声画删除区间，只生成既有时间线ops；不修改字幕原文，不自动判断该不该删。先预听气口再提交。',
  required: ['base', 'clip', 'sourceRevision', 'first', 'last'], properties: {
    base: revision, clip: { type: 'string', minLength: 1, maxLength: 512, description: '字幕所属的真实片段ID；首末句必须在同一个片段。' }, sourceRevision,
    first: cue, last: cue,
    adjust: { type: 'object', additionalProperties: false, required: ['startMs', 'endMs'], description: '对候选成片区间的有符号边界微调；负数向前、正数向后，须预听，不能越出该片段。', properties: {
      startMs: { type: 'integer', minimum: -10000, maximum: 10000, description: '删除入点的成片毫秒微调，默认0。' },
      endMs: { type: 'integer', minimum: -10000, maximum: 10000, description: '删除出点的成片毫秒微调，默认0。' },
    } },
    follow: { type: 'object', additionalProperties: false, required: ['sync'], description: '复用时间线同步锁/联动规则；目标及其关联声轨锁定时拒绝。', properties: {
      sync: { type: 'boolean', description: '默认true，同时切去未锁轨道的该区间并同步闭合。' },
      linkage: { type: 'boolean', description: 'sync为false时按已有主轨联动规则携带其附属片段。' },
    } },
  },
};
export const speechCutApplySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'urn:desirecore:video-creation:speech-cut-apply:v1',
  title: '提交已预览的文稿精剪', type: 'object', additionalProperties: false, required: ['base', 'ops', 'preconditions'],
  description: '提交提案中的原base/ops/双版本前置条件到既有edit。不能重取新base后盲目复用旧ops；失败保留原提案供重读。',
  properties: { base: revision, ops: timelineOpsSchema, preconditions: speechCutPreconditionsSchema },
};
export const speechCutContract = () => ({ contractVersion: 1, requestSchema: speechCutRequestSchema, applySchema: speechCutApplySchema });
const validate = new Ajv({ allErrors: true }).compile(speechCutRequestSchema);
const invalid = (/** @type {string} */ message) => new EditError(message, 'invalid');
const conflict = (/** @type {string} */ message) => new EditError(message, 'conflict');

/**
 * @param {string} root @param {import('./speech-cut-types.mjs').SpeechCutRequest} ask
 * @param {{ duration?: (src: string) => Promise<number | undefined> }} [options]
 * @returns {Promise<import('./speech-cut-types.mjs').SpeechCutPlan>}
 */
export async function planSpeechCut(root, ask, options = {}) {
  if (!validate(ask)) throw invalid(`文稿精剪参数无效：${new Ajv().errorsText(validate.errors)}`);
  const current = await readProjectFilm(root);
  if (!current.doc) throw invalid(current.problems.join('\n') || '影片不可读取。');
  if (current.rev !== ask.base) throw conflict('影片已改变，请重读影片和文稿后重新选择。');
  const doc = current.doc;
  const target = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === ask.clip);
  if (!target || !['video', 'sound'].includes(kindOf(target) ?? '')) throw invalid('文稿精剪需要可发声的媒体片段。');
  const duration = options.duration ?? ((/** @type {string} */ src) => probe(root, src).then((p) => p.duration));
  const captions = await filmCaptions(root, { duration });
  const cues = captions.cues.filter((c) => c.clip === ask.clip && c.src === target.src).sort((a, b) => a.startMs - b.startMs);
  const indexOf = (/** @type {{line:number,part?:number}} */ key) => cues.findIndex((c) => c.line === key.line && (c.part ?? 0) === (key.part ?? 0));
  const first = indexOf(ask.first), last = indexOf(ask.last);
  if (first < 0 || last < first) throw invalid('首末句必须是同一片段中按时间排列的实际原语言字幕。');
  const selected = cues.slice(first, last + 1);
  if (selected.some((c) => c.sourceRevision !== ask.sourceRevision)) throw conflict('字幕已改变，请重读原文后重新选择。');
  const sourceNow = () => readSourceSnapshot(root, target.src).then(sourceSnapshotRevision);
  if (await sourceNow() !== ask.sourceRevision) throw conflict('字幕已改变，请重读原文后重新选择。');
  const head = selected[0], tail = selected.at(-1);
  if (!head || !tail) throw invalid('所选文稿没有实际字幕。');
  const startMs = head.startMs + (ask.adjust?.startMs ?? 0);
  const endMs = tail.startMs + tail.durMs + (ask.adjust?.endMs ?? 0);
  /** @type {import('./speech-cut-types.mjs').TimelineEditTrack[]} */
  const model = [];
  /** @type {Map<string, ReturnType<typeof clipSpan>>} */
  const spans = new Map();
  for (const [index, track] of doc.tracks.entries()) {
    /** @type {import('./speech-cut-types.mjs').TimelineEditTrack} */
    const row = { index, locked: track.locked, role: /** @type {'video'|'audio'} */ (track.clips.every((c) => kindOf(c) === 'sound') ? 'audio' : 'video'), clips: [] };
    for (const clip of track.clips) {
      const native = clip.time?.length === 2 ? undefined : await duration(clip.src).catch(() => undefined);
      let span;
      try { span = clipSpan(clip, native, clip.id); } catch { throw invalid(`片段${clip.id}的长度不可确定，请先确认其媒体长度或明确区间。`); }
      spans.set(clip.id, span);
      const at = (clip.at ?? 0) * 1000;
      row.clips.push({ id: clip.id, startMs: at, endMs: at + span.length * 1000, inMs: span.from * 1000, speed: span.speed,
        sourceMs: native == null ? Infinity : native * 1000, ...(kindOf(clip) === 'still' ? { still: true } : {}), ...(clip.attrs?.['data-link'] ? { link: clip.attrs['data-link'] } : {}) });
    }
    model.push(row);
  }
  // 发布材料只含dist；此构建产物与界面直接使用的纯TS计划器同源，不引入React运行时。
  const { planCutRange } = await import('../ui/dist/timeline-plan.mjs');
  const planned = planCutRange(model, ask.clip, startMs, endMs, ask.follow ?? { sync: true });
  if (!planned || !planned.ops.length) throw invalid('该区间不能精剪：检查范围、最小片长以及目标/关联轨道是否锁定。');
  const affected = [...planned.placed.keys()];
  for (const clip of doc.tracks.flatMap((t) => t.clips)) {
    if (affected.includes(clip.id) && (clip.overrides?.some((o) => o.lock) || clip.motion?.locked?.length))
      throw invalid(`片段${clip.id}包含人工锁，不能通过文稿精剪移动、裁切或删除它。`);
  }
  if ((await readProjectFilm(root)).rev !== ask.base || await sourceNow() !== ask.sourceRevision) throw conflict('预览期间影片或字幕已改变，请重新选择。');
  const targetSpan = spans.get(target.id);
  if (!targetSpan) throw invalid('目标片段的源时间不可确定。');
  const sourceAt = (/** @type {number} */ filmMs) => targetSpan.from * 1000 + (filmMs - (target.at ?? 0) * 1000) * targetSpan.speed;
  return {
    base: ask.base, clip: ask.clip, text: selected.map((c) => c.text).join(' '), source: { src: target.src, revision: ask.sourceRevision },
    range: { sourceStartMs: sourceAt(startMs), sourceEndMs: sourceAt(endMs), filmStartMs: startMs, filmEndMs: endMs },
    timing: [...new Set(selected.map((c) => c.timing ?? 'unknown'))], affected, ops: planned.ops, shortMs: planned.shortMs,
    preconditions: { strictBase: true, subtitles: [{ src: target.src, revision: ask.sourceRevision }] },
  };
}
