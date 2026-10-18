/** 动效的局部编辑语义：参数按字段、轨按属性路径、事件按稳定 ID 定位。 */
import Ajv from 'ajv';
import { validateMotionInstance } from '../../src/motion-schema.mjs';

export const motionChangeSchema = {
  type: 'object', required: ['path'], additionalProperties: false,
  description: '只修改指定动效输入；remove:true 显式删除，value 可为任意满足场景 Schema 的 JSON。',
  properties: {
    path: { type: 'array', minItems: 1, maxItems: 24, items: { type: 'string', minLength: 1, maxLength: 240 }, description: 'params/data 后接对象字段；tracks 后接属性路径；markers 后接事件 ID。数组数据和单条属性轨作为整体修改。' },
    value: { description: '写入的 JSON 值，与 remove 互斥。' },
    remove: { const: true, description: '明确删除此字段、属性轨或事件，与 value 互斥。' },
  },
  oneOf: [{ required: ['value'], not: { required: ['remove'] } }, { required: ['remove'], not: { required: ['value'] } }],
};
export const motionChangesSchema = { type: 'array', minItems: 1, maxItems: 1000, items: motionChangeSchema, description: '按稳定路径提交的局部动效修改；不同字段可重放，同一字段或同一轨有同期变更时冲突。' };
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(motionChangesSchema);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

export function validateMotionChanges(changes) {
  if (!validate(changes)) throw new Error(`动效修改无效：${ajv.errorsText(validate.errors)}`);
  for (const { path } of changes) {
    if (!['params', 'data', 'tracks', 'markers'].includes(path[0]) || path.some((key) => forbidden.has(key))) throw new Error('动效修改只允许 params、data、tracks、markers 的普通字段路径。');
    if (['tracks', 'markers'].includes(path[0]) && path.length !== 2) throw new Error('属性轨按属性路径、事件按 ID 整项修改，不接受数组索引或整组覆盖。');
  }
  return changes;
}

/** 用于同期编辑比较；轨和事件不受其他项插入或排序影响。 */
export function motionValueAt(motion, path) {
  const [field, key, ...rest] = path;
  if (field === 'tracks') return motion?.tracks?.find((track) => track.path === key);
  if (field === 'markers') return motion?.markers?.find((marker) => marker.id === key);
  return [key, ...rest].filter((part) => part !== undefined).reduce((value, part) => plain(value) && Object.hasOwn(value, part) ? value[part] : undefined, motion?.[field]);
}

/** 叶子相同仍须保留其祖先，避免在旧基线上复活被人工删除的对象。 */
export function motionAncestorsUnchanged(before, after, path) {
  if (!['params', 'data'].includes(path[0])) return true;
  for (let depth = 1; depth < path.length; depth++) {
    const a = motionValueAt(before, path.slice(0, depth));
    const b = motionValueAt(after, path.slice(0, depth));
    if ((a === undefined) !== (b === undefined)) return false;
    if (a !== undefined && (!plain(a) || !plain(b))) return false;
  }
  return true;
}

/** 不更改未指定的字段；数组需整项替换，避免索引在人工编辑后移位。 */
export function applyMotionChanges(before, changes) {
  validateMotionChanges(changes);
  const motion = structuredClone(before ?? { version: 1 });
  for (const change of changes) {
    const [field, key, ...rest] = change.path;
    if (field === 'tracks' || field === 'markers') {
      const list = motion[field] ?? [];
      const id = field === 'tracks' ? 'path' : 'id';
      const index = list.findIndex((entry) => entry[id] === key);
      if (change.remove) { if (index >= 0) list.splice(index, 1); }
      else {
        if (!plain(change.value) || change.value[id] !== key) throw new Error(`动效 ${field} 的值必须保留定位字段 ${id}=${key}。`);
        if (index >= 0) list[index] = structuredClone(change.value);
        else list.push(structuredClone(change.value));
      }
      motion[field] = list;
      continue;
    }
    if (key === undefined) {
      if (change.remove) delete motion[field];
      else motion[field] = structuredClone(change.value);
      continue;
    }
    if (motion[field] === undefined) motion[field] = {};
    let target = motion[field];
    for (const part of [key, ...rest].slice(0, -1)) {
      if (!plain(target)) throw new Error('动效数组或非对象值必须整体替换，不能按索引编辑。');
      if (!Object.hasOwn(target, part)) target[part] = {};
      target = target[part];
    }
    if (!plain(target)) throw new Error('动效数组或非对象值必须整体替换，不能按索引编辑。');
    const leaf = change.path.at(-1);
    if (change.remove) delete target[leaf];
    else target[leaf] = structuredClone(change.value);
  }
  const checked = validateMotionInstance(motion);
  if (!checked.value) throw new Error(checked.problems.join('\n'));
  return motion;
}
