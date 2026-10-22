import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filmHtml } from '../../src/film-doc.mjs';
import { editProjectFilm, readProjectFilm, withProjectFilmEdit } from './film.mjs';
import { SCENE_READ_SCHEMA, SCENE_REVISE_SCHEMA, SCENE_SOURCE_LIMITS, SceneSourceError, readSceneSource, reviseSceneSource, sceneSourceContract, sceneSourceErrorReceipt, projectSceneSourceErrorReceipt } from './scene-source.mjs';

const roots = [];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const plain = '<!doctype html><canvas id="art"></canvas><script>window.film={duration:2,frame(t){}};</script>\n<!-- 原创：潮光 -->';
const manifest = { version: 1, id: 'fixture', name: '测试场景', description: '保留人工参数。', paramsSchema: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, opacity: { type: 'number', minimum: 0, maximum: 1 } } }, defaults: { title: '默认', opacity: 1 } };
const declared = (value = manifest) => `<script id="film-motion" type="application/json">${JSON.stringify(value)}</script>${plain}`;
async function fixture({ source = plain, motion, shared = true } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'scene-source-')); roots.push(root);
  const clip = { id: 'one', src: 'scene.html', time: [0.25, 1.5], at: 1, box: { x: 10, y: 10, w: 300, h: 160 }, attrs: { 'data-note': '人工备注' }, overrides: [{ at: '#art', text: '人工终稿', lock: true }], ...(motion ? { motion } : {}) };
  await fs.writeFile(join(root, 'scene.html'), source);
  await fs.writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ hidden: true, locked: true, clips: [clip] }, ...(shared ? [{ muted: true, clips: [{ id: 'two', src: 'scene.html', time: [0, 2], ...(motion ? { motion: structuredClone(motion) } : {}) }] }] : [])] }));
  return root;
}
test.afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const request = (read, extra = {}) => ({ base: read.filmRevision, sourcePath: read.source.path, expectedSourceSha256: read.source.sha256, clipIds: ['one'], targetPath: 'scene-r2.html', content: `${plain}\n<!-- 明确新版本 -->`, ...extra });
const read = (root) => readSceneSource(root, { clipId: 'one' });
const noTarget = async (root, path = 'scene-r2.html') => assert.equal(await fs.lstat(join(root, path)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)), null);
const kind = (expected) => (error) => error instanceof SceneSourceError && error.kind === expected;

test('公开 Draft-07 合同与原Buffer UTF8/SHA/完整正文、共享物理引用一致', async () => {
  const root = await fixture();
  const raw = await fs.readFile(join(root, 'scene.html'));
  const got = await read(root);
  assert.equal(got.source.sha256, digest(raw)); assert.equal(got.source.bytes, raw.length);
  assert.equal(got.source.textIncluded, true); assert.equal(got.source.text, raw.toString('utf8'));
  assert.deepEqual(got.shared.references.map((row) => row.clipId), ['one', 'two']); assert.equal(got.shared.complete, true);
  assert.equal(sceneSourceContract().read, SCENE_READ_SCHEMA); assert.equal(sceneSourceContract().revise, SCENE_REVISE_SCHEMA);
  assert.equal(SCENE_READ_SCHEMA.$schema, 'http://json-schema.org/draft-07/schema#');
});

test('源文件单独变化但影片不变时旧摘要在发布前拒绝，fresh读可继续', async () => {
  const root = await fixture(), before = await read(root), film = await fs.readFile(join(root, 'film.html'));
  await fs.appendFile(join(root, 'scene.html'), '\n<!-- 人工新改 -->');
  await assert.rejects(reviseSceneSource(root, request(before)), kind('conflict'));
  await noTarget(root); assert.deepEqual(await fs.readFile(join(root, 'film.html')), film);
  assert.equal((await readProjectFilm(root)).rev, before.filmRevision);
  const done = await reviseSceneSource(root, request(await read(root)));
  assert.equal(done.outcome, 'completed');
});

test('严格base不使用普通edit的字段重放；film-only变化不发布目标', async () => {
  const root = await fixture(), before = await read(root);
  await editProjectFilm(root, before.filmRevision, [{ op: 'set', clip: 'one', field: 'at', value: 2 }]);
  await assert.rejects(reviseSceneSource(root, request(before)), kind('conflict')); await noTarget(root);
});

test('只切一个共享实例，时间与轨标记/参数锁/DOM覆盖和所有非src字段保留', async () => {
  const motion = { version: 1, params: { title: '人工标题', opacity: 0.5 }, locked: ['params.title'], tracks: [{ path: 'params.opacity', keyframes: [{ t: 0, value: 0.3 }, { t: 1, value: 0.7 }] }], markers: [{ id: 'hold', t: 1 }] };
  const root = await fixture({ source: declared(), motion });
  const before = await readProjectFilm(root), source = await read(root);
  const done = await reviseSceneSource(root, request(source, { content: `${declared()}\n<!-- 新版 -->` }));
  const now = await readProjectFilm(root); const restored = structuredClone(now.value); restored.tracks[0].clips[0].src = before.value.tracks[0].clips[0].src;
  assert.deepEqual(restored, before.value); assert.equal(now.value.tracks[1].clips[0].src, 'scene.html');
  assert.equal(done.shared.selectedTotal, 1); assert.deepEqual(done.changed, [{ clipId: 'one', before: 'scene.html', after: 'scene-r2.html' }]);
  assert.equal(done.publication.sha256, digest(await fs.readFile(join(root, 'scene-r2.html'))));
  assert.equal(await fs.readFile(join(root, 'scene.html'), 'utf8'), declared());
});

test('同物理源的两个明确实例一次切换，硬链接共享引用可见', async () => {
  const root = await fixture(), before = await readProjectFilm(root);
  await fs.link(join(root, 'scene.html'), join(root, 'alias.html'));
  before.value.tracks[1].clips[0].src = 'alias.html'; await fs.writeFile(join(root, 'film.html'), filmHtml(before.value));
  const source = await read(root); assert.equal(source.shared.total, 2);
  const done = await reviseSceneSource(root, request(source, { clipIds: ['one', 'two'] }));
  assert.equal(done.changed.length, 2); assert.equal(done.shared.selectedTotal, 2);
  assert.deepEqual((await readProjectFilm(root)).value.tracks.map((track) => track.clips[0].src), ['scene-r2.html', 'scene-r2.html']);
});

test('重复ID、不同实际源、原路径、越界与film别名均拒绝且不发布', async () => {
  const root = await fixture(), source = await read(root);
  for (const extra of [{ clipIds: ['one', 'one'] }, { targetPath: 'scene.html' }, { targetPath: '../outside.html' }, { targetPath: 'film.html' }, { sourcePath: 'scene.html#t=0,1' }]) {
    await assert.rejects(reviseSceneSource(root, request(source, extra)), (error) => error instanceof SceneSourceError); await noTarget(root);
  }
  await fs.writeFile(join(root, 'different.html'), plain);
  const film = await readProjectFilm(root); film.value.tracks[1].clips[0].src = 'different.html'; await fs.writeFile(join(root, 'film.html'), filmHtml(film.value));
  await assert.rejects(reviseSceneSource(root, request(await read(root), { clipIds: ['one', 'two'] })), kind('conflict')); await noTarget(root);
});

test('现存同字节普通目标明确reuse，不同内容/符号链接/原源硬链接不覆盖', async () => {
  const root = await fixture(), source = await read(root), input = request(source);
  await fs.writeFile(join(root, input.targetPath), input.content);
  const done = await reviseSceneSource(root, input); assert.equal(done.publication.disposition, 'reused');
  const fresh = await read(root);
  for (const [name, create] of [
    ['different.html', () => fs.writeFile(join(root, 'different.html'), '保留')],
    ['linked.html', () => fs.symlink('scene-r2.html', join(root, 'linked.html'))],
    ['hard.html', () => fs.link(join(root, 'scene-r2.html'), join(root, 'hard.html'))],
  ]) {
    await create(); const before = await fs.readFile(join(root, name));
    await assert.rejects(reviseSceneSource(root, request(fresh, { targetPath: name })), kind('conflict'));
    assert.deepEqual(await fs.readFile(join(root, name)), before);
  }
});

test('no-replace link竞争保留外部目标；文件系统不支持时fail closed并清temp', async (t) => {
  const root = await fixture(), source = await read(root), original = fs.link;
  let called = 0;
  const mocked = t.mock.method(fs, 'link', async (from, to) => {
    called++; await fs.writeFile(to, '外部目标', { flag: 'wx' }); return original(from, to);
  });
  await assert.rejects(reviseSceneSource(root, request(source)), kind('conflict'));
  assert.equal(called, 1); assert.equal(await fs.readFile(join(root, 'scene-r2.html'), 'utf8'), '外部目标'); mocked.mock.restore();
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' }); });
  await assert.rejects(reviseSceneSource(root, request(source, { targetPath: 'unsupported.html' })), kind('unsupported'));
  await noTarget(root, 'unsupported.html'); assert.equal((await fs.readdir(root)).some((name) => name.includes('.scene-')), false);
});

test('发布后影片外写冲突保留完整新源并给有限恢复事实，不伪造回滚', async (t) => {
  const root = await fixture(), source = await read(root), input = request(source), original = fs.link;
  const before = await fs.readFile(join(root, 'film.html'), 'utf8');
  t.mock.method(fs, 'link', async (from, to) => { await original(from, to); await fs.writeFile(join(root, 'film.html'), before.replace('<head>', '<head><!-- 外部改动 -->')); });
  let failure;
  await assert.rejects(reviseSceneSource(root, input), (error) => { failure = error; return kind('recovery')(error); });
  assert.equal(await fs.readFile(join(root, input.targetPath), 'utf8'), input.content);
  assert.equal(failure.recovery.publication.disposition, 'created'); assert.equal(failure.recovery.outcome, 'published-film-state-requires-inspection');
  assert.equal(failure.recovery.selectedMappings[0].src, 'scene.html');
  assert.equal(failure.recovery.filmRevision, (await readProjectFilm(root)).rev);
  const safe = sceneSourceErrorReceipt(failure); assert.deepEqual(projectSceneSourceErrorReceipt({ ...safe, details: { secret: '不透传' } }), safe);
  assert.equal(projectSceneSourceErrorReceipt({ error: 'generic', details: failure.recovery }), null);
  assert.equal(Buffer.byteLength(JSON.stringify(safe)) < 480 * 1024, true);
});

test('发布后原source单独被外写也留新源恢复，不写film或抹掉外部字节', async (t) => {
  const root = await fixture(), source = await read(root), original = fs.link;
  t.mock.method(fs, 'link', async (from, to) => { await original(from, to); await fs.appendFile(join(root, 'scene.html'), '\n外部源码'); });
  await assert.rejects(reviseSceneSource(root, request(source)), kind('recovery'));
  assert.match(await fs.readFile(join(root, 'scene.html'), 'utf8'), /外部源码$/); assert.equal((await readProjectFilm(root)).rev, source.filmRevision);
  assert.equal(await fs.readFile(join(root, 'scene-r2.html'), 'utf8'), request(source).content);
});

test('完整静态声明校验每个motion实例，畸形声明拒绝；无manifest自由页面可用', async () => {
  const root = await fixture({ source: declared(), motion: { version: 1, params: { title: '人工', opacity: 0.5 }, locked: ['params.title'] } });
  const source = await read(root);
  for (const content of [plain, '<div id="film-motion"></div>', '<script id="film-motion" type="application/json">bad</script>', declared({ ...manifest, paramsSchema: { type: 'object', additionalProperties: false, properties: {} } })]) {
    await assert.rejects(reviseSceneSource(root, request(source, { content })), kind('invalid')); await noTarget(root);
  }
  const free = await fixture({ shared: false }); const done = await reviseSceneSource(free, request(await read(free)));
  assert.equal(done.compatibility.manifest, 'not-declared-free-scene'); assert.equal(done.compatibility.dynamicSemantics, 'unknown');
});

test('同canonical队列无递归死锁，两个严格同base修订只提交一个', async () => {
  const root = await fixture(), source = await read(root);
  const ordinary = withProjectFilmEdit(root, async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  const results = await Promise.allSettled([
    reviseSceneSource(root, request(source)),
    reviseSceneSource(root, request(source, { targetPath: 'scene-r3.html' })),
    ordinary,
  ]);
  assert.equal(results.slice(0, 2).filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(results.slice(0, 2).filter((row) => row.status === 'rejected' && row.reason.kind === 'conflict').length, 1);
  assert.equal(results[2].status, 'fulfilled');
  const fresh = await read(root);
  const [scene, edit] = await Promise.allSettled([
    reviseSceneSource(root, request(fresh, { targetPath: 'scene-r4.html' })),
    editProjectFilm(root, fresh.filmRevision, [{ op: 'set', clip: 'two', field: 'at', value: 3 }]),
  ]);
  assert.equal(scene.status, 'fulfilled'); assert.equal(edit.status, 'fulfilled');
  assert.equal((await readProjectFilm(root)).value.tracks[1].clips[0].at, 3);
});

test('fatal UTF8拒绝非法源；全文超序列化预算明确省略但SHA仍涵盖完整Buffer', async () => {
  const root = await fixture(); await fs.writeFile(join(root, 'scene.html'), Buffer.from([0x61, 0xc0, 0xaf]));
  await assert.rejects(read(root), kind('invalid'));
  const full = Buffer.from('"'.repeat(260000)); await fs.writeFile(join(root, 'scene.html'), full);
  const got = await read(root); assert.equal(got.source.sha256, digest(full)); assert.equal(got.source.bytes, full.length);
  assert.equal(got.source.textIncluded, false); assert.equal(got.source.text, undefined); assert.equal(got.source.omissionReason, 'complete-source-exceeds-receipt-budget');
  assert.equal(Buffer.byteLength(JSON.stringify(got)) < SCENE_SOURCE_LIMITS.receiptBytes, true);
});

test('正文UTF8与完整JSON分别限额，未知字段/非字符串摘要与孤立代理字符均拒绝', async () => {
  const root = await fixture(), source = await read(root);
  for (const extra of [{ content: '中'.repeat(90000) }, { content: '\0'.repeat(140000) }, { content: '\ud800' }, { extra: true }, { expectedSourceSha256: 'A'.repeat(64) }, { base: 1111111111111111 }]) {
    await assert.rejects(reviseSceneSource(root, request(source, extra)), kind('invalid')); await noTarget(root);
  }
  assert.equal(constants.O_NOFOLLOW > 0, true);
});

test('read同句柄读取期间源码变更拒绝混合来源，未回执半新正文', async (t) => {
  const root = await fixture(), original = fs.open;
  let changed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await original(...args);
    if (args[0] === join(root, 'scene.html') && !changed) {
      const read = handle.read.bind(handle);
      handle.read = async (...input) => { const result = await read(...input); if (!changed) { changed = true; await fs.appendFile(args[0], '外部'); } return result; };
    }
    return handle;
  });
  await assert.rejects(read(root), kind('conflict')); assert.equal(changed, true);
});

test('超过4MiB原始源拒绝，BOM原字节摘要和解码正文不被悄悄改写', async () => {
  const root = await fixture();
  await fs.writeFile(join(root, 'scene.html'), Buffer.alloc(SCENE_SOURCE_LIMITS.rawBytes + 1, 65));
  await assert.rejects(read(root), kind('conflict'));
  const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(plain)]); await fs.writeFile(join(root, 'scene.html'), raw);
  const got = await read(root); assert.equal(got.source.sha256, digest(raw)); assert.equal(got.source.text, raw.toString('utf8'));
});

test('共享引用超过投影限额时保留总数并显式complete false，不截断字段', async () => {
  const root = await fixture(), film = await readProjectFilm(root);
  film.value.tracks.push({ clips: Array.from({ length: 101 }, (_, index) => ({ id: `shared-${index}`, src: 'scene.html' })) });
  await fs.writeFile(join(root, 'film.html'), filmHtml(film.value));
  const got = await read(root); assert.equal(got.shared.total, 103); assert.equal(got.shared.references.length, 100); assert.equal(got.shared.complete, false);
  assert.equal(got.source.text, plain);
});

test('每个明确实例都校验新manifest，不因第一个兼容而发布不兼容第二个', async () => {
  const root = await fixture({ source: declared(), motion: { version: 1, params: { title: '人工', opacity: 0.3 } } });
  const film = await readProjectFilm(root); film.value.tracks[1].clips[0].motion.params.opacity = 0.9; await fs.writeFile(join(root, 'film.html'), filmHtml(film.value));
  const constrained = structuredClone(manifest); constrained.paramsSchema.properties.opacity.maximum = 0.5; constrained.defaults.opacity = 0.4;
  await assert.rejects(reviseSceneSource(root, request(await read(root), { clipIds: ['one', 'two'], content: declared(constrained) })), kind('invalid'));
  await noTarget(root);
});

test('发布后目标被外写不伪造完整成功；私有temp被替换时不删除外部替身', async (t) => {
  const root = await fixture(), source = await read(root), original = fs.link;
  const mock = t.mock.method(fs, 'link', async (from, to) => { await original(from, to); await fs.writeFile(to, '外部已改目标'); });
  await assert.rejects(reviseSceneSource(root, request(source)), kind('recovery'));
  assert.equal(await fs.readFile(join(root, 'scene-r2.html'), 'utf8'), '外部已改目标'); assert.equal((await readProjectFilm(root)).rev, source.filmRevision); mock.mock.restore();
  let replacement;
  t.mock.method(fs, 'link', async (from, to) => {
    await fs.rename(from, `${from}.retained`); await fs.writeFile(from, '外部私有路径替身'); replacement = from;
    throw Object.assign(new Error('external replacement'), { code: 'ENOTSUP' });
  });
  await assert.rejects(reviseSceneSource(root, request(source, { targetPath: 'private-race.html' })), kind('conflict'));
  assert.equal(await fs.readFile(replacement, 'utf8'), '外部私有路径替身'); await noTarget(root, 'private-race.html');
});

test('多字节实例元数据先核完整changed预算，超限不在副作用后丢失回执', async () => {
  const root = await fixture(), sourceName = `${'源'.repeat(70)}.html`, targetName = `${'新'.repeat(70)}.html`;
  await fs.rename(join(root, 'scene.html'), join(root, sourceName));
  const ids = Array.from({ length: 100 }, (_, index) => `${'标'.repeat(500)}${index}`);
  await fs.writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: ids.map((id) => ({ id, src: sourceName })) }] }));
  const source = await readSceneSource(root, { clipId: ids[0] });
  await assert.rejects(reviseSceneSource(root, request(source, { clipIds: ids, targetPath: targetName })), (error) => kind('invalid')(error) && /changed/.test(error.message));
  await noTarget(root, targetName);
});

test('已完整发布后私有句柄close失败仍保留publication恢复事实', async (t) => {
  const root = await fixture(), source = await read(root), input = request(source), original = fs.open;
  let injected = false, realClosed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).includes('.scene-') && String(args[0]).endsWith('.tmp')) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close(); realClosed = true; injected = true;
        throw Object.assign(new Error('精确测试：真实close完成后报告EIO'), { code: 'EIO' });
      };
    }
    return handle;
  });
  let failure;
  try { await reviseSceneSource(root, input); } catch (error) { failure = error; }
  assert.equal(injected, true); assert.equal(realClosed, true);
  assert.equal(await fs.readFile(join(root, input.targetPath), 'utf8'), input.content);
  assert.equal((await readProjectFilm(root)).rev, source.filmRevision);
  assert.equal(failure?.kind, 'recovery');
  assert.deepEqual(failure.recovery.publication, { path: input.targetPath, sha256: digest(Buffer.from(input.content)), bytes: Buffer.byteLength(input.content), disposition: 'created' });
  assert.equal(failure.recovery.selectedMappings[0].src, 'scene.html');
  assert.equal((await fs.readdir(root)).some((name) => name.includes('.scene-')), false);
});
