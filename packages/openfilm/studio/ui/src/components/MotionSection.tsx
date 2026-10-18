/** 声明式场景的参数、关键帧和事件编辑；数据仍通过原有版本化编辑队列写回。 */
import * as React from 'react';
import { Diamond, LockKeyhole, Plus, Trash2, UnlockKeyhole } from 'lucide-react';
import { useT } from '@/i18n';
import { validateSchemaValue } from '../../../../src/motion.mjs';
import {
  curveProgress, defaultMotionEase, motionFields, motionLocked, motionLoopClock, motionValue, schemaDefault, sourceTimeForKey, trackTime, valueAtTrack, withKeyframe, withMotionValue,
  type MotionEase, type MotionInstance, type MotionKeyframe, type MotionManifest, type MotionSchema, type MotionTrack,
} from '@/lib/motion-editor';
import { ColorField, FIELD, HEAD_BTN, INPUT, NumField, Section, SectionAction } from './inspector-fields';
import type { TemplateHost } from './TemplateSection';

type T = ReturnType<typeof useT>;
const EMPTY: MotionInstance = { version: 1 };
// 草稿只留在当前页面内存，并按工程与片段区分，切换检查对象后可继续编辑。
const MotionDraftScope = React.createContext('');
const rowDrafts = new Map<string, { value: unknown }>();
const EASES = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'step', 'custom'] as const;

export function MotionSection({ host, timeMs, commit }: {
  host: TemplateHost;
  timeMs: number;
  commit: (next: MotionInstance) => Promise<string | null>;
}) {
  const t = useT();
  const [manifest, setManifest] = React.useState<MotionManifest | null>(null);
  const [readError, setReadError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const writing = React.useRef(false);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [selectedPath, setSelectedPath] = React.useState('');
  const motion = host.motion?.() ?? EMPTY;
  const kept = JSON.stringify(motion);
  React.useEffect(() => {
    let live = true; let timer = 0; let reading = 0;
    const read = () => { const seq = ++reading; void host.read().then((controls) => {
      if (!live || seq !== reading) return;
      setLoaded(true); setReadError(controls?.motionError ?? null);
      setManifest(controls?.motionManifest ?? null);
      if (!controls) timer = window.setTimeout(read, 1200);
    }).catch((error: unknown) => { if (live && seq === reading) { setLoaded(true); setReadError(String(error)); } }); };
    const stop = host.onPageChanged?.(() => { window.clearTimeout(timer); read(); });
    timer = window.setTimeout(read, 100);
    return () => { live = false; stop?.(); window.clearTimeout(timer); };
  }, [host, kept]);
  if (!loaded || (!manifest && !readError)) return null;
  if (readError) return <Section id="motion" title={t('motion.title')}><p role="alert" className="text-[11px] text-[var(--text-muted)]">{t('motion.error')}: {readError}</p></Section>;
  if (!manifest) return null;
  const fields = motionFields(manifest, motion);
  const sourceTime = host.motionTime?.(timeMs) ?? timeMs / 1000;
  const update = (change: (current: MotionInstance) => MotionInstance): Promise<string | null> => {
    if (writing.current) return Promise.resolve(t('motion.pending'));
    writing.current = true;
    setPending(true); setRefusal(null);
    return commit(change(host.motion?.() ?? EMPTY)).then((error) => { setRefusal(error); return error; }).catch((error: unknown) => { const message = error instanceof Error ? error.message : String(error); setRefusal(message); return message; }).finally(() => { writing.current = false; setPending(false); });
  };
  const setValue = (path: string, value: unknown) => update((current) => withMotionValue(current, path, value));
  const toggleLock = (path: string) => update((current) => ({ ...current, locked: current.locked?.includes(path) ? current.locked.filter((p) => p !== path) : [...(current.locked ?? []), path] }));
  const setTrack = (path: string, change: (track: MotionTrack) => MotionTrack | null) => update((current) => {
    const old = current.tracks?.find((track) => track.path === path) ?? { path, keyframes: [] };
    const next = change(old);
    return { ...current, tracks: [...(current.tracks ?? []).filter((track) => track.path !== path), ...(next ? [next] : [])] };
  });
  const tracks = motion.tracks ?? [];
  const available = fields.filter((field) => !tracks.some((track) => track.path === field.path));
  return <MotionDraftScope.Provider value={host.motionKey ?? host.page}>
    <Section id="motion" title={manifest.name || t('motion.title')}>
      <p className="text-[10px] leading-4 text-[var(--text-faint)]">{manifest.description || t('motion.hint')}</p>
      {pending ? <span role="status" className="text-[10px] text-[var(--text-faint)]">{t('motion.pending')}</span> : null}
      {refusal ? <p role="alert" className="rounded bg-[var(--fill-tsp)] p-2 text-[11px] text-[var(--text)]">{refusal}</p> : null}
      <fieldset disabled={pending} className="min-w-0 space-y-3">
        {fields.map((field) => <Property key={field.path} label={field.name} description={field.schema.description} path={field.path} motion={motion} toggleLock={toggleLock} t={t}>
          <SchemaInput schema={field.schema} value={field.value} label={field.name} disabled={motionLocked(motion, field.path)} onChange={(value) => setValue(field.path, value)} t={t} />
        </Property>)}
        {manifest.dataSchema ? <Property label={manifest.dataSchema.title || t('motion.data')} description={manifest.dataSchema.description} path="data" motion={motion} toggleLock={toggleLock} t={t}>
          <SchemaInput schema={manifest.dataSchema} value={motion.data ?? manifest.data ?? schemaDefault(manifest.dataSchema)} label={t('motion.data')} disabled={motionLocked(motion, 'data')} onChange={(value) => setValue('data', value)} t={t} />
        </Property> : null}
      </fieldset>
      {motion.locked?.length ? <div className="space-y-1 border-t border-[var(--border)] pt-2">
        {motion.locked.map((path) => <div key={path} className="flex min-w-0 items-center gap-1"><LockKeyhole size={10} className="shrink-0 text-[var(--text-faint)]" /><span className="min-w-0 flex-1 truncate text-[10px] text-[var(--text-muted)]" title={path}>{path}</span><button type="button" className={HEAD_BTN} disabled={pending} aria-label={`${t('motion.unlock')}: ${path}`} onClick={() => toggleLock(path)}><UnlockKeyhole size={11} /></button></div>)}
      </div> : null}
    </Section>
    <Section id="motion-animation" title={t('motion.animation')}>
      <p className="text-[10px] text-[var(--text-faint)]">{t('motion.source')}: {sourceTime.toFixed(3)} s</p>
      <fieldset disabled={pending} className="min-w-0 space-y-3">
        {tracks.map((track) => {
          const field = fields.find((field) => field.path === track.path);
          const locked = motionLocked(motion, track.path);
          return <div key={track.path} className="min-w-0 rounded-[7px] bg-[var(--fill-tsp)] p-2" data-motion-track={track.path}>
            <div className="mb-1 flex min-w-0 items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text)]" title={track.path}>{field?.name ?? track.path}</span>
              <LockButton locked={locked} exact={motion.locked?.includes(track.path) ?? false} onClick={() => toggleLock(track.path)} t={t} />
              <button type="button" className={HEAD_BTN} aria-label={`${t('motion.removeTrack')}: ${field?.name ?? track.path}`} disabled={locked} onClick={() => setTrack(track.path, () => null)}><Trash2 size={12} /></button>
            </div>
            <fieldset disabled={locked} className="min-w-0 space-y-2">
              <KeyframeEditor track={track} schema={field?.schema ?? { type: 'number' }} label={field?.name ?? track.path} sourceTime={sourceTime} duration={host.motionDuration ?? 10} stepOnly={Boolean(field && defaultMotionEase(manifest, field.path) === 'step')} onTrack={(next) => setTrack(track.path, () => next)} onSeek={(local) => host.motionSeek?.(sourceTimeForKey(track, local, sourceTime))} t={t} />
              <button type="button" className="flex items-center gap-1 text-[10px] text-[var(--accent)]" onClick={() => setTrack(track.path, (old) => withKeyframe(old, { t: trackTime(old, sourceTime), value: valueAtTrack(old, sourceTime, field?.value ?? motionValue(motion, track.path) ?? 0), ease: field ? defaultMotionEase(manifest, field.path) : 'linear' }))}><Diamond size={11} />{t('motion.addKey')}</button>
              <ClockEditor track={track} onChange={(clock) => setTrack(track.path, (old) => ({ ...old, clock }))} t={t} />
            </fieldset>
          </div>;
        })}
        {!tracks.length ? <p className="text-[10px] text-[var(--text-faint)]">{t('motion.noTracks')}</p> : null}
        {available.length ? <div className="flex gap-1">
          <select aria-label={t('motion.selectProperty')} value={selectedPath} onChange={(event) => setSelectedPath(event.target.value)} className={`${FIELD} h-7 px-1 text-[11px] text-[var(--text)]`}>
            <option value="">{t('motion.selectProperty')}</option>
            {available.map((field) => <option key={field.path} value={field.path}>{field.name}</option>)}
          </select>
          <button type="button" className={HEAD_BTN} aria-label={t('motion.addTrack')} disabled={!selectedPath || motionLocked(motion, selectedPath)} onClick={() => { const field = fields.find((f) => f.path === selectedPath); if (field) setTrack(field.path, (old) => withKeyframe(old, { t: sourceTime, value: field.value, ease: defaultMotionEase(manifest, field.path) })); setSelectedPath(''); }}><Plus size={13} /></button>
        </div> : null}
      </fieldset>
    </Section>
    <Section id="motion-markers" title={t('motion.markers')} aside={<SectionAction label={t('motion.addMarker')} disabled={pending || motionLocked(motion, 'markers')} onClick={() => update((current) => ({ ...current, markers: [...(current.markers ?? []), { id: `marker-${crypto.randomUUID()}`, t: Math.max(0, Math.round(sourceTime * 1000) / 1000), name: t('motion.name') }].sort((a, b) => a.t - b.t) }))}><Plus size={12} /></SectionAction>}>
      <fieldset disabled={pending || motionLocked(motion, 'markers')} className="min-w-0 space-y-1">
        {(motion.markers ?? []).map((marker, i) => <div key={marker.id} className="grid grid-cols-[minmax(0,1fr)_76px_24px] items-center gap-1">
          <TextInput label={`${t('motion.name')} ${i + 1}`} value={marker.name ?? ''} onChange={(name) => update((current) => ({ ...current, markers: current.markers?.map((m) => m.id === marker.id ? { ...m, name } : m) }))} />
          <NumField label={`${t('motion.time')} ${i + 1}`} bare value={marker.t} min={0} unit="s" step={0.1} onCommit={(time) => update((current) => ({ ...current, markers: current.markers?.map((m) => m.id === marker.id ? { ...m, t: time } : m).sort((a, b) => a.t - b.t) }))} />
          <button type="button" className={HEAD_BTN} aria-label={`${t('motion.remove')} ${marker.name ?? marker.id}`} onClick={() => update((current) => ({ ...current, markers: current.markers?.filter((m) => m.id !== marker.id) }))}><Trash2 size={12} /></button>
        </div>)}
      </fieldset>
    </Section>
  </MotionDraftScope.Provider>;
}

function LockButton({ locked, exact, onClick, t }: { locked: boolean; exact: boolean; onClick: () => void; t: T }) {
  return <button type="button" className={`${HEAD_BTN} ${locked ? 'text-[var(--accent)]' : ''}`} disabled={locked && !exact} aria-label={t(exact ? 'motion.unlock' : 'motion.lock')} aria-pressed={locked} onClick={onClick}>{locked ? <LockKeyhole size={12} /> : <UnlockKeyhole size={12} />}</button>;
}
function Property({ label, description, path, motion, toggleLock, t, children }: { label: string; description?: string; path: string; motion: MotionInstance; toggleLock: (path: string) => void; t: T; children: React.ReactNode }) {
  return <div className="min-w-0 space-y-1" data-motion-property={path}>
    <div className="flex items-center gap-1"><label className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]" title={description}>{label}</label><LockButton locked={motionLocked(motion, path)} exact={motion.locked?.includes(path) ?? false} onClick={() => toggleLock(path)} t={t} /></div>
    {description ? <p className="text-[10px] leading-[14px] text-[var(--text-faint)]">{description}</p> : null}
    {children}
  </div>;
}

/** Schema 驱动的递归表单：数字向量和图表数组均有实际字段，复杂值不退化成单个 JSON 文本框。 */
function SchemaInput({ schema, value, label, disabled = false, onChange, t }: { schema: MotionSchema; value: unknown; label: string; disabled?: boolean; onChange: (value: unknown) => Promise<string | null> | void; t: T }) {
  if (schema.enum?.length) return <select aria-label={label} disabled={disabled} className={`${FIELD} px-1 text-[11px] text-[var(--text)]`} value={JSON.stringify(value)} onChange={(event) => onChange(JSON.parse(event.target.value))}>{schema.enum.map((option, i) => <option key={i} value={JSON.stringify(option)}>{String(option)}</option>)}</select>;
  if (schema.type === 'boolean') return <label className="flex items-center gap-2 text-[11px] text-[var(--text)]"><input type="checkbox" aria-label={label} disabled={disabled} checked={value === true} onChange={(event) => onChange(event.target.checked)} />{t(value ? 'motion.true' : 'motion.false')}</label>;
  if (schema.type === 'number' || schema.type === 'integer') return <NumField label={label} bare value={typeof value === 'number' ? value : 0} disabled={disabled} {...(schema.minimum != null ? { min: schema.minimum } : {})} {...(schema.maximum != null ? { max: schema.maximum } : {})} step={schema.multipleOf ?? (schema.type === 'integer' ? 1 : 0.1)} onCommit={(n) => onChange(schema.type === 'integer' ? Math.round(n) : n)} />;
  if (schema.type === 'string') return <fieldset disabled={disabled}>{schema.format === 'color' || typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value) ? <ColorField label={label} value={String(value ?? '')} onCommit={onChange} /> : <TextInput label={label} value={String(value ?? '')} onChange={onChange} />}</fieldset>;
  if (schema.type === 'object' && schema.properties) {
    const values = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    return <div className="min-w-0 space-y-1 border-l border-[var(--border)] pl-2">{Object.entries(schema.properties).map(([key, child]) => <div key={key} className="min-w-0 space-y-0.5"><span className="text-[10px] text-[var(--text-muted)]" title={child.description}>{child.title ?? key}</span><SchemaInput schema={child} value={values[key] ?? schemaDefault(child)} label={`${label}: ${child.title ?? key}`} disabled={disabled} onChange={(next) => onChange({ ...values, [key]: next })} t={t} /></div>)}</div>;
  }
  if (schema.type === 'array') return <SchemaArrayInput schema={schema} value={value} label={label} disabled={disabled} onChange={onChange} t={t} />;
  return <p className="text-[10px] text-[var(--text-faint)]">{t('motion.schemaUnsupported')}</p>;
}

/** 新数据行先留在局部草稿中；满足完整数组约束后才进入工程编辑队列。 */
function SchemaArrayInput({ schema, value, label, disabled, onChange, t }: { schema: MotionSchema; value: unknown; label: string; disabled: boolean; onChange: (value: unknown) => Promise<string | null> | void; t: T }) {
  const scope = React.useContext(MotionDraftScope);
  const draftKey = `${scope}:${label}`;
  const [draft, setDraft] = React.useState<{ value: unknown } | null>(() => rowDrafts.get(draftKey) ?? null);
  const changeDraft = (next: { value: unknown } | null) => { if (next) rowDrafts.set(draftKey, next); else rowDrafts.delete(draftKey); setDraft(next); };
  const [failure, setFailure] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const values = Array.isArray(value) ? value : [];
  const item = (i: number) => (Array.isArray(schema.items) ? schema.items[i] : schema.items) ?? { type: 'number' };
  const tuple = Array.isArray(schema.items) || (schema.maxItems != null && schema.maxItems === schema.minItems && schema.maxItems <= 4);
  return <div className="min-w-0 space-y-1" role="group" aria-label={label}>
    <div className={tuple ? 'grid grid-cols-2 gap-1' : 'space-y-2'}>{values.map((entry, i) => <div key={i} className={tuple ? 'min-w-0' : 'min-w-0 rounded-[5px] border border-[var(--border)] p-1.5'}>
      {!tuple ? <div className="flex items-center justify-between text-[10px] text-[var(--text-faint)]"><span>{t('motion.tableRow')} {i + 1}</span><button type="button" className={HEAD_BTN} disabled={disabled || values.length <= (schema.minItems ?? 0)} aria-label={`${t('motion.remove')} ${label} ${i + 1}`} onClick={() => onChange(values.filter((_, at) => at !== i))}><Trash2 size={11} /></button></div> : null}
      <SchemaInput schema={item(i)} value={entry} label={`${label} ${i + 1}`} disabled={disabled} onChange={(next) => onChange(values.map((old, at) => at === i ? next : old))} t={t} />
    </div>)}</div>
    {draft ? <div className="space-y-1 rounded-[5px] border border-[var(--accent)] p-1.5">
      <span className="text-[10px] text-[var(--text-faint)]">{t('motion.newRow')}</span>
      <SchemaInput schema={item(values.length)} value={draft.value} label={`${label} ${t('motion.newRow')}`} disabled={disabled} onChange={(next) => { changeDraft({ value: next }); setFailure(null); }} t={t} />
      {failure ? <p role="alert" className="text-[10px] text-[var(--text-muted)]">{failure}</p> : null}
      <div className="flex items-center gap-3 text-[10px]"><button type="button" disabled={disabled || saving} className="text-[var(--accent)]" onClick={() => {
        const next = [...values, draft.value]; const problems = validateSchemaValue(next, schema, label);
        if (problems.length) { setFailure(problems.join('\n')); return; }
        setSaving(true); setFailure(null);
        // 服务端确认后才丢弃草稿；冲突、校验和网络失败均保留可重试输入。
        void Promise.resolve(onChange(next)).then((error) => { if (error) setFailure(error); else changeDraft(null); }).catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error))).finally(() => setSaving(false));
      }}>{t(saving ? 'motion.pending' : 'motion.saveRow')}</button><button type="button" className="text-[var(--text-muted)]" onClick={() => { changeDraft(null); setFailure(null); }}>{t('motion.cancelRow')}</button></div>
    </div> : !tuple ? <button type="button" disabled={disabled || values.length >= (schema.maxItems ?? 1000)} className="flex items-center gap-1 text-[10px] text-[var(--accent)] disabled:opacity-40" onClick={() => changeDraft({ value: schemaDefault(item(values.length)) })}><Plus size={11} />{t('motion.addRow')}</button> : null}
  </div>;
}

function TextInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => Promise<string | null> | void }) {
  const [raw, setRaw] = React.useState(value); const escape = React.useRef(false);
  React.useEffect(() => setRaw(value), [value]);
  return <div className={FIELD}><input aria-label={label} value={raw} className={`${INPUT} pl-2`} onChange={(event) => setRaw(event.target.value)} onBlur={() => { if (escape.current) { escape.current = false; return; } if (raw !== value) onChange(raw); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur(); if (event.key === 'Escape') { escape.current = true; setRaw(value); event.currentTarget.blur(); } }} /></div>;
}

function ClockEditor({ track, onChange, t }: { track: MotionTrack; onChange: (clock: MotionTrack['clock']) => void; t: T }) {
  const clock = track.clock ?? {};
  return <div className="grid grid-cols-2 gap-1 border-t border-[var(--border)] pt-1" title={t('motion.clockHint')}>
    <NumField label={t('motion.offset')} word prefix={t('motion.offset')} value={clock.offset ?? 0} step={0.1} unit="s" onCommit={(offset) => onChange({ ...clock, offset })} />
    <NumField label={t('motion.speed')} word prefix={t('motion.speed')} value={clock.speed ?? 1} min={0.001} max={100} step={0.1} unit="×" onCommit={(speed) => onChange({ ...clock, speed })} />
    <NumField label={t('motion.duration')} word prefix={t('motion.duration')} value={clock.duration ?? Math.max(0.1, ...track.keyframes.map((frame) => frame.t))} min={0.001} step={0.1} unit="s" onCommit={(duration) => onChange({ ...clock, duration })} />
    <select aria-label={t('motion.loop')} value={clock.loop ?? ''} className={`${FIELD} px-1 text-[10px] text-[var(--text)]`} onChange={(event) => onChange(motionLoopClock(track, event.target.value as '' | 'repeat' | 'pingpong'))}><option value="">{t('motion.none')}</option><option value="repeat">{t('motion.repeat')}</option><option value="pingpong">{t('motion.pingpong')}</option></select>
  </div>;
}

function KeyframeEditor({ track, schema, label, sourceTime, duration, stepOnly, onTrack, onSeek, t }: { stepOnly: boolean; track: MotionTrack; schema: MotionSchema; label: string; sourceTime: number; duration: number; onTrack: (track: MotionTrack | null) => void; onSeek: (sourceTime: number) => void; t: T }) {
  const [selected, setSelected] = React.useState(0);
  const dragged = React.useRef(false);
  const frames = track.keyframes;
  const localTime = trackTime(track, sourceTime);
  const index = Math.min(selected, Math.max(0, frames.length - 1));
  const frame = frames[index];
  const maxTime = Math.max(0.1, track.clock?.duration ?? duration, ...frames.map((key) => key.t));
  const write = (next: MotionKeyframe) => { const changed = withKeyframe(track, next, index); setSelected(changed.keyframes.findIndex((key) => key.t === Math.round(next.t * 1000) / 1000)); onTrack(changed); };
  return <div className="space-y-1">
    <div className="relative h-7 rounded bg-[var(--bg)]" role="group" aria-label={`${label}: ${t('motion.keyframe')}`}>
      <span className="pointer-events-none absolute bottom-0 top-0 w-px bg-[var(--text-faint)]" style={{ left: `${Math.min(100, Math.max(0, localTime / maxTime * 100))}%` }} />
      {frames.map((key, i) => <button key={`${key.t}:${i}`} type="button" className={`absolute top-1.5 -translate-x-1/2 touch-none ${i === index ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`} style={{ left: `clamp(7px, ${key.t / maxTime * 100}%, calc(100% - 7px))` }} aria-label={`${label}: ${t('motion.keyframe')} ${i + 1}, ${key.t} s`} aria-pressed={i === index} onClick={() => { if (dragged.current) { dragged.current = false; return; } setSelected(i); onSeek(key.t); }} onPointerDown={(event) => {
        if (event.button !== 0) return;
        dragged.current = false;
        const rect = event.currentTarget.parentElement!.getBoundingClientRect(); const startX = event.clientX; const original = key.t;
        event.currentTarget.setPointerCapture(event.pointerId); setSelected(i);
        const button = event.currentTarget;
        const move = (moveEvent: PointerEvent) => { button.style.left = `${Math.min(100, Math.max(0, (original / maxTime + (moveEvent.clientX - startX) / rect.width) * 100))}%`; };
        const finish = (up: PointerEvent) => { button.removeEventListener('pointermove', move); button.removeEventListener('pointerup', finish); button.removeEventListener('pointercancel', cancel); const next = Math.max(0, Math.min(maxTime, original + (up.clientX - startX) / rect.width * maxTime)); if (Math.abs(up.clientX - startX) > 2) { dragged.current = true; const changed = withKeyframe(track, { ...key, t: next }, i); setSelected(changed.keyframes.findIndex((entry) => entry.t === Math.round(next * 1000) / 1000)); onTrack(changed); onSeek(next); } };
        const cancel = () => { button.removeEventListener('pointermove', move); button.removeEventListener('pointerup', finish); button.removeEventListener('pointercancel', cancel); button.style.left = `clamp(7px, ${original / maxTime * 100}%, calc(100% - 7px))`; };
        button.addEventListener('pointermove', move); button.addEventListener('pointerup', finish); button.addEventListener('pointercancel', cancel);
      }}><Diamond size={13} fill={i === index ? 'currentColor' : 'none'} /></button>)}
    </div>
    {frame ? <>
      <div className="grid grid-cols-[minmax(0,1fr)_24px] gap-1"><NumField label={`${label}: ${t('motion.time')}`} word prefix={t('motion.time')} value={frame.t} min={0} step={0.1} unit="s" onCommit={(time) => write({ ...frame, t: time })} /><button type="button" className={HEAD_BTN} aria-label={`${t('motion.remove')} ${t('motion.keyframe')}`} onClick={() => onTrack(frames.length === 1 ? null : { ...track, keyframes: frames.filter((_, at) => at !== index) })}><Trash2 size={12} /></button></div>
      <SchemaInput schema={schema} value={frame.value} label={`${label}: ${t('motion.value')}`} onChange={(value) => write({ ...frame, value })} t={t} />
      <select aria-label={`${label}: ${t('motion.easing')}`} value={Array.isArray(frame.ease) ? 'custom' : frame.ease ?? 'linear'} className={`${FIELD} px-1 text-[10px] text-[var(--text)]`} onChange={(event) => write({ ...frame, ease: event.target.value === 'custom' ? [0.25, 0.1, 0.25, 1] : event.target.value as MotionEase })}>{EASES.map((ease) => <option key={ease} value={ease} disabled={stepOnly && ease !== 'step'}>{t(`motion.${ease}`)}</option>)}</select>
      <svg viewBox="0 0 160 64" role="img" aria-label={t('motion.curve')} className="h-16 w-full overflow-visible rounded bg-[var(--bg)]"><path d="M8 8 V56 H152" fill="none" stroke="var(--border)" /><path d={Array.from({ length: 41 }, (_, i) => `${i ? 'L' : 'M'}${8 + i / 40 * 144},${56 - curveProgress(frame.ease, i / 40) * 48}`).join(' ')} fill="none" stroke="var(--accent)" strokeWidth="1.5" /></svg>
      {Array.isArray(frame.ease) ? <div className="grid grid-cols-2 gap-1">{frame.ease.map((value, i) => <NumField key={i} label={`${t('motion.curve')} ${['x1', 'y1', 'x2', 'y2'][i]}`} prefix={['x1', 'y1', 'x2', 'y2'][i]} value={value} step={0.05} {...(i % 2 === 0 ? { min: 0, max: 1 } : {})} onCommit={(next) => { const ease = [...(frame.ease as number[])] as [number, number, number, number]; ease[i] = next; write({ ...frame, ease }); }} />)}</div> : null}
    </> : null}
  </div>;
}
