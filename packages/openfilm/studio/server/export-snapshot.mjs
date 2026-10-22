// @ts-check
/** Freeze the same bounded local dependency closure used by project history. Copies/reflinks, never hardlinks.
 * The manifest records exactly what was frozen, and the static-closure/remote limitations for audit.
 */
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { filmClosure, folderView } from './closure.mjs';
import { FILM_FILE } from '../../src/film-doc.mjs';

export const exportRuntimeSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object', additionalProperties: false,
  properties: {
    stateDir: { type: 'string', description: 'Absolute application-home directory for durable export receipts and temporary input snapshots.' },
    snapshotMaxFiles: { type: 'integer', minimum: 1, maximum: 100000, default: 10000, description: 'Maximum files in a render input closure. Exceeding the limit fails before rendering.' },
    snapshotMaxBytes: { type: 'integer', minimum: 1, default: 21474836480, description: 'Maximum total bytes in a render input closure (default 20 GiB). Copies may use reflinks but never share writable file content.' },
  },
};
const stamp = (/** @type {import('node:fs').Stats} */ s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const aborted = (/** @type {AbortSignal | undefined} */ signal) => { if (signal?.aborted) throw new Error('cancelled'); };

/** Snapshot the local files identified by upstream filmClosure. A source changing during copying fails explicitly.
 * @param {string} root @param {string} dir
 * @param {{ signal?: AbortSignal, maxFiles?: number, maxBytes?: number }} [options]
 */
export async function snapshotFilm(root, dir, { signal, maxFiles = 10000, maxBytes = 20 * 2 ** 30 } = {}) {
  const base = folderView(root);
  /** @type {Map<string, string>} */
  const texts = new Map();
  const files = await filmClosure({ ...base, async text(path) {
    const text = await base.text(path);
    if (text != null) texts.set(path, text);
    return text;
  } });
  if (!files.has(FILM_FILE)) throw new Error('The project has no film.html to snapshot.');
  if (files.size > maxFiles) throw new Error(`Render input has ${files.size} files; the snapshot limit is ${maxFiles}.`);
  const bytes = [...files.values()].reduce((n, size) => n + size, 0);
  if (bytes > maxBytes) throw new Error(`Render input needs ${bytes} bytes; the snapshot limit is ${maxBytes}.`);
  /** @type {Map<string, string>} */
  const stamps = new Map();
  /** @type {{ version: number, createdAt: number, source: string, filmRevision: string, bytes: number, files: { path: string, bytes: number, sha256: string }[], limitations: string[] }} */
  const manifest = { version: 1, createdAt: Date.now(), source: root, filmRevision: '', bytes, files: [],
    limitations: ['Only local inputs resolved by OpenFilm filmClosure are frozen. Dynamically constructed paths must name their dependencies in page code; remote resources are not snapshotted.'] };
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const [name, size] of files) {
      aborted(signal);
      const from = join(root, ...name.split('/')), to = join(dir, ...name.split('/'));
      const before = await stat(from);
      if (!before.isFile() || before.size !== size) throw new Error(`Render input changed while snapshotting: ${name}. Retry after saving the project.`);
      stamps.set(name, stamp(before));
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to, constants.COPYFILE_FICLONE);
      if (texts.has(name) && (await readFile(to, 'utf8')) !== texts.get(name)) {
        throw new Error(`Render input changed while resolving dependencies: ${name}. Retry after saving the project.`);
      }
      // 摘要只取本次冻结副本的真实字节；历史清单仍可没有此字段。
      const digest = createHash('sha256'); let copiedBytes = 0;
      for await (const chunk of createReadStream(to)) { aborted(signal); digest.update(chunk); copiedBytes += chunk.length; }
      if (copiedBytes !== size) throw new Error(`Render snapshot bytes changed: ${name}.`);
      const after = await stat(from);
      if (stamp(after) !== stamp(before)) throw new Error(`Render input changed while snapshotting: ${name}. Retry after saving the project.`);
      manifest.files.push({ path: name, bytes: size, sha256: digest.digest('hex') });
    }
    /* Verify the whole set after copying: a file copied first may have changed while later media was copied. */
    for (const [name, before] of stamps) {
      aborted(signal);
      if (stamp(await stat(join(root, ...name.split('/')))) !== before) throw new Error(`Render input changed while snapshotting: ${name}. Retry after saving the project.`);
    }
    manifest.filmRevision = createHash('sha256').update(await readFile(join(dir, FILM_FILE))).digest('hex').slice(0, 16);
    await writeFile(join(dirname(dir), 'input-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return manifest;
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
