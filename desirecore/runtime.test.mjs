import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runtimeConfig, runtimeIdentity, managedDocumentNavigation } from './config.mjs';
import { connectStudio } from './client.mjs';
import { createHash } from 'node:crypto';
import { serveMcp } from './mcp.mjs';
import { waitForJob } from './cli.mjs';

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
  for (const name of ['video_inspect', 'video_captions', 'video_prepare_media', 'video_speech_cut_plan', 'video_speech_cut_apply',
    'video_motion_catalog', 'video_motion_inspect', 'video_motion_install', 'video_motion_take', 'video_motion_patch',
    'video_patch', 'video_check', 'video_scene_read', 'video_scene_revise', 'video_review', 'video_render', 'video_jobs', 'video_retry', 'video_cancel'])
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
