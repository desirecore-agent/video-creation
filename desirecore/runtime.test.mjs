import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
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
  const patch = replies[1].result.tools.find((tool) => tool.name === 'video_patch');
  assert.deepEqual(patch.inputSchema.required, ['base', 'ops']);
  assert.equal(replies[1].result.tools.length, 7);
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
