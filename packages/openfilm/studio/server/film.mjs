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
    if (op.op === 'set') check(op.clip, [op.field]);
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

/** A whole-film write also cooperates with clip edits, and refuses a stale `before` text.
 * @param {string} root @param {FilmValue} value @param {string} [before] */
export async function writeProjectFilm(root, value, before = '') {
  const key = await projectKey(root);
  return serial(key, async () => {
    const current = await readProjectFilm(root);
    if (current.text !== before) throw new EditError('film.html changed before this write; reload before editing', 'conflict');
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
  const key = await projectKey(root);
  return serial(key, async () => {
    const current = await readProjectFilm(root);
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
    /* Detect writes from an ordinary editor while this edit was being prepared. This is an optimistic check,
       not an OS-level CAS: all cooperating writers should call this revision-aware API. */
    if ((await readProjectFilm(root)).rev !== current.rev) throw new EditError('film.html changed while preparing this edit; reload before editing', 'conflict');
    const written = await writeFilm(root, /** @type {FilmValue} */ (value), current.text);
    remember(key, written.rev, value);
    return { ...written, value, doc, rebased: base != null && base !== current.rev };
  });
}
