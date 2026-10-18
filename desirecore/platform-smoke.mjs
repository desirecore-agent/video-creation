#!/usr/bin/env node
/** 有界跨平台实跑：只创建自己的合成影片、服务进程与导出，不使用平台身份或外部模型。 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { arch, platform, release, version } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { projectClient, connectStudio } from './client.mjs';
import { applyRuntimeEnvironment, runtimeConfig } from './config.mjs';
import { filmHtml } from '../packages/openfilm/src/film-doc.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const terminal = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const cleanError = (error) => String(error?.message ?? error).replace(/([?&](?:key|token)=)[^&\s]+/gi, '$1[redacted]').replace(/("(?:key|proof)"\s*:\s*")[^"]+/gi, '$1[redacted]').slice(-6000);
const hashFile = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const deadline = (promise, ms, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`${label} timed out after ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};
const commandText = (program, args, options = {}) => execFileSync(program, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000, ...options }).trim();

/** ffprobe 的实际输出必须满足样片合同；存在文件或扩展名不足以证明导出成功。 */
export function verifyVideoProbe(probe, { width = 320, height = 180, fps = 12, duration = 1 } = {}) {
  const stream = probe.streams?.find((entry) => entry.codec_type === 'video');
  assert.ok(stream, 'ffprobe found no video stream');
  assert.equal(stream.codec_name, 'h264');
  assert.equal(stream.width, width);
  assert.equal(stream.height, height);
  const [num, den = 1] = String(stream.avg_frame_rate).split('/').map(Number);
  assert.equal(num / den, fps);
  assert.ok(Math.abs(Number(probe.format?.duration) - duration) <= 1 / fps + 0.02, `unexpected duration: ${probe.format?.duration}`);
  assert.ok(Number(stream.nb_frames) >= Math.floor(duration * fps), `unexpected frame count: ${stream.nb_frames}`);
  return { codec: stream.codec_name, width: stream.width, height: stream.height, fps: num / den, duration: Number(probe.format.duration), frames: Number(stream.nb_frames) };
}

/** 子进程继承系统运行依赖，但不能继承另一个应用实例的数据根、端口或平台运行身份。 */
function childEnvironment(home) {
  const env = { ...process.env };
  for (const key of ['APP_DATA_DIR', 'APP_DATA_ROOT', 'DESIRECORE_APP_DATA_DIR', 'DESIRECORE_APP_DATA_ROOT', 'PORT', 'VIDEO_DIRECTOR_AGENT_ID', 'DESIRECORE_APP_RUNTIME_PROOF', 'DESIRECORE_APP_RELEASE_DIGEST', 'DESIRECORE_APP_SCOPE_ID', 'DESIRECORE_APP_RUNTIME_GENERATION']) delete env[key];
  return { ...env, VIDEO_CREATION_HOME: home, OPENFILM_HOME: home, OPENFILM_NO_BROWSER: '1', OPENFILM_NO_UPDATE_CHECK: '1' };
}

function childProcess(args, home) {
  const child = spawn(process.execPath, [cli, ...args, '--home', home], { cwd: root, env: childEnvironment(home), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12_000); });
  const exited = new Promise((done) => {
    child.once('exit', (code, signal) => done({ code, signal }));
    child.once('error', (error) => done({ error: cleanError(error) }));
  });
  return { child, exited, errors: () => cleanError(stderr) };
}

async function stop(processRecord, force = false) {
  if (!processRecord || processRecord.child.exitCode !== null || processRecord.child.signalCode !== null) return;
  const { child } = processRecord;
  if (process.platform === 'win32') {
    // Windows does not forward POSIX termination to Chromium/FFmpeg descendants.
    commandText('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  } else {
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await deadline(processRecord.exited, 20_000, 'owned process shutdown');
}

async function start(home) {
  const proc = childProcess(['start', '--port', '0', '--no-browser'], home);
  const lines = createInterface({ input: proc.child.stdout, crlfDelay: Infinity });
  try {
    const descriptor = await deadline(new Promise((done, fail) => {
      lines.on('line', (line) => {
        try { const value = JSON.parse(line); if (value.app === 'video-creation') done(value); } catch { /* normal diagnostics aren't descriptors */ }
      });
      proc.exited.then((status) => fail(new Error(`Studio exited before ready (${status.code ?? status.error}): ${proc.errors()}`)));
    }), 30_000, 'Studio startup');
    assert.equal(resolve(descriptor.home), resolve(home));
    return { ...proc, descriptor };
  } catch (error) { await stop(proc, true); throw error; }
  finally { lines.close(); }
}

function mcp(home, project) {
  const proc = childProcess(['mcp', '--project', project], home);
  const lines = createInterface({ input: proc.child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 1;
  lines.on('line', (line) => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    const item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id);
    if (response.error) item.fail(new Error(JSON.stringify(response.error)));
    else item.done(response.result);
  });
  proc.exited.then((status) => {
    for (const { fail } of pending.values()) fail(new Error(`MCP exited (${status.code ?? status.error}): ${proc.errors()}`));
    pending.clear();
  });
  const request = (method, params = {}) => {
    const id = nextId++;
    return deadline(new Promise((done, fail) => {
      pending.set(id, { done, fail });
      proc.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    }), method === 'tools/call' ? 120_000 : 15_000, `MCP ${method}`).finally(() => pending.delete(id));
  };
  return { ...proc, request,
    notify: (method, params = {}) => proc.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    tool: async (name, args = {}) => {
      const result = await request('tools/call', { name, arguments: args });
      if (result.isError) throw new Error(`${name}: ${result.content?.map((entry) => entry.text ?? '').join('\n')}`);
      return JSON.parse(result.content.find((entry) => entry.type === 'text').text);
    },
  };
}

async function waitJob(client, id, predicate = (job) => terminal.has(job.status)) {
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    const job = (await client.jobs()).find((entry) => entry.id === id);
    assert.ok(job, `job ${id} missing`);
    if (predicate(job)) return job;
    await pause(100);
  }
  throw new Error(`job ${id} did not reach expected state`);
}

export async function runPlatformSmoke({ workdir, evidencePath, label = `${platform()}-${arch()}`, sourceCommit }) {
  assert.ok(workdir && evidencePath, '--workdir and --evidence are required');
  workdir = resolve(workdir);
  evidencePath = resolve(evidencePath);
  const home = join(workdir, '应用 数据');
  const project = join(home, 'projects', '跨平台 样片');
  const output = join(workdir, '导出 视频');
  assert.equal(existsSync(join(home, 'application.lock')), false, 'smoke home already has an application lock; choose a fresh workdir');
  assert.equal(existsSync(join(project, 'film.html')), false, 'smoke project already exists; choose a fresh workdir');
  await mkdir(home, { recursive: true });
  await mkdir(output, { recursive: true });
  if (sourceCommit) assert.match(sourceCommit, /^[a-f0-9]{40}$/, '--source-commit must be the archive source full SHA');
  const gitCheckout = existsSync(join(root, '.git'));
  assert.ok(gitCheckout || sourceCommit, 'An archived checkout requires --source-commit <archive full SHA>');
  const runtimeFiles = ['desirecore/cli.mjs', 'desirecore/client.mjs', 'desirecore/mcp.mjs', 'desirecore/config.mjs', 'desirecore/config.schema.json', 'desirecore/ffmpeg-runtime.mjs', 'packages/openfilm/studio/server/server.mjs', 'packages/openfilm/studio/server/atomic.mjs', 'packages/openfilm/studio/server/exports.mjs', 'packages/openfilm/studio/server/export-job-store.mjs', 'packages/openfilm/studio/server/export-snapshot.mjs', 'packages/openfilm/src/host.mjs', 'packages/openfilm/src/render.mjs', 'packages/openfilm/src/film-doc.mjs'];
  const files = Object.fromEntries(await Promise.all(runtimeFiles.map(async (path) => [path, await hashFile(join(root, path))])));
  const evidence = { schemaVersion: 1, label, startedAt: new Date().toISOString(), status: 'running', environment: { platform: platform(), arch: arch(), release: release(), os: version(), node: process.version }, source: { commit: gitCheckout ? commandText('git', ['rev-parse', 'HEAD'], { cwd: root }) : sourceCommit, origin: gitCheckout ? 'git-checkout' : 'declared-archive-sha', dirty: gitCheckout ? Boolean(commandText('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root })) : null, runtimeFileSha256: files, harnessSha256: await hashFile(fileURLToPath(import.meta.url)) }, workdir, checks: [] };
  let studio, protocol;
  const record = (name, details) => { evidence.checks.push({ name, status: 'passed', ...details }); process.stderr.write(`[platform-smoke] ${name} passed\n`); };
  const probe = async (job) => {
    assert.equal(job.status, 'done', job.error);
    const data = JSON.parse(commandText('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', job.out]));
    return { id: job.id, ...verifyVideoProbe(data), sha256: await hashFile(job.out), path: job.out, inputRevision: job.inputSnapshot?.filmRevision };
  };
  try {
    // Match the same home passed to setup-runtime, including its downloaded FFmpeg directory on Windows/macOS.
    applyRuntimeEnvironment(runtimeConfig({ home }, childEnvironment(home)));
    evidence.environment.ffmpeg = commandText('ffmpeg', ['-version']).split('\n')[0];
    evidence.environment.ffprobe = commandText('ffprobe', ['-version']).split('\n')[0];
    studio = await start(home);
    const duplicate = childProcess(['start', '--port', '0', '--no-browser'], home);
    try {
      const status = await deadline(duplicate.exited, 10_000, 'duplicate start rejection');
      assert.equal(status.code, 1);
      assert.match(duplicate.errors(), /已在运行/);
    } finally { await stop(duplicate, true); }
    record('single-runtime-per-home', { pid: studio.child.pid, home });

    const api = await connectStudio({ home });
    const created = await api.call('/api/projects', { path: project, create: true });
    assert.equal(await realpath(created.project.path), await realpath(project));
    // A tiny synthetic project with no network assets or user materials. Content generation is a normal file workflow.
    await writeFile(join(project, 'scene.html'), '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden;background:#182032}#title{position:absolute;left:12px;top:12px;color:white;font:20px sans-serif}#bar{position:absolute;top:70px;width:70px;height:60px;background:#ffbe45}</style><div id="title">视频创作</div><div id="bar"></div><script>window.film={duration:30,frame(t){document.getElementById("bar").style.left=(20+t*100%220)+"px"}}</script>');
    await writeFile(join(project, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ id: 'main', clips: [{ id: 'intro', src: 'scene.html', time: [0, 1] }] }] }));
    const client = await projectClient({ home, renderFps: 12, renderQuality: 'standard' }, project);
    const initial = await client.inspect();
    assert.equal(initial.problems.length, 0);
    assert.equal(initial.value.tracks[0].clips[0].id, 'intro');
    const edited = await client.patch(initial.rev, [{ op: 'set', clip: 'intro', field: 'overrides', value: [{ at: '#title', text: '人工标题' }] }]);
    await assert.rejects(client.patch(initial.rev, [{ op: 'set', clip: 'intro', field: 'overrides', value: [] }]), (error) => error.status === 409);
    assert.equal((await client.inspect()).rev, edited.rev);
    record('unicode-spaces-project-and-revision-conflict', { project, initialRevision: initial.rev, editedRevision: edited.rev, conflictStatus: 409 });

    protocol = mcp(home, project);
    const initialized = await protocol.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'platform-smoke', version: '1' } });
    assert.equal(initialized.protocolVersion, '2025-06-18');
    protocol.notify('notifications/initialized');
    assert.deepEqual(await protocol.request('ping'), {});
    const listed = await protocol.request('tools/list');
    assert.ok(listed.tools.some((tool) => tool.name === 'video_inspect'));
    assert.equal((await protocol.tool('video_inspect')).rev, edited.rev);
    const invalid = await protocol.request('tools/call', { name: 'video_patch', arguments: { base: 'invalid', ops: [] } });
    assert.equal(invalid.isError, true);
    const checked = await protocol.tool('video_check', { range: '0-1' });
    assert.equal(checked.ok, true, checked.lines.join('\n'));
    const checkFiles = await Promise.all(checked.files.map(async (path) => ({ path, sha256: await hashFile(path) })));
    record('mcp-real-stdio-and-frame-check', { protocolVersion: initialized.protocolVersion, tools: listed.tools.map((tool) => tool.name), rejectedInvalidArguments: true, frameCheck: { ok: checked.ok, lines: checked.lines, files: checkFiles } });

    const submitted = await client.render({ fps: 12 }, output);
    const done = await waitJob(client, submitted.id);
    const firstOutput = await probe(done);
    assert.equal(firstOutput.inputRevision, edited.rev);
    assert.ok((await protocol.tool('video_jobs')).some((job) => job.id === done.id && job.status === 'done'));
    record('real-mp4-export-and-ffprobe', firstOutput);

    // A longer, still tiny scene keeps a real export active long enough to terminate the owned process tree.
    const longer = await client.patch((await client.inspect()).rev, [{ op: 'set', clip: 'intro', field: 'time', value: [0, 30] }]);
    const interruptedRequest = await client.render({ fps: 12 }, output);
    await waitJob(client, interruptedRequest.id, (job) => {
      assert.ok(!terminal.has(job.status), `export finished before interruption: ${job.status}`);
      return job.status === 'running';
    });
    await stop(protocol, true); protocol = undefined;
    await stop(studio, true); studio = undefined;
    studio = await start(home);
    const reopened = await projectClient({ home, renderFps: 12, renderQuality: 'standard' }, project);
    const recovered = (await reopened.jobs()).find((job) => job.id === interruptedRequest.id);
    assert.equal(recovered.status, 'interrupted');
    assert.equal((await reopened.jobs()).find((job) => job.id === done.id).status, 'done');
    const current = await reopened.inspect();
    assert.equal(current.rev, longer.rev);
    const shorter = await reopened.patch(current.rev, [{ op: 'set', clip: 'intro', field: 'time', value: [0, 1] }]);
    const retryResponse = await reopened.retry(recovered.id);
    const retry = retryResponse.export ?? retryResponse.job ?? retryResponse;
    assert.notEqual(retry.id, recovered.id);
    const retryDone = await waitJob(reopened, retry.id);
    assert.equal(retryDone.retryOf, recovered.id);
    const retryOutput = await probe(retryDone);
    assert.equal(retryOutput.inputRevision, shorter.rev);
    assert.equal((await reopened.jobs()).find((job) => job.id === recovered.id).status, 'interrupted');
    record('durable-jobs-crash-restart-and-explicit-retry', { interruptedJob: recovered.id, interruptedInputRevision: longer.rev, retainedCompletedJob: done.id, retryOf: retryDone.retryOf, retry: retryOutput, freshInputRevision: shorter.rev });
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = cleanError(error);
    throw error;
  } finally {
    await stop(protocol, true).catch((error) => { evidence.cleanupError = cleanError(error); });
    await stop(studio).catch((error) => { evidence.cleanupError = cleanError(error); });
    evidence.finishedAt = new Date().toISOString();
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ status: evidence.status, evidence: evidencePath, environment: evidence.environment, source: evidence.source, checks: evidence.checks.map(({ name, status }) => ({ name, status })), ...(evidence.error ? { error: evidence.error } : {}) }, null, 2)}\n`);
  }
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { workdir: { type: 'string' }, evidence: { type: 'string' }, label: { type: 'string' }, 'source-commit': { type: 'string' } } });
  runPlatformSmoke({ workdir: values.workdir, evidencePath: values.evidence, label: values.label, sourceCommit: values['source-commit'] }).catch((error) => { process.stderr.write(`${cleanError(error)}\n`); process.exitCode = 1; });
}
