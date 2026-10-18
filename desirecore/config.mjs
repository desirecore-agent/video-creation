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

export function applyRuntimeEnvironment(config) {
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  process.env.VIDEO_CREATION_HOME = config.home;
  // 兼容原内核环境接口，所有数据仍写入此应用独立的 home。
  process.env.OPENFILM_HOME = config.home;
  process.env.OPENFILM_NO_UPDATE_CHECK = '1';
  process.env.OPENFILM_NO_BROWSER = '1';
  if (config.directorAgentId) process.env.VIDEO_DIRECTOR_AGENT_ID = config.directorAgentId;
  const media = join(config.home, 'runtime', 'ffmpeg-b6.1.1');
  if (existsSync(media) && !(process.env.PATH ?? '').split(delimiter).includes(media)) process.env.PATH = `${media}${delimiter}${process.env.PATH ?? ''}`;
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
