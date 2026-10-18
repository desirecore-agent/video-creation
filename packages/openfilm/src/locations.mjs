// @ts-check
/**
 * Where OpenFilm keeps the person's work on this computer: the projects library (where new projects go) and the
 * exports folder. The library has a default and may be moved in Studio's Settings → General: Studio's `prefs.json`
 * (`projectsFolder`), read by Studio and by the `openfilm` command alike, so a project fetched from the command line
 * lands where Studio's go. OPENFILM_LIBRARY sets the default (a build, or a Studio kept apart); what the person chose
 * comes first. Projects made before stay where they are: the projects list knows them by their folder. Exports go to
 * the folder picked when exporting (the export dialog keeps the last one), else to the exports default.
 *
 * Reads no Studio module, so the command can use it.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { PRODUCT } from './product.mjs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** 独立实例的数据根：兼容 OPENFILM_HOME，默认 ~/.video-creation。 */
export const studioHomeDir = () => process.env.OPENFILM_HOME || join(homedir(), PRODUCT.dataDirectory);

/** 每个实例有自己的作品库；显式设置的环境或用户偏好仍可选择外部目录。 */
export const libraryDefault = () => process.env.OPENFILM_LIBRARY
  || join(studioHomeDir(), 'projects');

/**
 * 导出默认归本实例的数据根；显式环境或导出对话框可选其他位置。
 */
export const exportsDefault = () => process.env.OPENFILM_EXPORTS
  || join(studioHomeDir(), 'exports');

/**
 * 收藏属于实例，不随作品库设置移动；显式 OPENFILM_SAVED 仍可选择外部收藏库。
 */
export const savedRoot = () => process.env.OPENFILM_SAVED || join(studioHomeDir(), 'saved');

/**
 * 未创建的路径也按最近存在的祖先解析真实位置，统一 /tmp 等别名并识别符号链接。
 * 检查本身不创建目录，防止拒绝内部状态路径前已经在该处写入内容。
 * @param {string} path @returns {string}
 */
export function canonicalLocation(path) {
  let at = resolve(path);
  const missing = [];
  while (!existsSync(at) && dirname(at) !== at) {
    missing.unshift(basename(at));
    at = dirname(at);
  }
  return join(realpathSync(at), ...missing);
}

/**
 * 数据根中的项目只进入明确的 projects 业务子树，其余目录留给密钥、偏好、运行时和任务状态。
 * 以数据根的真实位置拼接 projects，不能把指向 runtime 的 projects 符号链接当成允许的业务目录。
 * 根目录可作为作品库，但不能把整个作品库打开成单部影片。
 * @param {string} path @param {{ project?: boolean }} [options]
 */
export function protectedStudioLocation(path, { project = false } = {}) {
  const own = canonicalLocation(studioHomeDir());
  const at = canonicalLocation(path);
  if (at !== own && !at.startsWith(own + sep)) return false;
  const projects = join(own, 'projects');
  return !(at.startsWith(projects + sep) || (!project && at === projects));
}

/** The folders the person can choose, by their key in prefs.json. */
export const LOCATION_KEYS = /** @type {const} */ ({ projects: 'projectsFolder' });

/** A folder the person chose, as kept in prefs.json: an absolute path, or null (none chosen, or not one). */
export function chosenFolder(/** @type {'projectsFolder'} */ key) {
  try {
    const value = JSON.parse(readFileSync(join(studioHomeDir(), 'prefs.json'), 'utf8'))?.[key];
    return typeof value === 'string' && isAbsolute(value) ? resolve(value) : null;
  } catch {
    return null;
  }
}

/** Where new projects go: the folder the person chose, else the default. */
export const libraryRoot = () => chosenFolder('projectsFolder') ?? libraryDefault();

/** Where exports go when no folder is picked. */
export const exportsRoot = () => exportsDefault();

/** The free space, in bytes, on the disk a folder is on (the folder, or the nearest one above it that is there), or null. */
export function freeSpace(/** @type {string} */ folder) {
  let at = resolve(folder);
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  try {
    const s = statfsSync(at);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/**
 * Each folder the person can choose, for Settings: where it is now, its default, whether it was chosen, and the free
 * space on its disk.
 */
export function locations() {
  const one = (/** @type {string} */ path, /** @type {string} */ fallback, /** @type {boolean} */ chosen) => ({ path, default: fallback, chosen, free: freeSpace(path) });
  return {
    projects: one(libraryRoot(), libraryDefault(), chosenFolder('projectsFolder') !== null),
  };
}

/**
 * 可选项目库：绝对路径、非磁盘根；实例内仅允许 projects 子树，外部目录仍可显式选择。
 * @param {unknown} value @returns {string}
 */
export function usableFolder(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Choose a folder by its full path.');
  const path = resolve(value);
  if (dirname(path) === path) throw new Error('Choose a folder on that disk, not the disk itself.');
  if (protectedStudioLocation(path)) throw new Error(`${PRODUCT.displayName} keeps its own settings there: choose its projects folder or another folder.`);
  try {
    mkdirSync(path, { recursive: true });
    if (protectedStudioLocation(path)) throw new Error('Studio state is not a project library.');
    accessSync(path, constants.W_OK);
  } catch {
    throw new Error('That folder cannot be written to: choose another one.');
  }
  return path;
}
