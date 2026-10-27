// @ts-check
/**
 * What changes in a project folder while someone watches it: film.html (`film`, with its new revision) or any other
 * file (`files`: a page, a picture, a sound). One watcher per open project, shared by every page showing it, closed when
 * the last one leaves. Studio's own folders and the usual build and dependency folders are not watched.
 */
import { lstatSync, readdirSync, watch } from 'node:fs';
import { basename, join } from 'node:path';
import { readProjectFilm } from './film.mjs';
import { FILM_FILE } from '../../src/film-doc.mjs';

/* a dot folder is a tool's (Studio's own .film, .git…), and what builds and packages make is not the film */
const IGNORED = /^(\.[^/\\]+|node_modules|dist|build)([/\\]|$)/;
/** How long changes are gathered before one event: an agent writes a file in several chunks, and often several files. */
const SETTLE_MS = 120;

/* Studio's own half-written files (a file written whole through a random-named sibling, atomic.mjs; an import
   streaming in, files.mjs): only the result is a change */
const WRITING = /(^|[/\\])([^/\\]+\.[0-9a-f-]{8,}\.tmp|\.\d+\.\d+\.importing)$/;

/**
 * `files`: `paths` are the files that changed (folder relative), or none when the system could not say.
 * `ask` / `asked`: a question about spending for the person, and that it was answered; `notice`: something the person
 * is told, such as a provider with no balance left (get.mjs).
 * `history-progress`: how far a version history action is (history.mjs), `op` the action ('commit', 'checkout'…).
 * @typedef {{ type: 'film', rev: string } | { type: 'files', paths?: string[] } | { type: 'history' } | { type: 'export', job: object }
 *   | { type: 'project', project: Awaited<ReturnType<typeof import('./projects.mjs').projectById>>, folder: string }
 *   | { type: 'history-progress', op: string, phase: string, done: number, total: number }
 *   | { type: 'ask', ask: object } | { type: 'asked', id: string } | { type: 'notice', notice: object }} FolderEvent
 */

/**
 * Watch `root`; `send` gets each change once it settles. Returns `close`.
 * @param {string} root @param {(event: FolderEvent) => void} send
 */
export function watchFolder(root, send) {
  /** @type {Set<'film' | 'files'>} */
  const pending = new Set();
  /** @type {Set<string> | null} null: some change could not say which file */
  let paths = new Set();
  let timer = /** @type {NodeJS.Timeout | null} */ (null);
  let closed = false;
  let lastRev = '';
  readProjectFilm(root).then((f) => { lastRev = f.rev; }, () => {});

  const flush = async () => {
    if (closed) return;
    timer = null;
    const kinds = [...pending];
    const changed = paths;
    pending.clear();
    paths = new Set();
    if (kinds.includes('film')) {
      const { rev } = await readProjectFilm(root).catch(() => ({ rev: '' }));
      if (closed) return;
      /* the same text written again (an editor's save, Studio's own write echoed back) is no change */
      if (rev && rev !== lastRev) { lastRev = rev; send({ type: 'film', rev }); }
    }
    if (kinds.includes('files')) send(changed ? { type: 'files', paths: [...changed] } : { type: 'files' });
  };

  const close = watchTree(root, (name) => {
    if (closed) return;
    if (!name) { pending.add('files'); pending.add('film'); paths = null; }
    else {
      const rel = name;
      if (IGNORED.test(rel) || WRITING.test(rel)) return;
      if (rel === FILM_FILE) pending.add('film');
      else { pending.add('files'); paths?.add(rel); }
    }
    if (!timer) timer = setTimeout(flush, SETTLE_MS);
  });
  return () => { closed = true; if (timer) clearTimeout(timer); close(); };
}

/**
 * Every change under `root`, as a folder-relative name (null: something changed, the system could not say what).
 * macOS and Windows watch a tree natively. Elsewhere Node's recursive watch follows each file's inode, so a file
 * replaced by a rename (film.html written by a rename, most editors' saves) goes unseen after the first time: there each
 * folder is watched on its own, which names whatever lands in it, and a new folder is taken in as it appears.
 * @param {string} root @param {(name: string | null) => void} onChange @param {boolean} [native] @returns {() => void} close
 */
export function watchTree(root, onChange, native = process.platform === 'darwin' || process.platform === 'win32') {
  if (native) {
    const ownName = basename(root);
    const namesakeExists = () => {
      try { lstatSync(join(root, ownName)); return true; }
      catch (error) { return !['ENOENT', 'ENOTDIR'].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? ''); }
    };
    const rootStillThere = () => { try { return lstatSync(root).isDirectory(); } catch { return false; } };
    let hadNamesake = namesakeExists();
    let closed = false;
    /* a folder that is not there (any more) is not watched: nothing comes of it */
    let watcher;
    try { watcher = watch(root, { recursive: true }, (event, name) => {
      if (closed) return;
      const rel = name ? String(name).split('\\').join('/') : null;
      if (rel?.startsWith(`${ownName}/`)) hadNamesake = true;
      if (rel === ownName) {
        const exists = namesakeExists();
        // macOS can deliver the watched directory's own creation/rename after a new watcher starts. It names
        // the directory itself, not a child resource. A real child with that name must still invalidate on delete.
        const selfRename = event === 'rename' && !hadNamesake && !exists && rootStillThere();
        hadNamesake = exists;
        if (selfRename) return;
      }
      onChange(rel);
    }); }
    catch { return () => {}; }
    watcher.on('error', () => {});
    return () => { closed = true; watcher.close(); };
  }
  /** @type {Map<string, import('node:fs').FSWatcher>} folder-relative folder ('' for the root) → its watcher */
  const folders = new Map();
  const add = (/** @type {string} */ rel) => {
    if (folders.has(rel) || (rel && IGNORED.test(rel))) return;
    let watcher;
    try {
      watcher = watch(rel ? join(root, rel) : root, (_event, name) => {
        if (!name) { onChange(null); return; }
        const path = rel ? `${rel}/${name}` : String(name);
        onChange(path);
        /* a folder that just appeared (or moved in) is watched too, with what is already in it */
        try { if (readdirSync(join(root, path))) { add(path); addBelow(path); } } catch { /* a file, or gone */ }
      });
    } catch { return; }
    watcher.on('error', () => { watcher.close(); folders.delete(rel); });
    folders.set(rel, watcher);
  };
  const addBelow = (/** @type {string} */ rel) => {
    let entries;
    try { entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory()) { const sub = rel ? `${rel}/${e.name}` : e.name; add(sub); addBelow(sub); }
  };
  add('');
  addBelow('');
  return () => { for (const w of folders.values()) w.close(); folders.clear(); };
}

/**
 * Every project someone is watching, and who: `subscribe` starts the folder's watcher with its first listener and stops
 * it with its last.
 */
export function createWatchers() {
  /** @typedef {{ on: (e: FolderEvent) => void, entry: WatchEntry }} Subscription */
  /** @typedef {{ root: string, close: () => void, listeners: Set<Subscription> }} WatchEntry */
  /** @type {Map<string, WatchEntry>} */
  const byRoot = new Map();
  const start = (/** @type {WatchEntry} */ entry) => watchFolder(entry.root, (e) => { for (const sub of entry.listeners) sub.on(e); });
  return {
    /** @param {string} root @param {(e: FolderEvent) => void} listener */
    subscribe(root, listener) {
      let entry = byRoot.get(root);
      if (!entry) {
        entry = { root, listeners: new Set(), close: () => {} };
        entry.close = start(entry);
        byRoot.set(root, entry);
      }
      const sub = { on: listener, entry };
      entry.listeners.add(sub);
      return () => {
        const current = sub.entry;
        if (!current.listeners.delete(sub)) return;
        if (!current.listeners.size) {
          current.close();
          if (byRoot.get(current.root) === current) byRoot.delete(current.root);
        }
      };
    },
    /** A project's directory changed; keep its open streams and watch the new directory on every OS. */
    move(/** @type {string} */ from, /** @type {string} */ to) {
      if (from === to) return;
      const entry = byRoot.get(from);
      if (!entry) return;
      entry.close();
      byRoot.delete(from);
      const target = byRoot.get(to);
      if (target) {
        for (const sub of entry.listeners) { sub.entry = target; target.listeners.add(sub); }
        entry.listeners.clear();
      } else {
        entry.root = to;
        entry.close = start(entry);
        byRoot.set(to, entry);
      }
    },
    /** The projects someone is watching now. */
    roots: () => [...byRoot.keys()],
    /** Tell everyone watching `root` something the folder itself does not say (a new version in its history). */
    emit(/** @type {string} */ root, /** @type {FolderEvent} */ event) { for (const sub of byRoot.get(root)?.listeners ?? []) sub.on(event); },
    closeAll() { for (const entry of byRoot.values()) entry.close(); byRoot.clear(); },
  };
}
