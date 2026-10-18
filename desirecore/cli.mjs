#!/usr/bin/env node
/** 视频创作正式入口。复用上游 Studio 与影片内核，CLI 和 MCP 都走同一服务提交编辑。 */
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, readFileSync as read, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { runtimeConfig, applyRuntimeEnvironment, runtimeIdentity, managedDocumentNavigation } from './config.mjs';
import { projectClient } from './client.mjs';

export const HELP = `视频创作 — 本地影片编辑与视频导演协作

node desirecore/cli.mjs <命令> [项目目录] [选项]
  start [--project <目录>] [--port 0] [--no-browser]   启动编辑器和后台服务
  setup-runtime                                    准备本机 FFmpeg 与 Chromium
  inspect <项目>                                    读取影片、片段和真实 revision
  patch <项目> --base <revision> --ops <JSON文件>     按基线提交结构化编辑
  check <项目> [时间或范围]                          抽帧并检查确定性与资源
  render <项目> [--output <目录>] [--wait]           提交固定输入的视频导出
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
    wait: { type: 'boolean' }, fps: { type: 'string' }, timeout: { type: 'string' },
  } });
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
  const lock = join(config.home, 'application.lock');
  const nonce = randomBytes(16).toString('hex');
  if (existsSync(lock)) {
    let old;
    try { old = JSON.parse(read(lock, 'utf8')); } catch { throw new Error('应用锁记录损坏，请检查数据目录，不会自动覆盖。'); }
    try { process.kill(old.pid, 0); throw new Error('此数据目录的视频创作已在运行，请使用已有实例或另选 --home。'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    unlinkSync(lock);
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx', mode: 0o600 });
  let studio;
  const releaseLock = () => {
    try { if (JSON.parse(read(lock, 'utf8')).nonce === nonce) unlinkSync(lock); } catch { /* 不能删除后来实例的锁 */ }
  };
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
      await studio.close();
      releaseLock();
    };
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
    process.once('exit', releaseLock);
    return { ...studio, close };
  } catch (error) {
    await studio?.close();
    releaseLock();
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
  if (!['inspect', 'patch', 'check', 'render', 'jobs', 'retry', 'cancel'].includes(name)) throw new Error(`未知命令：${name}；运行 --help 查看用法。`);
  const client = await projectClient(config, folder);
  if (name === 'inspect') return output(await client.inspect());
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
  const fps = Number(values.fps ?? config.renderFps);
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error('fps 必须是 1 到 60 的整数。');
  const job = await client.render({ fps }, values.output);
  const result = values.wait ? await waitForJob(client, job.id, { timeoutMs: Number(values.timeout ?? 1800) * 1000 }) : job;
  output(result);
  if (values.wait && result.status !== 'done') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  command(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.status === 409 ? 3 : 1;
  });
}
