/** CLI/MCP 与同一个 Studio 实例协作，避免另起进程绕过编辑串行与版本缓存。 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { normalizeVideoExportOptions } from '../packages/openfilm/studio/server/video-export-options.mjs';

export async function connectStudio(config, request = fetch) {
  let run;
  try { run = JSON.parse(await readFile(join(config.home, 'run.json'), 'utf8')); }
  catch { throw new Error('视频创作尚未启动。请先运行 start，或在 DesireCore 中打开应用。'); }
  const origin = new URL(run.origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || typeof run.key !== 'string' || !/^[a-f0-9]{48}$/.test(run.key)) throw new Error('本地运行记录无效，请重新启动视频创作。');
  const call = async (path, body, method = body === undefined ? 'GET' : 'POST', { timeoutMs = 30_000, unknownReceipt = false } = {}) => {
    if (!path.startsWith('/api/')) throw new Error('无效的视频创作操作路径。');
    let response;
    try {
      response = await request(new URL(path, origin), {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'x-studio-key': run.key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (unknownReceipt) throw new Error('未取得导出提交回执，结果未知；后台可能仍在准备或导出。请先用 jobs 查询，勿直接重复提交。', { cause: error });
      throw error;
    }
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error ?? `视频创作返回 ${response.status}`);
      error.status = response.status;
      error.details = result;
      throw error;
    }
    return result;
  };
  const health = await call('/api/health');
  const home = createHash('sha256').update(resolve(config.home)).digest('hex');
  if (health.product !== 'video-creation-studio' || health.home !== home) throw new Error('运行记录属于另一个应用或数据目录，已停止连接。');
  return { call, origin: origin.origin };
}

export async function projectClient(config, folder, options) {
  if (!folder) throw new Error('请明确影片项目目录。');
  const studio = await connectStudio(config, options?.request);
  const { project } = await studio.call('/api/projects', { path: resolve(folder), create: false });
  const base = `/api/projects/${encodeURIComponent(project.id)}`;
  return { ...studio, project, base,
    inspect: () => studio.call(base),
    mediaCatalog: (verb) => studio.call(`/api/get${verb ? `?verb=${encodeURIComponent(verb)}` : ''}`),
    getMedia: async (verb, args, { via, model } = {}) => {
      try {
        // Studio already checks provider options, authorisation and where files land. Do not create a second media executor.
        return await studio.call('/api/get', { folder: project.path, verb, args, ...(via ? { via } : {}), ...(model ? { model } : {}) }, 'POST', { timeoutMs: 7 * 60_000 });
      } catch (error) {
        if (error?.status) throw error;
        throw new Error('未取得媒体生成回执，结果未知；服务可能已经收到请求。请先检查工程素材和现有回执，勿直接重复付费调用。');
      }
    },
    motionCatalog: () => studio.call(`${base}/motion/catalog`),
    motionInspect: (clip) => studio.call(`${base}/motion${clip ? `?clip=${encodeURIComponent(clip)}` : ''}`),
    motionInstall: (revision) => studio.call(`${base}/motion/sdk`, { base: revision }),
    motionTake: (revision, component) => studio.call(`${base}/motion/take`, { base: revision, component }),
    motionPatch: (revision, clip, changes) => studio.call(`${base}/motion`, { base: revision, clip, changes }, 'PATCH'),
    patch: (revision, ops) => {
      if (typeof revision !== 'string' || !/^[a-f0-9]{16}$/.test(revision)) throw new Error('patch 必须携带 inspect 返回的真实 revision。');
      if (!Array.isArray(ops) || !ops.length || ops.length > 1000) throw new Error('patch 需要 1 到 1000 项明确操作。');
      return studio.call(`${base}/edit`, { base: revision, ops });
    },
    sceneRead: (ask) => studio.call(`${base}/scene/read`, ask),
    sceneRevise: async (ask) => {
      try { return await studio.call(`${base}/scene/revise`, ask); }
      catch (error) {
        if (error?.status) throw error;
        // 断连不证明服务端未发布或未换源；不自动重复不可确定结果的修改。
        throw new Error('未取得场景修订回执，结果未知；新源码可能已发布或影片已换源。请先 scene-read/inspect 查询当前源与版本，勿直接重复提交。', { cause: error });
      }
    },
    review: (ask) => studio.call(`${base}/reviews`, ask, 'POST', { timeoutMs: 10 * 60_000 }),
    reviewReceipt: (id) => studio.call(`${base}/reviews/${encodeURIComponent(id)}`),
    jobs: async () => (await studio.call(`${base}/exports?statusOnly=1`)).exports,
    render: async (ask = {}, folder) => (await studio.call(`${base}/exports`, { jobs: [{ kind: 'video', ...normalizeVideoExportOptions({ fps: config.renderFps ?? 30, quality: config.renderQuality ?? 'standard', ...ask }) }], ...(folder ? { folder: resolve(folder) } : {}) }, 'POST', { timeoutMs: config.prepareTimeoutMs ?? 15 * 60_000, unknownReceipt: true })).exports[0],
    retry: (id) => studio.call(`${base}/exports/${encodeURIComponent(id)}/retry`, {}, 'POST', { timeoutMs: config.prepareTimeoutMs ?? 15 * 60_000, unknownReceipt: true }),
    cancel: (id) => studio.call(`${base}/exports/${encodeURIComponent(id)}`, undefined, 'DELETE'),
  };
}
