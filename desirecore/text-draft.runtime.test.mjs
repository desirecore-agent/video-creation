import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startStudio } from '../packages/openfilm/studio/server/server.mjs';
import { launch } from '../packages/openfilm/src/host.mjs';
import { filmHtml, readFilmFile } from '../packages/openfilm/src/film-doc.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

/* Actual built Studio, its text inspector, React callbacks and real film writes. Only the first response delivery
   is delayed (or explicitly fault-injected); no application callbacks or saved state are replaced. */
test('Studio text drafts survive slow writes, refusals and a later layer selection', { timeout: 90_000 }, async (t) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'vc-text-draft-ui-')));
  const old = Object.fromEntries(['OPENFILM_HOME', 'OPENFILM_LIBRARY'].map((key) => [key, process.env[key]]));
  process.env.OPENFILM_HOME = join(scratch, 'home');
  process.env.OPENFILM_LIBRARY = join(scratch, 'projects');
  const studio = await startStudio({ port: 0 });
  let browser;
  const releases = [];
  const pages = [];
  const pageErrors = [];
  const savedText = (project) => {
    const film = readFilmFile(readFileSync(join(project.path, 'film.html'), 'utf8'));
    return film.value.tracks[0].clips[0].overrides?.find((entry) => entry.at === '#headline')?.text;
  };
  const open = async (name, secondClip = false) => {
    const path = join(scratch, 'projects', name);
    mkdirSync(path, { recursive: true });
    const intro = { id: 'intro', src: 'scene.html', time: [0, 6], ...(secondClip ? { box: { x: 0, y: 0, w: 320, h: 360 } } : {}) };
    writeFileSync(join(path, 'film.html'), filmHtml({ stage: { w: 640, h: 360 }, tracks: [{ clips: [intro] }, ...(secondClip
      ? [{ clips: [{ id: 'other-clip', src: 'other.html', time: [0, 6], box: { x: 320, y: 0, w: 320, h: 360 } }] }] : [])] }));
    writeFileSync(join(path, 'scene.html'), '<body style="margin:0;background:#eee"><h1 id="headline" style="position:absolute;left:40px;top:40px">Initial title</h1><h2 id="subtitle" style="position:absolute;left:40px;top:160px">Other layer</h2><script>window.film={duration:6,frame(t){}}</script>');
    if (secondClip) writeFileSync(join(path, 'other.html'), '<body style="margin:0;background:#ddd"><h1 id="headline" style="position:absolute;left:40px;top:40px">Other clip</h1><script>window.film={duration:6,frame(t){}}</script>');
    const response = await fetch(`${studio.origin}/api/projects`, { method: 'POST', headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, body: JSON.stringify({ path, create: false }) });
    assert.equal(response.status, 200);
    const { project } = await response.json();
    /* Finish the library's first derived picture before holding a live preview element. */
    const poster = await fetch(`${studio.origin}/api/projects/${project.id}/poster`, { headers: { 'x-studio-key': studio.key } });
    assert.equal(poster.status, 200); await poster.arrayBuffer();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
    pages.push(page);
    page.on('pageerror', (error) => { pageErrors.push({ case: name, message: error.message }); t.diagnostic(error.stack ?? error.message); });
    await page.goto(`${studio.origin}/open?key=${studio.key}&to=/projects/${project.id}`);
    await page.frameLocator('iframe[title="film"]').frameLocator('#intro').getByRole('heading', { name: 'Initial title', exact: true }).click();
    const field = page.getByRole('textbox', { name: '文字', exact: true });
    await field.waitFor();
    return { page, field, project };
  };
  const delayFirst = async (page, project, refuse = false) => {
    const started = deferred(), release = deferred(); releases.push(release.resolve);
    let first = true;
    await page.route(`**/api/projects/${project.id}/edit`, async (route) => {
      if (!first) { await route.continue(); return; }
      first = false;
      const response = refuse ? null : await route.fetch();
      if (response) assert.equal(response.status(), 200, 'the delayed write actually succeeded');
      started.resolve();
      await release.promise;
      if (response) await route.fulfill({ response });
      else await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic refused edit' }) });
    });
    return { started: started.promise, release: release.resolve };
  };
  const settled = async (page) => {
    await page.waitForFunction(() => {
      const field = document.querySelector('textarea[aria-label="文字"]');
      return field && !field.classList.contains('opacity-60');
    });
  };
  const saveNow = async (page, field, project) => {
    const response = page.waitForResponse((entry) => entry.url().endsWith(`/api/projects/${project.id}/edit`));
    await field.press('Tab');
    assert.equal((await response).status(), 200);
    await settled(page);
  };
  try {
    browser = await launch();
    await t.test('an earlier success keeps a newer unsubmitted draft and its eventual save', async () => {
      const { page, field, project } = await open('slow-success');
      const delayed = await delayFirst(page, project);
      await field.fill('First committed'); await field.press('Tab'); await delayed.started;
      await field.fill('Second unsaved draft');
      delayed.release(); await settled(page);
      assert.equal(await field.inputValue(), 'Second unsaved draft');
      assert.equal(savedText(project), 'First committed');
      await saveNow(page, field, project);
      assert.equal(savedText(project), 'Second unsaved draft');
      await page.reload();
      await page.frameLocator('iframe[title="film"]').frameLocator('#intro').getByRole('heading', { name: 'Second unsaved draft', exact: true }).waitFor();
      await page.close();
    });
    await t.test('an earlier refusal retains the newer draft despite resetting the other inspector controls', async () => {
      const { page, field, project } = await open('slow-refusal');
      const delayed = await delayFirst(page, project, true);
      await field.fill('Refused first'); await field.press('Tab'); await delayed.started;
      await field.fill('Keep this new draft');
      delayed.release(); await settled(page);
      assert.equal(await field.inputValue(), 'Keep this new draft');
      await page.getByText('Synthetic refused edit', { exact: true }).first().waitFor();
      assert.equal(savedText(project), undefined);
      await saveNow(page, field, project);
      assert.equal(savedText(project), 'Keep this new draft');
      await page.close();
    });
    await t.test('two queued blurs finish for their original layer without changing another layer draft', async () => {
      const { page, field, project } = await open('queued-layer-switch');
      const delayed = await delayFirst(page, project);
      await field.fill('First committed'); await field.press('Tab'); await delayed.started;
      await field.fill('Second committed'); await field.press('Tab');
      await page.frameLocator('iframe[title="film"]').frameLocator('#intro').getByRole('heading', { name: 'Other layer', exact: true }).click();
      /* Selecting an iframe layer reaches the parent inspector asynchronously; type only after that selection. */
      await page.waitForFunction(() => document.querySelector('textarea[aria-label="文字"]')?.value === 'Other layer');
      await field.fill('Other layer unsaved');
      const lastResponse = page.waitForResponse((response) => response.url().endsWith(`/api/projects/${project.id}/edit`) && response.request().postData()?.includes('Second committed'));
      delayed.release(); await lastResponse;
      await page.waitForFunction(() => document.querySelector('textarea[aria-label="文字"]')?.value === 'Other layer unsaved');
      assert.equal(await field.inputValue(), 'Other layer unsaved');
      assert.equal(savedText(project), 'Second committed');
      assert.equal(readFileSync(join(project.path, 'film.html'), 'utf8').includes('Other layer unsaved'), false);
      await page.close();
    });
    await t.test('the same selector in another clip is a different inspector target', async () => {
      const { page, field, project } = await open('queued-same-selector', true);
      const delayed = await delayFirst(page, project);
      await field.fill('First committed'); await field.press('Tab'); await delayed.started;
      await field.fill('Second committed'); await field.press('Tab');
      await page.frameLocator('iframe[title="film"]').frameLocator('#other-clip').getByRole('heading', { name: 'Other clip', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('textarea[aria-label="文字"]')?.value === 'Other clip');
      await field.fill('Other clip unsaved');
      const lastResponse = page.waitForResponse((response) => response.url().endsWith(`/api/projects/${project.id}/edit`) && response.request().postData()?.includes('Second committed'));
      delayed.release(); await lastResponse;
      assert.equal(await field.inputValue(), 'Other clip unsaved');
      assert.equal(savedText(project), 'Second committed');
      const film = readFilmFile(readFileSync(join(project.path, 'film.html'), 'utf8'));
      assert.equal(film.value.tracks[1].clips[0].overrides, undefined, 'old target writes do not enter the other clip');
      await page.close();
    });
    assert.deepEqual(pageErrors, [], 'refusals and layer changes do not crash the actual React editor');
  } finally {
    for (const release of releases) release();
    await Promise.all(pages.map((page) => page.close().catch(() => {})));
    await browser?.close();
    await studio.close();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(scratch, { recursive: true, force: true });
  }
});
