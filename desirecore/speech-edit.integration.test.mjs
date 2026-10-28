import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');

// 经真正的CLI/stdio子进程验证传输，不能以直接调用callTool代替接线检查。
function execute(file, args, env, input = '', timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', (bytes) => { stdout += bytes; });
    child.stderr.on('data', (bytes) => { stderr += bytes; });
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') reject(error); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`口播传输fixture超时：${file}`));
      else resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

const message = (name, args, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const toolData = (reply) => JSON.parse(reply.result.content[0].text);
const conditionBody = (plan) => ({ base: plan.base, ops: plan.ops, preconditions: plan.preconditions });

test('口播工作媒体与文稿精剪的真实HTTP、CLI、stdio传输及条件提交', { timeout: 120_000 }, async (t) => {
  const scratch = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'speech-edit-transport-')));
  const home = join(scratch, 'home'), project = join(scratch, '口播 中文项目');
  const envKeys = ['OPENFILM_HOME', 'OPENFILM_LIBRARY', 'APP_DATA_DIR'];
  const beforeEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { OPENFILM_HOME: home, OPENFILM_LIBRARY: join(home, 'projects'), APP_DATA_DIR: home });
  const childEnv = { ...process.env, PORT: '0' };
  let studio;
  try {
    await fs.mkdir(join(project, 'assets'), { recursive: true });
    const { startStudio } = await import('../packages/openfilm/studio/server/server.mjs');
    const { projectClient } = await import('./client.mjs');
    const { speechCutContract } = await import('../packages/openfilm/studio/server/speech-cut.mjs');
    const { workingMediaRequestSchema } = await import('../packages/openfilm/studio/server/working-media.mjs');
    const { filmHtml } = await import('../packages/openfilm/src/film-doc.mjs');
    const { clipSpan } = await import('../packages/openfilm/src/film-doc.mjs');
    const source = join(project, 'assets/source.mp4');
    const made = await execute('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '3', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-threads', '1', '-c:a', 'aac', '-shortest', '-n', source], childEnv);
    assert.equal(made.code, 0, made.stderr);
    const sourceBytes = await fs.readFile(source), sourceSha = digest(sourceBytes);
    const original = { stage: { w: 320, h: 180 }, tracks: [
      { clips: [{ id: 'presenter', src: 'assets/source.mp4', time: [0, 3], volume: 0, attrs: { 'data-link': 'spoken-pair' } }] },
      { clips: [{ id: 'voice', src: 'assets/source.mp4', time: [0, 3], sound: true, attrs: { 'data-link': 'spoken-pair' } }] },
    ] };
    const originalVtt = 'WEBVTT\n\nopenfilm-timing:measured\n00:00:00.250 --> 00:00:00.750\n<00:00:00.250>应删的一句\n\nopenfilm-timing:measured\n00:00:01.250 --> 00:00:01.750\n<00:00:01.250>保留的一句\n';
    const filmPath = join(project, 'film.html'), vttPath = join(project, 'assets/source.vtt');
    const reset = async () => {
      await fs.writeFile(filmPath, filmHtml(original));
      await fs.writeFile(vttPath, originalVtt);
    };
    await reset();
    studio = await startStudio({ port: 0, advertise: true, openBrowser: () => {} });
    const client = await projectClient({ home }, project);
    const headers = { 'x-studio-key': studio.key, 'content-type': 'application/json' };
    const route = (suffix) => `${studio.origin}${client.base}/${suffix}`;
    const post = async (suffix, body) => {
      const response = await fetch(route(suffix), { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const runCli = (args, env = childEnv) => execute(process.execPath, [cli, ...args, '--home', home], env);
    const jsonArgs = async (name, body) => {
      const path = join(scratch, name);
      await fs.writeFile(path, JSON.stringify(body));
      return path;
    };
    const runMcp = async (requests) => {
      const run = await execute(process.execPath, [cli, 'mcp', '--project', project, '--home', home], childEnv,
        requests.map((request) => JSON.stringify(request)).join('\n') + '\n');
      assert.equal(run.code, 0, run.stderr);
      return run.stdout.trim().split('\n').map(JSON.parse);
    };
    const ask = async () => {
      const film = await client.inspect();
      const response = await fetch(route('captions'), { headers });
      assert.equal(response.status, 200);
      const { cues } = await response.json();
      const first = cues.find((cue) => cue.clip === 'voice' && cue.line === 250);
      assert.ok(first, '从实际字幕响应发现首句，不猜数组位置或版本');
      return { base: film.rev, clip: first.clip, sourceRevision: first.sourceRevision,
        first: { line: first.line, part: first.part }, last: { line: first.line, part: first.part } };
    };

    await t.test('离线Schema不创建home，共享planner在只有发布文件时也能执行', async () => {
      const absent = join(scratch, '不存在的数据目录');
      for (const name of ['prepare-media', 'speech-cut', 'speech-cut-apply']) {
        const result = await execute(process.execPath, [cli, name, '--schema', '--home', absent], { ...childEnv, APP_DATA_DIR: absent });
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), name === 'prepare-media'
          ? { contractVersion: 1, requestSchema: workingMediaRequestSchema } : speechCutContract());
      }
      await assert.rejects(fs.stat(absent), { code: 'ENOENT' });
      const isolated = join(scratch, '仅发布planner');
      await fs.mkdir(isolated);
      const shipped = join(isolated, 'timeline-plan.mjs');
      await fs.copyFile(new URL('../packages/openfilm/studio/ui/dist/timeline-plan.mjs', import.meta.url), shipped);
      const { planCutRange } = await import(pathToFileURL(shipped).href);
      const planned = planCutRange([{ index: 0, role: 'audio', clips: [{ id: 'voice', startMs: 0, endMs: 3000, inMs: 0, sourceMs: 3000, speed: 1 }] }], 'voice', 250, 750, { sync: true });
      assert.ok(planned?.ops.length, '不依赖ui/src或React的发布模块生成真实操作');
    });

    await t.test('实际captions经CLI和stdio可发现，未鉴权请求仍被拒绝', async () => {
      assert.equal((await fetch(route('captions'))).status, 401);
      assert.equal((await fetch(route('speech-cut/plan'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
      assert.equal((await fetch(route('media/prepare'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
      const fromCli = await runCli(['captions', project]);
      assert.equal(fromCli.code, 0, fromCli.stderr);
      const captions = JSON.parse(fromCli.stdout);
      assert.equal(captions.cues.length, 2);
      assert.ok(captions.cues.every((cue) => cue.clip === 'voice' && /^[a-f0-9]{64}$/.test(cue.sourceRevision)));
      const replies = await runMcp([{ jsonrpc: '2.0', id: '工具表', method: 'tools/list' }, message('video_captions', {}, '字幕')]);
      const tools = replies[0].result.tools;
      assert.deepEqual(tools.find((tool) => tool.name === 'video_prepare_media').inputSchema, workingMediaRequestSchema);
      assert.deepEqual(tools.find((tool) => tool.name === 'video_speech_cut_plan').inputSchema, speechCutContract().requestSchema);
      assert.deepEqual(tools.find((tool) => tool.name === 'video_speech_cut_apply').inputSchema, speechCutContract().applySchema);
      assert.deepEqual(toolData(replies[1]).cues, captions.cues);
    });

    await t.test('HTTP提案不写影片，CLI提交原计划一次联动精剪声画且原字幕不变', async () => {
      await reset();
      const before = await fs.readFile(filmPath, 'utf8');
      const planned = await post('speech-cut/plan', await ask());
      assert.equal(planned.status, 200, JSON.stringify(planned.body));
      assert.equal(await fs.readFile(filmPath, 'utf8'), before);
      assert.equal(planned.body.range.filmStartMs, 250);
      assert.equal(planned.body.range.filmEndMs, 750);
      assert.deepEqual(planned.body.preconditions.subtitles, [{ src: 'assets/source.mp4', revision: planned.body.source.revision }]);
      const args = await jsonArgs('提交原提案.json', planned.body);
      const applied = await runCli(['speech-cut-apply', project, '--args', args]);
      assert.equal(applied.code, 0, applied.stderr);
      const film = JSON.parse(applied.stdout);
      const spans = film.doc.tracks.map((track) => track.clips.map((clip) => [clip.at ?? 0, clip.time]));
      assert.deepEqual(spans, [[[0, [0, .25]], [.25, [.75, 3]]], [[0, [0, .25]], [.25, [.75, 3]]]]);
      assert.equal(Math.max(...film.doc.tracks.flatMap((track) => track.clips.map((clip) => (clip.at ?? 0) + clipSpan(clip).length))), 2.5);
      assert.equal(await fs.readFile(vttPath, 'utf8'), originalVtt);
      assert.equal(digest(await fs.readFile(source)), sourceSha);
    });

    await t.test('CLI提案后字幕改变，HTTP及stdio条件提交均409且零写入', async () => {
      await reset();
      const args = await jsonArgs('规划选句.json', await ask());
      const proposed = await runCli(['speech-cut', project, '--args', args]);
      assert.equal(proposed.code, 0, proposed.stderr);
      const plan = JSON.parse(proposed.stdout), before = await fs.readFile(filmPath, 'utf8');
      const editedVtt = originalVtt.replace('应删的一句', '此句已由他人改字');
      await fs.writeFile(vttPath, editedVtt);
      const stale = await post('edit', conditionBody(plan));
      assert.equal(stale.status, 409, JSON.stringify(stale.body));
      assert.match(stale.body.error, /字幕/);
      const [reply] = await runMcp([message('video_speech_cut_apply', conditionBody(plan))]);
      assert.equal(reply.result.isError, true);
      assert.equal(toolData(reply).status, 409);
      assert.equal(await fs.readFile(filmPath, 'utf8'), before);
      assert.equal(await fs.readFile(vttPath, 'utf8'), editedVtt);
    });

    await t.test('影片新改动不被旧计划重放，缺少字幕guard的stdio申请在提交前拒绝', async () => {
      await reset();
      const plan = (await post('speech-cut/plan', await ask())).body;
      const changed = await client.patch(plan.base, [{ op: 'set', clip: 'voice', field: 'volume', value: .5 }]);
      const before = await fs.readFile(filmPath, 'utf8');
      const [stale, missing] = await runMcp([
        message('video_speech_cut_apply', conditionBody(plan), '旧影片'),
        message('video_speech_cut_apply', { base: changed.rev, ops: plan.ops }, '没有前置版本'),
      ]);
      assert.equal(stale.result.isError, true);
      assert.equal(toolData(stale).status, 409);
      assert.equal(missing.result.isError, true);
      assert.match(toolData(missing).error, /preconditions/);
      assert.equal(await fs.readFile(filmPath, 'utf8'), before);
      assert.equal((await client.inspect()).doc.tracks[1].clips[0].volume, .5);
    });

    await t.test('CLI准备小视频工作副本，stdio复用同来源且不换影片或改原片', async () => {
      await reset();
      const before = await fs.readFile(filmPath, 'utf8');
      const args = await jsonArgs('准备工作媒体.json', { src: 'assets/source.mp4', shortEdge: 720 });
      const prepared = await runCli(['prepare-media', project, '--args', args]);
      assert.equal(prepared.code, 0, prepared.stderr);
      const receipt = JSON.parse(prepared.stdout);
      assert.equal(receipt.source.sha256, sourceSha);
      assert.equal(receipt.source.bytes, sourceBytes.length);
      assert.match(receipt.output.path, /^assets\/working\/[a-f0-9]{64}\/media\.mp4$/);
      assert.equal(receipt.output.facts.width, 320);
      assert.equal(receipt.output.facts.height, 180);
      assert.equal(receipt.output.facts.fps, 30);
      assert.equal(receipt.output.facts.color.transfer, 'bt709');
      assert.equal(receipt.mapping.sourceSecondsPerWorkingSecond, 1);
      assert.equal(digest(await fs.readFile(join(project, receipt.output.path))), receipt.output.sha256);
      assert.equal(JSON.parse(await fs.readFile(join(project, receipt.provenancePath), 'utf8')).source.sha256, sourceSha);
      const [reply] = await runMcp([message('video_prepare_media', { src: 'assets/source.mp4', shortEdge: 720 })]);
      assert.notEqual(reply.result.isError, true, reply.result.content[0].text);
      const reused = toolData(reply);
      assert.equal(reused.reused, true);
      assert.equal(reused.output.path, receipt.output.path);
      assert.equal(reused.output.sha256, receipt.output.sha256);
      assert.equal(await fs.readFile(filmPath, 'utf8'), before);
      assert.equal(digest(await fs.readFile(source)), sourceSha);
      assert.equal(await fs.readFile(vttPath, 'utf8'), originalVtt);
    });
  } finally {
    await studio?.close();
    for (const key of envKeys) {
      if (beforeEnv[key] === undefined) delete process.env[key];
      else process.env[key] = beforeEnv[key];
    }
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
