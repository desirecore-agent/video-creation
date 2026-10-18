import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectClient } from './client.mjs';
import { callTool, serveMcp } from './mcp.mjs';
import { PassThrough } from 'node:stream';
import { filmHtml } from '../packages/openfilm/src/film-doc.mjs';
import { launch } from '../packages/openfilm/src/host.mjs';

const manifest = { version: 1, id: 'http-fixture', name: 'HTTP动效', description: '真实HTTP结构化编辑验证。', paramsSchema: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, opacity: { type: 'number', minimum: 0, maximum: 1 } } }, defaults: { title: '初稿', opacity: 1 } };

test('真实HTTP和MCP共享动效revision/锁/Schema，固定SDK与内置构件可导入自由编排', { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'video-motion-http-'));
  const project = join(home, 'projects', '真实 动效项目');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'scene', src: 'scene.html', time: [0, 2], motion: { version: 1, params: { title: '初稿', opacity: 1 } } }] }] }));
  writeFileSync(join(project, 'scene.html'), `<script id="film-motion" type="application/json">${JSON.stringify(manifest)}</script><body><div id="sample"></div><script type="module">import {mix} from './video-creation-motion/motion.mjs';window.film={duration:2,frame(t,c){document.getElementById('sample').textContent=c.params.title;document.body.dataset.sample=String(mix(0,10,t));document.body.dataset.clip=c.clipId;document.body.dataset.opacity=String(c.params.opacity);}}</script></body>`);
  writeFileSync(join(project, 'free.html'), '<script>window.film={duration:1,frame(t){}}</script>');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'start', '--home', home, '--project', project, '--no-browser'], { env: { ...process.env, APP_DATA_DIR: home, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  try {
    const lines = createInterface({ input: child.stdout });
    await Promise.race([once(lines, 'line').then(([line]) => JSON.parse(line)), exited.then(([code]) => { throw new Error(`启动失败 ${code}: ${errors}`); })]); lines.close();
    const config = { home, renderFps: 30, renderQuality: 'standard' };
    const client = await projectClient(config, project);
    const initial = await callTool(config, project, 'video_motion_inspect', { clip: 'scene' });
    assert.equal(initial.clips[0].manifest.id, 'http-fixture');
    assert.deepEqual(initial.clips[0].problems, []);
    const catalog = await callTool(config, project, 'video_motion_catalog');
    assert.ok(catalog.components.some((item) => item.source === 'project' && item.manifest.id === 'http-fixture'));
    const preset = catalog.components.find((item) => item.source === 'builtin' && item.manifest.id === 'general-alpha-title');
    assert.ok(preset);
    const manual = await client.motionPatch(initial.rev, 'scene', [{ path: ['params', 'title'], value: '人工终稿' }]);
    const merged = await callTool(config, project, 'video_motion_patch', { base: initial.rev, clip: 'scene', changes: [{ path: ['params', 'opacity'], value: 0.5 }] });
    assert.equal(merged.rebased, true);
    assert.equal(merged.value.tracks[0].clips[0].motion.params.title, '人工终稿');
    await assert.rejects(client.motionPatch(initial.rev, 'scene', [{ path: ['params', 'title'], value: '过期覆盖' }]), (error) => error.status === 409);
    await assert.rejects(client.motionPatch(merged.rev, 'scene', [{ path: ['params', 'opacity'], value: 5 }]), (error) => error.status === 422);
    const locked = await client.patch(merged.rev, [{ op: 'motion-locks', clip: 'scene', locked: ['params.title'] }]);
    await assert.rejects(callTool(config, project, 'video_motion_patch', { base: locked.rev, clip: 'scene', changes: [{ path: ['params', 'title'], value: '锁后覆盖' }] }), (error) => error.status === 409);
    await assert.rejects(client.patch(locked.rev, [{ op: 'fields', clip: 'scene', fields: { motion: null } }]), (error) => error.status === 409);
    const sdk = await callTool(config, project, 'video_motion_install', { base: locked.rev });
    assert.equal(sdk.installed, true);
    assert.match(readFileSync(join(project, sdk.path), 'utf8'), /MIT/);
    const opened = await client.inspect();
    const servedSdk = await fetch(new URL(sdk.path, opened.folder));
    assert.equal(servedSdk.status, 200);
    assert.match(await servedSdk.text(), /MIT/);
    const browser = await launch();
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
      await page.goto(new URL('scene.html', opened.folder).href);
      await page.waitForFunction(() => typeof window.film?.frame === 'function');
      const sampled = await page.evaluate(async (motion) => {
        const { drawFrame } = await import('./video-creation-motion/motion.mjs');
        await drawFrame(window.film, 1, { document, motion, clipId: 'scene', viewport: { width: 320, height: 180 } });
        return { title: document.getElementById('sample').textContent, value: document.body.dataset.sample, clip: document.body.dataset.clip, opacity: document.body.dataset.opacity };
      }, locked.value.tracks[0].clips[0].motion);
      assert.deepEqual(sampled, { title: '人工终稿', value: '10', clip: 'scene', opacity: '0.5' });
    } finally { await browser.close(); }
    assert.equal((await client.motionInstall(locked.rev)).installed, false);
    const taken = await callTool(config, project, 'video_motion_take', { base: locked.rev, component: preset.ref });
    assert.equal(taken.rev, locked.rev);
    assert.match(taken.clip.src, /^saved\//);
    assert.equal(taken.clip.id, undefined);
    assert.match(readFileSync(join(project, dirname(taken.clip.src), 'motion.mjs'), 'utf8'), /MIT/);
    const inserted = await client.patch(taken.rev, [{ op: 'insert', clip: taken.clip, at: 2, track: 0 }]);
    assert.equal(inserted.value.tracks[0].clips.length, 2);
    const free = await client.patch(inserted.rev, [{ op: 'insert', clip: { src: 'free.html', time: [0, 1] }, at: 8 }]);
    assert.notEqual(free.rev, inserted.rev);
    assert.deepEqual((await client.motionInspect('free')).clips[0].problems, []);
    await assert.rejects(client.motionTake(taken.rev, preset.ref), (error) => error.status === 409);
    await assert.rejects(client.call(`${client.base}/motion`, { clip: 'scene', changes: [] }, 'PATCH'), (error) => error.status === 400);
    await assert.rejects(client.call(`${client.base}/exports`, { jobs: [{ kind: 'video', codec: 'av1' }] }), (error) => error.status === 400 && /视频导出参数无效/.test(error.message));
    await assert.rejects(client.call(`${client.base}/exports`, { jobs: [{ kind: 'video', codec: 'h264', alpha: true }] }), (error) => error.status === 400 && /alpha=true/.test(error.message));
    const input = new PassThrough(), output = new PassThrough();
    let protocol = '';
    output.on('data', (chunk) => { protocol += chunk; });
    const served = serveMcp(config, project, { input, output });
    input.end([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'video_motion_patch', arguments: { base: initial.rev, clip: 'scene', changes: [{ path: ['params', 'title'], value: '协议覆盖' }] } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'video_render', arguments: { codec: 'av1' } } },
    ].map((request) => JSON.stringify(request)).join('\n') + '\n');
    await served;
    const replies = protocol.trim().split('\n').map(JSON.parse);
    assert.equal(replies[0].result.isError, true);
    assert.equal(JSON.parse(replies[0].result.content[0].text).status, 409);
    assert.equal(JSON.parse(replies[0].result.content[0].text).rev, free.rev);
    assert.equal(replies[1].result.isError, true);
    assert.match(JSON.parse(replies[1].result.content[0].text).error, /参数无效/);
    assert.equal((await client.jobs()).length, 0);
    assert.notEqual(manual.rev, initial.rev);
  } finally {
    child.kill('SIGTERM'); await exited;
    rmSync(home, { recursive: true, force: true });
  }
});
