import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio } from '../packages/openfilm/studio/server/server.mjs';
import { launch } from '../packages/openfilm/src/host.mjs';
import { filmHtml } from '../packages/openfilm/src/film-doc.mjs';

/* Run after pnpm build; this exercises the real bundled Studio, its socket and the actual preview iframe. */
test('Studio follows an external same-id rename without losing the open director draft or reloading the film', { timeout: 45_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'vc-project-sync-ui-'));
  const oldHome = process.env.OPENFILM_HOME, oldLibrary = process.env.OPENFILM_LIBRARY;
  process.env.OPENFILM_HOME = join(scratch, 'home');
  process.env.OPENFILM_LIBRARY = join(scratch, 'projects');
  const studio = await startStudio({ port: 0 });
  let browser;
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`${studio.origin}/api/${path}`, {
      method, headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    /* Complete the fixture before registering/opening it, so setup writes cannot refresh the first preview. */
    const projectPath = join(scratch, 'projects', 'Rename draft');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, 'film.html'), filmHtml({ stage: { w: 640, h: 360 }, tracks: [{ clips: [{ id: 'scene', src: 'scene.html', time: [0, 10] }] }] }));
    writeFileSync(join(projectPath, 'scene.html'), '<body><h1>Before rename</h1><script>window.film={duration:10,frame(t){}}</script></body>');
    const { project } = await api('projects', 'POST', { path: projectPath, create: false });
    browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
    await page.goto(`${studio.origin}/open?key=${studio.key}&to=/projects/${project.id}`);
    await page.getByRole('button', { name: '交给视频导演', exact: true }).waitFor();
    /* Preview may replace its initial hidden iframe while mounting. Anchor only after its first picture is shown
       and no replacement is loading; src assignment alone does not mean that a frame navigated or is ready. */
    const readyFrame = await page.waitForFunction(() => {
      const frames = [...document.querySelectorAll('.stage-frames > iframe[title="film"]')];
      return frames.length === 1 && frames[0].style.opacity !== '0' ? frames[0] : null;
    });
    const preview = await readyFrame.asElement().contentFrame();
    assert.ok(preview, 'the actual film preview loaded');
    const initialScene = preview.childFrames().find((frame) => /\/scene\.html/.test(frame.url()));
    assert.ok(initialScene, 'the actual scene is loaded in the shown preview');
    await initialScene.getByRole('heading', { name: 'Before rename', exact: true }).waitFor();
    const origin = await preview.evaluate(() => performance.timeOrigin);
    await page.getByRole('button', { name: '交给视频导演', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '交给视频导演' });
    await dialog.getByRole('textbox').fill('保留当前镜头和我的修改指令');
    const { project: renamed } = await api(`projects/${project.id}`, 'PATCH', { name: 'Rename final' });
    await dialog.getByText(`项目: ${renamed.path}`, { exact: true }).waitFor({ state: 'attached' });
    assert.equal(await dialog.getByRole('textbox').inputValue(), '保留当前镜头和我的修改指令');
    assert.equal(await preview.evaluate(() => performance.timeOrigin), origin, 'metadata does not reload the preview document');
    await dialog.getByRole('button', { name: '关闭', exact: true }).first().click();
    await page.locator('[data-titlebar]').getByRole('button', { name: 'Rename final', exact: true }).waitFor();
    await page.getByRole('button', { name: '项目', exact: true }).click();
    await page.getByRole('dialog', { name: '项目', exact: true }).getByRole('button', { name: 'Rename final', exact: true }).first().click({ timeout: 10_000 });
    await page.locator('[data-titlebar]').getByRole('button', { name: 'Rename final', exact: true }).waitFor();
    assert.equal(await preview.evaluate(() => performance.timeOrigin), origin, 'picking the current project does not reset it');

    /* A later file edit is served from the renamed folder and reaches the already-open preview. */
    const sceneChanged = page.waitForEvent('framenavigated', { predicate: (frame) => /\/scene\.html/.test(frame.url()), timeout: 10_000 });
    writeFileSync(join(renamed.path, 'scene.html'), '<body><h1>After rename</h1><script>window.film={duration:10,frame(t){}}</script></body>');
    const updatedScene = await sceneChanged;
    await updatedScene.locator('h1').waitFor();
    assert.equal(await updatedScene.locator('h1').textContent(), 'After rename', 'the renamed project continues to receive file events');
    /* Let the library's poster work finish before shutting down its shared renderer. */
    await page.close();
    const poster = await fetch(`${studio.origin}/api/projects/${project.id}/poster`, { headers: { 'x-studio-key': studio.key } });
    assert.equal(poster.status, 200);
    await poster.arrayBuffer();
  } finally {
    await browser?.close();
    await studio.close();
    if (oldHome === undefined) delete process.env.OPENFILM_HOME; else process.env.OPENFILM_HOME = oldHome;
    if (oldLibrary === undefined) delete process.env.OPENFILM_LIBRARY; else process.env.OPENFILM_LIBRARY = oldLibrary;
    rmSync(scratch, { recursive: true, force: true });
  }
});
