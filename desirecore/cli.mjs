#!/usr/bin/env node
/** 视频创作正式入口。复用上游 Studio 与影片内核，CLI 和 MCP 都走同一服务提交编辑。 */
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { runtimeConfig, applyRuntimeEnvironment, runtimeIdentity, managedDocumentNavigation } from './config.mjs';
import { projectClient } from './client.mjs';
import { acquireApplicationLock } from './application-lock.mjs';
import { normalizeVideoExportOptions } from '../packages/openfilm/studio/server/video-export-options.mjs';

export const HELP = `视频创作 — 本地影片编辑与视频导演协作

node desirecore/cli.mjs <命令> [项目目录] [选项]
  start [--project <目录>] [--port 0] [--no-browser]   启动编辑器和后台服务
  setup-runtime                                    准备本机 FFmpeg 与 Chromium
  inspect <项目>                                    读取影片、片段和真实 revision
  motion-catalog <项目>                            发现项目与内置构件及其参数 Schema
  motion-inspect <项目> [片段ID]                    读取动效实例、场景契约与真实 revision
  motion-install <项目> --base <revision>          复制固定 MIT SDK 到工程，不联网下载
  motion-take <项目> <构件ref> --base <revision>    导入内置构件依赖，返回可插入的 clip
  motion-patch <项目> <片段ID> --base <revision> --ops <JSON文件>
                                                   按字段、属性轨和事件 ID 局部编辑
  patch <项目> --base <revision> --ops <JSON文件>     按基线提交结构化编辑
  check <项目> [时间或范围]                          抽帧并检查确定性与资源
  get <项目> [媒体动词] --args <JSON文件>             复用已连接媒体服务；无动词时只读能力目录
    --via <provider> --model <model>                明确选择服务与模型；不从参数读取密钥
  render <项目> [--output <目录>] [--wait]           提交固定输入的视频导出
    --codec <h264|hevc|vp9|prores422hq|prores4444|hevc_alpha|png>
    --alpha --fps <30|30000/1001> --quality <standard|high|master>
    --frame <native|9:16> --fill <contain|cover> --short-edge <像素>
    --width <偶数像素> --height <偶数像素> --range <起秒-止秒>
    --clip <片段ID> --scale <0.25-4> --samples <1-32> --shutter <0-1>
    --no-audio --no-hardware --burn-subtitles --sidecar <srt|vtt>
  jobs <项目>                                      查看持久化导出记录
  retry <项目> <任务ID>                             明确重试，生成新任务
  cancel <项目> <任务ID>                            取消精确导出任务
  mcp --project <项目>                              标准输入输出 MCP 服务

所有命令支持 --home <应用数据目录>。check 需 FFmpeg 和匹配的 Playwright Chromium。
应用不会自动安装收费服务或连接原版更新源。`;

export function argumentsOf(args) {
  return parseArgs({ args, allowPositionals: true, options: {
    home: { type: 'string' }, project: { type: 'string' }, port: { type: 'string' },
    'no-browser': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    base: { type: 'string' }, ops: { type: 'string' }, output: { type: 'string' },
    args: { type: 'string' }, via: { type: 'string' }, model: { type: 'string' },
    wait: { type: 'boolean' }, fps: { type: 'string' }, timeout: { type: 'string' },
    codec: { type: 'string' }, alpha: { type: 'boolean' }, quality: { type: 'string' },
    frame: { type: 'string' }, fill: { type: 'string' }, 'short-edge': { type: 'string' },
    width: { type: 'string' }, height: { type: 'string' }, range: { type: 'string' },
    clip: { type: 'string' }, scale: { type: 'string' }, samples: { type: 'string' }, shutter: { type: 'string' },
    'no-audio': { type: 'boolean' }, 'no-hardware': { type: 'boolean' }, 'burn-subtitles': { type: 'boolean' }, sidecar: { type: 'string' },
  } });
}

/** CLI 只做语法转换，领域参数与 HTTP/MCP 使用同一校验。 */
export function renderOptionsOf(values) {
  const options = {};
  for (const key of ['codec', 'quality', 'frame', 'fill', 'clip', 'sidecar']) if (values[key] !== undefined) options[key] = values[key];
  for (const key of ['width', 'height', 'scale', 'samples', 'shutter']) if (values[key] !== undefined) options[key] = Number(values[key]);
  if (values['short-edge'] !== undefined) options.shortEdge = Number(values['short-edge']);
  if (values.fps !== undefined) options.fps = values.fps.includes('/') ? values.fps : Number(values.fps);
  if (values.range !== undefined) {
    const match = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(values.range);
    if (!match) throw new Error('视频导出参数无效：--range 使用起秒-止秒，例如 0-3.5。');
    options.range = [Number(match[1]), Number(match[2])];
  }
  if (values.alpha !== undefined) options.alpha = values.alpha;
  if (values['no-audio']) options.audio = false;
  if (values['no-hardware']) options.hardware = false;
  if (values['burn-subtitles']) options.burnSubtitles = true;
  return normalizeVideoExportOptions(options);
}

export async function waitForJob(client, id, { timeoutMs = 30 * 60_000, intervalMs = 500 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 12 * 60 * 60_000) throw new Error('等待时间必须在 1 毫秒到 12 小时之间。');
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const job = (await client.jobs()).find((entry) => entry.id === id);
    if (!job) throw new Error('导出记录已不可用。');
    if (['done', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job;
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  throw new Error(`等待超时；导出 ${id} 仍由后台管理，可用 jobs 查询。`);
}

export async function start(config, options = {}) {
  applyRuntimeEnvironment(config);
  const releaseLock = await acquireApplicationLock(config.home);
  let studio;
  try {
    const { startStudio, opener } = await import('../packages/openfilm/studio/server/server.mjs');
    const { studioHome } = await import('../packages/openfilm/studio/server/projects.mjs');
    studio = await startStudio({ port: config.port, advertise: true, key: randomBytes(24).toString('hex'), stays: true,
      openBrowser: () => {}, runtimeIdentity, managedDocumentNavigation, directorAgentId: config.directorAgentId });
    const response = await fetch(`${studio.origin}/api/open`, { method: 'POST', headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, body: JSON.stringify({ ...(options.project ? { path: resolve(options.project) } : {}), fallback: 0 }) });
    if (!response.ok) throw new Error(`无法打开项目：${await response.text()}`);
    const opened = await response.json();
    const descriptor = { app: 'video-creation', pid: process.pid, origin: studio.origin, filmOrigin: studio.filmOrigin, url: opened.url, ...(opened.project ? { project: opened.project } : {}), home: studioHome() };
    writeFileSync(join(config.home, 'application.json'), `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(descriptor)}\n`);
    if (!options.noBrowser) {
      const [program, ...args] = opener(opened.url);
      spawn(program, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
    }
    let ending = false;
    const close = async () => {
      if (ending) return;
      ending = true;
      try { await studio.close(); } finally { releaseLock(); }
    };
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
    process.once('exit', releaseLock);
    return { ...studio, close };
  } catch (error) {
    try { await studio?.close(); } finally { releaseLock(); }
    throw error;
  }
}

export async function command(args, output = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)) {
  const { values, positionals } = argumentsOf(args);
  const [name, folder, target] = positionals;
  if (values.help || !name) { process.stdout.write(`${HELP}\n`); return; }
  const config = runtimeConfig(values);
  applyRuntimeEnvironment(config);
  if (name === 'setup-runtime') return output(await (await import('./setup-runtime.mjs')).setupRuntime(config));
  if (name === 'start') return start(config, { project: values.project ?? folder, noBrowser: values['no-browser'] });
  if (name === 'mcp') {
    if (!values.project && !folder) throw new Error('MCP 必须绑定明确的 --project。');
    return (await import('./mcp.mjs')).serveMcp(config, resolve(values.project ?? folder));
  }
  if (!['inspect', 'patch', 'check', 'get', 'render', 'jobs', 'retry', 'cancel', 'motion-catalog', 'motion-inspect', 'motion-install', 'motion-take', 'motion-patch'].includes(name)) throw new Error(`未知命令：${name}；运行 --help 查看用法。`);
  const client = await projectClient(config, folder);
  if (name === 'inspect') return output(await client.inspect());
  if (name === 'get') {
    if (!target) return output(await client.mediaCatalog());
    if (!values.args) throw new Error('get 需要 --args JSON 文件；文件只包含媒体参数，不包含密钥。');
    const args = JSON.parse(readFileSync(resolve(values.args), 'utf8'));
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('get --args 必须是媒体参数 JSON 对象。');
    const result = await client.getMedia(target, args, { via: values.via, model: values.model });
    output(result);
    if (!result.ok) process.exitCode = result.code === 2 ? 2 : 1;
    return;
  }
  if (name === 'motion-catalog') return output(await client.motionCatalog());
  if (name === 'motion-inspect') return output(await client.motionInspect(target));
  if (name === 'motion-install') return output(await client.motionInstall(values.base));
  if (name === 'motion-take') {
    if (!target) throw new Error('请提供 motion-catalog 返回的内置构件 ref。');
    return output(await client.motionTake(values.base, target));
  }
  if (name === 'motion-patch') {
    if (!target || !values.ops) throw new Error('motion-patch 需要片段 ID 与 --ops changes JSON 文件。');
    return output(await client.motionPatch(values.base, target, JSON.parse(readFileSync(resolve(values.ops), 'utf8'))));
  }
  if (name === 'patch') {
    if (!values.ops) throw new Error('patch 需要 --ops JSON 文件。');
    return output(await client.patch(values.base, JSON.parse(readFileSync(resolve(values.ops), 'utf8'))));
  }
  if (name === 'check') {
    const { look } = await import('../packages/openfilm/src/look.mjs');
    const result = await look([client.project.path, ...(target ? [target] : [])], { count: 6 });
    output(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (name === 'jobs') return output(await client.jobs());
  if ((name === 'retry' || name === 'cancel') && !target) throw new Error('请明确导出任务 ID。');
  if (name === 'retry') return output(await client.retry(target));
  if (name === 'cancel') return output(await client.cancel(target));
  const job = await client.render(renderOptionsOf(values), values.output);
  const result = values.wait ? await waitForJob(client, job.id, { timeoutMs: Number(values.timeout ?? 1800) * 1000 }) : job;
  output(result);
  if (values.wait && result.status !== 'done') process.exitCode = 1;
}

// 目录链接和 /tmp 别名需比较实际文件；stdin 或普通 import 不应执行命令。
function isDirectEntry() {
  const entry = process.argv[1];
  if (!entry || entry === '-' || !existsSync(entry)) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(entry)); }
  catch { return false; }
}

if (isDirectEntry()) {
  command(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.status === 409 ? 3 : 1;
  });
}
