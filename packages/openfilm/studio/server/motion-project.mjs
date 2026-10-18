/** 项目动效的只读发现和本地 SDK 安装；影片事实仍保存在 film.html。 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSceneMotion } from './motion-manifest.mjs';
export { motionManifestFromHtml, readSceneMotion } from './motion-manifest.mjs';
import { validateMotionInputs } from '../../src/motion.mjs';
import { readProjectFilm, withProjectFilmEdit } from './film.mjs';
import { inside, listFiles } from './files.mjs';
import { HttpError } from './http.mjs';
import { saveClip, takeSaved } from './saved.mjs';

const SDK_PATH = 'video-creation-motion/motion.mjs';
const SDK_MAX_BYTES = 4 * 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** 工程里未声明 manifest 的页面仍是有效的自由场景，不被强制变成模板。 */
export async function inspectProjectMotion(root, clipId) {
  const film = await readProjectFilm(root);
  if (!film.value) throw new HttpError(422, film.problems.join('\n'));
  const clips = film.value.tracks.flatMap((track) => track.clips).filter((clip) => clipId === undefined || clip.id === clipId);
  if (clipId !== undefined && !clips.length) throw new HttpError(404, '找不到此影片片段。');
  const entries = [];
  for (const clip of clips) {
    if (!/\.html?$/i.test(clip.src)) continue;
    try {
      const scene = await readSceneMotion(root, clip.src);
      const problems = scene.manifest || clip.motion ? validateMotionInputs(scene.manifest, clip.motion) : [];
      entries.push({ clip: clip.id, src: clip.src, motion: clip.motion ?? null, ...scene, problems });
    } catch (error) { entries.push({ clip: clip.id, src: clip.src, motion: clip.motion ?? null, manifest: null, problems: [error.message] }); }
  }
  return { rev: film.rev, clips: entries };
}

/** 复用项目已有页面发现范围，返回实际参数 Schema，不复制或执行任意第三方代码。 */
export async function catalogProjectMotion(root) {
  const film = await readProjectFilm(root);
  const { pages } = await listFiles(root);
  if (pages.length > 500) throw new HttpError(422, '项目页面超过 500 个，请拆分项目后再发现动效构件。');
  const entries = [], problems = [];
  for (const page of pages) {
    try {
      const scene = await readSceneMotion(root, page.path);
      if (scene.manifest) entries.push({ source: 'project', src: page.path, ...scene });
    } catch (error) { problems.push({ src: page.path, error: error.message }); }
  }
  const builtins = await builtinMotionCatalog();
  entries.push(...builtins.map(({ root: _root, clip: _clip, ...entry }) => entry));
  return { rev: film.rev, components: entries, problems, scope: 'project-and-builtin', limitations: ['项目页面复用编辑器的发现范围：非隐藏目录、最多三级；内置构件来自本应用固定材料，不下载外部模板。'] };
}

const BUILTIN_ROOT = fileURLToPath(new URL('../../../../examples/general-motion/', import.meta.url));
async function builtinMotionCatalog() {
  let folders;
  try { folders = await readdir(BUILTIN_ROOT, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const folder of folders) {
    if (!folder.isDirectory() || folder.name.startsWith('.')) continue;
    const root = join(BUILTIN_ROOT, folder.name);
    const film = await readProjectFilm(root);
    for (const clip of film.value?.tracks.flatMap((track) => track.clips) ?? []) {
      if (!/\.html?$/i.test(clip.src)) continue;
      const scene = await readSceneMotion(root, clip.src);
      if (scene.manifest) result.push({ source: 'builtin', ref: `${folder.name}/${clip.id}`, src: clip.src, ...scene, root, clip });
    }
  }
  return result;
}

/** 内置构件沿 Saved 的依赖闭包导入，调用者再按真实 revision 决定插入位置。 */
export async function takeBuiltinMotion(root, base, component) {
  if (typeof base !== 'string' || !/^[a-f0-9]{16}$/.test(base) || typeof component !== 'string' || !component || component.length > 400) throw new HttpError(400, '构件导入需要真实 base 与 catalog 返回的 component ref。');
  return withProjectFilmEdit(root, async () => {
    const film = await readProjectFilm(root);
    if (film.rev !== base) throw new HttpError(409, '影片已变更，请重读后导入构件。', { rev: film.rev });
    const entry = (await builtinMotionCatalog()).find((item) => item.ref === component);
    if (!entry) throw new HttpError(404, '找不到当前材料中的动效构件，请重新读取 catalog。');
    const saved = await saveClip(entry.root, entry.clip.id, { name: entry.manifest.name, into: 'saved/内置动效' });
    const taken = await takeSaved(root, saved);
    if (!('clip' in taken)) throw new HttpError(422, '构件资源导入没有返回页面片段。');
    const current = await readProjectFilm(root);
    if (current.rev !== film.rev) throw new HttpError(409, '影片在导入期间发生变更；资源已保留，请重读后决定插入位置。', { rev: current.rev, imported: taken });
    return { rev: current.rev, ...taken, component, saved };
  });
}

/** 固定 MIT SDK 只复制一次；现存不同字节须显式处理，不覆盖用户依赖。 */
export async function installProjectMotionSdk(root, base) {
  if (typeof base !== 'string' || !/^[a-f0-9]{16}$/.test(base)) throw new HttpError(400, 'SDK 安装必须携带 inspect 返回的真实 revision。');
  return withProjectFilmEdit(root, async () => {
    const film = await readProjectFilm(root);
    if (film.rev !== base) throw new HttpError(409, '影片已变更，请重新读取后安装 SDK。', { rev: film.rev });
    const source = fileURLToPath(new URL('../ui/dist/motion.mjs', import.meta.url));
    let bytes;
    try { bytes = await readFile(source); } catch { throw new HttpError(503, '固定动效 SDK 尚未构建，请先构建应用材料。'); }
    if (!bytes.length || bytes.length > SDK_MAX_BYTES || !bytes.toString('utf8').includes('MIT')) throw new HttpError(503, '固定动效 SDK 缺少完整构建或 MIT 来源声明。');
    const dir = inside(root, 'video-creation-motion');
    const target = inside(root, SDK_PATH);
    const dirInfo = await lstat(dir).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (dirInfo && (!dirInfo.isDirectory() || dirInfo.isSymbolicLink())) throw new HttpError(409, '项目 SDK 目录不是普通本地目录，已保留原内容。');
    const info = await lstat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (info) {
      if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(409, '项目 SDK 路径不是普通文件，已保留原内容。');
      if (!(await readFile(target)).equals(bytes)) throw new HttpError(409, '项目已有不同版本的动效 SDK，已保留原文件；请在确认兼容后明确备份或迁移。');
      const current = await readProjectFilm(root);
      if (current.rev !== film.rev) throw new HttpError(409, '影片在核对 SDK 时发生变更，请重读后再试。', { rev: current.rev });
      return { rev: current.rev, path: SDK_PATH, sha256: digest(bytes), bytes: bytes.length, installed: false, license: 'MIT' };
    }
    await mkdir(dir, { recursive: true });
    const finalDir = await lstat(dir);
    if (!finalDir.isDirectory() || finalDir.isSymbolicLink() || inside(root, SDK_PATH) !== target) throw new HttpError(409, '项目 SDK 目录在准备期间发生变更。');
    if ((await readProjectFilm(root)).rev !== film.rev) throw new HttpError(409, '影片在准备 SDK 时发生变更，请重读后再试。');
    let handle;
    try {
      handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o644);
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      if (handle) { await handle.close(); handle = undefined; await rm(target, { force: true }); }
      if (error.code === 'EEXIST') throw new HttpError(409, '项目 SDK 在安装期间发生变更，已保留现存文件。');
      throw error;
    } finally { await handle?.close(); }
    const current = await readProjectFilm(root);
    if (current.rev !== film.rev) throw new HttpError(409, '影片在 SDK 安装期间发生变更；固定 SDK 已保留，请重读后再试。', { rev: current.rev, path: SDK_PATH, installed: true });
    return { rev: current.rev, path: SDK_PATH, sha256: digest(bytes), bytes: bytes.length, installed: true, license: 'MIT' };
  });
}
