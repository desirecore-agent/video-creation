import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');

// 子进程仅执行正式 CLI/stdio 入口，不通过 import callTool 代替传输验证。
function execute(args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('定向 CLI/stdio fixture 超时')); }, 20_000);
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.end(input);
  });
}

function callMessage(name, args, id = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}
function toolData(response) { return JSON.parse(response.result.content[0].text); }

// 环境在 server/film 等产品模块导入之前隔离；单一临时服务顺序完成每种入口。
test('场景源码真实 HTTP、CLI 和 stdio 共用合同、字节预算和有限恢复回执', { timeout: 90_000 }, async (t) => {
  const scratch = await fs.mkdtemp(join(tmpdir(), 'scene-source-transport-'));
  const home = join(scratch, 'home'), project = join(scratch, '影片 中文项目');
  const beforeEnv = Object.fromEntries(['OPENFILM_HOME', 'OPENFILM_LIBRARY', 'APP_DATA_DIR'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { OPENFILM_HOME: home, OPENFILM_LIBRARY: join(home, 'projects'), APP_DATA_DIR: home });
  const childEnv = { ...process.env, PORT: '0' };
  let studio;
  try {
    await fs.mkdir(project, { recursive: true });
    const { startStudio } = await import('../packages/openfilm/studio/server/server.mjs');
    const { projectClient } = await import('./client.mjs');
    const { sceneSourceContract, SCENE_SOURCE_LIMITS } = await import('../packages/openfilm/studio/server/scene-source.mjs');
    const { filmHtml } = await import('../packages/openfilm/src/film-doc.mjs');
    const initialSource = '<!doctype html><body>人工：潮光不灭 💡 "引号" \\ 尾\n<script>window.film={duration:2,frame(t){}}</script>';
    const original = { stage: { w: 640, h: 360 }, tracks: [{ muted: true, clips: [
      { id: 'scene', src: 'scene.html', time: [0, 2], overrides: [{ at: '#human-note', text: '人工保留', lock: true }] },
      { id: 'other', src: 'scene.html', time: [1, 2] },
    ] }] };
    const reset = async (source = initialSource) => {
      await fs.writeFile(join(project, 'film.html'), filmHtml(original));
      await fs.writeFile(join(project, 'scene.html'), source);
    };
    await reset();
    studio = await startStudio({ port: 0, advertise: true, openBrowser: () => {} });
    const config = { home }, client = await projectClient(config, project);
    const headers = { 'x-studio-key': studio.key, 'content-type': 'application/json' };
    const url = (route) => `${studio.origin}${client.base}/scene/${route}`;
    const post = async (route, body) => {
      const result = await fetch(url(route), { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: result.status, body: await result.json() };
    };
    const runCli = (args) => execute([...args, '--home', home], childEnv);
    const runMcp = async (requests) => {
      const wire = requests.map((request) => JSON.stringify(request)).join('\n') + '\n';
      const result = await execute(['mcp', '--project', project, '--home', home], childEnv, wire);
      assert.equal(result.code, 0, 'stdio 服务自身正常结束；工具错误另查 isError');
      return { ...result, requestWireBytes: Buffer.byteLength(wire), replies: result.stdout.trim().split('\n').map(JSON.parse) };
    };
    const ask = (read, targetPath, content) => ({ base: read.filmRevision, sourcePath: read.source.path, expectedSourceSha256: read.source.sha256, clipIds: ['scene'], targetPath, content });

    await t.test('离线发现不读取 home，HTTP 与 stdio 工具直接使用唯一 Schema 且鉴权不放宽', async () => {
      const absentHome = join(scratch, '不存在的 home');
      for (const name of ['scene-read', 'scene-revise']) {
        const result = await execute([name, '--schema', '--home', absentHome], { ...childEnv, APP_DATA_DIR: absentHome });
        assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), sceneSourceContract());
      }
      await assert.rejects(fs.stat(absentHome), { code: 'ENOENT' });
      assert.equal((await fetch(`${studio.origin}/api/scene-source-schema`)).status, 401);
      assert.deepEqual(await (await fetch(`${studio.origin}/api/scene-source-schema`, { headers })).json(), sceneSourceContract());
      assert.equal((await fetch(url('read'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"clipId":"scene"}' })).status, 401);
      assert.equal((await fetch(url('revise'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
      const listed = await runMcp([{ jsonrpc: '2.0', id: '列出', method: 'tools/list' }]);
      const tools = listed.replies[0].result.tools;
      assert.deepEqual(tools.find((entry) => entry.name === 'video_scene_read').inputSchema, sceneSourceContract().read);
      assert.deepEqual(tools.find((entry) => entry.name === 'video_scene_revise').inputSchema, sceneSourceContract().revise);
    });

    await t.test('同字节 Unicode 全文经真实 CLI/stdio读取，JSON 文件修订只切选定 src', async () => {
      const read = (await post('read', { clipId: 'scene' })).body;
      assert.equal(read.source.sha256, digest(Buffer.from(initialSource)));
      assert.equal(read.source.bytes, Buffer.byteLength(initialSource)); assert.equal(read.source.textIncluded, true);
      assert.equal(read.shared.total, 2);
      const fromCli = await runCli(['scene-read', project, 'scene']);
      assert.equal(fromCli.code, 0); assert.equal(JSON.parse(fromCli.stdout).source.text === initialSource, true);
      const fromMcp = await runMcp([callMessage('video_scene_read', { clipId: 'scene' }, '读取💡')]);
      assert.equal(toolData(fromMcp.replies[0]).source.text === initialSource, true);
      const content = initialSource.replace('尾', '新版本；仍保留人工标题');
      const argsFile = join(scratch, '修订 参数.json');
      await fs.writeFile(argsFile, JSON.stringify(ask(read, 'scene-r2.html', content)));
      const revised = await runCli(['scene-revise', project, '--args', argsFile]);
      assert.equal(revised.code, 0, revised.stderr);
      assert.equal(JSON.parse(revised.stdout).outcome, 'completed');
      assert.equal((await fs.readFile(join(project, 'scene-r2.html'), 'utf8')) === content, true);
      const film = await client.inspect(), scene = film.value.tracks[0].clips.find((entry) => entry.id === 'scene');
      assert.equal(scene.src, 'scene-r2.html'); assert.deepEqual(scene.time, original.tracks[0].clips[0].time);
      assert.deepEqual(scene.overrides, original.tracks[0].clips[0].overrides);
      assert.equal(film.value.tracks[0].clips.find((entry) => entry.id === 'other').src, 'scene.html');
      assert.equal(film.value.tracks[0].muted, true);
      await reset(); const fresh = (await post('read', { clipId: 'scene' })).body;
      await fs.appendFile(join(project, 'scene.html'), '<!-- 源变但 film 未变 -->');
      const conflict = await runMcp([callMessage('video_scene_revise', ask(fresh, 'stale.html', content))]);
      assert.equal(conflict.replies[0].result.isError, true); assert.equal(toolData(conflict.replies[0]).status, 409);
      assert.equal(toolData(conflict.replies[0]).sceneSourceError, true);
      await assert.rejects(fs.stat(join(project, 'stale.html')), { code: 'ENOENT' });
      const generic = await runMcp([callMessage('not_a_tool', {})]);
      assert.equal(generic.replies[0].result.isError, true);
      assert.deepEqual(Object.keys(toolData(generic.replies[0])), ['error']);
    });

    await t.test('实际原字节、JSON 文件与 MCP 行预算分别生效，超限不发布', async () => {
      await reset(); let read = (await post('read', { clipId: 'scene' })).body;
      const content = `<body>${'光'.repeat(87_000)}</body>`;
      assert.ok(Buffer.byteLength(content) <= SCENE_SOURCE_LIMITS.contentBytes);
      const argsFile = join(scratch, '大段源码.json');
      await fs.writeFile(argsFile, JSON.stringify(ask(read, 'unicode-near-limit.html', content)));
      const good = await runCli(['scene-revise', project, '--args', argsFile]);
      assert.equal(good.code, 0, good.stderr); assert.equal(JSON.parse(good.stdout).publication.bytes, Buffer.byteLength(content));
      await reset(); read = (await post('read', { clipId: 'scene' })).body;
      const tooRaw = ask(read, 'raw-too-large.html', '光'.repeat(88_000));
      await fs.writeFile(argsFile, JSON.stringify(tooRaw));
      const rawResult = await runCli(['scene-revise', project, '--args', argsFile]);
      assert.equal(rawResult.code, 1); assert.equal(JSON.parse(rawResult.stderr).status, 422);
      const escaped = ask(read, 'json-too-large.html', '\0'.repeat(132_000));
      const encoded = JSON.stringify(escaped);
      assert.ok(Buffer.byteLength(escaped.content) < SCENE_SOURCE_LIMITS.contentBytes);
      assert.ok(Buffer.byteLength(encoded) > SCENE_SOURCE_LIMITS.inputBytes);
      await fs.writeFile(argsFile, encoded);
      const fileResult = await runCli(['scene-revise', project, '--args', argsFile]);
      assert.equal(fileResult.code, 1); assert.match(fileResult.stderr, /768 KiB/);
      const escapedMcp = await runMcp([callMessage('video_scene_revise', escaped, 'escape-budget')]);
      assert.ok(escapedMcp.requestWireBytes < 1024 * 1024);
      t.diagnostic(JSON.stringify({ scope: 'escaped-revise-input', rawContentBytes: Buffer.byteLength(escaped.content), domainJsonBytes: Buffer.byteLength(encoded), actualRequestLineAndNewlineBytes: escapedMcp.requestWireBytes }));
      assert.equal(escapedMcp.replies[0].result.isError, true); assert.equal(toolData(escapedMcp.replies[0]).status, 422);
      const overLine = await runMcp([callMessage('video_scene_revise', ask(read, 'line-too-large.html', 'ok'), 'x'.repeat(1024 * 1024))]);
      assert.equal(overLine.replies[0].id, null); assert.equal(overLine.replies[0].error.code, -32700);
      for (const name of ['raw-too-large.html', 'json-too-large.html', 'line-too-large.html']) await assert.rejects(fs.stat(join(project, name)), { code: 'ENOENT' });
      assert.equal((await client.inspect()).rev, read.filmRevision);
    });

    await t.test('读取不静默截断；按实际 id、双层转义和换行计完整 stdio 字节', async () => {
      const quotes = '"'.repeat(200_000); await reset(quotes);
      const request = callMessage('video_scene_read', { clipId: 'scene' }, '实际id💡\\"');
      const actual = await runMcp([request]), message = actual.replies[0], data = toolData(message);
      assert.equal(message.id, request.id); assert.equal(data.source.textIncluded, true); assert.equal(data.source.text === quotes, true);
      assert.ok(Buffer.byteLength(message.result.content[0].text) <= SCENE_SOURCE_LIMITS.receiptBytes);
      const exactWire = JSON.stringify(message) + '\n';
      assert.equal(actual.stdout, exactWire);
      assert.ok(Buffer.byteLength(exactWire) > 512 * 1024, '512KiB 是旧内部 data JSON 检查，不是完整双层 RPC cap');
      t.diagnostic(JSON.stringify({ scope: 'actual-stdio-read-wire', sourceBytes: data.source.bytes, innerDataBytes: Buffer.byteLength(message.result.content[0].text), actualWireBytes: Buffer.byteLength(exactWire), exactSameSerializedLine: true }));
      await reset('"'.repeat(600_000));
      const omitted = await runMcp([callMessage('video_scene_read', { clipId: 'scene' }, 2)]);
      const metadata = toolData(omitted.replies[0]);
      assert.equal(metadata.source.textIncluded, false); assert.equal(Object.hasOwn(metadata.source, 'text'), false);
      assert.equal(metadata.source.omissionReason, 'complete-source-exceeds-receipt-budget');
      assert.equal(metadata.source.sha256, digest(Buffer.from('"'.repeat(600_000))));
      assert.ok(Buffer.byteLength(omitted.replies[0].result.content[0].text) <= SCENE_SOURCE_LIMITS.receiptBytes);
    });

    await t.test('真实发布后注入 film 竞争，HTTP、CLI、stdio 都保留有界恢复材料', async () => {
      const originalLink = fs.link;
      for (const via of ['http', 'cli', 'mcp']) {
        await reset(); const read = (await post('read', { clipId: 'scene' })).body;
        const content = `${initialSource}\n<!-- ${via} 完整新源码 -->`, target = `retained-${via}.html`;
        const input = ask(read, target, content);
        const mocked = t.mock.method(fs, 'link', async (from, to) => {
          const result = await originalLink(from, to);
          if (to === join(project, target)) await fs.appendFile(join(project, 'film.html'), `\n<!-- 同期外写 ${via} -->`);
          return result;
        });
        let detail, status;
        try {
          if (via === 'http') { const result = await post('revise', input); detail = result.body; status = result.status; }
          if (via === 'cli') {
            const file = join(scratch, '竞争 参数.json'); await fs.writeFile(file, JSON.stringify(input));
            const result = await execute(['--home', home, 'scene-revise', project, '--args', file], childEnv);
            assert.equal(result.code, 3); detail = JSON.parse(result.stderr); status = detail.status;
          }
          if (via === 'mcp') {
            const result = await runMcp([callMessage('video_scene_revise', input, '冲突')]);
            assert.equal(result.replies[0].result.isError, true); detail = toolData(result.replies[0]); status = detail.status;
          }
        } finally { mocked.mock.restore(); }
        assert.equal(status, 409); assert.equal(detail.sceneSourceError, true); assert.equal(detail.kind, 'recovery');
        assert.equal(detail.recovery.outcome, 'published-film-state-requires-inspection');
        assert.equal(detail.recovery.publication.path, target);
        assert.equal(detail.recovery.publication.sha256, digest(Buffer.from(content)));
        assert.equal(detail.recovery.publication.bytes, Buffer.byteLength(content));
        assert.equal(detail.recovery.publication.disposition, 'created');
        assert.equal(detail.recovery.filmRevision, (await client.inspect()).rev);
        assert.deepEqual(detail.recovery.selectedMappings, [{ clipId: 'scene', src: 'scene.html' }]);
        assert.equal(detail.recovery.action, 'fresh-inspect-before-retry');
        assert.equal(Object.hasOwn(detail, 'content'), false); assert.equal(Object.hasOwn(detail.recovery, 'source'), false);
        assert.ok(Buffer.byteLength(JSON.stringify(detail)) <= SCENE_SOURCE_LIMITS.receiptBytes);
        assert.equal((await fs.readFile(join(project, target), 'utf8')) === content, true);
      }
      assert.equal((await client.jobs()).length, 0);
    });
  } finally {
    await studio?.close();
    for (const [key, value] of Object.entries(beforeEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
