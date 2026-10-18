import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { projectClient } from './client.mjs';
import { argumentsOf, renderOptionsOf } from './cli.mjs';
import { tools } from './mcp.mjs';
import { normalizeVideoExportOptions, videoExportOptionsSchema } from '../packages/openfilm/studio/server/video-export-options.mjs';

const exact = 30000 / 1001;
test('CLI/MCP共享导出合同，明确保留透明、画幅、范围与快门语义', () => {
  const args = argumentsOf(['render', '/demo', '--codec', 'vp9', '--alpha', '--fps', '30000/1001', '--width', '1080', '--height', '1920', '--samples', '8', '--shutter', '0.5', '--range', '1-2.5', '--no-audio', '--no-hardware']);
  assert.deepEqual(renderOptionsOf(args.values), { codec: 'vp9', alpha: true, fps: exact, frame: '1080:1920', shortEdge: 1080, samples: 8, shutter: 0.5, range: [1, 2.5], audio: false, hardware: false });
  assert.equal(normalizeVideoExportOptions({ fps: 29.97 }).fps, exact);
  assert.equal(normalizeVideoExportOptions({ fps: '24000/1001' }).fps, 24000 / 1001);
  assert.equal(normalizeVideoExportOptions({ fps: 59.94 }).fps, 60000 / 1001);
  assert.deepEqual(tools.find((tool) => tool.name === 'video_render').inputSchema.properties.fps, videoExportOptionsSchema.properties.fps);
  assert.equal(tools.find((tool) => tool.name === 'video_render').inputSchema.properties.output.type, 'string');
});

test('无效或实际不支持的导出组合在提交前拒绝，不静默忽略', () => {
  for (const value of [
    { codec: 'av1' }, { fps: '29.97' }, { fps: 0 }, { fps: NaN }, { fps: 121 }, { width: 100 }, { width: 101, height: 100 },
    { width: 1080, height: 1920, frame: '9:16' }, { frame: '0:1' }, { frame: '7:1' }, { alpha: true, codec: 'h264' },
    { codec: 'png', audio: true }, { range: [2, 1] }, { samples: 0 }, { samples: 1.5 }, { samples: 33 },
    { shutter: 0.5 }, { shutter: 1.1, samples: 2 }, { clip: 'intro', shortEdge: 100 }, { scale: 2 }, { unknownOption: true },
  ]) assert.throws(() => normalizeVideoExportOptions(value), /视频导出参数无效/, JSON.stringify(value));
  assert.throws(() => renderOptionsOf({ range: 'start-end' }), /--range/);
});

test('真实client请求将规范化完整参数送到既有exports接口并返回实际回执', async () => {
  const home = mkdtempSync(join(tmpdir(), 'video-export-client-'));
  try {
    writeFileSync(join(home, 'run.json'), JSON.stringify({ origin: 'http://127.0.0.1:12345', key: 'a'.repeat(48) }));
    const calls = [];
    const request = async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      if (url.pathname === '/api/health') return Response.json({ product: 'video-creation-studio', home: createHash('sha256').update(home).digest('hex') });
      if (url.pathname === '/api/projects') return Response.json({ project: { id: 'film', path: '/demo' } });
      calls.push({ path: url.pathname, body });
      return Response.json({ exports: [{ id: 'b'.repeat(12), status: 'failed', error: '编码器不可用', ask: body.jobs[0] }] });
    };
    const client = await projectClient({ home, renderFps: 30, renderQuality: 'standard' }, '/demo', { request });
    const result = await client.render({ codec: 'prores4444', alpha: true, clip: 'badge', scale: 0.5, fps: '30000/1001', samples: 4, shutter: 0.25, audio: false, range: [0, 0.5] });
    assert.equal(result.status, 'failed');
    assert.equal(result.error, '编码器不可用');
    assert.equal(calls[0].path, '/api/projects/film/exports');
    assert.deepEqual(calls[0].body.jobs[0], { kind: 'video', fps: exact, quality: 'standard', codec: 'prores4444', alpha: true, clip: 'badge', scale: 0.5, samples: 4, shutter: 0.25, audio: false, range: [0, 0.5] });
    await assert.rejects(client.render({ codec: 'h264', alpha: true }), /alpha=true/);
    assert.equal(calls.length, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
