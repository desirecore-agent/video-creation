/** 视频创作的运行边界；所有可调配置均经过同目录 Draft-07 Schema 校验。 */
import Ajv from 'ajv';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, delimiter } from 'node:path';

export const APP_ID = 'video-creation';
export const APP_NAME = '视频创作';
export const IDENTITY_PATH = '/api/desirecore/runtime-identity';
export const schema = JSON.parse(readFileSync(new URL('./config.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ allErrors: true }).compile(schema);

export function runtimeConfig(overrides = {}, env = process.env) {
  // 正式/预览 owner 注入的独立数据根优先于候选命令里固化的 --home。
  const home = resolve(env.APP_DATA_DIR ?? env.APP_DATA_ROOT ?? env.DESIRECORE_APP_DATA_DIR ?? env.DESIRECORE_APP_DATA_ROOT ?? overrides.home ?? env.VIDEO_CREATION_HOME ?? join(homedir(), '.video-creation'));
  const file = join(home, 'runtime-config.json');
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const data = {
    port: 0, renderFps: 30, renderQuality: 'standard', prepareTimeoutMs: 15 * 60_000, ...saved,
    ...(env.VIDEO_DIRECTOR_AGENT_ID ? { directorAgentId: env.VIDEO_DIRECTOR_AGENT_ID } : {}),
    ...(overrides.port !== undefined ? { port: Number(overrides.port) } : {}),
    ...(env.PORT ? { port: Number(env.PORT) } : {}),
  };
  if (!validate(data)) throw new Error(`视频创作运行配置无效：${new Ajv().errorsText(validate.errors)}`);
  return { ...data, home };
}

/** 为本次应用/安装子进程构造环境，不修改调用者；显式 Playwright 路径交给 SDK 解释（包括 0 和相对路径）。 */
export function runtimeEnvironment(config, env = process.env) {
  const result = { ...env, VIDEO_CREATION_HOME: config.home, OPENFILM_HOME: config.home,
    OPENFILM_NO_UPDATE_CHECK: '1', OPENFILM_NO_BROWSER: '1',
    PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH || join(config.home, 'runtime', 'ms-playwright') };
  if (config.directorAgentId) result.VIDEO_DIRECTOR_AGENT_ID = config.directorAgentId;
  const media = join(config.home, 'runtime', 'ffmpeg-b6.1.1');
  if (existsSync(media) && !(result.PATH ?? '').split(delimiter).includes(media)) result.PATH = `${media}${delimiter}${result.PATH ?? ''}`;
  return result;
}

/** 仅由应用 CLI 自己的进程初始化；父平台进程环境不变。须在首次渲染 SDK 导入前调用。 */
export function applyRuntimeEnvironment(config) {
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  Object.assign(process.env, runtimeEnvironment(config));
}

export function runtimeIdentity(env = process.env) {
  const values = ['DESIRECORE_APP_RUNTIME_PROOF', 'DESIRECORE_APP_RELEASE_DIGEST', 'DESIRECORE_APP_SCOPE_ID', 'DESIRECORE_APP_RUNTIME_GENERATION'].map((key) => env[key]);
  if (!values.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 512)) return null;
  const [proof, releaseDigest, scopeId, runtimeGeneration] = values;
  return { proof, releaseDigest, scopeId, runtimeGeneration };
}

/** 仅受管应用的顶层原生导航引导已有 Studio 登录；跨站嵌入不能换取本地密钥。 */
export function managedDocumentNavigation(headers, env = process.env) {
  return runtimeIdentity(env) !== null && headers['sec-fetch-dest'] === 'document'
    && headers['sec-fetch-site'] === 'none' && headers['sec-fetch-mode'] === 'navigate'
    && !headers.origin && !headers.referer;
}
