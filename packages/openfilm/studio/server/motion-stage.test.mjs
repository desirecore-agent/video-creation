import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_FLAG, folderFiles, launch } from '../../src/host.mjs';
import { filmHtml } from '../../src/film-doc.mjs';

const STAGE = readFileSync(new URL('./stage.js', import.meta.url), 'utf8');

test('带项目路径前缀的真实舞台异步读取声明，结果可跨窗口克隆且错误明确反馈', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-motion-stage-'));
  const manifest = { version: 1, id: 'editable-title', name: '标题构件', description: '异步元数据回归', paramsSchema: { type: 'object', properties: { title: { type: 'string', description: '标题文字' } }, required: ['title'], additionalProperties: false }, defaults: { title: '原始标题' } };
  writeFileSync(join(dir, 'scene.html'), `<!doctype html><h1 id="title">标题</h1><script type="application/json" id="film-motion">${JSON.stringify(manifest)}</script><script>window.film={duration:2,frame(t,c){document.getElementById('title').textContent=c.params.title}}</script>`);
  writeFileSync(join(dir, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'scene', src: 'scene.html', motion: { version: 1, params: { title: '人工标题' } } }] }] }));
  let files;
  const prefix = '/p/test-stage-project/';
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    if (!url.pathname.startsWith(prefix) || !files(req, res, `/${url.pathname.slice(prefix.length)}`, url.searchParams)) res.writeHead(404).end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  files = folderFiles(dir, { timelineInject: `<script>${HOST_FLAG}</script><script>${STAGE.replaceAll('__EDITOR__', JSON.stringify(origin))}</script>` });
  let browser;
  try {
    browser = await launch();
    const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}${prefix}film.html`);
    await page.waitForFunction(() => Boolean(window.film));
    await page.evaluate(async () => { await window.film.ready; await window.film.frame(0.5); });
    const ask = () => page.evaluate(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('message', hear); reject(new Error('stage controls没有返回结果')); }, 3000);
      function hear(event) {
        if (event.data?.source !== 'openfilm-film' || event.data.type !== 'stage' || event.data.seq !== 701) return;
        clearTimeout(timer); window.removeEventListener('message', hear); resolve(event.data.result);
      }
      window.addEventListener('message', hear);
      window.postMessage({ source: 'openfilm-studio', type: 'stage', seq: 701, op: 'controls', clip: 'scene' }, '*');
    }));
    const controls = await ask();
    assert.equal(controls.motionManifest.id, manifest.id);
    assert.equal(controls.motionError, null);
    assert.ok(controls.texts.some((row) => row.value === '人工标题'));
    assert.deepEqual(errors, []);
    await page.frames()[1].evaluate(() => { document.getElementById('film-motion').textContent = '{"version":'; });
    const invalid = await ask();
    assert.equal(invalid.motionManifest, null);
    assert.match(invalid.motionError, /JSON/);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); server.closeAllConnections?.(); await new Promise((done) => server.close(done)); rmSync(dir, { recursive: true, force: true });
  }
});
