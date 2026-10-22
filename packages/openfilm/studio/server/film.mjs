// @ts-check
/**
 * A project's film.html as Studio changes it: read with its revision, edited by clip id, written atomically over what
 * it was (what an edit leaves alone keeps its text).
 *
 * The agent and the person edit the same file. Studio never addresses a clip by its place (a track index and a clip
 * index move whenever the agent rewrites the file); every operation names the clip by its id. An edit carries the
 * revision it was made against; unchanged target fields can be replayed by clip id on a newer file. A changed field,
 * a missing clip or a structural edit against an old revision fails instead of silently overwriting another edit.
 */
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve } from 'node:path';
import { FILM_FILE, filmHtml, readFilm, readFilmFile } from '../../src/film-doc.mjs';
import { EditError, applyOps } from './ops.mjs';
import { writeAtomic } from './atomic.mjs';
import { motionValueAt, validateMotionChanges, motionAncestorsUnchanged } from './motion-edits.mjs';
import { validateMotionInputs } from '../../src/motion.mjs';
import { checkMotionLocks } from '../../src/motion-schema.mjs';
import { readSceneMotion } from './motion-manifest.mjs';

export { EditError };

/* Server edits share one queue even when a folder was opened through a symlink. This coordinates this process;
 * external editors must use revision-aware edits too. Atomic rename alone is not compare-and-swap. */
/** @type {Map<string, Promise<any>>} */
const edits = new Map();
/** @type {Map<string, Map<string, FilmValue | null>>} */
const revisions = new Map();
const projectKey = async (/** @type {string} */ root) => realpath(root).catch(() => resolve(root));
/** @param {string} key @param {string} rev @param {FilmValue | null} value */
const remember = (key, rev, value) => {
  let known = revisions.get(key);
  if (!known) { known = new Map(); revisions.set(key, known); }
  if (!known.has(rev)) known.set(rev, structuredClone(value));
  while (known.size > 64) known.delete(/** @type {string} */ (known.keys().next().value));
  /* Do not retain the content of every project ever opened for the lifetime of Studio. */
  if (revisions.size > 128) revisions.delete(/** @type {string} */ (revisions.keys().next().value));
};
/** @template T @param {string} key @param {() => Promise<T>} task @returns {Promise<T>} */
const serial = async (key, task) => {
  const previous = edits.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  edits.set(key, next);
  try { return await next; }
  finally { if (edits.get(key) === next) edits.delete(key); }
};

/** 项目辅助材料与影片写入共用同一进程内串行边界；回调中不能递归调用编辑入口。
 * @template T @param {string} root @param {() => Promise<T>} task */
export async function withProjectFilmEdit(root, task) {
  return serial(await projectKey(root), task);
}

/** Rebase only fields whose old value can be proven unchanged. Structural edits use a fresh revision. */
/** @param {FilmValue | null | undefined} before @param {FilmValue | null} current @param {Op[]} ops */
function checkRebase(before, current, ops) {
  const clip = (/** @type {FilmValue | null | undefined} */ value, /** @type {string} */ id) => value?.tracks?.flatMap((t) => t.clips ?? []).find((c) => c.id === id);
  const check = (/** @type {string} */ id, /** @type {string[]} */ fields) => {
    const a = clip(before, id), b = clip(current, id);
    if (!a || !b) throw new EditError(`clip "${id}" is not in the base and current film; reload before editing`, 'conflict');
    for (const field of [...new Set(fields.flatMap((field) => ['time', 'speed'].includes(field) ? [field, 'overrides'] : [field]))]) {
      if (!isDeepStrictEqual(a[field], b[field])) throw new EditError(`clip "${id}" field "${field}" changed since this edit; reload before editing`, 'conflict');
    }
  };
  for (const op of ops) {
    if (op.op === 'motion') {
      try { validateMotionChanges(op.changes); } catch (error) { throw new EditError(error instanceof Error ? error.message : String(error), 'invalid'); }
      const a = clip(before, op.clip), b = clip(current, op.clip);
      if (!a || !b || !isDeepStrictEqual(a.src, b.src)) throw new EditError('动效片段或场景来源已变更，请重读后修改。', 'conflict');
      for (const change of op.changes) if (!motionAncestorsUnchanged(a.motion, b.motion, change.path) || !isDeepStrictEqual(motionValueAt(a.motion, change.path), motionValueAt(b.motion, change.path))) throw new EditError(`动效字段 ${change.path.join('.')} 已变更，请重读后修改。`, 'conflict');
    }
    else if (op.op === 'set') check(op.clip, [op.field]);
    else if (op.op === 'fields') check(op.clip, Object.keys(op.fields ?? {}).filter((k) => k !== 'id'));
    else if (op.op === 'props') {
      for (const edit of op.edits ?? []) {
        if (['track', 'trackOrder', 'locked', 'hidden', 'muted'].includes(edit.prop)) throw new EditError('the track changed; reload before editing', 'conflict');
        check(edit.clip, [edit.prop === 'start' || edit.prop === 'end' ? 'time' : edit.prop === 'fade' ? 'overrides' : edit.prop === 'gainDb' ? 'volume' : edit.prop === 'link' ? 'attrs' : edit.prop]);
      }
    } else if (op.op === 'stage' && isDeepStrictEqual(before?.stage, current?.stage)) continue;
    else throw new EditError(`the film changed before ${op.op}${'clip' in op && typeof op.clip === 'string' ? ` of clip "${op.clip}"` : ''}; reload before editing`, 'conflict');
  }
}

/** @typedef {import('./ops.mjs').FilmValue} FilmValue @typedef {import('./ops.mjs').Op} Op */

/** What a folder starts as: one 1920×1080 stage and no clips. */
export const EMPTY_FILM = Object.freeze({ stage: Object.freeze({ w: 1920, h: 1080 }), tracks: Object.freeze([]) });

/** The revision of a film.html text: what an edit is made against. */
export const revOf = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * The film as it is on disk: its text, revision, the raw value (clips named, see readFilm) and the checked edit, or the
 * problems that keep it from being one. A folder without film.html reads as an empty film.
 * @param {string} root
 */
export async function readProjectFilm(root) {
  let text;
  try { text = await readFile(join(root, FILM_FILE), 'utf8'); }
  catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
    text = '';
  }
  const rev = revOf(text);
  const key = await projectKey(root);
  if (!text.trim()) { remember(key, rev, null); return { text, rev, value: null, doc: null, problems: [`${FILM_FILE} is empty`] }; }
  const { value, doc, problems } = readFilmFile(text);
  remember(key, rev, doc ? value : null);
  return { text, rev, value: doc ? value : null, doc, problems };
}

/**
 * A clip's overrides (SPEC §1), by its id, as film.html has them now: what its thumbnails are drawn with. Null when it
 * has none, or no clip has that id.
 * @param {string} root @param {string} id
 */
export async function clipOverrides(root, id) {
  const { value } = await readProjectFilm(root);
  for (const track of value?.tracks ?? []) {
    for (const clip of track.clips ?? []) if (clip.id === id) return clip.overrides?.length ? clip.overrides : null;
  }
  return null;
}

/**
 * film.html as Studio writes it: over `before` (its text as read), so what did not change stays as it was, through a
 * temporary file so no reader sees half.
 * @param {string} root @param {FilmValue} value @param {string} [before]
 */
async function writeFilm(root, value, before = '') {
  const text = filmHtml(value, before);
  const path = join(root, FILM_FILE);
  await writeAtomic(path, text);
  return { text, rev: revOf(text) };
}

/** 参数与关键帧必须满足场景声明；记录源码摘要，写前检测同期场景变化。
 * @param {string} root @param {FilmValue} value */
async function checkedMotionSources(root, value) {
  /** @type {Map<string, Awaited<ReturnType<typeof readSceneMotion>>>} */
  const sources = new Map();
  for (const clip of value.tracks.flatMap((track) => track.clips)) {
    if (clip.motion === undefined) continue;
    let scene = sources.get(clip.src);
    if (!scene) {
      try { scene = await readSceneMotion(root, clip.src); }
      catch (error) { throw new EditError(`${clip.src}: ${error instanceof Error ? error.message : String(error)}`, 'invalid'); }
      sources.set(clip.src, scene);
    }
    const problems = validateMotionInputs(scene.manifest, /** @type {Parameters<typeof validateMotionInputs>[1]} */ (clip.motion));
    if (problems.length) throw new EditError(`${clip.id}: ${problems.join('\n')}`, 'invalid');
  }
  return sources;
}
/** @param {string} root @param {Map<string, Awaited<ReturnType<typeof readSceneMotion>>>} sources */
async function checkMotionSourcesUnchanged(root, sources) {
  for (const [src, before] of sources) {
    let after;
    try { after = await readSceneMotion(root, src); } catch { throw new EditError(`${src}: 场景在编辑期间发生变更，请重读后修改。`, 'conflict'); }
    if (after.sourceDigest !== before.sourceDigest) throw new EditError(`${src}: 场景在编辑期间发生变更，请重读后修改。`, 'conflict');
  }
}
/** @param {FilmValue | null} before @param {FilmValue} after */
function checkFilmMotionLocks(before, after) {
  for (const clip of before?.tracks?.flatMap((track) => track.clips) ?? []) {
    const now = after.tracks.flatMap((track) => track.clips).find((item) => item.id === clip.id);
    const problems = checkMotionLocks(clip.motion, now?.motion);
    if (problems.length) throw new EditError(problems.join('\n'), 'conflict');
  }
}

/** A whole-film write also cooperates with clip edits, and refuses a stale `before` text.
 * @param {string} root @param {FilmValue} value @param {string} [before] */
export async function writeProjectFilm(root, value, before = '') {
  const key = await projectKey(root);
  return serial(key, async () => {
    const current = await readProjectFilm(root);
    if (current.text !== before) throw new EditError('film.html changed before this write; reload before editing', 'conflict');
    checkFilmMotionLocks(current.value, value);
    const sources = await checkedMotionSources(root, value);
    await checkMotionSourcesUnchanged(root, sources);
    if ((await readProjectFilm(root)).rev !== current.rev) throw new EditError('film.html changed while preparing this write; reload before editing', 'conflict');
    const written = await writeFilm(root, value, before);
    remember(key, written.rev, value);
    return written;
  });
}

/**
 * Apply an edit to the film on disk. `base` is the revision the edit was made against; a newer file gets the same
 * operations by clip id. Returns the new text, revision, the value written and the checked edit. Throws EditError:
 * `conflict` when an operation names a clip that is gone, `invalid` when the result is not a film.
 * @param {string} root @param {string | null} base @param {Op[]} ops
 */
export async function editProjectFilm(root, base, ops) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 1000 || ops.some((op) => !op || typeof op !== 'object' || typeof op.op !== 'string')) throw new EditError('an edit needs 1 to 1000 operation objects', 'invalid');
  const key = await projectKey(root);
  return serial(key, () => editProjectFilmCore(root, key, base, ops));
}

/** 队列内复用既有编辑核心；源码发布只提供严格 base 和提交前核验，不递归公开队列。
 * @param {string} root @param {string} key @param {string | null} base @param {Op[]} ops
 * @param {{ strict?: boolean, verify?: () => Promise<void> }} [options] */
async function editProjectFilmCore(root, key, base, ops, options = {}) {
    const current = await readProjectFilm(root);
    if (options.strict && current.rev !== base) throw new EditError('film.html changed before this source revision; reload before editing', 'conflict');
    if (ops.some((op) => op.op === 'motion' || op.op === 'motion-locks') && (typeof base !== 'string' || !/^[a-f0-9]{16}$/.test(base))) throw new EditError('动效编辑必须携带 inspect 返回的真实 revision。', 'invalid');
    /* a film.html that does not read is the agent's to fix: Studio never writes over it */
    if (!current.value && current.text.trim()) throw new EditError(current.problems.join('\n'), 'invalid');
    if (base != null && base !== current.rev) {
      const known = revisions.get(key);
      if (!known?.has(base)) throw new EditError('the base revision is no longer available; reload before editing', 'conflict');
      checkRebase(known.get(base), current.value, ops);
    }
    const value = applyOps(/** @type {FilmValue} */ (structuredClone(current.value ?? EMPTY_FILM)), ops);
    const { doc, problems } = readFilm(value);
    if (!doc) throw new EditError(problems.join('\n'), 'invalid');
    const sources = await checkedMotionSources(root, value);
    await checkMotionSourcesUnchanged(root, sources);
    await options.verify?.();
    /* Detect writes from an ordinary editor while this edit was being prepared. This is an optimistic check,
       not an OS-level CAS: all cooperating writers should call this revision-aware API. */
    if ((await readProjectFilm(root)).rev !== current.rev) throw new EditError('film.html changed while preparing this edit; reload before editing', 'conflict');
    const written = await writeFilm(root, /** @type {FilmValue} */ (value), current.text);
    remember(key, written.rev, value);
    return { ...written, value, doc, rebased: base != null && base !== current.rev };
}

/** 仅供场景领域在同一 canonical 队列内准备/发布后提交点名 src；不暴露 HTTP 控制面。
 * @param {string} root @param {string} base
 * @param {(current: Awaited<ReturnType<typeof readProjectFilm>>) => Promise<{ops: Op[], verify: () => Promise<void>, verifyCommitted?: (written: {rev: string}) => Promise<void>}>} prepare */
export async function withProjectFilmSourceEdit(root, base, prepare) {
  const key = await projectKey(root);
  return serial(key, async () => {
    const current = await readProjectFilm(root);
    if (!current.value || current.rev !== base) throw new EditError('film.html changed before this source revision; reload before editing', 'conflict');
    const prepared = await prepare(current);
    if (!prepared.ops.length || prepared.ops.some((op) => op.op !== 'set' || op.field !== 'src' || typeof op.value !== 'string')) throw new EditError('source revisions only replace explicitly selected src fields', 'invalid');
    const next = applyOps(structuredClone(current.value), prepared.ops);
    const restored = structuredClone(next);
    for (const track of restored.tracks) for (const clip of track.clips) {
      const before = current.value.tracks.flatMap((row) => row.clips).find((row) => row.id === clip.id);
      if (before) clip.src = before.src;
    }
    if (!isDeepStrictEqual(restored, current.value)) throw new EditError('source revision changed a non-src film field', 'invalid');
    const written = await editProjectFilmCore(root, key, base, prepared.ops, { strict: true, verify: prepared.verify });
    // 提交后的来源核验也留在同队列，不能把随后合法合作编辑误报为本次失败。
    await prepared.verifyCommitted?.(written);
    return written;
  });
}
