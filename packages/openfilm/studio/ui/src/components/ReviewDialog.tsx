/** 围绕来源工程临时审片；编辑器保持挂载，关闭回到原按钮，不另造时间线或播放时钟。 */
import React from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/api';
import { useT } from '@/i18n';
import { pointsOf, reviewImage, type ReviewRecord, type ReviewSummary, type ReviewTarget, type ReviewPoint } from '@/lib/reviews';

export type ReviewSelection = { reviewId: string; pointKey: string; before?: string; after?: string; scrollTop?: number } | null;
export function ReviewDialog({ projectId, selection, onSelection, onClose, onEngineering, onMediaPlay }: {
  projectId: string; selection: ReviewSelection; onSelection: (s: ReviewSelection) => void; onClose: () => void;
  onEngineering: (point: ReviewPoint, isCurrent: () => boolean) => Promise<void>; onMediaPlay: (media: HTMLVideoElement) => void;
}) {
  const selectedSection = React.useRef<HTMLElement>(null), overview = React.useRef<HTMLDivElement>(null);
  const t = useT(), root = React.useRef<HTMLDivElement>(null), video = React.useRef<HTMLVideoElement>(null);
  const close = React.useRef(onClose); close.current = onClose;
  const generation = React.useRef(0);
  React.useEffect(() => () => { generation.current++; }, []);
  const [nextOffset, setNextOffset] = React.useState<number | null>(null);
  const [list, setList] = React.useState<ReviewSummary[]>([]), [record, setRecord] = React.useState<ReviewRecord | null>(null);
  const [pointKey, setPointKey] = React.useState(selection?.pointKey ?? ''), [target, setTarget] = React.useState<ReviewTarget | null>(null);
  const [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false), [zoom, setZoom] = React.useState(false);
  const [before, setBefore] = React.useState(selection?.before ?? ''), [after, setAfter] = React.useState(selection?.after ?? '');
  const [listNotice, setListNotice] = React.useState(false);
  const initialSelection = React.useRef(selection);
  const finishClose = () => { onSelection({ reviewId: record?.reviewId ?? selection?.reviewId ?? '', pointKey, before, after, scrollTop: overview.current?.scrollTop ?? 0 }); onClose(); };
  close.current = finishClose;
  React.useLayoutEffect(() => { if (record?.reviewId === initialSelection.current?.reviewId && overview.current) overview.current.scrollTop = initialSelection.current?.scrollTop ?? 0; }, [record?.reviewId]);
  const sourceName = (kind: string) => t(`review.source.${kind}`);
  const loadList = React.useCallback(async (offset = 0) => { const r = await api.reviews(projectId, offset); setList((old) => offset ? [...new Map([...old, ...r.reviews].map((r) => [r.reviewId, r])).values()] : r.reviews); setNextOffset(r.nextOffset); setListNotice(r.limited || r.unavailable > 0); return r.reviews; }, [projectId]);
  const open = async (id: string, key = '') => {
    const ticket = ++generation.current; setError(''); setTarget(null); setRecord(null);
    try { const r = await api.reviewRead(projectId, id); if (ticket !== generation.current) return; setRecord(r); const next = key || pointsOf(r)[0]?.key || ''; setPointKey(next); onSelection({ reviewId: id, pointKey: next }); }
    catch (e) { setError(String((e as Error).message)); }
  };
  React.useEffect(() => {
    let alive = true; const started = generation.current;
    void loadList().then((r) => { if (alive && generation.current === started && (selection?.reviewId || r[0]?.reviewId)) void open(selection?.reviewId ?? r[0].reviewId, selection?.pointKey); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [projectId]);
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null; root.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); return; }
      if (e.key !== 'Tab') return;
      const items = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),video') ?? [])];
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus(); };
  }, []);
  const points = record ? pointsOf(record) : [], point = points.find((p) => p.key === pointKey) ?? points[0];
  React.useEffect(() => {
    setTarget(null); if (!point) return;
    let alive = true;
    void api.reviewTarget(projectId, point.reviewId, point.kind, point.index).then((v) => { if (alive) setTarget(v); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [projectId, record?.reviewId, point?.key]);
  const seekVideo = () => { if (video.current && target?.playback?.canLocate && target.playback.time != null) video.current.currentTime = target.playback.time; };
  React.useEffect(seekVideo, [target?.reviewId, target?.point.actualTime]);
  const choosePoint = (p: ReviewPoint) => { generation.current++; setError(''); setPointKey(p.key); onSelection({ reviewId: record!.reviewId, pointKey: p.key }); selectedSection.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
  const pair = async () => {
    const ticket = ++generation.current; setBusy(true); setError('');
    try {
      const ref = (v: string) => { const [reviewId, index] = v.split(':'); return { reviewId, frameIndex: Number(index) }; };
      const r = await api.reviewCreate(projectId, { source: 'review-pair', before: ref(before), after: ref(after), maxEdge: 1280 });
      await loadList(); if (ticket !== generation.current) return; setRecord(r); const key = pointsOf(r)[0]?.key ?? ''; setPointKey(key); onSelection({ reviewId: r.reviewId, pointKey: key });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const options = list.flatMap((r) => r.frames.map((f) => ({ value: `${r.reviewId}:${f.index}`, label: `${sourceName(r.sourceKind)} · ${r.filmRevision?.slice(0, 8)} · ${f.actualTime.toFixed(3)}s` })));
  const BTN = 'rounded-md border border-[var(--border)] px-3 py-1.5 text-[13px] hover:bg-[var(--bg-hover)] disabled:opacity-40';
  return createPortal(<div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-3" onPointerDown={(e) => { if (e.target === e.currentTarget) finishClose(); }}>
    <div ref={root} role="dialog" aria-modal="true" aria-label={t('review.title')} className="flex max-h-[92vh] w-[min(1280px,96vw)] min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-xl">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] p-3"><h2 className="font-semibold">{t('review.title')}</h2><button type="button" className={BTN} onClick={finishClose}>{t('review.close')}</button></header>
      <div ref={overview} className="min-h-0 overflow-auto p-4">
        <div className="flex flex-wrap items-center gap-2"><label>{t('review.material')} <select aria-label={t('review.material')} className={BTN} value={record?.reviewId ?? ''} onChange={(e) => void open(e.target.value)}><option value="" disabled>{t('review.choose')}</option>{list.map((r) => <option key={r.reviewId} value={r.reviewId}>{sourceName(r.sourceKind)} · {r.filmRevision?.slice(0, 8) ?? t('review.pair')} · {new Date(r.createdAt).toLocaleString()}</option>)}</select></label><button type="button" className={BTN} onClick={() => void loadList().catch((e) => setError(e.message))}>{t('review.refresh')}</button></div>
        {nextOffset != null ? <button type="button" className={BTN} onClick={() => void loadList(nextOffset).catch((e) => setError(e.message))}>{t('review.older')}</button> : null}
        {listNotice ? <p className="mt-2 text-xs text-[var(--text-muted)]">{t('review.recentOnly')}</p> : null}
        {!list.length ? <p className="my-6 text-[var(--text-muted)]">{t('review.empty')}</p> : null}
        {error ? <p role="alert" className="my-3 text-[var(--text-muted)]">{error}</p> : null}
        {record ? <>
          <p className="my-3 text-xs text-[var(--text-muted)]">{sourceName(record.sourceKind)} · {record.filmRevision ?? t('review.independentVersions')}</p>
          {(record.artifacts ?? []).map((a) => <div key={a.artifactId} className="my-3 overflow-hidden rounded border border-[var(--border)]" style={{ maxWidth: a.width }}>
            {a.artifactId === 'revision-comparison' ? <><div className="grid grid-cols-2 gap-3 bg-[var(--surface-2)] p-3 text-xs">{a.derivedFrom.map((f, i) => <p key={i} title={f.sha256}>{t(i ? 'review.after' : 'review.before')} · {sourceName(f.sourceKind ?? '')}<br /><span className="font-mono">{f.filmRevision}</span><br />{f.actualTime?.toFixed(3)}s · {f.width}×{f.height}</p>)}</div><p className="p-2 text-xs text-[var(--text-muted)]">{t('review.pairNote')}</p></> : null}
            <div className="relative"><img onError={() => setError(t('review.imageChanged'))} src={reviewImage(projectId, record.reviewId, { artifactId: a.artifactId, sha256: a.sha256, width: a.width, height: a.height })} alt={t('review.artifact')} className="block h-auto w-full" />
            {a.artifactId === 'sequence' || a.artifactId === 'revision-comparison' ? a.layout.cells.map((c, i) => { const p = points.find((p) => p.key === (a.artifactId === 'sequence' ? `sequence:${i}` : `pair:${i}`)); return p ? <button key={i} type="button" aria-label={`${t('review.point')} ${i} · ${p.time.toFixed(3)}s`} title={`${p.time.toFixed(3)}s`} className="absolute border border-transparent hover:border-[var(--accent)] focus:border-[var(--accent)]" style={{ left: `${c.x / a.width * 100}%`, top: `${c.y / a.height * 100}%`, width: `${c.width / a.width * 100}%`, height: `${c.height / a.height * 100}%` }} onClick={() => choosePoint(p)} /> : null; }) : null}
          </div></div>)}
          <div className="my-3 flex flex-wrap gap-2">{points.map((p) => <button type="button" key={p.key} className={BTN} aria-pressed={point?.key === p.key} onClick={() => choosePoint(p)}>{p.time.toFixed(3)}s</button>)}</div>
          {point ? <section ref={selectedSection} className="my-4 rounded-lg border border-[var(--border)] p-3" aria-label={t('review.selectedPoint')}>
            <div className="mb-2 flex flex-wrap items-center gap-2"><button type="button" className={BTN} onClick={() => { if (overview.current) overview.current.scrollTop = 0; }}>{t('review.overview')}</button><span>{target ? `${sourceName(target.sourceKind)} · ${target.filmRevision} · ` : ''}{point.time.toFixed(3)}s · {point.width}×{point.height}</span><button type="button" className={BTN} onClick={() => setZoom(!zoom)}>{t(zoom ? 'review.fit' : 'review.zoom')}</button><button type="button" className={BTN} disabled={busy || !target || target.engineering.status === 'unavailable'} onClick={() => { const ticket = ++generation.current; setBusy(true); void onEngineering(point, () => ticket === generation.current).then(() => { if (ticket === generation.current) close.current(); }).catch((e) => setError(e.message)).finally(() => setBusy(false)); }}>{t('review.locateEngineering')}</button></div>
            <p className="mb-2 text-xs text-[var(--text-muted)]">{t('review.zoomNote')}</p>
            <div className="overflow-auto bg-black/20"><div style={{ width: zoom ? point.width * 2 : Math.min(point.width, 1000), maxWidth: zoom ? 'none' : '100%', aspectRatio: `${point.width}/${point.height}`, position: 'relative', overflow: 'hidden' }}>
              <img onError={() => setError(t('review.imageChanged'))} alt={t('review.selectedPoint')} src={reviewImage(projectId, record.reviewId, point.image)} style={point.image.cell ? { position: 'absolute', maxWidth: 'none', width: `${point.image.width / point.width * 100}%`, height: `${point.image.height / point.height * 100}%`, left: `${-point.image.cell.x / point.width * 100}%`, top: `${-point.image.cell.y / point.height * 100}%` } : { width: '100%', height: '100%', objectFit: 'contain' }} />
            </div></div>
            {target?.engineering.status === 'unavailable' ? <p className="mt-2 text-xs text-[var(--text-muted)]">{t(target.engineering.reason?.startsWith('current-inputs') ? 'review.engineeringChanged' : 'review.mappingUnknown')}</p> : null}
            {target?.playback ? <div className="mt-3"><p className="mb-2 text-xs text-[var(--text-muted)]">{t('review.outputPlayback')}</p><video key={target.playback.url} ref={video} src={target.playback.url} controls preload="metadata" className="max-h-[420px] w-full bg-black" onLoadedMetadata={seekVideo} onPlay={(e) => onMediaPlay(e.currentTarget)} onError={() => setError(t('review.mediaChanged'))} />{!target.playback.canLocate ? <p className="text-xs">{t('review.mediaOriginUnknown')}</p> : null}</div> : null}
          </section> : null}
          {!record.sourceFacts?.intents?.length && record.sourceKind !== 'review-pair' ? <p className="my-3 text-sm text-[var(--text-muted)]">{t('review.noIntent')}</p> : null}
          {(record.sourceFacts?.intents ?? []).map((intent) => <section key={intent.clipId} className="my-3 rounded border border-[var(--border)] p-3"><h3>{t('review.intent')} · {intent.clipId}</h3>{intent.status !== 'observed' ? <p>{t('review.intentInvalid')}</p> : <><p>{intent.value?.targetWidths?.join(' / ')} px</p>{intent.value?.text?.map((v, i) => <p key={i} className="mt-1 text-sm">{t(`review.role.${v.role}`)} · {v.description}{v.selector ? ` (${v.selector})` : ''}</p>)}<p className="mt-2 text-sm text-[var(--text-muted)]">{intent.value?.note}</p></>}</section>)}
          {record.artifacts.find((a) => a.differences)?.differences ? (() => { const diff = record.artifacts.find((a) => a.differences)!.differences!; return <section className="my-3 rounded border border-[var(--border)] p-3"><h3>{t('review.differences')}</h3><p>{t('review.fileChanges')}: {diff.files?.status === 'observed' ? diff.files.totalChanges : t('review.unknown')}</p>{diff.files?.changes?.map((v) => <p className="text-sm" key={v.path}>{v.path} · {t(`review.inputChange.${v.kind}`)}</p>)}<p className="mt-2">{t('review.preservedChanges')}: {diff.preservedData?.status === 'observed' ? diff.preservedData.totalChanges : t('review.unknown')}</p>{diff.preservedData?.changes?.map((v) => <p className="text-sm" key={v.field}>{v.field.split(':').slice(0, -1).join(':')} · {t(`review.field.${v.field.split(':').at(-1)}`)}</p>)}<p className="mt-2 text-xs text-[var(--text-muted)]">{t('review.differencesNote')}</p></section>; })() : null}
        </> : null}

      </div>
        <footer className="shrink-0 border-t border-[var(--border)] p-3"><h3 className="mb-2">{t('review.pair')}</h3><div className="flex flex-wrap gap-2"><select aria-label={t('review.before')} className={BTN} value={before} onChange={(e) => { setBefore(e.target.value); onSelection({ reviewId: record?.reviewId ?? '', pointKey, before: e.target.value }); }}><option value="">{t('review.before')}</option>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select><select aria-label={t('review.after')} className={BTN} value={after} onChange={(e) => { setAfter(e.target.value); onSelection({ reviewId: record?.reviewId ?? '', pointKey, after: e.target.value }); }}><option value="">{t('review.after')}</option>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select><button type="button" className={BTN} disabled={busy || !before || !after} onClick={() => void pair()}>{t(busy ? 'review.working' : 'review.makePair')}</button></div></footer>
    </div>
  </div>, document.body);
}
