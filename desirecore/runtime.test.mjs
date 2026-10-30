import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runtimeConfig, runtimeEnvironment, runtimeIdentity, managedDocumentNavigation } from './config.mjs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setupRuntime } from './setup-runtime.mjs';
import { connectStudio } from './client.mjs';
import { createHash } from 'node:crypto';
import { serveMcp } from './mcp.mjs';
import { waitForJob } from './cli.mjs';

test('首次CLI导入后初始化：真实SDK完整路径与默认shell、显式channel均在同一根，缺失不回退', () => {
  const root = mkdtempSync(join(tmpdir(), 'video-browser-root-'));
  const before = { ...process.env };
  try {
    for (const override of [undefined, join(root, 'explicit'), 'relative-cache', '0']) {
      const env = { ...process.env, APP_DATA_DIR: join(root, 'formal'), INIT_CWD: root };
      delete env.PLAYWRIGHT_BROWSERS_PATH;
      if (override !== undefined) env.PLAYWRIGHT_BROWSERS_PATH = override;
      const script = `
        await import(${JSON.stringify(new URL('./cli.mjs', import.meta.url).href)});
        const {runtimeConfig,applyRuntimeEnvironment} = await import(${JSON.stringify(new URL('./config.mjs', import.meta.url).href)});
        applyRuntimeEnvironment(runtimeConfig({home:'unused-candidate'}));
        const {launch} = await import(${JSON.stringify(new URL('../packages/openfilm/src/host.mjs', import.meta.url).href)});
        const failures=[];
        if(process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') {
          for(const options of [{},{channel:'chromium'}]) {
            try { const browser=await launch(options); await browser.close(); throw Error('unexpected browser'); }
            catch(e) { failures.push(e.message); }
          }
        }
        const {createRequire} = await import('node:module');
        const require=createRequire(${JSON.stringify(new URL('../packages/openfilm/package.json', import.meta.url).href)});
        const {chromium}=require('playwright-core');
        const path=chromium.executablePath();
        let changed;
        if(failures.length) { process.env.PLAYWRIGHT_BROWSERS_PATH += '-changed'; try { await launch(); } catch(e) { changed=e.message; } }
        console.log(JSON.stringify({path,failures,changed}));`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-'], { input: script, env, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, result.stderr);
      const observed = JSON.parse(result.stdout);
      if (override === '0') { assert.match(observed.path, /playwright-core[/\\].local-browsers/); continue; }
      const cache = override === 'relative-cache' ? join(root, override) : override ?? join(root, 'formal', 'runtime', 'ms-playwright');
      assert.ok(observed.path.startsWith(cache), observed.path);
      assert.equal(observed.failures.length, 2);
      assert.match(observed.changed, /首次加载后发生变化/);
      for (const failure of observed.failures) { assert.ok(failure.includes(cache), failure); assert.match(failure, /Executable doesn't exist/); }
      assert.match(observed.failures[0], /chromium_headless_shell/);
      assert.ok(observed.failures[1].includes(observed.path), observed.failures[1]);
    }
    assert.deepEqual({ ...process.env }, before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('首次SDK异步导入窗口漂移永久拒绝复用，同环境并发保持可用', () => {
  const root = mkdtempSync(join(tmpdir(), 'video-browser-import-window-'));
  try {
    for (const drift of [false, true]) {
      const first = join(root, 'first'), second = join(root, 'second');
      const script = `
        const {launch}=await import(${JSON.stringify(new URL('../packages/openfilm/src/host.mjs', import.meta.url).href)});
        const message=promise=>promise.then(async browser=>{await browser.close();return 'unexpected browser';},error=>error.message);
        // launch 在第一个 await 之前发起 SDK import；同步改值确定落在导入完成之前。
        const pending=[message(launch()),message(launch())];
        if (${JSON.stringify(drift)}) process.env.PLAYWRIGHT_BROWSERS_PATH=${JSON.stringify(second)};
        const failures=await Promise.all(pending);
        process.env.PLAYWRIGHT_BROWSERS_PATH=${JSON.stringify(first)};
        const restored=await message(launch());
        console.log(JSON.stringify({failures,restored}));`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-'], {
        input: script, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: first, INIT_CWD: root },
      });
      assert.equal(child.status, 0, child.stderr);
      const { failures, restored } = JSON.parse(child.stdout);
      assert.equal(failures.length, 2);
      for (const failure of [...failures, restored]) {
        if (drift) {
          assert.match(failure, /首次加载后发生变化/);
          assert.doesNotMatch(failure, /Executable doesn't exist/);
        } else {
          assert.match(failure, /Executable doesn't exist/);
          assert.ok(failure.includes(first), failure);
          assert.match(failure, /chromium_headless_shell/);
        }
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('setup真实spawn消费同根env，受控安装GC只触临时目标且不污染父环境', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'video-setup-cache-'));
  const sentinel = join(root, 'shared-sentinel');
  writeFileSync(sentinel, 'keep');
  // 测试固定使用临时根，不继承开发者或CI的显式共享缓存；结束后恢复原值。
  const inheritedCache = process.env.PLAYWRIGHT_BROWSERS_PATH;
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  const before = { ...process.env };
  const spawnReal = childProcess.spawn;
  try {
    t.mock.method(childProcess, 'spawnSync', (file) => {
      assert.ok(['ffmpeg','ffprobe'].includes(file)); return { status: 0 };
    });
    t.mock.method(childProcess, 'spawn', (exe, args, options) => {
      assert.deepEqual(args.slice(1), ['install', '--only-shell', 'chromium']);
      assert.equal(options.env.PLAYWRIGHT_BROWSERS_PATH, runtimeEnvironment({home:root}).PLAYWRIGHT_BROWSERS_PATH);
      // 替身仅允许临时目标；模拟安装器在缓存内写入/GC，不执行真实下载或共享GC。
      const cache = options.env.PLAYWRIGHT_BROWSERS_PATH;
      assert.ok(cache.startsWith(root), '测试环境显式缓存不得指向真实用户缓存');
      const code = `const fs=require('node:fs'),p=require('node:path');const root=process.env.PLAYWRIGHT_BROWSERS_PATH;fs.mkdirSync(root,{recursive:true});fs.writeFileSync(p.join(root,'stale'),'old');fs.unlinkSync(p.join(root,'stale'));fs.writeFileSync(p.join(root,'installed'),'shell');`;
      return spawnReal(exe, ['-e', code], options);
    });
    syncBuiltinESMExports();
    await setupRuntime({ home: root });
    assert.equal(readFileSync(join(root, 'runtime', 'ms-playwright', 'installed'), 'utf8'), 'shell');
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
    assert.deepEqual({ ...process.env }, before);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (inheritedCache === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = inheritedCache;
    rmSync(root, { recursive: true, force: true });
  }
});

const identity = { DESIRECORE_APP_RUNTIME_PROOF: 'opaque-proof', DESIRECORE_APP_RELEASE_DIGEST: 'digest', DESIRECORE_APP_SCOPE_ID: 'installed-a', DESIRECORE_APP_RUNTIME_GENERATION: 'generation-a' };

test('受管数据目录优先、配置校验拒绝未知字段及猜测参数', () => {
  const home = mkdtempSync(join(tmpdir(), 'video-config-'));
  try {
    assert.equal(runtimeConfig({}, { DESIRECORE_APP_DATA_DIR: home, PORT: '12345' }).port, 12345);
    assert.equal(runtimeConfig({ home: '/stale-candidate', port: 1000 }, { APP_DATA_DIR: home, PORT: '12345' }).home, home);
    assert.equal(runtimeConfig({ home: '/stale-candidate', port: 1000 }, { APP_DATA_DIR: home, PORT: '12345' }).port, 12345);
    writeFileSync(join(home, 'runtime-config.json'), JSON.stringify({ directorAgentId: 'actual-director-2' }));
    assert.equal(runtimeConfig({ home }, {}).directorAgentId, 'actual-director-2');
    writeFileSync(join(home, 'runtime-config.json'), '{"serviceToken":"must-not-be-config"}');
    assert.throws(() => runtimeConfig({ home }, {}), /配置无效/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('原生受管导航可签入，跨站iframe与缺字段身份不能签入', () => {
  const headers = { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' };
  assert.equal(runtimeIdentity({}), null);
  assert.equal(runtimeIdentity(identity).scopeId, 'installed-a');
  assert.equal(managedDocumentNavigation(headers, identity), true);
  assert.equal(managedDocumentNavigation({ ...headers, 'sec-fetch-dest': 'iframe' }, identity), false);
  assert.equal(managedDocumentNavigation({ ...headers, origin: 'https://external.test' }, identity), false);
  assert.equal(managedDocumentNavigation(headers, {}), false);
});

test('运行发现拒绝非loopback地址，不发送本地key到外部地址', async () => {
  const home = mkdtempSync(join(tmpdir(), 'video-discovery-'));
  try {
    writeFileSync(join(home, 'run.json'), JSON.stringify({ origin: 'https://outside.test', key: 'a'.repeat(48) }));
    let fetched = false;
    await assert.rejects(connectStudio({ home }, () => { fetched = true; }), /运行记录无效/);
    assert.equal(fetched, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('MCP初始化和工具目录无需运行应用且标准输出只有JSON-RPC', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  const ended = serveMcp({ home: '/unused' }, '/unused', { input, output });
  input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  await ended;
  const replies = text.trim().split('\n').map(JSON.parse);
  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
  assert.equal(replies[0].result.serverInfo.version, JSON.parse(readFileSync(new URL('../packages/openfilm/package.json', import.meta.url), 'utf8')).version);
  const patch = replies[1].result.tools.find((tool) => tool.name === 'video_patch');
  assert.deepEqual(patch.inputSchema.required, ['base', 'ops']);
  assert.deepEqual(replies[1].result.tools.filter((tool) => tool.name.startsWith('video_motion_')).map((tool) => tool.name), ['video_motion_catalog', 'video_motion_inspect', 'video_motion_install', 'video_motion_take', 'video_motion_patch']);
  // 公开入口须向后兼容且名称唯一；新增工具不应让旧的固定数量断言误报失败。
  const listedNames = replies[1].result.tools.map((tool) => tool.name);
  const names = new Set(listedNames);
  assert.equal(names.size, listedNames.length);
  for (const name of ['video_inspect', 'video_captions', 'video_captions_source', 'video_captions_save', 'video_prepare_media', 'video_speech_cut_plan', 'video_speech_cut_apply',
    'video_motion_catalog', 'video_motion_inspect', 'video_motion_install', 'video_motion_take', 'video_motion_patch',
    'video_patch', 'video_check', 'video_scene_read', 'video_scene_revise', 'video_review', 'video_reviews', 'video_review_read', 'video_subtitle_style', 'video_caption_audio', 'video_render', 'video_jobs', 'video_retry', 'video_cancel'])
    assert.ok(names.has(name), `缺少公开工具：${name}`);
  assert.deepEqual(replies[1].result.tools.filter((tool) => tool.name.startsWith('video_scene_')).map((tool) => tool.name), ['video_scene_read', 'video_scene_revise']);
  assert.deepEqual(replies[1].result.tools.find((tool) => tool.name === 'video_scene_read').inputSchema.required, ['clipId']);
  assert.deepEqual(replies[1].result.tools.find((tool) => tool.name === 'video_scene_revise').inputSchema.required, ['base', 'sourcePath', 'expectedSourceSha256', 'clipIds', 'targetPath', 'content']);
  assert.deepEqual(replies[1].result.tools.find((tool) => tool.name === 'video_review').inputSchema.required, ['source']);
});

test('导出回执等待失败明确结果未知，不自动重复提交', async () => {
  const home = mkdtempSync(join(tmpdir(), 'video-timeout-'));
  try {
    writeFileSync(join(home, 'run.json'), JSON.stringify({ origin: 'http://127.0.0.1:12345', key: 'a'.repeat(48) }));
    let submitted = 0;
    const client = await connectStudio({ home }, async (url) => {
      if (url.pathname === '/api/health') return Response.json({ product: 'video-creation-studio', home: createHash('sha256').update(home).digest('hex') });
      submitted += 1;
      throw new DOMException('The operation timed out', 'TimeoutError');
    });
    await assert.rejects(client.call('/api/projects/test/exports', {}, 'POST', { timeoutMs: 1000, unknownReceipt: true }), /结果未知.*jobs/);
    assert.equal(submitted, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('等待失败/中断立即返回，不将中断当作成功；超时不取消后台工作', async () => {
  const client = { jobs: async () => [{ id: 'a', status: 'interrupted' }] };
  assert.equal((await waitForJob(client, 'a')).status, 'interrupted');
  await assert.rejects(waitForJob({ jobs: async () => [{ id: 'a', status: 'running' }] }, 'a', { timeoutMs: 5, intervalMs: 2 }), /等待超时/);
});


test('目录链接正式入口实际执行并保留错误退出码，兼容preserve-symlinks-main', () => {
  const root = mkdtempSync(join(tmpdir(), 'video-entry-link-'));
  try {
    const alias = join(root, 'app-link');
    symlinkSync(fileURLToPath(new URL('..', import.meta.url)), alias, process.platform === 'win32' ? 'junction' : 'dir');
    for (const flags of [[], ['--preserve-symlinks-main']]) {
      const cli = spawnSync(process.execPath, [...flags, join(alias, 'desirecore', 'cli.mjs'), 'unknown-entry-command', '--home', join(root, 'unused-home')], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, APP_DATA_DIR: join(root, 'unused-home') } });
      assert.equal(cli.status, 1, cli.stderr);
      assert.equal(cli.stdout, '');
      assert.match(cli.stderr, /未知命令：unknown-entry-command/);
      const release = spawnSync(process.execPath, [...flags, join(alias, 'desirecore', 'release.mjs'), '--unknown-entry-option'], { encoding: 'utf8', timeout: 15_000 });
      assert.equal(release.status, 1, release.stderr);
      assert.equal(release.stdout, '');
      assert.match(release.stderr, /Unknown or incomplete argument: --unknown-entry-option/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stdin导入正式模块没有main输出、副作用或不存在argv路径异常', () => {
  const root = mkdtempSync(join(tmpdir(), 'video-entry-import-'));
  try {
    const alias = join(root, 'app-link');
    symlinkSync(fileURLToPath(new URL('..', import.meta.url)), alias, process.platform === 'win32' ? 'junction' : 'dir');
    const home = join(root, 'must-not-be-created');
    const imports = ['cli.mjs', 'release.mjs', 'mcp.mjs', 'setup-runtime.mjs'].map((file) => `await import(${JSON.stringify(pathToFileURL(join(alias, 'desirecore', file)).href)});`).join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-'], { input: imports, cwd: root, encoding: 'utf8', timeout: 15_000, env: { ...process.env, APP_DATA_DIR: home } });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr, '');
    assert.equal(existsSync(home), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
