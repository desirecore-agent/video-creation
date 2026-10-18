import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilmPage, launch, serve } from './host.mjs';
import { filmHtml } from './film-doc.mjs';
const manifest = { version: 1, id: 'host.canvas', name: '程序化画面', description: '验证参数先于 Canvas 绘制、人工 DOM 覆盖仍最后应用。', paramsSchema: { type: 'object', additionalProperties: false, required: ['x', 'title'], properties: { x: { type: 'number', minimum: 0 }, title: { type: 'string' } } }, defaults: { x: 2, title: '默认' } };
const scene = `<!doctype html><html><body style="margin:0"><canvas width="320" height="180"></canvas><p id="title"></p>
<script id="film-motion" type="application/json">${JSON.stringify(manifest)}</script>
<script>window.film={duration:4,prepare(c){window.prepared=c.params.x},frame(t,c){if(!c||window.prepared!==c.params.x)throw Error('上下文未先送达');const g=document.querySelector('canvas').getContext('2d');g.clearRect(0,0,320,180);g.fillStyle='#ff0000';g.fillRect(c.params.x,0,10,10);document.querySelector('#title').textContent=c.params.title;window.seen={t,context:c,prepared:window.prepared};}}</script></body></html>`;
test('真实 Chromium 单页与时间线使用相同输入协议，Canvas 先得到参数、DOM 覆盖最后生效', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'video-motion-host-'));
  mkdirSync(join(root, 'scenes'));
  writeFileSync(join(root, 'scenes', 'scene.html'), scene);
  const motion = { version: 1, params: { title: '实例' }, tracks: [{ path: 'params.x', keyframes: [{ t: 0, value: 0 }, { t: 2, value: 100 }] }], markers: [{ id: 'beat', t: 1 }] };
  writeFileSync(join(root, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'canvas', src: 'scenes/scene.html', motion, overrides: [{ at: '#title', text: '人工覆盖' }] }] }] }));
  const site = await serve(root), browser = await launch();
  try {
    const direct = await FilmPage.open(browser, site.url, 'scenes/scene.html');
    try {
      await direct.seek(0);
      const seen = await direct.page.evaluate(() => window.seen);
      assert.equal(seen.context.params.x, 2);
      assert.equal(seen.context.params.title, '默认');
      assert.deepEqual(seen.context.viewport, { width: 1920, height: 1080 });
    } finally { await direct.context.close(); }
    const film = await FilmPage.open(browser, site.url, 'film.html');
    try {
      const sample = async (t) => { await film.seek(t); return film.page.evaluate(() => { const d = document.querySelector('iframe').contentWindow; return { seen: d.seen, text: d.document.querySelector('#title').textContent, pixel: [...d.document.querySelector('canvas').getContext('2d').getImageData(50, 1, 1, 1).data] }; }); };
      const atOne = await sample(1);
      assert.equal(atOne.seen.context.params.x, 50);
      assert.equal(atOne.seen.context.clipId, 'canvas');
      assert.equal(atOne.seen.context.filmTime, 1);
      assert.deepEqual(atOne.seen.context.viewport, { width: 320, height: 180 });
      assert.equal(atOne.text, '人工覆盖');
      assert.deepEqual(atOne.pixel, [255, 0, 0, 255]);
      await sample(3);
      await sample(0);
      assert.deepEqual(await sample(1), atOne);
      assert.deepEqual(film.problems, []);
    } finally { await film.context.close(); }
  } finally { await browser.close(); await site.close(); rmSync(root, { recursive: true, force: true }); }
});
