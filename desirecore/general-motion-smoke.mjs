#!/usr/bin/env node
/** 有界的通用动效实跑：正式求帧、服务编辑、MCP、Saved 与持久导出队列使用同一工程。 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { arch, platform, release, version } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { projectClient, connectStudio } from './client.mjs';
import { applyRuntimeEnvironment, runtimeConfig } from './config.mjs';
import { FilmPage, launch, serve } from '../packages/openfilm/src/host.mjs';
import { filmHtml } from '../packages/openfilm/src/film-doc.mjs';
import { sampleNames } from '../examples/general-motion/prepare-samples.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'desirecore', 'cli.mjs');
const terminal = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const clean = (error) => String(error?.message ?? error).replace(/([?&](?:key|token)=)[^&\s]+/gi, '$1[redacted]').replace(/("(?:key|proof)"\s*:\s*")[^"]+/gi, '$1[redacted]').slice(-6000);
const command = (program, args, options = {}) => execFileSync(program, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 32 << 20, ...options });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashFile = async (path) => { const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex'); };
const deadline = (promise, ms, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`${label} 超过 ${ms} 毫秒`)), ms); })]).finally(() => clearTimeout(timer));
};

/** ffprobe 必须证明编码、尺寸、时间和实际帧数；文件名或成功回执不能替代媒体检查。 */
export function verifyMotionProbe(probe, { codec = 'h264', width = 320, height = 180, fps = 12, duration = 2, audio = false } = {}) {
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  assert.ok(video, '没有视频流'); assert.equal(video.codec_name, codec); assert.equal(video.width, width); assert.equal(video.height, height);
  const [n, d = 1] = String(video.avg_frame_rate).split('/').map(Number);
  assert.ok(Math.abs(n / d - fps) < 1e-5, `帧率不符：${video.avg_frame_rate}`);
  const count = Number(video.nb_read_frames ?? video.nb_frames);
  assert.equal(count, Math.round(duration * fps), `实际帧数不符：${count}`);
  assert.ok(Math.abs(Number(probe.format?.duration) - duration) <= 1 / fps + 0.025, `时长不符：${probe.format?.duration}`);
  if (audio) assert.ok(probe.streams.some((stream) => stream.codec_type === 'audio'), '缺少应有的声音流');
  return { codec: video.codec_name, pixelFormat: video.pix_fmt, width, height, fps: n / d, frames: count, duration: Number(probe.format.duration), audio: probe.streams.filter((stream) => stream.codec_type === 'audio').map((stream) => ({ codec: stream.codec_name, sampleRate: Number(stream.sample_rate), start: Number(stream.start_time ?? 0) })) };
}

/** 逐像素差异在同一机器上比较，允许少量边缘栅格化误差，不把跨系统字体差别当作确定性失败。 */
export function pixelDifference(a, b, threshold = 4) {
  assert.equal(a.length, b.length, '像素缓冲尺寸不一致'); assert.ok(a.length > 0 && a.length % 3 === 0, '需要 RGB 像素');
  let total = 0, changed = 0;
  for (let i = 0; i < a.length; i += 3) {
    let differs = false;
    for (let c = 0; c < 3; c++) { const d = Math.abs(a[i + c] - b[i + c]); total += d; if (d > threshold) differs = true; }
    if (differs) changed++;
  }
  return { meanAbsolute: total / a.length, changedRatio: changed / (a.length / 3), threshold };
}

/** 在真实解码 PCM 的一段窗口内找能量峰；返回实际时间，调用者按该输出帧率判定误差。 */
export function energyPeak(pcm, sampleRate, { from = 0.85, to = 1.15, binMs = 4 } = {}) {
  assert.ok(Buffer.isBuffer(pcm) && pcm.length % 4 === 0 && sampleRate > 0);
  const samples = pcm.length / 4;
  const bin = Math.max(1, Math.round(sampleRate * binMs / 1000));
  const lo = Math.max(0, Math.floor(from * sampleRate)), hi = Math.min(samples, Math.ceil(to * sampleRate));
  assert.ok(hi - lo >= bin, '声音窗口过短');
  let best = { rms: -1, time: null };
  for (let start = lo; start + bin <= hi; start += bin) {
    let sum = 0;
    for (let i = start; i < start + bin; i++) { const value = pcm.readFloatLE(i * 4); assert.ok(Number.isFinite(value), 'PCM 含无效样本'); sum += value * value; }
    const rms = Math.sqrt(sum / bin);
    if (rms > best.rms) best = { rms, time: (start + bin / 2) / sampleRate };
  }
  assert.ok(best.rms > 0.005, '没有可测量的合成节拍');
  return best;
}

/** 在真实 DOM 标记边界内寻找连续两帧的 2×2 绿色块，返回最初帧而非确认帧。 */
export function firstVisibleBeat(rgb, width, height, rect) {
  const stride = width * height * 3;
  assert.ok(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && Number.isSafeInteger(stride) && Buffer.isBuffer(rgb) && rgb.length > 0 && rgb.length % stride === 0, '视频 RGB 帧不完整');
  assert.ok(rect && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key])) && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= width && rect.y + rect.height <= height, '缺少有效的真实 DOM 节拍条边界');
  // 只检查完整落在 DOM 边界内的像素，不扩张至相邻图标或背景。
  const left = Math.ceil(rect.x), top = Math.ceil(rect.y), right = Math.floor(rect.x + rect.width), bottom = Math.floor(rect.y + rect.height);
  assert.ok(right - left >= 2 && bottom - top >= 2, '节拍条边界不足以容纳完整的 2×2 像素块');
  const green = (start) => rgb[start + 1] - rgb[start] > 35 && rgb[start + 1] > 110;
  const blockAt = (frame) => {
    const base = frame * stride;
    for (let y = top; y < bottom - 1; y++) for (let x = left; x < right - 1; x++) {
      const offsets = [base + (y * width + x) * 3, base + (y * width + x + 1) * 3, base + ((y + 1) * width + x) * 3, base + ((y + 1) * width + x + 1) * 3];
      if (offsets.every(green)) return { frame, point: { x, y }, pixel: [...rgb.subarray(offsets[0], offsets[0] + 3)], pixels: offsets.map((offset) => [...rgb.subarray(offset, offset + 3)]), block: { x, y, width: 2, height: 2 } };
    }
    return null;
  };
  let previous = null;
  for (let frame = 0; frame < rgb.length / stride; frame++) {
    const current = blockAt(frame);
    if (previous && current) return { ...previous, rect: { ...rect }, confirmedByFrame: frame };
    previous = current;
  }
  throw new Error('真实视频的标记边界内没有连续两帧显现的 2×2 绿色节拍块');
}

/** 在真实场景中采集文字、主区域和主体的矩形；SVG 字号换算为最终画面像素。 */
export function collectSampleLayout() {
  const visible = (element) => {
    for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < .03) return false;
    }
    return true;
  };
  const rect = (element) => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, w: box.width, h: box.height }; };
  const subjects = [...document.querySelectorAll('[data-layout-subject]')].filter(visible);
  const texts = [...document.querySelectorAll('[data-layout-text]')].filter((element) => element.textContent.trim() && visible(element)).map((element) => ({
    id: element.id, text: element.textContent.trim(),
    font: parseFloat(getComputedStyle(element).fontSize) * (element instanceof SVGElement ? element.getScreenCTM().a : 1), rect: rect(element),
    subject: subjects.indexOf(element.closest('[data-layout-subject]')),
  }));
  return { viewport: [innerWidth, innerHeight], texts,
    boxes: [...document.querySelectorAll('[data-layout-box]')].filter(visible).map((element) => ({ id: element.id, kind: element.dataset.layoutBox, rect: rect(element) })),
    subjects: subjects.map((element, index) => ({ index, id: element.id, rect: rect(element) })),
  };
}

/** 文字须可读、在画布内，且不得遮住其他文字或无关主体；容器与自身文字的正常包含不算冲突。 */
export function verifySampleLayout(layout) {
  const [width, height] = layout.viewport;
  assert.ok(width > 0 && height > 0 && layout.texts.length > 0, '没有可验收的真实场景布局');
  const within = ({ x, y, w, h }) => x >= -.75 && y >= -.75 && x + w <= width + .75 && y + h <= height + .75;
  const intersects = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > .75 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > .75;
  for (const text of layout.texts) { assert.ok(within(text.rect), `文字越出画面：${text.text}`); assert.ok(text.font >= 7.95, `文字小于8画面像素：${text.text} (${text.font})`); }
  for (const box of [...layout.boxes, ...layout.subjects]) assert.ok(within(box.rect), `主体或区域越出画面：${box.id ?? box.kind}`);
  for (let i = 0; i < layout.texts.length; i++) for (let j = i + 1; j < layout.texts.length; j++) assert.ok(!intersects(layout.texts[i].rect, layout.texts[j].rect), `文字相互遮挡：${layout.texts[i].text} / ${layout.texts[j].text}`);
  for (let i = 0; i < layout.boxes.length; i++) for (let j = i + 1; j < layout.boxes.length; j++) assert.ok(!intersects(layout.boxes[i].rect, layout.boxes[j].rect), `主区域相互遮挡：${layout.boxes[i].kind} / ${layout.boxes[j].kind}`);
  for (let i = 0; i < layout.subjects.length; i++) for (let j = i + 1; j < layout.subjects.length; j++) assert.ok(!intersects(layout.subjects[i].rect, layout.subjects[j].rect), '主体相互遮挡');
  for (const text of layout.texts) for (const subject of layout.subjects) if (text.subject !== subject.index) assert.ok(!intersects(text.rect, subject.rect), `文字遮挡无关主体：${text.text}`);
  return { width, height, texts: layout.texts.length, subjects: layout.subjects.length, boxes: layout.boxes.length, minFontPixels: Math.min(...layout.texts.map((text) => text.font)) };
}

function childEnvironment(home) {
  const env = { ...process.env };
  for (const key of ['APP_DATA_DIR', 'APP_DATA_ROOT', 'DESIRECORE_APP_DATA_DIR', 'DESIRECORE_APP_DATA_ROOT', 'PORT', 'VIDEO_DIRECTOR_AGENT_ID', 'DESIRECORE_APP_RUNTIME_PROOF', 'DESIRECORE_APP_RELEASE_DIGEST', 'DESIRECORE_APP_SCOPE_ID', 'DESIRECORE_APP_RUNTIME_GENERATION']) delete env[key];
  return { ...env, VIDEO_CREATION_HOME: home, OPENFILM_HOME: home, OPENFILM_LIBRARY: join(home, 'projects'), OPENFILM_EXPORTS: join(home, 'exports'), OPENFILM_SAVED: join(home, 'saved'), OPENFILM_NO_BROWSER: '1', OPENFILM_NO_UPDATE_CHECK: '1' };
}
/** 正式 CLI 返回的生命周期只由本次拥有的标准输入关闭，不开放额外网络控制入口。 */
export const ownedServiceEntry = fileURLToPath(new URL('./general-motion-smoke-child.mjs', import.meta.url));
function child(args, home) {
  const wrapped = args[0] === 'start';
  const commandArgs = wrapped ? [ownedServiceEntry, pathToFileURL(cli).href, ...args, '--home', home] : [cli, ...args, '--home', home];
  const processRecord = spawn(process.execPath, commandArgs, { cwd: root, env: childEnvironment(home), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: platform() !== 'win32' });
  let errors = '';
  processRecord.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-12000); });
  const exited = new Promise((done) => { processRecord.once('exit', (code, signal) => done({ code, signal })); processRecord.once('error', (error) => done({ error: clean(error) })); });
  return { process: processRecord, exited, errors: () => clean(errors) };
}
export async function stopOwnedProcess(proc, force = false) {
  if (!proc) return null;
  if (proc.process.exitCode !== null || proc.process.signalCode !== null) return { method: 'already-exited', ...(await proc.exited) };
  if (force) {
    if (platform() === 'win32') command('taskkill', ['/pid', String(proc.process.pid), '/T', '/F']);
    else try { process.kill(-proc.process.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    return { method: 'forced-owned-tree', ...(await deadline(proc.exited, 20_000, '本次创建的进程强制退出')) };
  }
  proc.process.stdin.end();
  try {
    const status = await deadline(proc.exited, 20_000, '本次创建的服务正常关闭');
    assert.equal(status.code, 0, `正常关闭返回 ${JSON.stringify(status)}`);
    assert.equal(status.signal, null);
    return { method: 'stdin-eof-close', ...status };
  } catch (error) {
    // 超时后只清理当前仍持有的进程树；本次验收继续保留失败，不能把强停当作正常通过。
    await stopOwnedProcess(proc, true);
    throw error;
  }
}
const stop = stopOwnedProcess;
async function start(home) {
  const proc = child(['start', '--port', '0', '--no-browser'], home);
  const lines = createInterface({ input: proc.process.stdout, crlfDelay: Infinity });
  try {
    const descriptor = await deadline(new Promise((done, fail) => {
      lines.on('line', (line) => { try { const value = JSON.parse(line); if (value.app === 'video-creation') done(value); } catch { /* 普通启动诊断不是回执。 */ } });
      proc.exited.then((status) => fail(new Error(`启动提前结束：${status.code ?? status.error} ${proc.errors()}`)));
    }), 45_000, '本地服务启动');
    assert.equal(resolve(descriptor.home), resolve(home));
    return { ...proc, descriptor };
  } catch (error) { await stop(proc, true); throw error; }
  finally { lines.close(); }
}
function mcp(home, project) {
  const proc = child(['mcp', '--project', project], home); const pending = new Map(); let next = 1;
  const lines = createInterface({ input: proc.process.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    let response; try { response = JSON.parse(line); } catch { return; }
    const waiter = pending.get(response.id); if (!waiter) return; pending.delete(response.id);
    if (response.error) waiter.fail(new Error(JSON.stringify(response.error))); else waiter.done(response.result);
  });
  proc.exited.then(() => { for (const waiter of pending.values()) waiter.fail(new Error(`MCP 提前结束：${proc.errors()}`)); pending.clear(); });
  const request = (method, params = {}) => {
    const id = next++;
    return deadline(new Promise((done, fail) => { pending.set(id, { done, fail }); proc.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }), 180_000, `MCP ${method}`).finally(() => pending.delete(id));
  };
  return { ...proc, request, notify: (method, params = {}) => proc.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`), tool: async (name, args = {}) => {
    const result = await request('tools/call', { name, arguments: args });
    if (result.isError) throw new Error(`${name}: ${result.content?.map((entry) => entry.text ?? '').join('\n')}`);
    return JSON.parse(result.content.find((entry) => entry.type === 'text').text);
  } };
}
async function waitJob(client, id, predicate = (job) => terminal.has(job.status), timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const job = (await client.jobs()).find((entry) => entry.id === id); assert.ok(job, `导出 ${id} 丢失`); if (predicate(job)) return job; await pause(70); }
  throw new Error(`导出 ${id} 未在限定时间内到达所需状态`);
}
const rgbPng = (png) => command('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { encoding: null, input: png });
const videoProbe = (file) => JSON.parse(command('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]));
async function sampleFrame(browser, folder, time, evidenceFile) {
  const site = await serve(folder); let page;
  try {
    page = await FilmPage.open(browser, site.url, 'film.html', { offline: true }); await page.seek(time);
    const png = await page.capture(); if (evidenceFile) await writeFile(evidenceFile, png);
    const scene = page.page.frames().find((frame) => /\/scene\.html(?:[?#]|$)/.test(frame.url())); assert.ok(scene, '场景 iframe 未加载');
    const state = await scene.evaluate(() => { const marker = document.querySelector('#beat i:first-child')?.getBoundingClientRect(); return { title: document.getElementById('title')?.textContent, accent: document.body.style.getPropertyValue('--accent'), event: document.body.dataset.event, portrait: document.body.classList.contains('portrait'), captions: document.getElementById('captions') ? getComputedStyle(document.getElementById('captions')).display : null, value: document.getElementById('number')?.textContent, viewport: [innerWidth, innerHeight], beatPoint: marker ? { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 } : null, beatRect: marker ? { x: marker.x, y: marker.y, width: marker.width, height: marker.height } : null }; });
    assert.equal(page.problems.length, 0, JSON.stringify(page.problems));
    const layout = await scene.evaluate(collectSampleLayout);
    return { png, state, layout, width: page.meta.width, height: page.meta.height };
  } finally { await page?.close(); await site.close(); }
}

export async function runGeneralMotionSmoke({ workdir, evidencePath, sourceCommit, label = `${platform()}-${arch()}`, showcase = false }) {
  assert.ok(workdir && evidencePath, '必须提供 --workdir 和 --evidence');
  workdir = resolve(workdir); evidencePath = resolve(evidencePath);
  assert.equal(existsSync(workdir), false, '验收目录已存在，请为本轮选择全新目录');
  const builtSdk = join(root, 'packages/openfilm/studio/ui/dist/motion.mjs');
  assert.ok(existsSync(builtSdk), '通用动效 SDK 尚未构建，请先运行 pnpm build');
  const home = join(workdir, '应用 数据'), projects = join(home, 'projects'), output = join(workdir, '导出 媒体');
  await mkdir(output, { recursive: true }); await mkdir(projects, { recursive: true });
  const checkout = existsSync(join(root, '.git'));
  if (sourceCommit) assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.ok(checkout || sourceCommit, '归档源码需提供 --source-commit 完整 SHA');
  const trackedFiles = ['desirecore/general-motion-smoke.mjs', 'desirecore/general-motion-smoke-child.mjs', 'desirecore/cli.mjs', 'desirecore/mcp.mjs', 'packages/openfilm/src/motion.mjs', 'packages/openfilm/src/motion-schema.mjs', 'packages/openfilm/src/host.mjs', 'packages/openfilm/src/timeline.mjs', 'packages/openfilm/studio/server/film.mjs', 'packages/openfilm/studio/server/exports.mjs', 'packages/openfilm/studio/ui/dist/motion.mjs', ...sampleNames.flatMap((name) => [`examples/general-motion/${name}/film.html`, `examples/general-motion/${name}/scene.html`]), 'examples/general-motion/product-demo/assets/workspace.svg', 'examples/general-motion/product-demo/assets/original-music.wav', 'examples/general-motion/optional-caption/assets/original-rhythm.wav'];
  const evidence = { schemaVersion: 1, label, startedAt: new Date().toISOString(), status: 'running', environment: { platform: platform(), arch: arch(), release: release(), os: version(), node: process.version }, source: { commit: checkout ? command('git', ['rev-parse', 'HEAD'], { cwd: root }).trim() : sourceCommit, origin: checkout ? 'git-checkout' : 'declared-archive-sha', dirty: checkout ? Boolean(command('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root }).trim()) : null, fileSha256: Object.fromEntries(await Promise.all(trackedFiles.map(async (path) => [path, await hashFile(join(root, path))]))) }, workdir, showcase, checks: [] };
  const record = (name, details = {}) => { evidence.checks.push({ name, status: 'passed', ...details }); process.stderr.write(`[general-motion] ${name} 通过\n`); };
  let studio, protocol, browser;
  try {
    applyRuntimeEnvironment(runtimeConfig({ home }, childEnvironment(home)));
    evidence.environment.ffmpeg = command('ffmpeg', ['-version']).split('\n')[0]; evidence.environment.ffprobe = command('ffprobe', ['-version']).split('\n')[0];
    for (const name of sampleNames) {
      await cp(join(root, 'examples/general-motion', name), join(projects, name), { recursive: true });
      await copyFile(builtSdk, join(projects, name, 'motion.mjs'));
    }
    studio = await start(home); let api = await connectStudio({ home });
    const clients = {}, projectIds = {};
    for (const name of sampleNames) {
      const { project } = await api.call('/api/projects', { path: join(projects, name), create: false }); projectIds[name] = project.id;
      clients[name] = await projectClient({ home, renderFps: 12, renderQuality: 'standard' }, join(projects, name));
      const initial = await clients[name].inspect(); assert.equal(initial.problems.length, 0, initial.problems.join('\n'));
      await clients[name].patch(initial.rev, [{ op: 'stage', w: 320, h: 180 }]);
    }
    browser = await launch(); evidence.environment.chromium = browser.version();
    const seekResults = [];
    for (const name of sampleNames) {
      const folder = join(projects, name), site = await serve(folder); let page;
      try {
        page = await FilmPage.open(browser, site.url, 'film.html', { offline: true }); const at = name === 'alpha-title' ? 2 : 14;
        await page.seek(at); const first = await page.capture(); await page.seek(.1); await page.seek(name === 'alpha-title' ? 5 : 23); await page.seek(at); const repeated = await page.capture();
        const difference = pixelDifference(rgbPng(first), rgbPng(repeated)); assert.ok(difference.meanAbsolute <= .2 && difference.changedRatio <= .005, `${name} 乱序求帧不稳定：${JSON.stringify(difference)}`);
        assert.equal(page.problems.length, 0, JSON.stringify(page.problems));
        const path = join(output, `${name}-seek.png`); await writeFile(path, repeated); seekResults.push({ name, sequence: [at, .1, name === 'alpha-title' ? 5 : 23, at], difference, path, sha256: hash(repeated) });
      } finally { await page?.close(); await site.close(); }
    }
    record('absolute-time-and-shuffled-seek', { samples: seekResults });

    const dataClient = clients['data-story']; const before = await sampleFrame(browser, join(projects, 'data-story'), 0);
    const inspected = await dataClient.inspect();
    const manual = await dataClient.patch(inspected.rev, [{ op: 'motion', clip: 'data', changes: [{ path: ['params', 'title'], value: '人工编辑的数据故事' }, { path: ['params', 'accent'], value: '#b64f78' }] }, { op: 'set', clip: 'data', field: 'overrides', value: [{ at: '#title', style: { letterSpacing: '0.02em' }, lock: true }] }]);
    const after = await sampleFrame(browser, join(projects, 'data-story'), 0, join(output, 'params-first-frame.png'));
    assert.equal(after.state.title, '人工编辑的数据故事'); assert.equal(after.state.accent, '#b64f78'); assert.ok(pixelDifference(rgbPng(before.png), rgbPng(after.png)).changedRatio > .001, '参数没有影响首帧像素');
    const locked = await dataClient.patch(manual.rev, [{ op: 'motion-locks', clip: 'data', locked: ['params.title'] }]);
    await assert.rejects(dataClient.patch(locked.rev, [{ op: 'motion', clip: 'data', changes: [{ path: ['params', 'title'], value: '不应覆盖人工锁' }] }]), (error) => error.status === 409);
    const current = await dataClient.inspect(); assert.equal(current.rev, locked.rev);
    const modifiedData = JSON.parse((await readFile(join(projects, 'data-story', 'scene.html'), 'utf8')).match(/<script id="film-motion" type="application\/json">\s*([\s\S]*?)<\/script>/)[1]).data;
    modifiedData.series[0].values[3] = 91;
    const dataEdit = await dataClient.patch(current.rev, [{ op: 'motion', clip: 'data', changes: [{ path: ['data'], value: modifiedData }, { path: ['params', 'accent'], value: '#237b86' }] }]);
    const actual = await sampleFrame(browser, join(projects, 'data-story'), 15); assert.equal(actual.state.value, '91%');
    const preserved = (await dataClient.inspect()).value.tracks[0].clips[0]; assert.equal(preserved.motion.params.title, '人工编辑的数据故事'); assert.deepEqual(preserved.motion.locked, ['params.title']); assert.equal(preserved.overrides[0].lock, true);
    record('pre-frame-parameters-structured-data-and-manual-lock', { firstRevision: inspected.rev, manualRevision: manual.rev, lockedRevision: locked.rev, dataRevision: dataEdit.rev, firstFrame: after.state, changedPixels: pixelDifference(rgbPng(before.png), rgbPng(after.png)), rejectedLockedWriteStatus: 409, retainedTitle: actual.state.title, dataValue: actual.state.value });

    const aspectResults = [];
    for (const name of sampleNames) for (const [w, h] of [[320, 180], [180, 320], [240, 240]]) {
      const client = clients[name]; await client.patch((await client.inspect()).rev, [{ op: 'stage', w, h }]);
      const frame = await sampleFrame(browser, join(projects, name), name === 'alpha-title' ? 2 : 14, join(output, `layout-${name}-${w}x${h}.png`));
      assert.deepEqual([frame.width, frame.height], [w, h]); assert.deepEqual(frame.state.viewport, [w, h]);
      if (name !== 'alpha-title') assert.equal(frame.state.portrait, h > w);
      const checkedLayout = verifySampleLayout(frame.layout);
      aspectResults.push({ name, width: w, height: h, state: frame.state, layout: frame.layout, checkedLayout, sha256: hash(frame.png) });
    }
    for (const name of sampleNames) await clients[name].patch((await clients[name].inspect()).rev, [{ op: 'stage', w: 320, h: 180 }]);
    const captionClient = clients['optional-caption']; await captionClient.patch((await captionClient.inspect()).rev, [{ op: 'motion', clip: 'lesson', changes: [{ path: ['params', 'showCaptions'], value: false }] }]);
    const captionOff = await sampleFrame(browser, join(projects, 'optional-caption'), 8); assert.equal(captionOff.state.captions, 'none');
    record('responsive-wide-portrait-square-and-optional-captions', { layouts: aspectResults, disabledCaptionsDisplay: captionOff.state.captions, subtitleFilesRequired: false });

    const saved = await api.call(`/api/projects/${encodeURIComponent(projectIds['data-story'])}/saved`, { clips: [{ id: 'data', name: '通用动效 自包含验收', durationMs: 24000, w: 320, h: 180 }] });
    assert.equal(saved.paths.length, 1); const target = join(projects, 'Saved 副本'); const { project: savedProject } = await api.call('/api/projects', { path: target, create: true });
    const taken = await api.call(`/api/projects/${encodeURIComponent(savedProject.id)}/saved/take`, { path: saved.paths[0] }); assert.ok(taken.clip?.src);
    await writeFile(join(target, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ ...taken.clip, id: 'saved', time: [0, 24] }] }] }));
    const savedFrame = await sampleFrame(browser, target, 15, join(output, 'saved-self-contained.png')); assert.equal(savedFrame.state.title, '人工编辑的数据故事'); assert.equal(savedFrame.state.value, '91%');
    const savedFiles = await readdir(target, { recursive: true }); assert.ok(savedFiles.some((name) => String(name).endsWith('motion.mjs'))); assert.ok(savedFiles.some((name) => String(name).endsWith('scene.html')));
    record('saved-template-dependency-closure', { libraryPath: saved.paths[0], copiedScene: taken.clip.src, locked: taken.clip.motion.locked, files: savedFiles.map(String), screenshotSha256: hash(savedFrame.png) });

    protocol = mcp(home, join(projects, 'product-demo'));
    const initialized = await protocol.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'general-motion-smoke', version: '1' } }); protocol.notify('notifications/initialized');
    const listed = await protocol.request('tools/list'); const toolNames = listed.tools.map((tool) => tool.name); assert.ok(toolNames.includes('video_inspect')); const mcpFilm = await protocol.tool('video_inspect'); assert.equal(mcpFilm.problems.length, 0);
    const catalog = await protocol.tool('video_motion_catalog'); assert.equal(catalog.problems.length, 0); assert.ok(catalog.components.some((component) => component.source === 'project' && component.manifest.id === 'general-product-demo'));
    const builtin = catalog.components.find((component) => component.source === 'builtin' && component.manifest.id === 'general-data-story'); assert.ok(builtin, '固定材料内缺少可复用数据构件');
    const motion = await protocol.tool('video_motion_inspect', { clip: 'product' }); assert.equal(motion.clips[0].problems.length, 0); assert.equal(motion.clips[0].manifest.id, 'general-product-demo');
    const patch = await protocol.tool('video_motion_patch', { base: mcpFilm.rev, clip: 'product', changes: [{ path: ['params', 'title'], value: '通用动效 · 自主创作' }] });
    const installed = await protocol.tool('video_motion_install', { base: patch.rev }); assert.equal(installed.license, 'MIT'); assert.equal(installed.sha256, await hashFile(builtSdk));
    const takenBuiltin = await protocol.tool('video_motion_take', { base: patch.rev, component: builtin.ref }); assert.ok(takenBuiltin.clip?.src); assert.equal((await clients['product-demo'].inspect()).rev, patch.rev, '导入构件不应替智能体自动改写编排');
    record('real-mcp-motion-discovery-edit-install-and-take', { protocolVersion: initialized.protocolVersion, tools: toolNames, projectComponent: motion.clips[0].manifest.id, builtinComponent: builtin.ref, originalRevision: mcpFilm.rev, modifiedRevision: patch.rev, sdk: installed, importedClip: takenBuiltin.clip.src, timelineRevisionAfterImport: patch.rev });

    const exports = [];
    for (const fps of [12, 30]) {
      const ask = { fps, codec: 'h264', range: [0, 2], hardware: false, width: 320, height: 180 };
      const submitted = fps === 12 ? await protocol.tool('video_render', { ...ask, output }) : await clients['product-demo'].render(ask, output);
      const job = submitted.export ?? submitted.job ?? submitted; const done = await waitJob(clients['product-demo'], job.id); assert.equal(done.status, 'done', done.error);
      const checked = verifyMotionProbe(videoProbe(done.out), { fps, audio: true });
      const pcm = command('ffmpeg', ['-v', 'error', '-i', done.out, '-vn', '-ac', '1', '-ar', '24000', '-f', 'f32le', '-'], { encoding: null }); const peak = energyPeak(pcm, 24000);
      const prev = await sampleFrame(browser, join(projects, 'product-demo'), (Math.ceil(fps) - 1) / fps); const event = await sampleFrame(browser, join(projects, 'product-demo'), 1);
      assert.equal(prev.state.event, 'off'); assert.equal(event.state.event, 'on');
      const rgb = command('ffmpeg', ['-v', 'error', '-i', done.out, '-an', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { encoding: null }); const visible = firstVisibleBeat(rgb, 320, 180, event.state.beatRect); const visualTime = visible.frame / fps;
      assert.ok(Math.abs(visualTime - 1) <= 1 / fps, `实际编码的视觉事件偏离标记：${visualTime}`); assert.ok(Math.abs(peak.time - visualTime) <= 1 / fps, `实际音画事件误差超过一帧：${peak.time - visualTime}`);
      exports.push({ jobId: done.id, inputRevision: done.inputSnapshot?.filmRevision, path: done.out, sha256: await hashFile(done.out), ...checked, measuredAudioPeak: peak, measuredVisibleBeat: visible, visualEventTime: visualTime, previousVisualFrame: (Math.ceil(fps) - 1) / fps, syncErrorSeconds: Math.abs(peak.time - visualTime) });
    }
    record('actual-multi-fps-export-and-audio-event-alignment', { exports });

    const alpha = [];
    for (const [codec, expectedCodec] of [['vp9', 'vp9'], ['prores4444', 'prores']]) {
      const submitted = await clients['alpha-title'].render({ codec, alpha: true, fps: 12, range: [1, 2], audio: false, hardware: false, width: 320, height: 180 }, output);
      const done = await waitJob(clients['alpha-title'], submitted.id); assert.equal(done.status, 'done', done.error); const checked = verifyMotionProbe(videoProbe(done.out), { codec: expectedCodec, duration: 1 });
      const decode = codec === 'vp9' ? ['-c:v', 'libvpx-vp9'] : [];
      const rgba = command('ffmpeg', ['-v', 'error', ...decode, '-i', done.out, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'], { encoding: null });
      assert.equal(rgba.length, 320 * 180 * 4); let alphaMin = 255, alphaMax = 0; for (let i = 3; i < rgba.length; i += 4) { alphaMin = Math.min(alphaMin, rgba[i]); alphaMax = Math.max(alphaMax, rgba[i]); } assert.equal(alphaMin, 0); assert.ok(alphaMax > 200); assert.equal(rgba[3], 0);
      const composited = join(output, `alpha-${codec}-on-magenta.png`);
      command('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xff00ff:s=320x180:r=12', ...decode, '-i', done.out, '-filter_complex', '[0:v][1:v]overlay=shortest=1:format=auto', '-frames:v', '1', composited]);
      const composite = rgbPng(await readFile(composited)); assert.ok(composite[0] > 230 && composite[1] < 25 && composite[2] > 230, '透明角落没有露出异色背景');
      alpha.push({ jobId: done.id, path: done.out, sha256: await hashFile(done.out), ...checked, alphaMin, alphaMax, backgroundPixel: [...composite.subarray(0, 3)], composite: composited, compositeSha256: await hashFile(composited) });
    }
    record('actual-webm-and-prores-alpha-on-colored-background', { exports: alpha });

    const long = await clients['product-demo'].render({ fps: 30, hardware: false }, output); await clients['product-demo'].cancel(long.id); const cancelled = await waitJob(clients['product-demo'], long.id); assert.equal(cancelled.status, 'cancelled');
    const interrupted = await clients['product-demo'].render({ fps: 30, hardware: false }, output); await waitJob(clients['product-demo'], interrupted.id, (job) => { assert.ok(!terminal.has(job.status), '导出在中断前已结束'); return job.status === 'running'; });
    await stop(protocol); protocol = undefined; await stop(studio, true); studio = undefined; studio = await start(home); api = await connectStudio({ home });
    const reopened = await projectClient({ home }, join(projects, 'product-demo')); const recovered = (await reopened.jobs()).find((job) => job.id === interrupted.id); assert.equal(recovered.status, 'interrupted');
    const fresh = await reopened.inspect(); const trims = fresh.value.tracks.flatMap((track) => track.clips).map((clip) => ({ op: 'set', clip: clip.id, field: 'time', value: [0, 1] })); const shortened = await reopened.patch(fresh.rev, trims);
    const retried = await reopened.retry(interrupted.id); const retry = retried.export ?? retried.job ?? retried; const retriedDone = await waitJob(reopened, retry.id); assert.equal(retriedDone.status, 'done', retriedDone.error); assert.notEqual(retry.id, interrupted.id); assert.equal(retriedDone.retryOf, interrupted.id); assert.equal(retriedDone.inputSnapshot?.filmRevision, shortened.rev); assert.equal((await reopened.jobs()).find((job) => job.id === interrupted.id).status, 'interrupted');
    verifyMotionProbe(videoProbe(retriedDone.out), { fps: 30, duration: 1 });
    record('real-cancellation-interruption-and-explicit-fresh-retry', { cancelled: cancelled.id, interrupted: interrupted.id, retryId: retry.id, retryOf: retriedDone.retryOf, freshRevision: shortened.rev, retrySha256: await hashFile(retriedDone.out), priorCompletedRetained: (await reopened.jobs()).some((job) => job.id === exports[0].jobId && job.status === 'done') });

    if (showcase) {
      const full = [];
      for (const name of sampleNames) {
        const showcaseProject = join(projects, `${name} 完整样片`); await cp(join(root, 'examples/general-motion', name), showcaseProject, { recursive: true }); await copyFile(builtSdk, join(showcaseProject, 'motion.mjs')); await api.call('/api/projects', { path: showcaseProject, create: false });
        const client = await projectClient({ home }, showcaseProject); const alphaLayer = name === 'alpha-title'; const submitted = await client.render({ codec: alphaLayer ? 'prores4444' : 'h264', alpha: alphaLayer, fps: 30, hardware: false }, output); const done = await waitJob(client, submitted.id, (job) => terminal.has(job.status), 20 * 60_000); assert.equal(done.status, 'done', done.error);
        const checked = verifyMotionProbe(videoProbe(done.out), { codec: alphaLayer ? 'prores' : 'h264', width: 1920, height: 1080, fps: 30, duration: alphaLayer ? 6 : 24, audio: ['product-demo', 'optional-caption'].includes(name) }); full.push({ name, jobId: done.id, path: done.out, sha256: await hashFile(done.out), ...checked });
      }
      record('real-1080p-showcase', { exports: full });
    }
    evidence.status = 'passed';
  } catch (error) { evidence.status = 'failed'; evidence.error = clean(error); throw error; }
  finally {
    await browser?.close().catch((error) => { evidence.cleanupError = clean(error); });
    evidence.cleanup = {};
    try { evidence.cleanup.mcp = await stop(protocol); } catch (error) { evidence.cleanupError = clean(error); }
    try { evidence.cleanup.studio = await stop(studio); } catch (error) { evidence.cleanupError = clean(error); }
    if (evidence.cleanupError) evidence.status = 'failed';
    evidence.finishedAt = new Date().toISOString(); await mkdir(dirname(evidencePath), { recursive: true }); await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ status: evidence.status, evidence: evidencePath, source: evidence.source, checks: evidence.checks.map(({ name, status }) => ({ name, status })), ...(evidence.error ? { error: evidence.error } : {}), ...(evidence.cleanupError ? { cleanupError: evidence.cleanupError } : {}) }, null, 2)}\n`);
    if (evidence.cleanupError) throw new Error(`验收清理失败：${evidence.cleanupError}`);
  }
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { workdir: { type: 'string' }, evidence: { type: 'string' }, label: { type: 'string' }, 'source-commit': { type: 'string' }, showcase: { type: 'boolean' } } });
  runGeneralMotionSmoke({ workdir: values.workdir, evidencePath: values.evidence, sourceCommit: values['source-commit'], label: values.label, showcase: values.showcase }).catch((error) => { process.stderr.write(`${clean(error)}\n`); process.exitCode = 1; });
}
