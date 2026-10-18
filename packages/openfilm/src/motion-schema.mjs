/** 通用动效数据契约。浏览器、Node 与工程编辑使用同一份完整 Draft-07 校验。 */
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
const ajv = new Ajv({ allErrors: true, strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false, ownProperties: true, validateFormats: true, addUsedSchema: false });
addFormats(ajv);
const validators = new WeakMap();
const immutableSchemas = new WeakSet();
const verifiedSchemas = new WeakSet();
const verifiedInstances = new WeakSet();
const verifiedManifests = new WeakSet();
function immutable(value) {
  if (!value || typeof value !== 'object') return true;
  if (immutableSchemas.has(value)) return true;
  if (!Object.isFrozen(value) || !Object.values(value).every(immutable)) return false;
  immutableSchemas.add(value);
  return true;
}
const deepFreeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };
const DRAFT = 'http://json-schema.org/draft-07/schema#';
const description = (text, schema) => ({ description: text, ...schema });
const json = description('可持久化的 JSON 值；不接受函数、非有限数字或原型键。', {});
const path = description('参数或结构化数据的点路径，例如 params.opacity、data.series.0.value。', { type: 'string', pattern: '^(params|data)(\\.[A-Za-z0-9_-]+)*$', maxLength: 240 });
const clock = description('在源秒时钟上做局部映射；可嵌套调用 SDK mapTime。', { type: 'object', additionalProperties: false, properties: {
  offset: description('局部零点位于父时钟的秒数。', { type: 'number' }),
  speed: description('时间倍率，正数；不改动工程音轨速度。', { type: 'number', exclusiveMinimum: 0, maximum: 100 }),
  duration: description('局部时段秒数；循环时必须提供。', { type: 'number', exclusiveMinimum: 0 }),
  loop: description('重复或往返，未指定时局部时间只在指定时段内截断。', { type: 'string', enum: ['repeat', 'pingpong'] }),
} });
const easing = description('当前关键帧到下一帧的缓动；四元组为 CSS cubic-bezier，横向控制点在 0..1。', { anyOf: [
  { type: 'string', enum: ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'step'] },
  { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' } },
] });
export const motionInstanceSchema = {
  $schema: DRAFT, title: '动效片段实例', description: 'film.html 页面片段的正式 motion 属性。时间线仍以片段本身为事实源。', type: 'object', required: ['version'], additionalProperties: false,
  properties: {
    version: description('协议版本。', { const: 1 }),
    params: description('覆盖构件默认参数；字段必须满足场景 paramsSchema。', { type: 'object' }),
    data: description('结构化数据输入，不依赖字幕或旁白。', {}),
    tracks: description('属性关键帧轨，按场景源秒求值，路径不得重复。', { type: 'array', maxItems: 200, items: { type: 'object', required: ['path', 'keyframes'], additionalProperties: false, properties: {
      path, clock,
      keyframes: description('按 t 严格递增的关键帧；区间外保持端点。', { type: 'array', minItems: 1, maxItems: 2000, items: { type: 'object', required: ['t', 'value'], additionalProperties: false, properties: {
        t: description('场景源秒或局部映射秒。', { type: 'number', minimum: 0 }), value: json, ease: easing,
      } } }),
    } } }),
    markers: description('可选事件锚点；每次求帧返回截至当前时刻的集合，场景不可依赖上次播放状态。', { type: 'array', maxItems: 2000, items: { type: 'object', required: ['id', 't'], additionalProperties: false, properties: {
      id: description('该实例内唯一标识。', { type: 'string', minLength: 1, maxLength: 120 }),
      t: description('场景源秒。', { type: 'number', minimum: 0 }),
      name: description('锚点可读名称，例如节拍、步骤、字幕开始。', { type: 'string', maxLength: 240 }), data: json,
    } } }),
    locked: description('人工锁定的输入路径；编辑器和工具修改时必须比较原实例，删除锁也属于修改。', { type: 'array', maxItems: 200, items: path, uniqueItems: true }),
  },
};
export const motionManifestSchema = {
  $schema: DRAFT, title: '动效构件描述', description: '场景内 script#film-motion 的 JSON 内容。无 manifest 的自由场景继续支持 frame(t)。', type: 'object', required: ['version', 'id', 'name', 'description', 'paramsSchema', 'defaults'], additionalProperties: false,
  properties: {
    version: description('协议版本。', { const: 1 }),
    id: description('构件稳定标识。', { type: 'string', minLength: 1, maxLength: 160 }),
    name: description('构件显示名。', { type: 'string', minLength: 1, maxLength: 160 }),
    description: description('用途、参数与适用边界，供人和智能体理解。', { type: 'string', minLength: 1, maxLength: 4000 }),
    paramsSchema: description('参数的 Draft-07 Schema，根类型必须为 object。', { type: 'object' }),
    defaults: description('完整且满足 paramsSchema 的默认参数。', { type: 'object' }),
    dataSchema: description('可选结构化数据的 Draft-07 Schema。', { type: 'object' }), data: json,
    assets: description('相对场景的本地资源依赖；已有 HTML/CSS/ES module 依赖闭包仍是打包事实源。', { type: 'array', maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 1000 }, uniqueItems: true }),
  },
};
deepFreeze(motionInstanceSchema);
deepFreeze(motionManifestSchema);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const same = (a, b) => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  return object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
};
/** Schema 与实例共用 Ajv，不在浏览器另行维护校验规则。 */
export function schemaProblems(schema, at = 'schema') {
  try {
    if (schema && typeof schema === 'object' && immutable(schema) && verifiedSchemas.has(schema)) return [];
    const shapeProblems = jsonProblems(schema, at);
    if (shapeProblems.length) return shapeProblems;
    if (containsAsync(schema)) return [`${at}: 动效参数只接受同步 Schema`];
    if (!ajv.validateSchema(schema)) return (ajv.errors ?? []).map((e) => `${at}${e.instancePath}: ${e.keyword}: ${e.message}`);
    validatorFor(schema);
    if (schema && typeof schema === 'object' && immutable(schema)) verifiedSchemas.add(schema);
    return [];
  } catch (e) { return [`${at}: ${e.message}`]; }
}
function containsAsync(value) {
  if (!value || typeof value !== 'object') return false;
  return value.$async === true || Object.values(value).some((v) => containsAsync(v));
}
function validatorFor(schema) {
  if (typeof schema === 'boolean') return ajv.compile(schema);
  // 只缓存不可变 Schema 的编译结果；可变输入复制后编译，防止 Ajv 按对象身份复用旧规则。
  if (!immutable(schema)) return ajv.compile(structuredClone(schema));
  if (!validators.has(schema)) validators.set(schema, ajv.compile(schema));
  return validators.get(schema);
}

/** JSON 值检查独立于 Schema，防止 NaN、循环引用、函数及原型路径进入求帧。 */
function jsonProblems(value, at = 'value', seen = new Set(), depth = 0) {
  if (depth > 32) return [`${at}: JSON 嵌套超过 32 层`];
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return [];
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [`${at}: 必须为有限数字`];
  if (!object(value) && !Array.isArray(value)) return [`${at}: 必须为 JSON 值`];
  if (seen.has(value)) return [`${at}: 不允许循环引用`];
  if (object(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return [`${at}: 必须为普通 JSON 对象`];
  seen.add(value);
  const out = [];
  if (Array.isArray(value) && Array.from({ length: value.length }, (_, i) => i).some((i) => !Object.hasOwn(value, i))) out.push(`${at}: JSON 数组不能有空位`);
  for (const [key, v] of Object.entries(value)) {
    if (forbidden.has(key)) out.push(`${at}.${key}: 不允许原型键`);
    out.push(...jsonProblems(v, `${at}.${key}`, seen, depth + 1));
  }
  seen.delete(value);
  return out;
}
export function validateSchemaValue(value, schema, at = 'value') {
  const problems = [...schemaProblems(schema), ...jsonProblems(value, at)];
  if (problems.length) return problems;
  const validate = validatorFor(schema);
  if (!validate(value)) problems.push(...(validate.errors ?? []).map((e) => `${at}${e.instancePath}: ${e.keyword}: ${e.message}`));
  return problems;
}
function result(value, problems) { return { value: problems.length ? null : value, problems }; }
export function validateMotionInstance(value) {
  if (value && typeof value === 'object' && immutable(value) && verifiedInstances.has(value)) return result(value, []);
  const problems = validateSchemaValue(value, motionInstanceSchema, 'motion');
  if (problems.length) return result(value, problems);
  const paths = new Set();
  for (const [i, track] of (value.tracks ?? []).entries()) {
    if (paths.has(track.path)) problems.push(`motion.tracks.${i}.path: 轨路径重复`);
    paths.add(track.path);
    if (track.clock?.loop && !track.clock.duration) problems.push(`motion.tracks.${i}.clock: 循环需要 duration`);
    for (let k = 0; k < track.keyframes.length; k++) {
      const frame = track.keyframes[k];
      if (k && frame.t <= track.keyframes[k - 1].t) problems.push(`motion.tracks.${i}.keyframes.${k}.t: 时间必须严格递增`);
      if (Array.isArray(frame.ease) && (frame.ease[0] < 0 || frame.ease[0] > 1 || frame.ease[2] < 0 || frame.ease[2] > 1)) problems.push(`motion.tracks.${i}.keyframes.${k}.ease: 贝塞尔横向控制点必须在 0..1`);
    }
  }
  const ids = new Set();
  for (const [i, marker] of (value.markers ?? []).entries()) { if (ids.has(marker.id)) problems.push(`motion.markers.${i}.id: 标识重复`); ids.add(marker.id); }
  for (const p of [...paths, ...(value.locked ?? [])]) if (p.split('.').some((k) => forbidden.has(k))) problems.push(`motion: 不允许原型路径 ${p}`);
  if (!problems.length && immutable(value)) verifiedInstances.add(value);
  return result(value, problems);
}
export function validateMotionManifest(value) {
  if (value && typeof value === 'object' && immutable(value) && verifiedManifests.has(value)) return result(value, []);
  const problems = validateSchemaValue(value, motionManifestSchema, 'manifest');
  if (problems.length) return result(value, problems);
  if (value.paramsSchema.type !== 'object') problems.push('manifest.paramsSchema.type: 根类型必须为 object');
  problems.push(...validateSchemaValue(value.defaults, value.paramsSchema, 'manifest.defaults'));
  if (value.dataSchema) problems.push(...validateSchemaValue(value.data ?? null, value.dataSchema, 'manifest.data'));
  for (const asset of value.assets ?? []) {
    let decoded;
    try { decoded = decodeURIComponent(asset); } catch { problems.push(`manifest.assets: 资源路径编码无效 ${asset}`); continue; }
    if (decoded !== decoded.trim() || /^(?:[a-z][a-z0-9+.-]*:|[/\\])/i.test(decoded) || /[\0\r\n]/.test(decoded) || decoded.split(/[\\/]/).includes('..')) problems.push(`manifest.assets: 资源必须为场景目录内的相对路径 ${asset}`);
  }
  if (!problems.length && immutable(value)) verifiedManifests.add(value);
  return result(value, problems);
}

const getPath = (v, p) => p.split('.').reduce((o, k) => o != null && Object.hasOwn(o, k) ? o[k] : undefined, v);
const overlaps = (a, b) => a === b || a.startsWith(b + '.') || b.startsWith(a + '.');
/** 原实例的锁是权威：删除实例、删锁、改值或改驱动该路径的轨都必须失败。 */
export function checkMotionLocks(before, after) {
  const problems = [];
  for (const p of before?.locked ?? []) {
    if (!after?.locked?.includes(p)) problems.push(`motion.${p}: 人工锁定不能被此操作移除`);
    if (!same(getPath(before, p), getPath(after, p))) problems.push(`motion.${p}: 人工锁定值不能修改`);
    const tracks = (v) => (v?.tracks ?? []).filter((t) => overlaps(t.path, p));
    if (!same(tracks(before), tracks(after))) problems.push(`motion.${p}: 人工锁定属性轨不能修改`);
  }
  return problems;
}

/** 在工程更新边界建立不可变快照；求帧可复用结构验证，实际参数与时间不会被缓存。 */
export function freezeMotionInstance(value) {
  if (value === undefined) return undefined;
  const checked = validateMotionInstance(value);
  if (!checked.value) throw new Error(checked.problems.join('\n'));
  const snapshot = deepFreeze(structuredClone(value));
  validateMotionInstance(snapshot);
  return snapshot;
}
