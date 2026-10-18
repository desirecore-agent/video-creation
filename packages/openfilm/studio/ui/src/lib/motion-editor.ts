/** 动效检查器共用的数据契约与无副作用编辑运算；实例始终写回 film.html。 */
import { ease, mapTime, motionTrackRequiresStep, sampleTrack } from '../../../../src/motion.mjs';
export interface MotionSchema {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, MotionSchema>;
  items?: MotionSchema | MotionSchema[];
  required?: string[];
  [key: string]: unknown;
}
export interface MotionManifest {
  version: 1;
  id: string;
  name: string;
  description: string;
  paramsSchema: MotionSchema;
  defaults: Record<string, unknown>;
  dataSchema?: MotionSchema;
  data?: unknown;
}
export type MotionEase = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'step' | [number, number, number, number];
export interface MotionKeyframe { t: number; value: unknown; ease?: MotionEase }
export interface MotionTrack {
  path: string;
  keyframes: MotionKeyframe[];
  clock?: { offset?: number; speed?: number; duration?: number; loop?: 'repeat' | 'pingpong' };
}
export interface MotionInstance {
  version: 1;
  params?: Record<string, unknown>;
  data?: unknown;
  tracks?: MotionTrack[];
  markers?: Array<{ id: string; t: number; name?: string; data?: unknown }>;
  locked?: string[];
}
export interface MotionField { path: string; name: string; schema: MotionSchema; value: unknown }

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safe = (key: string) => !['__proto__', 'prototype', 'constructor'].includes(key);

/** 路径以协议的点分格式表示；只读取自有字段，避免把继承属性当作工程参数。 */
export function motionValue(value: unknown, path: string): unknown {
  let at = value;
  for (const key of path.split('.')) {
    if (!safe(key) || !at || typeof at !== 'object' || !Object.hasOwn(at, key)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

/** 复制路径上的容器，其余字段和关键帧保持原样。 */
export function withMotionValue<T>(value: T, path: string, next: unknown): T {
  const keys = path.split('.');
  if (!keys.length || keys.some((key) => !safe(key) || !key)) return value;
  const write = (current: unknown, at: number): unknown => {
    const key = keys[at]!;
    const out: Record<string, unknown> | unknown[] = Array.isArray(current) ? [...current] : { ...record(current) };
    (out as Record<string, unknown>)[key] = at === keys.length - 1 ? next : write((out as Record<string, unknown>)[key], at + 1);
    return out;
  };
  return write(value, 0) as T;
}

/** 缺省值用于新增结构化表格行；遵守 schema 的基础类型和枚举。 */
export function schemaDefault(schema: MotionSchema): unknown {
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.enum?.length) return structuredClone(schema.enum[0]);
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([k]) => safe(k)).map(([k, child]) => [k, schemaDefault(child)]));
  if (schema.type === 'array') {
    const items = Array.isArray(schema.items) ? schema.items : null;
    return Array.from({ length: schema.minItems ?? items?.length ?? 0 }, (_, i) => schemaDefault(items?.[i] ?? (!Array.isArray(schema.items) ? schema.items : undefined) ?? { type: 'number' }));
  }
  if (schema.type === 'number' || schema.type === 'integer') return Math.max(0, schema.minimum ?? 0);
  if (schema.type === 'boolean') return false;
  return '';
}

/** 仅暴露声明的参数；自由代码场景继续使用原模板检查器。 */
export function motionFields(manifest: MotionManifest, motion: MotionInstance): MotionField[] {
  const walk = (schema: MotionSchema, path: string, value: unknown): MotionField[] => {
    if (schema.type === 'object' && schema.properties) return Object.entries(schema.properties).filter(([k]) => safe(k)).flatMap(([key, child]) => walk(child, `${path}.${key}`, record(value)[key] ?? schemaDefault(child)));
    return [{ path, name: schema.title ?? path.split('.').at(-1)!, schema, value }];
  };
  const merge = (left: unknown, right: unknown): unknown => {
    if (!left || typeof left !== 'object' || Array.isArray(left) || !right || typeof right !== 'object' || Array.isArray(right)) return right;
    const out = { ...record(left) };
    for (const [key, next] of Object.entries(record(right))) if (safe(key)) out[key] = merge(out[key], next);
    return out;
  };
  const values = merge(manifest.defaults ?? {}, motion.params ?? {}) as Record<string, unknown>;
  return Object.entries(manifest.paramsSchema.properties ?? {}).filter(([key]) => safe(key)).flatMap(([key, schema]) => walk(schema, `params.${key}`, values[key] ?? schemaDefault(schema)));
}

/** 锁可以覆盖整个对象或某条属性，动画轨与基础参数使用同一属性路径。 */
export function motionLocked(motion: MotionInstance, path: string): boolean {
  return (motion.locked ?? []).some((locked) => path === locked || path.startsWith(`${locked}.`) || locked.startsWith(`${path}.`));
}

/** 同一毫秒只保留一帧，插入与拖动均保持稳定排序，不改变其他属性轨。 */
export function withKeyframe(track: MotionTrack, frame: MotionKeyframe, replaceIndex?: number): MotionTrack {
  const t = Math.max(0, Math.round(frame.t * 1000) / 1000);
  return { ...track, keyframes: [...track.keyframes.filter((old, i) => i !== replaceIndex && Math.abs(old.t - t) >= 0.0005), { ...frame, t }].sort((a, b) => a.t - b.t) };
}

/** 曲线显示采用协议的归一化缓动；自定义贝塞尔也可由控制点直接编辑。 */
export function curveProgress(curve: MotionEase | undefined, value: number): number {
  return ease(value, curve);
}

/** 插帧与预览共用运行时采样，保证颜色、向量和循环时钟一致。 */
export function valueAtTrack(track: MotionTrack | undefined, time: number, fallback: unknown): unknown {
  return track?.keyframes.length ? sampleTrack(track, time) : fallback;
}

/** 属性轨显示和插帧使用局部时间，点击关键帧时定位当前循环周期。 */
export function trackTime(track: MotionTrack, sourceTime: number): number { return mapTime(sourceTime, track.clock).time; }
export function sourceTimeForKey(track: MotionTrack, keyTime: number, sourceNow: number): number {
  const clock = track.clock ?? {};
  const mapped = mapTime(sourceNow, clock);
  const local = clock.loop && clock.duration ? mapped.cycle * clock.duration + (mapped.direction === -1 ? clock.duration - keyTime : keyTime) : keyTime;
  return local / (clock.speed ?? 1) + (clock.offset ?? 0);
}

export interface MotionChange { path: string[]; value?: unknown; remove?: true }

/** 领域操作只提交修改过的参数、属性轨或标记，使其他人工/智能体编辑可以独立重基。 */
export function motionChanges(before: MotionInstance, after: MotionInstance): MotionChange[] {
  const out: MotionChange[] = [];
  const diff = (left: unknown, right: unknown, path: string[]) => {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (right === undefined) { out.push({ path, remove: true }); return; }
    if (right && typeof right === 'object' && !Array.isArray(right) && left && typeof left === 'object' && !Array.isArray(left)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) if (safe(key)) diff(record(left)[key], record(right)[key], [...path, key]);
    } else out.push({ path, value: right });
  };
  for (const key of new Set([...Object.keys(before.params ?? {}), ...Object.keys(after.params ?? {})])) if (safe(key)) diff(before.params?.[key], after.params?.[key], ['params', key]);
  diff(before.data, after.data, ['data']);
  for (const kind of ['tracks', 'markers'] as const) {
    const left = new Map((before[kind] ?? []).map((entry) => ['path' in entry ? entry.path : entry.id, entry]));
    const right = new Map((after[kind] ?? []).map((entry) => ['path' in entry ? entry.path : entry.id, entry]));
    for (const key of new Set([...left.keys(), ...right.keys()])) {
      if (JSON.stringify(left.get(key)) !== JSON.stringify(right.get(key))) out.push(right.has(key) ? { path: [kind, key], value: right.get(key) } : { path: [kind, key], remove: true });
    }
  }
  return out;
}

/** 离散和条件约束的准入与实际渲染共用同一个判定入口。 */
export function defaultMotionEase(manifest: MotionManifest, path: string): MotionEase {
  return motionTrackRequiresStep(manifest, path) ? 'step' : 'linear';
}

/** 首次启用循环时提交界面已经显示的范围，避免只有 loop 而缺少 duration。 */
export function motionLoopClock(track: MotionTrack, mode: '' | 'repeat' | 'pingpong'): MotionTrack['clock'] {
  const clock = { ...track.clock };
  if (mode) {
    clock.loop = mode;
    clock.duration ??= Math.max(0.1, ...track.keyframes.map((frame) => frame.t));
  } else delete clock.loop;
  return clock;
}
