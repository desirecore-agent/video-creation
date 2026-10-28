// @ts-check
/**
 * The subtitles of one source as the timeline's subtitle row edits them: retimed, moved, split, merged, deleted, added
 * and typed (the editing itself is the editor's, studio/ui/src/lib/subtitle-cues.ts; this reads and writes).
 *
 * A source's subtitles are its transcript's lines (transcripts.mjs), each cut into subtitles by subtitle-segments.mjs.
 * The row shows and edits those subtitles, so they are read here as the film shows them: one cue per subtitle, in the
 * source's own milliseconds, each with its words' times and its translations (cut to follow it, as captions.mjs does).
 * Written back, the transcript holds one cue per subtitle and says so (CUT_NOTE): Studio no longer cuts its lines, the
 * person did. Its translations are written beside it at the same times.
 *
 * Every write answers the files as they were and as they are now (a Snapshot); undo and redo put one back, and only
 * over the files they left (anything written in between, by the agent or another window, is kept and said).
 *
 *   GET captions/source?src=     → SourceSubtitles
 *   PUT captions/source          { src, cues, from: Snapshot } → { before: Snapshot, after: Snapshot }
 *   PUT captions/files           { src, from: Snapshot, to: Snapshot } → { ok } (409 when the files are not `from`)
 */
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { Ajv } from 'ajv';
import { writeAtomic } from './atomic.mjs';
import { withProjectFilmEdit } from './film.mjs';
import { isFilmSubtitleLanguage } from './film-subtitle.mjs';
import { inProject, inside } from './files.mjs';
import { HttpError, json, readJson } from './http.mjs';
import { alignTranslation, segmentLine } from './subtitle-segments.mjs';
import { normalizeEmphasis, normalizeSubtitleText, sliceEmphasis, subtitleTextBoundary } from './subtitle-emphasis.mjs';
import { readTranscript, setLine, transcriptPath, translationsOf, vttOf } from './transcripts.mjs';

/** @typedef {import('./transcripts.mjs').SpokenLine} SpokenLine */
/**
 * One subtitle of a source, in its milliseconds. `line` and `part` say which it is as captions.mjs names it (a cue's
 * `line` and `part`), so the row finds the one a cue on the film shows.
 * @typedef {{ startMs: number, endMs: number, text: string, marks?: { index: number, startMs: number }[], emphasis?: import('./subtitle-emphasis.mjs').SubtitleEmphasis[],
 *   alt?: Record<string, string>, line?: number, part?: number,
 *   timing?: 'measured' | 'estimated' | 'edited', alignment?: {matchedWords: number, totalWords: number} }} SourceCue
 * @typedef {{ src: string, cut: boolean, speaker?: string, cues: SourceCue[], snapshot: Snapshot, sourceRevision: string }} SourceSubtitles
 * The transcript files of a source (path in the project → text, null: no such file).
 * @typedef {{ files: Record<string, string | null> }} Snapshot
 */

/** A source's text is at most this long: a transcript, not a book. */
const MAX_CUES = 5000;
const MAX_TEXT = 2000;
const sourcePathSchema = { type: 'string', minLength: 1, description: '项目内真实媒体源路径；字幕使用相同目录与文件名的 VTT，路径边界由服务端校验。' };
const snapshotSchema = {
  type: 'object', additionalProperties: false, required: ['files'], description: '读取字幕时取得的完整原字节快照；包括源 VTT 与该源所有翻译 VTT，缺失文件以 null 表示。',
  properties: { files: { type: 'object', additionalProperties: { type: ['string', 'null'] }, description: '该媒体源的字幕路径到原始文件全文或 null 的映射；不能用摘要或新读的快照替换旧草稿来源。' } },
};
const emphasisSchema = {
  type: 'array', maxItems: MAX_TEXT, description: '所给纯文本的 UTF-16 半开强调范围；空白规范化时随原字符投影，重叠或相邻范围合并。不包含 HTML/CSS；边界须为完整码点，且 0 <= from < to <= text.length。',
  items: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: {
    from: { type: 'integer', minimum: 0, description: '强调起点，包含此 UTF-16 索引对应的完整码点。' },
    to: { type: 'integer', minimum: 1, description: '强调终点，不包含此 UTF-16 索引；不得超出所给文本或切断代理对。' },
  } },
};
const sourceCueSchema = {
  type: 'object', additionalProperties: false, required: ['startMs', 'endMs', 'text'], description: '一条源媒体字幕，时标属于源媒体毫秒；人工切分后每项独立保存为一个 VTT cue。',
  properties: {
    startMs: { type: 'number', minimum: 0, description: '源媒体中的字幕起点毫秒；保存时取整。' },
    endMs: { type: 'number', minimum: 0, description: '源媒体中的字幕终点毫秒；必须晚于起点，重叠部分按既有规则收窄。' },
    text: { type: 'string', maxLength: MAX_TEXT, description: '字幕纯文本，不解析任意标签；保存时折叠空白并裁去首尾，最多保留 2000 个 UTF-16 码元且不截断代理对。' },
    emphasis: emphasisSchema,
    marks: { type: 'array', description: '原词在纯文本中的 UTF-16 起点与源媒体时间；与语义强调独立。', items: {
      type: 'object', additionalProperties: false, required: ['index', 'startMs'], properties: {
        index: { type: 'integer', minimum: 0, description: '词在纯文本中的 UTF-16 起点。' },
        startMs: { type: 'number', description: '词在源媒体中的开始毫秒；保存时约束到 cue 时间内。' },
      },
    } },
    alt: { type: 'object', additionalProperties: { type: 'string', maxLength: MAX_TEXT }, description: '语言标签到译文纯文本的映射；译文按同一 cue 时标保存，时间来源为 estimated。' },
    line: { type: 'number', description: '读取时原整句的源起点，用于 UI 回指；不作为写入身份或锁。' },
    part: { type: 'integer', minimum: 0, description: '读取时该整句的切分序号；保存后按人工 cue 保留，不作为版本前置条件。' },
    timing: { type: 'string', enum: ['measured', 'estimated', 'edited'], description: '时间来源；只改强调保留 measured，改字或改时不能冒称原实测。省略表示旧文件未知。' },
    alignment: { type: 'object', additionalProperties: false, required: ['matchedWords', 'totalWords'], description: '整段转写的字面词匹配计数，不代表本 cue 的识别正确率。', properties: {
      matchedWords: { type: 'integer', minimum: 0, description: '整段实际字面匹配的输入词数，不能超过 totalWords。' },
      totalWords: { type: 'integer', minimum: 1, description: '整段转写输入的总词数。' },
    } },
  },
};
export const CAPTION_SOURCE_READ_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'urn:desirecore:video-creation:caption-source-read:v1',
  type: 'object', additionalProperties: false, required: ['src'], description: '读取源字幕与 snapshot/sourceRevision；修改时必须把该次 snapshot 原样放入保存请求的 from。',
  properties: { src: sourcePathSchema },
};
export const CAPTION_SOURCE_SAVE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'urn:desirecore:video-creation:caption-source-save:v1',
  type: 'object', additionalProperties: false, required: ['src', 'cues', 'from'], description: '以所读原字节快照保存源字幕；缺 from 返回 428，旧快照返回 409，服务端不自动更新前置条件。',
  properties: { src: sourcePathSchema, cues: { type: 'array', maxItems: MAX_CUES, items: sourceCueSchema, description: '明确的完整 cue 列表；空列表明确删除该源所有字幕。' }, from: snapshotSchema },
};
const validEmphasis = new Ajv({ allErrors: true }).compile(emphasisSchema);

/** 新增范围严格校验，不能由写入清洗把坏索引变成另一段文字的强调。
 * @param {unknown} raw @param {string} text @returns {import('./subtitle-emphasis.mjs').SubtitleEmphasis[]} */
function cleanEmphasis(raw, text) {
  if (raw === undefined) return [];
  if (!validEmphasis(raw)) throw new HttpError(400, 'emphasis must contain only integer UTF-16 { from, to } ranges');
  const ranges = /** @type {import('./subtitle-emphasis.mjs').SubtitleEmphasis[]} */ (raw);
  if (ranges.some((r) => r.from >= r.to || r.to > text.length || !subtitleTextBoundary(text, r.from) || !subtitleTextBoundary(text, r.to))) {
    throw new HttpError(400, 'emphasis ranges must stay inside the text and cannot split a Unicode code point');
  }
  return normalizeEmphasis(text, ranges);
}

/**
 * The subtitles of `src` (a path in the project) as the film shows them, or none when it has no transcript.
 * @param {string} root @param {string} src @returns {Promise<SourceSubtitles>}
 */
export async function sourceSubtitles(root, src) {
  return withProjectFilmEdit(root, async () => {
    const before = await readSourceSnapshot(root, src);
    const said = await readTranscript(root, src);
    if (!said) {
      await assertSourceSnapshot(root, src, before);
      return { src, cut: false, cues: [], snapshot: before, sourceRevision: sourceSnapshotRevision(before) };
    }
    /** @type {Map<number, Record<string, string>>} */
    const alt = new Map();
    for (const language of await translationsOf(root, src)) {
      for (const line of (await readTranscript(root, src, language))?.lines ?? []) alt.set(line.startMs, { ...alt.get(line.startMs), [language]: line.text });
    }
    /** @type {SourceCue[]} */
    const cues = [];
    for (const line of said.lines) {
      const translated = Object.entries(alt.get(line.startMs) ?? {});
      if (said.cut) {
        cues.push({ ...lineOf(line), ...(translated.length ? { alt: Object.fromEntries(translated) } : {}), line: line.startMs });
        continue;
      }
      const pieces = segmentLine(line);
      const parts = translated.map(([language, text]) => /** @type {const} */ ([language, alignTranslation(text, pieces)]));
      pieces.forEach((piece, k) => {
        const altOf = Object.fromEntries(parts.map(([language, list]) => [language, list[k].text]).filter(([, text]) => text));
        cues.push({
          ...lineOf(piece),
          ...(Object.keys(altOf).length ? { alt: altOf } : {}), line: line.startMs, ...(pieces.length > 1 ? { part: k } : {}),
        });
      });
    }
    await assertSourceSnapshot(root, src, before);
    return { src, cut: Boolean(said.cut), ...(said.speaker ? { speaker: said.speaker } : {}), cues, snapshot: before, sourceRevision: sourceSnapshotRevision(before) };
  });
}

/** @param {SpokenLine} line */
const lineOf = (line) => ({ text: line.text, startMs: line.startMs, endMs: line.endMs, ...(line.marks?.length ? { marks: line.marks } : {}),
  ...(line.emphasis?.length ? { emphasis: line.emphasis } : {}),
  ...(line.timing ? { timing: line.timing } : {}), ...(line.alignment ? { alignment: line.alignment } : {}) });

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const whole = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN);

/**
 * Cues as a request has them, made safe to write: in order of start, none overlapping the next (an end past the next
 * start is brought back to it), none empty or of no length, word marks inside their text and their time.
 * @param {unknown} raw @returns {SourceCue[]}
 */
export function cleanCues(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_CUES) throw new HttpError(400, 'which subtitles? { src, cues: [{ startMs, endMs, text }] }');
  /** @type {SourceCue[]} */
  const cues = [];
  for (const one of raw) {
    if (!isRecord(one)) throw new HttpError(400, 'a subtitle is { startMs, endMs, text }');
    const startMs = Math.max(0, whole(one.startMs)), endMs = whole(one.endMs);
    const rawText = typeof one.text === 'string' ? one.text : '';
    const normalized = normalizeSubtitleText(rawText, cleanEmphasis(one.emphasis, rawText));
    let text = normalized.text.slice(0, MAX_TEXT);
    if (!subtitleTextBoundary(normalized.text, text.length)) text = text.slice(0, -1);
    const emphasis = sliceEmphasis(normalized.emphasis, 0, text.length);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new HttpError(400, 'a subtitle\'s times are milliseconds');
    if (!text || endMs <= startMs) continue;
    /** @type {Record<string, string>} */
    const alt = {};
    if (isRecord(one.alt)) {
      for (const [language, value] of Object.entries(one.alt)) {
        if (isFilmSubtitleLanguage(language) && typeof value === 'string' && value.trim()) alt[language] = value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
      }
    }
    const marks = Array.isArray(one.marks) ? one.marks.flatMap((m) => (isRecord(m) && Number.isInteger(m.index) && Number.isFinite(whole(m.startMs))
      ? [{ index: /** @type {number} */ (m.index), startMs: whole(m.startMs) }] : [])) : [];
    const timing = one.timing === 'measured' || one.timing === 'estimated' || one.timing === 'edited' ? one.timing : undefined;
    const a = one.alignment;
    const alignment = isRecord(a) && Number.isInteger(a.matchedWords) && Number.isInteger(a.totalWords)
      && /** @type {number} */ (a.matchedWords) >= 0 && /** @type {number} */ (a.totalWords) >= /** @type {number} */ (a.matchedWords)
      ? { matchedWords: /** @type {number} */ (a.matchedWords), totalWords: /** @type {number} */ (a.totalWords) } : undefined;
    cues.push({ startMs, endMs, text, ...(marks.length ? { marks } : {}), ...(emphasis.length ? { emphasis } : {}), ...(Object.keys(alt).length ? { alt } : {}),
      ...(timing ? { timing } : {}), ...(alignment ? { alignment } : {}) });
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  /** @type {SourceCue[]} */
  const out = [];
  for (const [i, cue] of cues.entries()) {
    const prev = out.at(-1);
    const startMs = prev ? Math.max(cue.startMs, prev.endMs) : cue.startMs;
    const next = cues[i + 1];
    const endMs = next ? Math.min(cue.endMs, Math.max(next.startMs, startMs)) : cue.endMs;
    if (endMs <= startMs) continue;
    /* marks: inside the text, in order, inside the cue's time (the first word starts with the cue) */
    let last = -1;
    const marks = (cue.marks ?? []).filter((m) => {
      const ok = m.index > last && m.index < cue.text.length;
      if (ok) last = m.index;
      return ok;
    }).map((m) => ({ index: m.index, startMs: Math.min(endMs, Math.max(startMs, m.startMs)) }));
    out.push({ ...cue, startMs, endMs, ...(marks.length ? { marks } : {}) });
    if (!marks.length) delete out[out.length - 1].marks;
  }
  return out;
}

/** The transcript files of `src` now: its own and its translations', and `also` (paths of it, maybe not there). @param {string} root @param {string} src @param {readonly string[]} [also] */
export async function readSourceSnapshot(root, src, also = []) {
  const paths = new Set([transcriptPath(src), ...(await translationsOf(root, src)).map((language) => transcriptPath(src, language)), ...also]);
  /** @type {Snapshot} */
  const out = { files: {} };
  for (const path of [...paths].sort()) {
    const file = inProject(root, path);
    out.files[path] = file ? await readFile(file, 'utf8').catch(() => null) : null;
  }
  return out;
}

/** 仅给所见字幕携带轻量版本；保存仍比对原字节，不把摘要当作写入锁。
 * @param {Snapshot} value */
export function sourceSnapshotRevision(value) {
  return createHash('sha256').update(JSON.stringify(Object.entries(value.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');
}

/** 检查读取时的完整字幕集合；同进程写入另由项目串行边界协调，不承诺文件系统 CAS。
 * @param {string} root @param {string} src @param {unknown} rawFrom @param {readonly string[]} [also] */
export async function assertSourceSnapshot(root, src, rawFrom, also = []) {
  if (rawFrom == null) throw new HttpError(428, 'Read these subtitles again before saving; their snapshot is required.', { code: 'snapshot-required' });
  const from = snapshotOf(rawFrom, src);
  if (!Object.hasOwn(from.files, transcriptPath(src))) throw new HttpError(428, 'The source transcript must be in the snapshot.', { code: 'snapshot-required' });
  const now = await readSourceSnapshot(root, src, [...Object.keys(from.files), ...also]);
  for (const path of new Set([...Object.keys(from.files), ...Object.keys(now.files)])) {
    if ((now.files[path] ?? null) !== (from.files[path] ?? null)) throw new HttpError(409, 'These subtitles were changed since, elsewhere: they are left as they are now. Your draft has not been saved.', { code: 'changed' });
  }
  return now;
}

/**
 * Write `src`'s subtitles as `cues` (in its milliseconds): its transcript, cut by hand, and each translation at the same
 * times. A translation a cue no longer has loses that line; one no cue has is written empty (its file stays, so the
 * language stays known). Returns the files before and after.
 * @param {string} root @param {string} src @param {unknown} rawCues @param {unknown} rawFrom
 * @returns {Promise<{ before: Snapshot, after: Snapshot }>}
 */
export async function writeSourceSubtitles(root, src, rawCues, rawFrom) {
  if (!inProject(root, src)) throw new HttpError(400, `${src} is not a file inside the project`);
  return withProjectFilmEdit(root, async () => {
    const cues = cleanCues(rawCues);
    const had = await readTranscript(root, src);
    const languages = new Set([...await translationsOf(root, src), ...cues.flatMap((c) => Object.keys(c.alt ?? {}))]);
    const paths = [transcriptPath(src), ...[...languages].map((language) => transcriptPath(src, language))];
    const before = await assertSourceSnapshot(root, src, rawFrom, paths);
    const previous = had?.cut ? had.lines : (had?.lines ?? []).flatMap((line) => segmentLine(line));
    /** @type {SpokenLine[]} */
    const lines = cues.map((c) => {
      const line = lineOf(c);
      // 旧实测来源只能跟随原文字与原时标；API 不能把人工新输入仍标为原实测。
      if (line.timing === 'measured' && !previous.some((p) => p.text === c.text && p.startMs === c.startMs && p.endMs === c.endMs
        && JSON.stringify(p.marks ?? []) === JSON.stringify(c.marks ?? []))) {
        line.timing = 'edited';
        delete line.alignment;
      }
      return line;
    });
    await writeAtomic(inside(root, transcriptPath(src)), vttOf(lines, { ...(had?.speaker ? { speaker: had.speaker } : {}), cut: true }), 'utf8');
    for (const language of languages) {
      const translated = cues.flatMap((c) => (c.alt?.[language] ? [{ text: c.alt[language], startMs: c.startMs, endMs: c.endMs,
        timing: /** @type {const} */ ('estimated') }] : []));
      await writeAtomic(inside(root, transcriptPath(src, language)), vttOf(translated), 'utf8');
    }
    return { before, after: await readSourceSnapshot(root, src, paths) };
  });
}

/** 旧单行 HTTP 入口也使用所读快照，不能绕开普通保存的前置检查。
 * @param {string} root @param {string} src @param {number} line @param {string} text
 * @param {string | undefined} language @param {number | undefined} part @param {unknown} from */
export async function writeSubtitleLine(root, src, line, text, language, part, from) {
  return withProjectFilmEdit(root, async () => {
    await assertSourceSnapshot(root, src, from);
    return setLine(root, src, line, text, language, part);
  });
}

/** Whether `path` is one of `src`'s transcript files: `name.vtt` or `name.<language>.vtt` beside it. @param {string} src @param {string} path */
function transcriptOf(src, path) {
  if (path === transcriptPath(src)) return true;
  const name = basename(src, extname(src));
  const dir = dirname(src);
  const prefix = `${dir === '.' ? '' : `${dir}/`}${name}.`;
  return path.startsWith(prefix) && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\.vtt$/.test(path.slice(prefix.length));
}

/** @param {unknown} v @param {string} src @returns {Snapshot} */
function snapshotOf(v, src) {
  if (!isRecord(v) || !isRecord(v.files)) throw new HttpError(400, 'a snapshot is { files: { path: text | null } }');
  /** @type {Record<string, string | null>} */
  const files = {};
  for (const [path, body] of Object.entries(v.files)) {
    if (!transcriptOf(src, path)) throw new HttpError(400, `${path} is not a transcript of ${src}`);
    if (body !== null && typeof body !== 'string') throw new HttpError(400, `what goes in ${path}?`);
    files[path] = body;
  }
  return { files };
}

/**
 * Put `src`'s transcript files back as `to`, when they are now as `from` left them (a file `to` has as null goes:
 * the step made it). Otherwise nothing is written, and a 409 says they changed.
 * @param {string} root @param {string} src @param {unknown} rawFrom @param {unknown} rawTo
 */
export async function restoreSourceFiles(root, src, rawFrom, rawTo) {
  if (!inProject(root, src)) throw new HttpError(400, `${src} is not a file inside the project`);
  return withProjectFilmEdit(root, async () => {
    const from = snapshotOf(rawFrom, src), to = snapshotOf(rawTo, src);
    const paths = [...new Set([...Object.keys(from.files), ...Object.keys(to.files)])];
    await assertSourceSnapshot(root, src, from, paths);
    for (const path of paths) {
      const body = to.files[path] ?? null;
      if (body === null) await rm(inside(root, path), { force: true });
      else await writeAtomic(inside(root, path), body, 'utf8');
    }
  });
}

/**
 * The routes under /api/projects/:id/ (see the top). Returns whether it answered.
 * @param {import('./http.mjs').Req} req @param {import('./http.mjs').Res} res @param {string} root @param {string} rest
 */
export async function subtitleEditRoutes(req, res, root, rest) {
  if (rest === 'captions/source' && req.method === 'GET') {
    const src = new URL(req.url ?? '/', 'http://x').searchParams.get('src') ?? '';
    if (!src || !inProject(root, src)) throw new HttpError(400, `${src || 'which source?'} is not a file inside the project`);
    json(res, 200, await sourceSubtitles(root, src));
    return true;
  }
  if (rest === 'captions/source' && req.method === 'PUT') {
    const { src, cues, from } = /** @type {{ src?: unknown, cues?: unknown, from?: unknown }} */ (await readJson(req));
    if (typeof src !== 'string') throw new HttpError(400, 'which source? { src, cues }');
    json(res, 200, await writeSourceSubtitles(root, src, cues, from));
    return true;
  }
  if (rest === 'captions/files' && req.method === 'PUT') {
    const { src, from, to } = /** @type {{ src?: unknown, from?: unknown, to?: unknown }} */ (await readJson(req));
    if (typeof src !== 'string') throw new HttpError(400, 'which source? { src, from, to }');
    await restoreSourceFiles(root, src, from, to);
    json(res, 200, { ok: true });
    return true;
  }
  return false;
}
