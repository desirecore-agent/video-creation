import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio } from '../packages/openfilm/studio/server/server.mjs';
import { launch } from '../packages/openfilm/src/host.mjs';
import { filmHtml } from '../packages/openfilm/src/film-doc.mjs';

function projectEventLog(page, projectId) {
  const events = [], waiting = new Set();
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname !== `/api/projects/${projectId}/events`) return;
    socket.on('framereceived', ({ payload }) => {
      events.push(JSON.parse(String(payload)));
      for (const check of waiting) check();
    });
  });
  return {
    events,
    until(predicate, after = 0) {
      return new Promise((resolve, reject) => {
        const finish = () => { clearTimeout(timer); waiting.delete(check); };
        const check = () => { const found = events.slice(after).find(predicate); if (found) { finish(); resolve(found); } };
        const timer = setTimeout(() => { finish(); reject(new Error(`missing editor event: ${JSON.stringify(events)}`)); }, 10_000);
        waiting.add(check); check();
      });
    },
  };
}

const shownFilm = '.stage-frames > iframe[title="film"]:not([style*="opacity: 0"])';
const shownScene = (page) => page.frameLocator(shownFilm).frameLocator('#scene');

/* The preview reports a drawn picture before React removes the old frame. Do not retain a Frame from a hidden
   replacement, or a navigation of that old source could satisfy a later file-change assertion. */
async function readyPreview(page, heading) {
  await shownScene(page).getByRole('heading', { name: heading, exact: true }).waitFor();
  const handle = await page.waitForFunction(() => {
    const frames = [...document.querySelectorAll('.stage-frames > iframe[title="film"]')];
    return frames.length === 1 && frames[0].style.opacity !== '0' ? frames[0] : null;
  });
  const element = handle.asElement();
  assert.ok(element);
  return element;
}

/* Run after pnpm build; this exercises the real bundled Studio, its socket and the actual preview iframe. */
test('Studio follows an external same-id rename without losing the open director draft or reloading the film', { timeout: 45_000 }, async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'vc-project-sync-ui-')));
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
    mkdirSync(join(projectPath, 'assets'), { recursive: true });
    writeFileSync(join(projectPath, 'assets', 'notes.md'), 'Initial non-picture watcher marker.');
    writeFileSync(join(projectPath, 'film.html'), filmHtml({ stage: { w: 640, h: 360 }, tracks: [{ clips: [{ id: 'scene', src: 'scene.html', time: [0, 10] }] }] }));
    writeFileSync(join(projectPath, 'scene.html'), '<body><h1>Before rename</h1><script>window.film={duration:10,frame(t){}}</script></body>');
    const { project } = await api('projects', 'POST', { path: projectPath, create: false });
    const originalFilm = readFileSync(join(project.path, 'film.html'), 'utf8');
    browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
    const events = projectEventLog(page, project.id);
    await page.goto(`${studio.origin}/open?key=${studio.key}&to=/projects/${project.id}`);
    await page.getByRole('button', { name: '交给视频导演', exact: true }).waitFor();
    await events.until((event) => event.type === 'project' && event.project.id === project.id);
    const element = await readyPreview(page, 'Before rename');
    const preview = await element.contentFrame();
    assert.ok(preview);
    const origin = await preview.evaluate(() => performance.timeOrigin);
    const previewSrc = await element.getAttribute('src');
    const playhead = page.getByRole('slider', { name: '拖动播放头', exact: true });
    await playhead.press('ArrowRight');
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="拖动播放头"]')?.getAttribute('aria-valuenow')) > 0);
    const cursor = await playhead.getAttribute('aria-valuenow');
    const unchangedPreview = async (why) => {
      assert.equal(await page.locator('.stage-frames > iframe[title="film"]').count(), 1, `${why}: no replacement is loading`);
      assert.equal(await element.evaluate((el) => el.isConnected && el === document.querySelector('.stage-frames > iframe[title="film"]')), true, `${why}: the displayed DOM element stays`);
      assert.equal(await element.getAttribute('src'), previewSrc, `${why}: the preview URL stays`);
      const current = await element.contentFrame();
      assert.ok(current);
      assert.equal(await current.evaluate(() => performance.timeOrigin), origin, `${why}: the preview document stays`);
      assert.equal(await playhead.getAttribute('aria-valuenow'), cursor, `${why}: the playhead stays`);
    };
    await page.getByRole('button', { name: '交给视频导演', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '交给视频导演' });
    await dialog.getByRole('textbox').fill('保留当前镜头和我的修改指令');
    const { project: renamed } = await api(`projects/${project.id}`, 'PATCH', { name: 'Rename final' });
    await dialog.getByText(`项目: ${renamed.path}`, { exact: true }).waitFor({ state: 'attached' });
    /* A real non-picture write is a watcher barrier. It drains the native rename notification in the same stream
       and makes the UI process its files event, without sleeping until the offending reload might have happened. */
    const afterRename = events.events.length;
    const refreshedListing = page.waitForResponse(async (response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/api/projects/${project.id}/files`
      && (await response.json()).files.some((file) => file.path === 'assets/notes.md'), { timeout: 10_000 });
    const watchedNote = events.until((event) => event.type === 'files' && event.paths?.includes('assets/notes.md'), afterRename);
    writeFileSync(join(renamed.path, 'assets', 'notes.md'), 'Not part of the picture.');
    const [, listed] = await Promise.all([watchedNote, refreshedListing]);
    await listed.finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await dialog.getByRole('textbox').inputValue(), '保留当前镜头和我的修改指令');
    await unchangedPreview('metadata does not reload the preview');
    assert.equal(readFileSync(join(renamed.path, 'film.html'), 'utf8'), originalFilm);
    await dialog.getByRole('button', { name: '关闭', exact: true }).first().click();
    await page.locator('[data-titlebar]').getByRole('button', { name: 'Rename final', exact: true }).waitFor();
    await page.getByRole('button', { name: '项目', exact: true }).click();
    const library = page.getByRole('dialog', { name: '项目', exact: true });
    await library.getByRole('button', { name: 'Rename final', exact: true }).first().click({ timeout: 10_000 });
    await library.waitFor({ state: 'hidden' });
    await page.locator('[data-titlebar]').getByRole('button', { name: 'Rename final', exact: true }).waitFor();
    await unchangedPreview('picking the current project does not reset it');

    /* A later file edit is served from the renamed folder and reaches the already-open preview. */
    writeFileSync(join(renamed.path, 'scene.html'), '<body><h1>After rename</h1><script>window.film={duration:10,frame(t){}}</script></body>');
    await readyPreview(page, 'After rename');
    assert.equal(await shownScene(page).getByRole('heading', { name: 'After rename', exact: true }).textContent(), 'After rename', 'the renamed project continues to receive file events');
    assert.equal(await element.evaluate((el) => el.isConnected), false, 'a real source edit replaces the old preview only after its new picture is drawn');
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
