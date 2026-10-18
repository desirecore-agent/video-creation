import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio } from './server.mjs';
import { filmHtml } from '../../src/film-doc.mjs';

test('真实缩略图 HTTP 使用实例参数和布局，输入变化不能命中旧缓存', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'video-motion-thumbnails-'));
  const before = Object.fromEntries(['OPENFILM_HOME', 'OPENFILM_LIBRARY', 'OPENFILM_TRASH_DIR'].map((k) => [k, process.env[k]]));
  process.env.OPENFILM_HOME = join(root, 'home'); process.env.OPENFILM_LIBRARY = join(root, 'library'); process.env.OPENFILM_TRASH_DIR = join(root, 'trash'); mkdirSync(process.env.OPENFILM_TRASH_DIR);
  const studio = await startStudio({ port: 0, openBrowser: () => {} });
  try {
    const api = (path, body) => fetch(`${studio.origin}${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const made = await api('/api/projects', { path: join(root, 'project') });
    assert.equal(made.status, 200);
    const { project } = await made.json();
    const manifest = { version: 1, id: 'thumbnail', name: '缩略图', description: '参数和布局协议', paramsSchema: { type: 'object', additionalProperties: false, properties: { red: { type: 'number' } }, required: ['red'] }, defaults: { red: 0 } };
    writeFileSync(join(project.path, 'scene.html'), `<!doctype html><body style="margin:0"><script id="film-motion" type="application/json">${JSON.stringify(manifest)}</script><script>window.film={duration:2,frame(t,c){if(c.viewport.width!==320||innerWidth!==320||c.clipId!=='canvas')throw Error('缩略图实例上下文不同');document.body.style.background='rgb('+c.params.red+',0,0)';}}</script></body>`);
    const clip = { id: 'canvas', src: 'scene.html', motion: { version: 1, params: { red: 255 } } };
    const writeFilm = () => writeFileSync(join(project.path, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [clip] }] }));
    writeFilm();
    const thumbnail = async () => {
      const response = await api(`/api/projects/${project.id}/media?path=scene.html&what=frame&ms=500&w=160&clip=canvas`);
      assert.equal(response.status, 200, await (response.ok ? Promise.resolve('') : response.text()));
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.deepEqual([...bytes.subarray(0, 2)], [255, 216]);
      return bytes;
    };
    const red = await thumbnail();
    clip.motion.params.red = 30; writeFilm();
    const dark = await thumbnail();
    assert.ok(!red.equals(dark));
    assert.ok(dark.equals(await thumbnail()));
  } finally {
    await studio.close();
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
