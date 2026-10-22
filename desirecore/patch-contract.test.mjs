import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { timelineOpsSchema, SETTABLE_FIELDS } from '../packages/openfilm/studio/server/op-schema.mjs';
import { tools } from './mcp.mjs';
import { applyOps } from '../packages/openfilm/studio/server/ops.mjs';
import { filmHtml } from '../packages/openfilm/src/film-doc.mjs';
import { readProjectFilm, editProjectFilm } from '../packages/openfilm/studio/server/film.mjs';

const validate = new Ajv({ allErrors: true }).compile(timelineOpsSchema);
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));

test('patch --schema 与 --help 无工程/服务/home即可发现合同，畸形home配置也不读取或创建数据', () => {
  const root = mkdtempSync(join(tmpdir(), 'patch-schema-discovery-'));
  try {
    const home = join(root, 'bad-config'), absent = join(root, 'must-not-exist'); mkdirSync(home);
    writeFileSync(join(home, 'runtime-config.json'), '{invalid JSON');
    const before = readdirSync(root).sort();
    const schema = spawnSync(process.execPath, [cli, 'patch', '--schema', '--home', absent], { cwd: root, env: { ...process.env, APP_DATA_DIR: home }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(schema.status, 0, schema.stderr); assert.equal(schema.stderr, '');
    assert.deepEqual(JSON.parse(schema.stdout), timelineOpsSchema);
    const help = spawnSync(process.execPath, [cli, 'patch', '--help'], { cwd: root, env: { ...process.env, APP_DATA_DIR: home }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /patch --schema/);
    assert.equal(existsSync(absent), false); assert.deepEqual(readdirSync(root).sort(), before);
    assert.equal(readFileSync(join(home, 'runtime-config.json'), 'utf8'), '{invalid JSON');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('同源 Draft-07/MCP 合同完整列出内核十二操作，不新增执行器或附加字段限制', () => {
  assert.strictEqual(tools.find((tool) => tool.name === 'video_patch').inputSchema.properties.ops, timelineOpsSchema);
  assert.equal(timelineOpsSchema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.match(timelineOpsSchema.$id, /:v1$/);
  const kernel = readFileSync(new URL('../packages/openfilm/studio/server/ops.mjs', import.meta.url), 'utf8');
  const names = [...kernel.matchAll(/case '([^']+)':/g)].map((match) => match[1]);
  assert.deepEqual(timelineOpsSchema.items.oneOf.map((entry) => entry.properties.op.const).sort(), [...new Set(names)].sort());
  assert.deepEqual(SETTABLE_FIELDS, ['at', 'time', 'box', 'size', 'volume', 'speed', 'overrides', 'src']);
  for (const entry of timelineOpsSchema.items.oneOf) { assert.ok(entry.description); assert.equal(entry.additionalProperties, true); for (const property of Object.values(entry.properties)) assert.ok(property.description); }
  assert.equal(validate([{ op: 'set', clip: 'scene', field: 'src', value: 'r2.html', ignoredLegacyField: true }]), true);
  assert.equal(validate([{ op: 'set', clip: 'scene', field: 'src' }]), true);
  assert.equal(validate([{ op: 'fields', clip: 'scene' }]), true);
  assert.equal(validate([{ op: 'fields', clip: 'scene', fields: null }]), true);
  assert.equal(validate([{ op: 'track', track: 0, field: 'hidden', value: 1 }]), true);
  assert.equal(validate([{ op: 'unknown', clip: 'scene' }]), false);
});

test('公开 set src 真实按版本换场景且保留 time、人工 DOM overrides、动效锁与其他原字段', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patch-schema-source-'));
  try {
    const manifest = { version: 1, id: 'source-swap', name: '源切换', description: '人工字段保持。', paramsSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false }, defaults: { title: '原稿' } };
    const scene = `<script id="film-motion" type="application/json">${JSON.stringify(manifest)}</script><div id="title">源标题</div><script>window.film={duration:8,frame(t){}}</script>`;
    writeFileSync(join(root, 'scene.html'), scene); writeFileSync(join(root, 'scene-r2.html'), scene);
    const motion = { version: 1, params: { title: '人工终稿' }, locked: ['params.title'] };
    const overrides = [{ at: '#title', text: '人工DOM', style: { color: '#ffbf69' } }];
    writeFileSync(join(root, 'film.html'), filmHtml({ stage: { w: 1280, h: 720 }, tracks: [{ locked: true, clips: [{ id: 'scene', src: 'scene.html', time: [0, 8], motion, overrides }] }] }));
    const initial = await readProjectFilm(root), operation = [{ op: 'set', clip: 'scene', field: 'src', value: 'scene-r2.html' }];
    assert.equal(validate(operation), true);
    const result = await editProjectFilm(root, initial.rev, operation);
    const expected = structuredClone(initial.value); expected.tracks[0].clips[0].src = 'scene-r2.html';
    assert.deepEqual(result.value, expected);
    assert.deepEqual(result.doc.tracks[0].clips[0].time, [0, 8]);
    assert.match(result.text, /scene-r2\.html#t=0,8/);
    assert.deepEqual(result.doc.tracks[0].clips[0].motion, motion);
    assert.deepEqual(result.doc.tracks[0].clips[0].overrides, overrides);
    assert.equal(result.value.tracks[0].locked, true);
    await assert.rejects(editProjectFilm(root, initial.rev, [{ ...operation[0], value: 'scene.html' }]), (e) => e.kind === 'conflict');
    await assert.rejects(editProjectFilm(root, '0'.repeat(16), operation), (e) => e.kind === 'conflict');
    assert.equal((await readProjectFilm(root)).rev, result.rev);
    await assert.rejects(editProjectFilm(root, result.rev, [{ op: 'fields', clip: 'scene', fields: { motion: null } }]), (e) => e.kind === 'conflict');
    assert.equal(readFileSync(join(root, 'scene.html'), 'utf8'), scene); assert.equal(readFileSync(join(root, 'scene-r2.html'), 'utf8'), scene);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('公开合同保留 set 省略删除与 fields 空覆盖的原内核行为', () => {
  const original = { stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'scene', src: 'scene.html', volume: 0.5 }] }] };
  assert.equal(applyOps(structuredClone(original), [{ op: 'set', clip: 'scene', field: 'volume' }]).tracks[0].clips[0].volume, undefined);
  assert.deepEqual(applyOps(structuredClone(original), [{ op: 'fields', clip: 'scene' }]), original);
  assert.deepEqual(applyOps(structuredClone(original), [{ op: 'fields', clip: 'scene', fields: null }]), original);
});

test('同源 MCP Schema 保留原 applyOps 的 ID 回退与被忽略分支代表性成功输入', () => {
  const original = { stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'scene', src: 'scene.html', time: [0, 2] }] }] };
  const cases = [
    { label: 'insert null ID', op: { op: 'insert', clip: { src: 'new.html', id: null } } },
    { label: 'insert numeric ID', op: { op: 'insert', clip: { src: 'new.html', id: 42 } } },
    { label: 'split null right ID', op: { op: 'split', clip: 'scene', left: {}, right: {}, rightId: null } },
    { label: 'split numeric right ID', op: { op: 'split', clip: 'scene', left: {}, right: {}, rightId: 42 } },
    { label: 'insert coerced track position', op: { op: 'insert', clip: { src: 'new.html' }, track: { insert: '1' } } },
    { label: 'split left ignores null at', op: { op: 'split', clip: 'scene', left: {}, at: null } },
    { label: 'split left ignores zero at', op: { op: 'split', clip: 'scene', left: {}, at: 0 } },
    { label: 'move newTrack ignores track', op: { op: 'move', clip: 'scene', at: 1, newTrack: 1, track: 'ignored' } },
    { label: 'insert from ignores clip subtree', op: { op: 'insert', from: 'scene', clip: 'ignored' } },
    { label: 'insert after ignores both routes', op: { op: 'insert', clip: { src: 'new.html' }, after: 'scene', track: 'ignored', newTrack: 'ignored' } },
    { label: 'insert object track ignores newTrack', op: { op: 'insert', clip: { src: 'new.html' }, track: { insert: 1 }, newTrack: 'ignored' } },
    { label: 'idempotent insert ignores optional positioning', op: { op: 'insert', clip: { src: 'scene.html', id: 'scene' }, at: 'ignored', after: 42, track: 'ignored', newTrack: 'ignored' } },
    { label: 'props trackOrder ignores clip', op: { op: 'props', edits: [{ prop: 'trackOrder', clip: 42, value: { from: 0, to: 0 } }] } },
  ];
  const observed = cases.map(({ label, op }) => {
    assert.doesNotThrow(() => applyOps(structuredClone(original), [op]), label);
    return { label, schemaAccepts: validate([op]) };
  });
  assert.deepEqual(observed, cases.map(({ label }) => ({ label, schemaAccepts: true })));
});
