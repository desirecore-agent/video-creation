import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filmHtml } from '../../src/film-doc.mjs';
import { readProjectFilm, editProjectFilm, writeProjectFilm } from './film.mjs';
import { catalogProjectMotion, inspectProjectMotion, installProjectMotionSdk, motionManifestFromHtml } from './motion-project.mjs';
import { snapshotFilm } from './export-snapshot.mjs';

const manifest = { version: 1, id: 'fixture', name: '结构化动效', description: '测试局部修改与人工锁。', paramsSchema: { type: 'object', additionalProperties: false, required: ['title', 'opacity', 'scale'], properties: { title: { type: 'string' }, opacity: { type: 'number', minimum: 0, maximum: 1 }, scale: { type: 'number', minimum: 0.5, maximum: 2 } } }, defaults: { title: '默认', opacity: 1, scale: 1 }, dataSchema: { type: 'array', items: { type: 'number' } }, data: [1, 2] };
const roots = [];
function fixture(motion = { version: 1, params: { title: '初稿', opacity: 1, scale: 1 } }) {
  const root = mkdtempSync(join(tmpdir(), 'motion-project-')); roots.push(root);
  writeFileSync(join(root, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'scene', src: 'scene.html', time: [0, 2], motion }] }] }));
  writeFileSync(join(root, 'scene.html'), `<script id="film-motion" type="application/json">${JSON.stringify(manifest)}</script><script type="module">import {mix} from './video-creation-motion/motion.mjs'; window.film={duration:2,frame(t,c){}}</script>`);
  return root;
}
test.afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const current = async (root) => (await readProjectFilm(root)).value.tracks[0].clips[0].motion;
const change = (path, value) => ({ op: 'motion', clip: 'scene', changes: [{ path, value }] });
const conflict = (error) => error.kind === 'conflict';

test('局部参数、不同属性轨与事件按稳定键合并，同字段和同轨拒绝覆盖', async () => {
  const root = fixture();
  const base = (await readProjectFilm(root)).rev;
  const manual = await editProjectFilm(root, base, [change(['params', 'title'], '人工标题')]);
  const independent = await editProjectFilm(root, base, [change(['params', 'opacity'], 0.5)]);
  assert.equal(independent.rebased, true);
  assert.equal((await current(root)).params.title, '人工标题');
  assert.equal((await current(root)).params.opacity, 0.5);
  await assert.rejects(editProjectFilm(root, base, [change(['params', 'title'], '过期智能体标题')]), conflict);
  const trackBase = independent.rev;
  const opacity = { path: 'params.opacity', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }] };
  const scale = { path: 'params.scale', keyframes: [{ t: 0, value: 1 }, { t: 1, value: 1.2 }] };
  await editProjectFilm(root, trackBase, [change(['tracks', opacity.path], opacity)]);
  await editProjectFilm(root, trackBase, [change(['tracks', scale.path], scale)]);
  assert.equal((await current(root)).tracks.length, 2);
  await assert.rejects(editProjectFilm(root, trackBase, [change(['tracks', opacity.path], { ...opacity, keyframes: [{ t: 0, value: 0.1 }] })]), conflict);
  const markerBase = (await readProjectFilm(root)).rev;
  await editProjectFilm(root, markerBase, [change(['markers', 'beat'], { id: 'beat', t: 0.5 })]);
  await editProjectFilm(root, markerBase, [change(['markers', 'close'], { id: 'close', t: 1.5 })]);
  const now = await readProjectFilm(root);
  await editProjectFilm(root, now.rev, [{ op: 'motion', clip: 'scene', changes: [{ path: ['markers', 'beat'], remove: true }] }]);
  assert.deepEqual((await current(root)).markers, [{ id: 'close', t: 1.5 }]);
  assert.notEqual(manual.rev, base);
});

test('旧基线不能复活人工删除的祖先对象，独立兄弟字段仍可合并', async () => {
  const root = fixture();
  const nested = structuredClone(manifest);
  nested.paramsSchema.properties.group = { type: 'object', additionalProperties: false, properties: { one: { type: 'number' }, two: { type: 'number' } } };
  nested.defaults.group = {};
  writeFileSync(join(root, 'scene.html'), `<script id="film-motion" type="application/json">${JSON.stringify(nested)}</script>`);
  const initial = await readProjectFilm(root);
  const seeded = await editProjectFilm(root, initial.rev, [change(['params', 'group'], { one: 1 })]);
  const removed = await editProjectFilm(root, seeded.rev, [{ op: 'motion', clip: 'scene', changes: [{ path: ['params', 'group'], remove: true }] }]);
  await assert.rejects(editProjectFilm(root, seeded.rev, [change(['params', 'group', 'two'], 2)]), conflict);
  assert.equal((await readProjectFilm(root)).rev, removed.rev);
  const restored = await editProjectFilm(root, removed.rev, [change(['params', 'group'], { one: 1 })]);
  await editProjectFilm(root, restored.rev, [change(['params', 'group', 'one'], 3)]);
  await editProjectFilm(root, restored.rev, [change(['params', 'group', 'two'], 2)]);
  assert.deepEqual((await current(root)).params.group, { one: 3, two: 2 });
});

test('所有通用编辑和整片写入都保护旧锁，显式解锁要求真实最新revision', async () => {
  const root = fixture({ version: 1, params: { title: '人工终稿', opacity: 1, scale: 1 }, locked: ['params.title'] });
  const base = (await readProjectFilm(root)).rev;
  for (const ops of [
    [change(['params', 'title'], '覆盖')],
    [change(['tracks', 'params.title'], { path: 'params.title', keyframes: [{ t: 0, value: '覆盖' }] })],
    [{ op: 'fields', clip: 'scene', fields: { motion: { version: 1 } } }],
    [{ op: 'fields', clip: 'scene', fields: { motion: null } }],
    [{ op: 'remove', clip: 'scene' }],
  ]) await assert.rejects(editProjectFilm(root, base, ops), conflict);
  const before = await readProjectFilm(root);
  const replaced = structuredClone(before.value); delete replaced.tracks[0].clips[0].motion;
  await assert.rejects(writeProjectFilm(root, replaced, before.text), conflict);
  const changed = await editProjectFilm(root, base, [change(['params', 'opacity'], 0.5)]);
  await assert.rejects(editProjectFilm(root, base, [{ op: 'motion-locks', clip: 'scene', locked: [] }]), conflict);
  await assert.rejects(editProjectFilm(root, null, [{ op: 'motion-locks', clip: 'scene', locked: [] }]), (error) => error.kind === 'invalid');
  const unlocked = await editProjectFilm(root, changed.rev, [{ op: 'motion-locks', clip: 'scene', locked: [] }]);
  await editProjectFilm(root, unlocked.rev, [change(['params', 'title'], '明确解锁后修订')]);
  assert.equal((await current(root)).params.title, '明确解锁后修订');
});

test('参数与全部关键帧满足场景Schema，未知/数组索引/原型路径均不落盘', async () => {
  const root = fixture();
  const base = (await readProjectFilm(root)).rev;
  for (const operation of [
    change(['params', 'unknown'], true), change(['params', 'opacity'], 8), change(['data', '0'], 7),
    change(['tracks', 'params.opacity'], { path: 'params.opacity', keyframes: [{ t: 0, value: 0.2 }, { t: 100, value: 8 }] }),
    change(['tracks', 'params.opacity'], { path: 'params.scale', keyframes: [{ t: 0, value: 1 }] }),
    change(['params', '__proto__', 'polluted'], true),
    { op: 'motion', clip: 'scene', changes: [{ path: ['params', 'opacity'], value: 0.5, remove: true }] },
  ]) {
    await assert.rejects(editProjectFilm(root, base, [operation]), (error) => error.kind === 'invalid');
    assert.equal((await readProjectFilm(root)).rev, base);
  }
  await editProjectFilm(root, base, [change(['data'], [3, 4])]);
  assert.deepEqual((await current(root)).data, [3, 4]);
  assert.equal({}.polluted, undefined);
});

test('非法操作体仍返回领域错误而非内部TypeError', async () => {
  const root = fixture();
  const base = (await readProjectFilm(root)).rev;
  for (const ops of [{}, null, [], [null], ['motion'], [{}]]) await assert.rejects(editProjectFilm(root, base, ops), (error) => error.kind === 'invalid');
  assert.equal((await readProjectFilm(root)).rev, base);
});

test('静态声明提取拒绝重复、坏类型与JSON，不执行页面脚本', () => {
  const valid = `<script id='film-motion' type='application/json'>${JSON.stringify(manifest)}</script>`;
  assert.equal(motionManifestFromHtml(valid).id, 'fixture');
  assert.equal(motionManifestFromHtml(valid.replace("id='film-motion'", "id id='film-motion'")), null);
  assert.throws(() => motionManifestFromHtml(valid.replace("type='application/json'", "type type='application/json'")), /application\/json/);
  const literal = structuredClone(manifest); literal.defaults.title = '展示 <!--保留这段--> 文本';
  assert.equal(motionManifestFromHtml(`<script id="film-motion" type="application/json">${JSON.stringify(literal)}</script>`).defaults.title, literal.defaults.title);
  assert.equal(motionManifestFromHtml('<script>throw new Error("不得执行")</script>'), null);
  assert.equal(motionManifestFromHtml(`<!--${valid}-->`), null);
  assert.throws(() => motionManifestFromHtml(valid + valid), /只能声明一个/);
  assert.throws(() => motionManifestFromHtml('<div id="film-motion"></div>'), /application\/json/);
  assert.throws(() => motionManifestFromHtml('<div id="film-motion"></div>' + valid), /只能声明一个/);
  assert.throws(() => motionManifestFromHtml('<div id="film&#45;motion"></div>'), /application\/json/);
  assert.equal(motionManifestFromHtml('<textarea><div id="film-motion"></div></textarea>'), null);
  assert.equal(motionManifestFromHtml('<template>' + valid + '</template>'), null);
  assert.equal(motionManifestFromHtml(`<script>const s='<div id="film-motion"></div>';</script>`), null);
  assert.throws(() => motionManifestFromHtml(valid.replace('application/json', 'text/javascript')), /application\/json/);
  assert.throws(() => motionManifestFromHtml(valid.replace('"version":1', 'bad-json')), /JSON/);
});

test('本地SDK来自固定MIT构建，幂等安装且保留不同文件，闭包快照包含依赖', async () => {
  const root = fixture();
  const base = (await readProjectFilm(root)).rev;
  const installed = await installProjectMotionSdk(root, base);
  assert.equal(installed.installed, true);
  assert.equal(installed.license, 'MIT');
  const sdk = readFileSync(join(root, installed.path));
  assert.equal(installed.bytes, sdk.length);
  assert.match(sdk.toString(), /MIT/);
  assert.ok(sdk.toString().includes('Permission is hereby granted, free of charge'));
  assert.ok(sdk.toString().includes('Redistribution and use in source and binary forms'));
  assert.equal((await installProjectMotionSdk(root, base)).installed, false);
  const output = join(root, '.film', 'snapshot');
  const frozen = await snapshotFilm(root, output);
  assert.ok(frozen.files.some((file) => file.path === installed.path));
  assert.deepEqual(readFileSync(join(output, installed.path)), sdk, '独立输入闭包须保留完整许可字节');
  writeFileSync(join(root, installed.path), '人工SDK版本');
  await assert.rejects(installProjectMotionSdk(root, base), (error) => error.status === 409);
  assert.equal(readFileSync(join(root, installed.path), 'utf8'), '人工SDK版本');
  const changed = await editProjectFilm(root, base, [change(['params', 'title'], '新版')]);
  await assert.rejects(installProjectMotionSdk(root, base), (error) => error.status === 409);
  assert.notEqual(changed.rev, base);
});

test('SDK目录的符号链接不越过工程，旧自由影片可继续inspect/catalog', async () => {
  const root = fixture(), elsewhere = mkdtempSync(join(tmpdir(), 'motion-outside-')); roots.push(elsewhere);
  symlinkSync(elsewhere, join(root, 'video-creation-motion'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installProjectMotionSdk(root, (await readProjectFilm(root)).rev), /not a path inside|普通本地目录/);
  const legacy = fixture();
  writeFileSync(join(legacy, 'film.html'), '<section><iframe id="free" src="free.html#t=0,1"></iframe></section>');
  writeFileSync(join(legacy, 'free.html'), '<script>window.film={duration:1,frame(t){}}</script>');
  const inspected = await inspectProjectMotion(legacy, 'free');
  assert.equal(inspected.clips[0].manifest, null);
  assert.deepEqual(inspected.clips[0].problems, []);
  const catalog = await catalogProjectMotion(legacy);
  assert.ok(catalog.components.some((entry) => entry.source === 'builtin' && entry.manifest.id === 'general-product-demo'));
  assert.ok(catalog.components.some((entry) => entry.source === 'project' && entry.manifest.id === 'fixture'));
});
