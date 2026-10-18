/** 通用绝对时间动效：相同输入永远产生相同帧，不维护播放游标或另一条时间线。 */
import { validateMotionInstance, validateMotionManifest, validateSchemaValue } from './motion-schema.mjs';
export * from './motion-schema.mjs';
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const finite = (n, name) => { if (!Number.isFinite(n)) throw new TypeError(`${name} 必须为有限数字`); return n; };
const copy = (v) => v === undefined ? undefined : structuredClone(v);
const freeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const immutableValues = new WeakSet();
const isImmutable = (v) => {
  if (!v || typeof v !== 'object') return true;
  if (immutableValues.has(v)) return true;
  if (!Object.isFrozen(v) || !Object.values(v).every(isImmutable)) return false;
  immutableValues.add(v);
  return true;
};
const admitted = new WeakMap();
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const color = (s) => {
  if (typeof s !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return null;
  const h = s.slice(1), hex = h.length <= 4 ? [...h].map((x) => x + x).join('') : h;
  return [0, 2, 4, 6].map((i) => i < hex.length ? parseInt(hex.slice(i, i + 2), 16) : 255);
};

/** 数值、向量、对象、十六进制颜色和相同单位插值；不可插值的离散值保持前值。 */
export function mix(a, b, progress) {
  const p = finite(progress, 'progress');
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * p;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.map((v, i) => mix(v, b[i], p));
  if (object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => Object.hasOwn(b, k))) return Object.fromEntries(Object.keys(a).map((k) => [k, mix(a[k], b[k], p)]));
  const ca = color(a), cb = color(b);
  if (ca && cb) {
    // 无透明度的输入保持六位色值，避免破坏场景声明的颜色格式约束。
    const channels = [5, 9].includes(a.length) || [5, 9].includes(b.length) ? 4 : 3;
    return '#' + ca.slice(0, channels).map((v, i) => Math.round(clamp(v + (cb[i] - v) * p, 0, 255)).toString(16).padStart(2, '0')).join('');
  }
  const unit = /^(-?(?:\d+(?:\.\d*)?|\.\d+))([a-z%]+)$/i;
  const ua = typeof a === 'string' ? unit.exec(a) : null, ub = typeof b === 'string' ? unit.exec(b) : null;
  if (ua && ub && ua[2] === ub[2]) return `${mix(Number(ua[1]), Number(ub[1]), p)}${ua[2]}`;
  return copy(p >= 1 ? b : a);
}
const curves = { linear: null, 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1] };
/** CSS 三次贝塞尔通过横坐标反求参数；端点和乱序求值不依赖历史。 */
export function ease(progress, kind = 'linear') {
  const p = clamp(finite(progress, 'progress'));
  if (kind === 'step') return p >= 1 ? 1 : 0;
  if (kind === 'linear') return p;
  const c = Array.isArray(kind) ? kind : curves[kind];
  if (!c || c.length !== 4 || !c.every(Number.isFinite) || c[0] < 0 || c[0] > 1 || c[2] < 0 || c[2] > 1) throw new TypeError('无效缓动曲线');
  if (p === 0 || p === 1) return p;
  const bezier = (u, a, b) => 3 * (1 - u) ** 2 * u * a + 3 * (1 - u) * u * u * b + u ** 3;
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const u = (lo + hi) / 2; if (bezier(u, c[0], c[2]) < p) lo = u; else hi = u; }
  return bezier((lo + hi) / 2, c[1], c[3]);
}
/** 二阶弹簧解析解，支持欠阻尼、临界和过阻尼；velocity 是单位进度每秒。 */
export function spring(time, { mass = 1, stiffness = 100, damping = 10, velocity = 0, from = 0, to = 1 } = {}) {
  [time, mass, stiffness, damping, velocity, from, to].forEach((n) => finite(n, 'spring 参数'));
  if (mass <= 0 || stiffness <= 0 || damping < 0) throw new RangeError('弹簧质量与刚度须大于零，阻尼不能小于零');
  const t = Math.max(0, time), w = Math.sqrt(stiffness / mass), z = damping / (2 * Math.sqrt(stiffness * mass));
  let displacement;
  if (Math.abs(z - 1) < 1e-8) displacement = Math.exp(-w * t) * (-1 + (velocity - w) * t);
  else if (z < 1) { const wd = w * Math.sqrt(1 - z * z); displacement = Math.exp(-z * w * t) * (-Math.cos(wd * t) + (velocity - z * w) / wd * Math.sin(wd * t)); }
  else { const root = Math.sqrt(z * z - 1), a = -w * (z - root), b = -w * (z + root), A = (velocity + b) / (a - b); displacement = A * Math.exp(a * t) + (-1 - A) * Math.exp(b * t); }
  return from + (to - from) * (1 + displacement);
}
/** 从索引参考点错峰，返回该项延迟秒数。 */
export function stagger(index, { each = 0.1, from = 0 } = {}) {
  [index, each, from].forEach((n) => finite(n, 'stagger 参数'));
  return Math.abs(index - from) * each;
}
/** 父时间到局部时间的纯映射；可组合 mapTime(mapTime(t,a).time,b)。 */
export function mapTime(time, { offset = 0, speed = 1, duration, loop } = {}) {
  [time, offset, speed].forEach((n) => finite(n, 'clock 参数'));
  if (speed <= 0 || (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) || (loop && !['repeat', 'pingpong'].includes(loop)) || (loop && !duration)) throw new RangeError('无效局部时钟');
  const raw = (time - offset) * speed;
  if (duration === undefined) return { time: Math.max(0, raw), cycle: 0, direction: 1, active: raw >= 0 };
  if (!loop) return { time: clamp(raw, 0, duration), cycle: 0, direction: 1, active: raw >= 0 && raw <= duration };
  const positive = Math.max(0, raw), cycle = Math.floor(positive / duration), part = positive % duration;
  const direction = loop === 'pingpong' && cycle % 2 ? -1 : 1;
  return { time: direction === 1 ? part : duration - part, cycle, direction, active: raw >= 0 };
}
export function loopTime(time, duration, mode = 'repeat') { return mapTime(time, { duration, loop: mode }).time; }
/** 折线路径按弧长均匀采样，angle 为弧度；零长度段不会产生 NaN。 */
export function samplePath(points, progress, { closed = false } = {}) {
  if (!Array.isArray(points) || points.length < 2 || !points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) throw new TypeError('路径至少需要两个 [x,y] 点');
  const route = closed ? [...points, points[0]] : points, lengths = route.slice(1).map((p, i) => Math.hypot(p[0] - route[i][0], p[1] - route[i][1]));
  const total = lengths.reduce((a, b) => a + b, 0), target = clamp(finite(progress, 'progress')) * total;
  let walked = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (target <= walked + lengths[i] || i === lengths.length - 1) {
      const a = route[i], b = route[i + 1], p = lengths[i] ? (target - walked) / lengths[i] : 0;
      return { x: mix(a[0], b[0], p), y: mix(a[1], b[1], p), angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
    }
    walked += lengths[i];
  }
}
/** 无状态随机数：显式 seed 和索引，相同粒子在任意 seek 后保持一致。 */
export function seeded(seed, index = 0) {
  let h = 2166136261;
  for (const c of `${seed}:${index}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  h = Math.imul(h ^ h >>> 16, 0x21f0aaad); h = Math.imul(h ^ h >>> 15, 0x735a2d97);
  return ((h ^ h >>> 15) >>> 0) / 4294967296;
}
/** 缓动定义在当前关键帧的出段；区间外保持端点。 */
export function sampleTrack(track, time) {
  const frames = track.keyframes;
  if (!frames?.length) throw new TypeError('属性轨缺少关键帧');
  const t = mapTime(time, track.clock).time;
  if (t <= frames[0].t) return copy(frames[0].value);
  const last = frames.at(-1);
  if (t >= last.t) return copy(last.value);
  let lo = 0, hi = frames.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >>> 1; if (frames[mid].t <= t) lo = mid; else hi = mid; }
  const a = frames[lo], b = frames[hi];
  return mix(a.value, b.value, ease((t - a.t) / (b.t - a.t), a.ease));
}
function merge(base, over) {
  if (!object(base) || !object(over)) return copy(over);
  const out = copy(base);
  for (const [key, value] of Object.entries(over)) out[key] = object(value) && object(out[key]) ? merge(out[key], value) : copy(value);
  return out;
}
function setPath(value, path, next) {
  const parts = path.split('.'), last = parts.pop();
  let parent = value;
  for (const part of parts) {
    if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, part)) throw new Error(`属性轨路径不存在: ${path}`);
    parent = parent[part];
  }
  if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, last)) throw new Error(`属性轨路径不存在: ${path}`);
  parent[last] = next;
}
const checked = (result) => { if (result.problems.length) throw new Error(result.problems.join('\n')); return result.value; };
const manifests = new WeakMap();
/** HTML 内声明可选构件；非法声明报错，自由场景不必声明。 */
export function readMotionManifest(document) {
  const node = document?.getElementById?.('film-motion');
  if (!node) return null;
  if (document.querySelectorAll?.('[id="film-motion"]').length > 1) throw new Error('film-motion 标识不能重复');
  if (node.localName && node.localName !== 'script') throw new Error('film-motion 必须为 script 元素');
  if (node.getAttribute('type') !== 'application/json') throw new Error('film-motion 必须是 application/json 的 script');
  const text = node.textContent;
  const cached = manifests.get(node);
  if (cached?.text === text) return cached.value;
  if (new TextEncoder().encode(text).byteLength > 4 * 1024 * 1024) throw new Error('film-motion 不能超过 4 MiB');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('film-motion 不符合 JSON 格式'); }
  checked(validateMotionManifest(value));
  freeze(value);
  manifests.set(node, { text, value });
  return value;
}
function localRef(schema, root) {
  if (!schema?.$ref?.startsWith('#/')) return null;
  return schema.$ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((v, k) => v?.[k], root);
}
const nonContinuous = (schema) => schema && typeof schema === 'object' && (['not', 'if', 'contains', 'anyOf', 'oneOf'].some((k) => Object.hasOwn(schema, k)) || schema.uniqueItems === true);
function schemasAt(schema, parts, root, seen = new Map()) {
  if (!schema || typeof schema !== 'object') return [];
  const keyOfPath = JSON.stringify(parts);
  if (seen.get(schema)?.has(keyOfPath)) return [];
  seen = new Map(seen);
  seen.set(schema, new Set([...(seen.get(schema) ?? []), keyOfPath]));
  if (!parts.length) return [schema];
  const [key, ...rest] = parts, out = nonContinuous(schema) ? [schema] : [];
  const ref = localRef(schema, root);
  if (ref) out.push(...schemasAt(ref, parts, root, seen));
  for (const s of [...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...Object.values(schema.dependencies ?? {}).filter(object), schema.if, schema.then, schema.else, schema.not].filter(Boolean)) out.push(...schemasAt(s, parts, root, seen));
  let named = false;
  if (schema.properties?.[key] !== undefined) { named = true; out.push(...schemasAt(schema.properties[key], rest, root, seen)); }
  for (const [pattern, constraint] of Object.entries(schema.patternProperties ?? {})) if (new RegExp(pattern, 'u').test(key)) { named = true; out.push(...schemasAt(constraint, rest, root, seen)); }
  if (schema.items !== undefined && /^\d+$/.test(key)) {
    const item = Array.isArray(schema.items) ? schema.items[Number(key)] ?? schema.additionalItems : schema.items;
    out.push(...schemasAt(item, rest, root, seen));
  }
  if (!named && object(schema.additionalProperties)) out.push(...schemasAt(schema.additionalProperties, rest, root, seen));
  return out;
}
function discrete(schema, root, seen = new Set()) {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return false;
  seen = new Set(seen).add(schema);
  if (nonContinuous(schema) || schema.type === 'integer' || Array.isArray(schema.type) && schema.type.includes('integer') || ['enum', 'const', 'multipleOf'].some((k) => Object.hasOwn(schema, k))) return true;
  const children = [...Object.values(schema.properties ?? {}), ...Object.values(schema.patternProperties ?? {}), ...Object.values(schema.dependencies ?? {}).filter(object), ...(Array.isArray(schema.items) ? schema.items : [schema.items]), schema.additionalItems, schema.additionalProperties, ...(schema.allOf ?? []), schema.then, schema.else, localRef(schema, root)];
  return children.some((s) => discrete(s, root, seen));
}
/** 只给编辑器共享离散策略，不替代 Ajv；条件、联合与非凸约束保守要求 step。 */
export function motionTrackRequiresStep(manifest, path) {
  const [target, ...parts] = path.split('.'), schema = target === 'params' ? manifest?.paramsSchema : target === 'data' ? manifest?.dataSchema : null;
  return Boolean(schema && schemasAt(schema, parts, schema).some((s) => discrete(s, schema)));
}
/** 工具提交前检查完整输入及所有关键帧端点；离散约束要求显式 step，不猜测任意 Schema 的全区间。 */
export function validateMotionInputs(manifest, motion) {
  if (!manifest && !motion) return [];
  if (!manifest) return ['页面片段使用 motion 时必须声明 film-motion 参数契约'];
  if (motion && isImmutable(manifest) && isImmutable(motion) && admitted.get(manifest)?.has(motion)) return [];
  const problems = [...validateMotionManifest(manifest).problems, ...(motion ? validateMotionInstance(motion).problems : [])];
  if (problems.length) return problems;
  // 可变调用者的数据不被修改，局部冻结快照只服务本次批量端点校验。
  const contract = isImmutable(manifest) ? manifest : freeze(copy(manifest));
  const base = { params: merge(contract.defaults, motion?.params ?? {}), data: copy(motion?.data !== undefined ? motion.data : contract.data ?? null) };
  const validate = (value, at) => [...validateSchemaValue(value.params, contract.paramsSchema, `${at}.params`), ...(contract.dataSchema ? validateSchemaValue(value.data, contract.dataSchema, `${at}.data`) : [])];
  problems.push(...validate(base, 'motion'));
  for (const [i, track] of (motion?.tracks ?? []).entries()) {
    const mustStep = motionTrackRequiresStep(contract, track.path);
    for (const [k, keyframe] of track.keyframes.entries()) {
      const value = copy(base);
      try { setPath(value, track.path, copy(keyframe.value)); problems.push(...validate(value, `motion.tracks.${i}.keyframes.${k}`)); }
      catch (e) { problems.push(e.message); }
      if (mustStep && k < track.keyframes.length - 1 && keyframe.ease !== 'step' && JSON.stringify(keyframe.value) !== JSON.stringify(track.keyframes[k + 1].value)) problems.push(`motion.tracks.${i}.keyframes.${k}: 离散、条件或非凸 Schema 约束需要显式 ease: step`);
    }
  }
  if (!problems.length && motion && isImmutable(manifest) && isImmutable(motion)) {
    if (!admitted.has(manifest)) admitted.set(manifest, new WeakSet());
    admitted.get(manifest).add(motion);
  }
  return problems;
}
/** 默认值、实例输入、属性轨共同求值；绝不改写 manifest 或工程实例。 */
export function sampleMotion(manifest, motion, time) {
  finite(time, 'time');
  if (manifest) { const problems = validateMotionInputs(manifest, motion); if (problems.length) throw new Error(problems.join('\n')); }
  else if (motion) checked(validateMotionInstance(motion));
  if (motion && !manifest) throw new Error('页面片段使用 motion 时必须声明 film-motion 参数契约');
  const value = { params: merge(manifest?.defaults ?? {}, motion?.params ?? {}), data: copy(motion?.data !== undefined ? motion.data : manifest?.data ?? null) };
  if (manifest) {
    const problems = [...validateSchemaValue(value.params, manifest.paramsSchema, 'params'), ...(manifest.dataSchema ? validateSchemaValue(value.data, manifest.dataSchema, 'data') : [])];
    if (problems.length) throw new Error(problems.join('\n'));
  }
  for (const track of motion?.tracks ?? []) setPath(value, track.path, sampleTrack(track, time));
  if (manifest) {
    const problems = [...validateSchemaValue(value.params, manifest.paramsSchema, 'params'), ...(manifest.dataSchema ? validateSchemaValue(value.data, manifest.dataSchema, 'data') : [])];
    if (problems.length) throw new Error(problems.join('\n'));
  }
  return { ...value, events: copy((motion?.markers ?? []).filter((e) => e.t <= time).sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) };
}
/** 每帧都提供全量输入；Canvas/WebGL/JS 无须等待 DOM overrides。 */
export function frameContext(time, { document = globalThis.document, manifest, motion, viewport, filmTime = time, clipId = null } = {}) {
  const own = manifest === undefined ? readMotionManifest(document) : manifest;
  const sampled = sampleMotion(own, motion, time);
  const width = viewport?.width ?? document?.documentElement?.clientWidth ?? 1920, height = viewport?.height ?? document?.documentElement?.clientHeight ?? 1080;
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) throw new TypeError('viewport 尺寸必须为正有限数字');
  return { version: 1, time, filmTime: finite(filmTime, 'filmTime'), clipId, ...sampled, viewport: { width, height } };
}
/** 可选准备阶段先完成，随后调用旧协议兼容的 frame(t, context)。 */
export async function drawFrame(film, time, options = {}) {
  if (!film || typeof film.frame !== 'function') throw new Error('window.film.frame 不存在');
  const manifest = options.manifest === undefined ? readMotionManifest(options.document ?? globalThis.document) : options.manifest;
  if (!manifest && !options.motion) { await film.frame(time); return null; }
  const context = frameContext(time, { ...options, manifest });
  if (typeof film.prepare === 'function') await film.prepare(context);
  await film.frame(time, context);
  return context;
}
