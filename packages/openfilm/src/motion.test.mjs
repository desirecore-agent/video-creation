import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMotionLocks, drawFrame, ease, frameContext, freezeMotionInstance, loopTime, mapTime, mix, readMotionManifest, sampleMotion, samplePath, sampleTrack, seeded, spring, stagger, validateMotionInputs, validateMotionInstance, validateMotionManifest, validateSchemaValue } from './motion.mjs';
import { filmHtml, readFilm, readFilmFile } from './film-doc.mjs';
const manifest = {
  version: 1, id: 'test.generic', name: '测试构件', description: '支持结构化数据和参数动画的自由场景。',
  paramsSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false, required: ['title', 'x', 'scale'], properties: { title: { type: 'string', description: '标题' }, x: { type: 'number', minimum: 0, maximum: 100, description: '位置' }, scale: { type: 'number', exclusiveMinimum: 0, description: '缩放' } } },
  defaults: { title: '数据', x: 0, scale: 1 },
  dataSchema: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'number', minimum: 0 } } } }, data: [{ value: 10 }],
};
const motion = { version: 1, params: { title: '人工标题' }, tracks: [{ path: 'params.x', keyframes: [{ t: 0, value: 0, ease: 'ease-in' }, { t: 2, value: 100 }] }], markers: [{ id: 'beat', t: 1, name: '节拍' }] };
test('绝对时间工具在重复和乱序采样中稳定，支持颜色、向量、路径和种子', () => {
  assert.deepEqual(mix([0, 10], [10, 20], 0.5), [5, 15]);
  assert.equal(mix('#000', '#fff', 0.5), '#808080');
  assert.equal(mix('10px', '30px', 0.5), '20px');
  assert.equal(mix('左', '右', 0.8), '左');
  assert.equal(ease(0.5, 'linear'), 0.5);
  assert.ok(ease(0.5, 'ease-in') < 0.5);
  assert.ok(Math.abs(ease(0.5, [0.42, 0, 0.58, 1]) - 0.5) < 1e-9);
  assert.equal(stagger(0, { each: 0.2, from: 3 }), 0.6 + 1e-16);
  assert.deepEqual(samplePath([[0, 0], [10, 0], [10, 30]], 0.5), { x: 10, y: 10, angle: Math.PI / 2 });
  assert.deepEqual(samplePath([[3, 4], [3, 4]], 0.5), { x: 3, y: 4, angle: 0 });
  assert.equal(seeded('粒子', 42), seeded('粒子', 42));
  assert.notEqual(seeded('粒子', 42), seeded('粒子', 43));
  const times = [0, 0.1, 0.3, 1, 3, 5];
  for (const damping of [0, 10, 20, 40]) {
    const expected = times.map((t) => spring(t, { damping }));
    assert.equal(expected[0], 0);
    for (const i of [5, 1, 3, 0, 4, 2, 5]) assert.equal(spring(times[i], { damping }), expected[i]);
  }
});
test('嵌套时钟支持变速、偏移、重复与往返，不累计帧误差', () => {
  assert.deepEqual(mapTime(-1, { offset: 1, speed: 2 }), { time: 0, cycle: 0, direction: 1, active: false });
  assert.equal(mapTime(2, { offset: 1, speed: 2 }).time, 2);
  assert.equal(loopTime(5, 2), 1);
  assert.equal(loopTime(3, 2, 'pingpong'), 1);
  assert.deepEqual(mapTime(4, { duration: 2, loop: 'pingpong' }), { time: 0, cycle: 2, direction: 1, active: true });
  assert.equal(mapTime(mapTime(3, { offset: 1, speed: 2 }).time, { offset: 1, speed: 0.5 }).time, 1.5);
  const track = { path: 'params.x', clock: { speed: 2, duration: 2, loop: 'pingpong' }, keyframes: [{ t: 0, value: 0 }, { t: 2, value: 20 }] };
  assert.equal(sampleTrack(track, 0.5), 10);
  assert.equal(sampleTrack(track, 1.5), 10);
  assert.equal(sampleTrack(track, 2), 0);
  assert.throws(() => mapTime(1, { loop: 'repeat' }), /时钟/);
});
test('实例输入先于 prepare/frame，随机 seek 等价于首次求帧，且源数据不被修改', async () => {
  const before = JSON.stringify({ manifest, motion }), trace = [];
  const film = { async prepare(ctx) { trace.push(['prepare', ctx.params.x]); }, async frame(t, ctx) { trace.push(['frame', t, ctx.params.x]); } };
  const expected = [0, 0.5, 1, 1.5, 2].map((t) => frameContext(t, { manifest, motion, viewport: { width: 1080, height: 1920 } }));
  for (const index of [4, 0, 2, 1, 3, 2, 4]) {
    const ctx = await drawFrame(film, expected[index].time, { manifest, motion, viewport: { width: 1080, height: 1920 } });
    assert.deepEqual(ctx, expected[index]);
    assert.deepEqual(trace.slice(-2), [['prepare', ctx.params.x], ['frame', ctx.time, ctx.params.x]]);
  }
  assert.equal(expected[2].params.title, '人工标题');
  assert.equal(expected[1].events.length, 0);
  assert.equal(expected[2].events[0].id, 'beat');
  assert.equal(JSON.stringify({ manifest, motion }), before);
});
test('旧 frame(t) 不声明 manifest 时保持单参数调用，无新增准备阶段', async () => {
  let args, prepared = false;
  await drawFrame({ prepare() { prepared = true; }, frame(...values) { args = values; } }, 1.234, { document: null });
  assert.deepEqual(args, [1.234]);
  assert.equal(prepared, false);
  assert.deepEqual(validateMotionInputs(null, undefined), []);
  assert.ok(validateMotionInputs(null, motion).length);
});
test('Draft07 完整验证引用与条件，未知字段、非法轨、路径与原型输入必须失败', () => {
  assert.equal(validateMotionManifest(manifest).problems.length, 0);
  assert.equal(validateMotionInstance(motion).problems.length, 0);
  assert.deepEqual(validateMotionInputs(manifest, motion), []);
  assert.ok(validateMotionInputs(manifest, { version: 1, tracks: [{ path: 'params.x', keyframes: [{ t: 0, value: 0 }, { t: 1, value: -1 }] }] }).length);
  assert.ok(validateMotionInstance({ version: 1, data: new Array(1) }).problems.length);
  const conditional = structuredClone(manifest);
  conditional.paramsSchema = { type: 'object', definitions: { n: { type: 'number', minimum: 0 } }, properties: { x: { $ref: '#/definitions/n' }, title: { type: 'string' }, scale: { type: 'number' } }, if: { properties: { x: { const: 0 } } }, then: { required: ['title'] } };
  assert.equal(validateMotionManifest(conditional).problems.length, 0);
  assert.ok(validateMotionInstance({ ...motion, unknown: 1 }).problems.length);
  assert.ok(validateMotionInstance({ version: 1, tracks: [{ path: 'params.x', keyframes: [{ t: 1, value: 1 }, { t: 1, value: 2 }] }] }).problems.length);
  assert.ok(validateMotionInstance({ version: 1, tracks: [{ path: 'params.x', clock: { loop: 'repeat' }, keyframes: [{ t: 0, value: 1 }] }] }).problems.length);
  assert.ok(validateMotionInstance({ version: 1, params: JSON.parse('{"__proto__":{"polluted":true}}') }).problems.length);
  assert.ok(validateMotionInstance({ version: 1, tracks: [{ path: 'params.constructor', keyframes: [{ t: 0, value: 1 }] }] }).problems.length);
  assert.throws(() => sampleMotion(manifest, { ...motion, params: { unknown: 1 } }, 0), /additional|未声明/);
  assert.throws(() => sampleMotion(manifest, { version: 1, tracks: [{ path: 'params.missing', keyframes: [{ t: 0, value: 1 }] }] }, 0), /路径不存在/);
  assert.throws(() => sampleMotion(null, motion, 0), /参数契约/);
  assert.throws(() => sampleMotion(manifest, { version: 1, data: [{ value: -1 }] }, 0), /minimum/);
});
test('标准格式与未知关键字不能静默放行，可变 Schema 不能复用旧规则', () => {
  for (const [format, bad, good] of [['email', 'invalid', 'director@example.com'], ['date-time', '昨天', '2026-10-18T02:00:00Z'], ['uri', 'not a uri', 'https://example.com/a']]) {
    assert.ok(validateSchemaValue(bad, { type: 'string', format }).length, format);
    assert.deepEqual(validateSchemaValue(good, { type: 'string', format }), [], format);
  }
  assert.ok(validateSchemaValue('x', { type: 'string', format: 'unknown-custom-format' }).length);
  assert.ok(validateSchemaValue('x', { type: 'string', typoKeyword: true }).length);
  assert.ok(validateSchemaValue('x', { type: 'string', $async: true }).length);
  const schema = { type: 'number', minimum: 0 };
  assert.deepEqual(validateSchemaValue(1, schema), []);
  schema.minimum = 2;
  assert.ok(validateSchemaValue(1, schema).length);
  const shallow = Object.freeze({ type: 'object', properties: { x: { type: 'number', minimum: 0 } } });
  assert.deepEqual(validateSchemaValue({ x: 1 }, shallow), []);
  shallow.properties.x.minimum = 2;
  assert.ok(validateSchemaValue({ x: 1 }, shallow).length);
});
test('离散 Schema 必须显式 step，引用和组合约束同样适用', () => {
  for (const constraint of [{ type: 'integer' }, { type: 'number', multipleOf: 2 }, { type: 'number', enum: [0, 4] }, { $ref: '#/definitions/whole' }]) {
    const contract = structuredClone(manifest);
    contract.paramsSchema.definitions = { whole: { type: 'integer' } };
    contract.paramsSchema.properties.x = constraint;
    const instance = { version: 1, tracks: [{ path: 'params.x', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 4 }] }] };
    assert.ok(validateMotionInputs(contract, instance).some((p) => /step/.test(p)));
    instance.tracks[0].keyframes[0].ease = 'step';
    assert.deepEqual(validateMotionInputs(contract, instance), []);
    assert.equal(sampleMotion(contract, instance, 0.5).params.x, 0);
    assert.equal(sampleMotion(contract, instance, 1).params.x, 4);
  }
});
test('patternProperties、dependencies 与数组附加项的离散约束参与轨准入', () => {
  const cases = [
    { schema: { type: 'object', patternProperties: { '^count$': { type: 'integer' } }, additionalProperties: false }, defaults: { count: 0 }, path: 'params.count' },
    { schema: { type: 'object', properties: { enabled: { type: 'boolean' }, count: { type: 'number' } }, dependencies: { enabled: { properties: { count: { type: 'integer' } } } } }, defaults: { enabled: true, count: 0 }, path: 'params.count' },
    { schema: { type: 'object', properties: { counts: { type: 'array', items: [{ type: 'number' }], additionalItems: { type: 'integer' } } } }, defaults: { counts: [0, 0] }, path: 'params.counts.1' },
  ];
  for (const { schema, defaults, path } of cases) {
    const contract = { version: 1, id: 'constraints', name: '离散约束', description: '合法 Draft07 的不同声明路径。', paramsSchema: schema, defaults };
    const instance = { version: 1, tracks: [{ path, keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }] }] };
    assert.ok(validateMotionInputs(contract, instance).some((p) => /step/.test(p)), path);
    instance.tracks[0].keyframes[0].ease = 'step';
    assert.deepEqual(validateMotionInputs(contract, instance), []);
    assert.doesNotThrow(() => sampleMotion(contract, instance, 0.5));
  }
});
test('contains、not、if、联合与递归引用保守要求 step，Ajv 仍验证最终输入', () => {
  const base = { version: 1, id: 'nonlinear', name: '组合约束', description: '不求解条件分支，统一保守采用离散步进。', paramsSchema: { type: 'object' }, defaults: {} };
  const cases = [
    { contract: { ...base, dataSchema: { type: 'array', items: { type: 'number' }, contains: { type: 'integer' } }, data: [0.5, 1] }, path: 'data', values: [[0.5, 1], [1, 0.5]] },
    { contract: { ...base, paramsSchema: { type: 'object', properties: { count: { type: 'number', not: { type: 'integer' } } } }, defaults: { count: 0.5 } }, path: 'params.count', values: [0.5, 1.5] },
    { contract: { ...base, paramsSchema: { type: 'object', properties: { count: { type: 'number' }, flag: { type: 'boolean' } }, if: { properties: { count: { type: 'integer' } } }, then: { properties: { flag: { const: true } } }, else: { properties: { flag: { const: false } } } }, defaults: { count: 0.5, flag: false } }, path: 'params.count', values: [0.5, 1.5] },
    { contract: { ...base, paramsSchema: { type: 'object', properties: { count: { anyOf: [{ type: 'number', maximum: 0 }, { type: 'number', minimum: 1 }] } } }, defaults: { count: 0 } }, path: 'params.count', values: [0, 1] },
    { contract: { ...base, paramsSchema: { type: 'object', definitions: { node: { type: 'object', properties: { value: { type: 'integer' }, child: { $ref: '#/definitions/node' } } } }, properties: { tree: { $ref: '#/definitions/node' } } }, defaults: { tree: { value: 0, child: { value: 0 } } } }, path: 'params.tree.child.value', values: [0, 1] },
    { contract: { ...base, dataSchema: { type: 'array', items: { type: 'number' }, uniqueItems: true }, data: [0, 1] }, path: 'data.0', values: [0, 2] },
  ];
  for (const { contract, path, values } of cases) {
    const instance = { version: 1, tracks: [{ path, keyframes: [{ t: 0, value: values[0] }, { t: 1, value: values[1] }] }] };
    assert.ok(validateMotionInputs(contract, instance).some((p) => /step/.test(p)), path);
    instance.tracks[0].keyframes[0].ease = 'step';
    assert.deepEqual(validateMotionInputs(contract, instance), [], path);
    assert.doesNotThrow(() => sampleMotion(contract, instance, 0.5), path);
  }
});
test('颜色轨保持无 alpha 格式，有 alpha 的短长颜色正确混合', () => {
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#0000', '#ffff', 0.5), '#80808080');
  assert.equal(mix('#00000000', '#ffffffff', 0.5), '#80808080');
  assert.equal(mix('#000', '#ffff', 0.5), '#808080ff');
  assert.equal(mix('#0000', '#ffffff', 0.5), '#80808080');
  const contract = { version: 1, id: 'accent', name: '强调色', description: '与真实样片相同的六位颜色约束。', paramsSchema: { type: 'object', properties: { accent: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } }, required: ['accent'], additionalProperties: false }, defaults: { accent: '#000000' } };
  const instance = { version: 1, tracks: [{ path: 'params.accent', keyframes: [{ t: 0, value: '#000000' }, { t: 1, value: '#ffffff' }] }] };
  assert.deepEqual(validateMotionInputs(contract, instance), []);
  for (const t of [0, 1, 0.25, 0.5, 0.75, 0.5]) assert.match(sampleMotion(contract, instance, t).params.accent, /^#[0-9a-fA-F]{6}$/);
  assert.equal(sampleMotion(contract, instance, 0.5).params.accent, '#808080');
});
test('实例更新边界生成新快照，旧输入变更和乱序返回不能污染缓存', () => {
  const node = { localName: 'script', getAttribute: () => 'application/json', textContent: JSON.stringify(manifest) };
  const contract = readMotionManifest({ getElementById: () => node, querySelectorAll: () => [node] });
  const original = structuredClone(motion);
  const first = freezeMotionInstance(original);
  const atOne = sampleMotion(contract, first, 1);
  original.params.title = '新人工标题';
  original.tracks[0].keyframes[1].value = 40;
  const updated = freezeMotionInstance(original);
  assert.equal(sampleMotion(contract, updated, 1).params.title, '新人工标题');
  assert.notEqual(sampleMotion(contract, updated, 1).params.x, atOne.params.x);
  sampleMotion(contract, updated, 2);
  assert.deepEqual(sampleMotion(contract, first, 1), atOne);
  assert.equal(first.params.title, '人工标题');
  assert.throws(() => { first.params.title = '不能突变'; }, TypeError);
  node.textContent = JSON.stringify({ ...manifest, defaults: { ...manifest.defaults, title: '新构件默认值' } });
  const newer = readMotionManifest({ getElementById: () => node, querySelectorAll: () => [node] });
  assert.equal(sampleMotion(newer, undefined, 0).params.title, '新构件默认值');
  assert.equal(sampleMotion(contract, undefined, 0).params.title, '数据');
});
test('film.html 正式往返 motion，保留人类输入、锁和其他原始内容', () => {
  const value = { stage: { w: 1920, h: 1080 }, tracks: [{ clips: [{ id: 'a', src: 'scene.html', time: [0, 3], motion: { ...motion, locked: ['params.title'] }, overrides: [{ at: '#label', text: '人工覆盖', lock: true }] }] }] };
  assert.ok(readFilm(value).doc);
  const text = filmHtml(value);
  assert.match(text, /motion='/);
  const parsed = readFilmFile(text);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.doc, value);
  assert.equal(filmHtml(parsed.doc, text), text);
  const bad = structuredClone(value); bad.tracks[0].clips[0].src = 'image.png';
  assert.ok(readFilm(bad).problems.some((s) => /motion/.test(s)));
});
test('人工锁阻止输入、父路径、对应轨、锁和整个片段被删除', () => {
  const before = { ...motion, locked: ['params.title', 'data'] };
  assert.deepEqual(checkMotionLocks(before, structuredClone(before)), []);
  const ordered = { version: 1, data: { a: 1, b: 2 }, locked: ['data'] };
  assert.deepEqual(checkMotionLocks(ordered, { ...ordered, data: { b: 2, a: 1 } }), []);
  const changed = structuredClone(before); changed.params.title = '改写';
  assert.ok(checkMotionLocks(before, changed).length);
  assert.ok(checkMotionLocks(before, undefined).length);
  const removed = structuredClone(before); removed.locked = [];
  assert.ok(checkMotionLocks(before, removed).length);
  const animation = structuredClone(before); animation.tracks.push({ path: 'params', keyframes: [{ t: 0, value: { title: '改写' } }] });
  assert.ok(checkMotionLocks(before, animation).length);
});
