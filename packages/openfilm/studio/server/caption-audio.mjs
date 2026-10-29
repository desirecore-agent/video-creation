// @ts-check
/** 按已读字幕定位短原声窗；只生成原音频导出请求，不改字幕或另建任务队列。 */
import { Ajv } from 'ajv';
import { clipSpan, kindOf } from '../../src/film-doc.mjs';
import { filmCaptions } from './captions.mjs';
import { probe } from './derived.mjs';
import { readProjectFilm } from './film.mjs';
import { HttpError } from './http.mjs';
import { readSourceSnapshot, sourceSnapshotRevision } from './subtitle-edits.mjs';
import { captionMediaFile, captionMediaSnapshotSchema, captionMediaObservationRequestSchema } from './caption-media-snapshot.mjs';
export { captionMediaObservationRequestSchema } from './caption-media-snapshot.mjs';

export const CAPTION_AUDIO_MAX_SECONDS = 30;
export const CAPTION_AUDIO_MAX_BYTES = 6 * 1024 * 1024;
export const captionAudioRequestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'urn:desirecore:video-creation:caption-audio:v1',
  type: 'object', additionalProperties: false, required: ['base', 'clip', 'sourceRevision', 'mediaSnapshot', 'cue'],
  description: '按所见影片和源字幕版本定位一句及同片段上下文，沿既有导出队列生成最多30秒WAV；不自动校词，不证明已听或识别正确。',
  properties: {
    base: { type: 'string', pattern: '^[a-f0-9]{16}$', description: 'inspect所见真实影片revision，不把旧句位置重贴新影片。' },
    clip: { type: 'string', minLength: 1, maxLength: 512, description: 'captions所见可听片段ID，不是轨道或数组位置。' },
    sourceRevision: { type: 'string', pattern: '^[a-f0-9]{64}$', description: '同句captions返回的完整源字幕版本；与影片base分别核验。' },
    mediaSnapshot: captionMediaSnapshotSchema,
    cue: { type: 'object', additionalProperties: false, required: ['line'], description: '原语言真实字幕句标识；不按文本搜索猜句。', properties: {
      line: { type: 'integer', minimum: 0, description: '该句原行的源媒体起始毫秒。' },
      part: { type: 'integer', minimum: 0, description: '分句编号，省略为0。' },
    } },
    contextSeconds: { type: 'number', minimum: 0, maximum: 2, default: 1, description: '句首尾各附的成片秒数，限制在同一片段内；省略为1秒，完整窗口不得超过30秒。' },
  },
};
export const captionAudioContract = {
  contractVersion: 1, requestSchema: captionAudioRequestSchema,
  mediaObservation: { requestSchema: captionMediaObservationRequestSchema, route: 'GET captions?withMediaDigests=1',
    description: '显式观察响应filmRevision可作base；按所选cue.src找到mediaSnapshots中同src项，把其snapshot原值放入mediaSnapshot，不能提交时补新hash。' },
  description: 'POST captions/audio返回selection与已准备输入的普通export回执；仅done及实际输出摘要表示音频已生成。之后仍用原jobs查询/取消，不自动重试未知结果。',
  output: { format: 'wav', maximumSeconds: CAPTION_AUDIO_MAX_SECONDS, maximumBytes: CAPTION_AUDIO_MAX_BYTES,
    description: '成片时间窗的既有混音，可能包括同窗其他可听轨；不是分离人声或原始录音母版。完成回执outputDigests绑定实际输出字节。' },
  limitations: ['当前图片Read不能据WAV二进制声称已听；材料供原生试听、具听觉能力的观察者或人工听校。', '时间来源measured/estimated/edited不是ASR置信度；校订继续使用既有字幕原快照CAS。'],
};

/** @typedef {{ base: string, clip: string, sourceRevision: string, mediaSnapshot: import('./caption-media-snapshot.mjs').CaptionMediaSnapshot, cue: { line: number, part?: number }, contextSeconds?: number }} CaptionAudioRequest */
/** @typedef {{ base: string, clip: string, cue: { line: number, part: number, text: string, filmStartMs: number, filmEndMs: number, timing: string },
 * source: { src: string, revision: string, mediaSnapshot: import('./caption-media-snapshot.mjs').CaptionMediaSnapshot }, range: { filmStartMs: number, filmEndMs: number, sourceStartMs: number, sourceEndMs: number },
 * contextSeconds: number, limitations: string[] }} CaptionAudioSelection */
/** @typedef {{ kind: 'audio', format: 'wav', mix: true, stems: false, range: [number, number], captionAudio: CaptionAudioRequest }} CaptionAudioExportAsk */
const ajv = new Ajv({ allErrors: true });
const validRequest = ajv.compile(captionAudioRequestSchema);
const invalid = (/** @type {string} */ message) => new HttpError(400, message, { code: 'invalid-caption-audio' });
const stale = (/** @type {string} */ message) => new HttpError(409, message, { code: 'caption-audio-stale' });

/** @param {unknown} raw @returns {CaptionAudioRequest} */
export function normalizeCaptionAudioRequest(raw) {
  if (!validRequest(raw)) throw invalid(`字幕原声窗参数无效：${ajv.errorsText(validRequest.errors)}`);
  const ask = /** @type {CaptionAudioRequest} */ (raw);
  return { base: ask.base, clip: ask.clip, sourceRevision: ask.sourceRevision,
    mediaSnapshot: { bytes: ask.mediaSnapshot.bytes, sha256: ask.mediaSnapshot.sha256 },
    cue: { line: ask.cue.line, part: ask.cue.part ?? 0 }, contextSeconds: ask.contextSeconds ?? 1 };
}

/**
 * @param {string} root @param {unknown} raw
 * @param {{ duration?: (src: string) => Promise<number | undefined> }} [options]
 * @returns {Promise<{ selection: CaptionAudioSelection, exportAsk: CaptionAudioExportAsk }>}
 */
export async function planCaptionAudio(root, raw, options = {}) {
  const ask = normalizeCaptionAudioRequest(raw);
  const current = await readProjectFilm(root);
  if (!current.doc) throw invalid(current.problems.join('\n') || '影片不可读取。');
  if (current.rev !== ask.base) throw stale('影片已改变，请重读当前影片与字幕再选择原声窗。');
  const target = current.doc.tracks.flatMap((track) => track.clips).find((clip) => clip.id === ask.clip);
  if (!target || !['video', 'sound'].includes(kindOf(target) ?? '')) throw invalid('所选字幕需要属于可听的媒体片段。');
  const duration = options.duration ?? ((/** @type {string} */ src) => probe(root, src).then((p) => p.duration, () => undefined));
  const captions = await filmCaptions(root, { duration });
  const cue = captions.cues.find((c) => c.clip === ask.clip && c.src === target.src && c.line === ask.cue.line && (c.part ?? 0) === (ask.cue.part ?? 0));
  if (!cue) throw invalid('找不到所选片段中的实际原语言字幕句。');
  if (cue.sourceRevision !== ask.sourceRevision) throw stale('源字幕已改变，请重读该句后选择。');
  const sourceNow = () => readSourceSnapshot(root, target.src).then(sourceSnapshotRevision);
  if (await sourceNow() !== ask.sourceRevision) throw stale('源字幕已改变，请重读该句后选择。');
  let span;
  try { span = clipSpan(target, target.time?.length === 2 ? undefined : await duration(target.src), target.id); }
  catch { throw invalid('所选片段时长不可确定，不能定位原声窗。'); }
  const atMs = (target.at ?? 0) * 1000, endMs = atMs + span.length * 1000;
  const context = ask.contextSeconds ?? 1;
  const from = Math.max(atMs, cue.startMs - context * 1000), to = Math.min(endMs, cue.startMs + cue.durMs + context * 1000);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from) || to - from > CAPTION_AUDIO_MAX_SECONDS * 1000)
    throw invalid('该字幕及上下文必须形成不超过30秒的正原声窗口。');
  if ((await readProjectFilm(root)).rev !== ask.base || await sourceNow() !== ask.sourceRevision)
    throw stale('定位期间影片或字幕已改变，请重新选择。');
  const sourceAt = (/** @type {number} */ filmMs) => span.from * 1000 + (filmMs - atMs) * span.speed;
  const selection = { base: ask.base, clip: ask.clip,
    cue: { line: ask.cue.line, part: ask.cue.part ?? 0, text: cue.text, filmStartMs: cue.startMs, filmEndMs: cue.startMs + cue.durMs, timing: cue.timing ?? 'unknown' },
    source: { src: target.src, revision: ask.sourceRevision, mediaSnapshot: ask.mediaSnapshot },
    range: { filmStartMs: from, filmEndMs: to, sourceStartMs: sourceAt(from), sourceEndMs: sourceAt(to) }, contextSeconds: context,
    limitations: [...captionAudioContract.limitations, ...(captions.untranscribed.includes(target.src) ? ['该媒体的字幕被现有检查标为需重核；片段仅按当前保存的时标定位，不证明文字与录音吻合。'] : [])] };
  return { selection, exportAsk: { kind: 'audio', format: 'wav', mix: true, stems: false, range: [from / 1000, to / 1000], captionAudio: ask } };
}

/** 持久守卫在冻结副本复核，显式retry也不能沿旧字幕位置取新影片。
 * @param {string} root @param {{ kind: string, format?: string, mix?: boolean, stems?: boolean, range?: [number, number], captionAudio?: CaptionAudioRequest }} ask
 * @param {{ files: {path: string, bytes: number, sha256: string}[] }} manifest */
export async function verifyCaptionAudioInput(root, ask, manifest) {
  if (!ask.captionAudio) return undefined;
  if (ask.kind !== 'audio' || ask.format !== 'wav' || ask.mix === false || ask.stems === true) throw invalid('字幕原声窗只生成一份WAV成片混音。');
  const plan = await planCaptionAudio(root, ask.captionAudio);
  const path = captionMediaFile(root, plan.selection.source.src).path;
  const frozen = manifest.files.find((file) => file.path === path);
  if (!frozen || frozen.bytes !== ask.captionAudio.mediaSnapshot.bytes || frozen.sha256 !== ask.captionAudio.mediaSnapshot.sha256)
    throw stale('媒体内容已改变，不能沿旧字幕选句取得另一份录音。请重读同次字幕与媒体摘要。');
  if (!ask.range || ask.range.some((value, i) => value !== plan.exportAsk.range[i])) throw stale('原声窗范围不再对应所选字幕与上下文。');
  return plan.selection;
}
