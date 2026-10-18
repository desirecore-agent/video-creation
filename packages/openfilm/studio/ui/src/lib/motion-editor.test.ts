import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  curveProgress, defaultMotionEase, motionChanges, motionFields, motionLocked, motionLoopClock, motionValue, schemaDefault, sourceTimeForKey,
  trackTime, valueAtTrack, withKeyframe, withMotionValue, type MotionInstance, type MotionManifest, type MotionTrack,
} from './motion-editor.ts';

const manifest: MotionManifest = {
  version: 1, id: 'test-motion', name: '动态图形', description: '字段编辑测试构件',
  paramsSchema: { type: 'object', properties: { title: { type: 'string', title: '标题' }, opacity: { type: 'number', minimum: 0, maximum: 1 }, point: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, style: { type: 'object', properties: { size: { type: 'number' }, color: { type: 'string', format: 'color' } } } } },
  defaults: { title: '测试', opacity: 1, point: [10, 20], style: { size: 18, color: '#ffffff' } },
};

test('只从显式 Schema 生成字段，嵌套参数和向量保留原类型', () => {
  const fields = motionFields(manifest, { version: 1, params: { title: '人工标题', point: [30, 40], style: { color: '#aa1122' } } });
  assert.equal(fields.find((f) => f.path === 'params.title')?.value, '人工标题');
  assert.deepEqual(fields.find((f) => f.path === 'params.point')?.value, [30, 40]);
  assert.equal(fields.find((f) => f.path === 'params.style.size')?.value, 18);
  assert.equal(fields.find((f) => f.path === 'params.style.color')?.value, '#aa1122');
});

test('结构化表格新增行使用字段默认值，固定向量按声明长度构造', () => {
  assert.deepEqual(schemaDefault({ type: 'object', properties: { label: { type: 'string', default: '新数据' }, value: { type: 'number', minimum: 1 }, shown: { type: 'boolean' } } }), { label: '新数据', value: 1, shown: false });
  assert.deepEqual(schemaDefault({ type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }), [0, 0]);
});

test('修改一个参数不会重建其他属性轨、数据或锁，也不读取继承属性', () => {
  const before: MotionInstance = { version: 1, params: { title: '旧标题', style: { size: 20 } }, data: [{ value: 2 }], tracks: [{ path: 'params.opacity', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }] }], locked: ['data'] };
  const after = withMotionValue(before, 'params.style.size', 30);
  assert.equal(motionValue(after, 'params.style.size'), 30);
  assert.equal(after.tracks, before.tracks);
  assert.equal(after.data, before.data);
  assert.equal(after.locked, before.locked);
  assert.equal(motionValue(after, 'constructor.name'), undefined);
  assert.equal(withMotionValue(before, '__proto__.polluted', true), before);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('领域差异只写变化属性、完整数组、属性path轨和id标记', () => {
  const before: MotionInstance = { version: 1, params: { title: '旧', point: [1, 2], style: { size: 20, color: '#fff' } }, tracks: [{ path: 'params.opacity', keyframes: [{ t: 0, value: 1 }] }], markers: [{ id: 'beat-a', t: 1, name: '节拍' }] };
  const after: MotionInstance = { ...before, params: { ...before.params, point: [2, 3], style: { size: 30, color: '#fff' } }, tracks: [{ path: 'params.opacity', keyframes: [{ t: 0, value: 0 }] }], markers: [] };
  assert.deepEqual(motionChanges(before, after), [
    { path: ['params', 'point'], value: [2, 3] },
    { path: ['params', 'style', 'size'], value: 30 },
    { path: ['tracks', 'params.opacity'], value: after.tracks![0] },
    { path: ['markers', 'beat-a'], remove: true },
  ]);
});

test('父级和子级锁都覆盖对应编辑字段，其他属性仍可修改', () => {
  const motion: MotionInstance = { version: 1, locked: ['params.style', 'data.0.value'] };
  assert.equal(motionLocked(motion, 'params.style.color'), true);
  assert.equal(motionLocked(motion, 'data'), true);
  assert.equal(motionLocked(motion, 'params.title'), false);
});

test('关键帧拖动按毫秒排序、同一时刻替换，不改其他轨元数据', () => {
  const track: MotionTrack = { path: 'params.opacity', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }, { t: 2, value: 0.5 }], clock: { speed: 2 } };
  const changed = withKeyframe(track, { t: 2.0001, value: 0.75, ease: 'ease-out' }, 1);
  assert.deepEqual(changed.keyframes, [{ t: 0, value: 0 }, { t: 2, value: 0.75, ease: 'ease-out' }]);
  assert.equal(changed.clock, track.clock);
  assert.equal(track.keyframes.length, 3);
});

test('编辑器曲线与采样复用运行时，出段缓动、颜色和循环一致', () => {
  const track: MotionTrack = { path: 'params.opacity', keyframes: [{ t: 0, value: 0, ease: 'step' }, { t: 1, value: 1, ease: 'linear' }], clock: { offset: 2, speed: 2, duration: 1, loop: 'pingpong' } };
  assert.equal(valueAtTrack(track, 2.25, 9), 0);
  assert.equal(trackTime(track, 2.75), 0.5);
  assert.equal(sourceTimeForKey(track, 0.2, 2.75), 2.9);
  assert.equal(valueAtTrack({ path: 'params.color', keyframes: [{ t: 0, value: '#000000' }, { t: 1, value: '#ffffff' }] }, 0.5, ''), '#808080');
  assert.equal(curveProgress('ease-in', 0), 0);
  assert.equal(curveProgress('ease-in', 1), 1);
  assert.ok(curveProgress('ease-in', 0.5) < 0.5);
});


test('离散和条件约束使用运行时同一准入函数，默认保持且普通数值保留线性', () => {
  const withSchema = (schema: Record<string, unknown>): MotionManifest => ({ ...manifest, paramsSchema: { type: 'object', properties: { input: schema } } });
  assert.equal(defaultMotionEase(withSchema({ type: 'integer' }), 'params.input'), 'step');
  assert.equal(defaultMotionEase(withSchema({ type: 'string', enum: ['a', 'b'] }), 'params.input'), 'step');
  assert.equal(defaultMotionEase(withSchema({ type: 'number', multipleOf: 2 }), 'params.input'), 'step');
  assert.equal(defaultMotionEase(withSchema({ type: 'object', properties: { count: { type: 'integer' } } }), 'params.input'), 'step');
  const refs = withSchema({ $ref: '#/definitions/count' }); refs.paramsSchema.definitions = { count: { type: 'integer' } };
  assert.equal(defaultMotionEase(refs, 'params.input'), 'step');
  assert.equal(defaultMotionEase(withSchema({ type: 'array', contains: { const: 2 }, items: { type: 'number' } }), 'params.input'), 'step');
  assert.equal(defaultMotionEase(withSchema({ type: 'number' }), 'params.input'), 'linear');
});


test('没有显式时段的轨首次选择循环会写入可执行范围，关闭循环保留其他时钟字段', () => {
  const track: MotionTrack = { path: 'params.opacity', keyframes: [{ t: 0, value: 0 }, { t: 12, value: 1 }], clock: { speed: 2 } };
  const clock = motionLoopClock(track, 'repeat');
  assert.deepEqual(clock, { speed: 2, duration: 12, loop: 'repeat' });
  assert.equal(trackTime({ ...track, clock }, 7), 2);
  assert.deepEqual(motionLoopClock({ ...track, clock }, ''), { speed: 2, duration: 12 });
  assert.deepEqual(motionLoopClock({ ...track, keyframes: [{ t: 0, value: 1 }] }, 'pingpong'), { speed: 2, duration: 0.1, loop: 'pingpong' });
});
