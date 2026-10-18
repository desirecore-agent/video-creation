/** 构件库复用素材区；内置构件通过 Saved 依赖闭包导入，随后沿原时间线插入。 */
import * as React from 'react';
import { ChevronRight, Plus, RefreshCw, Shapes } from 'lucide-react';
import { api, type MotionCatalog, type MotionComponent } from '@/api';
import { useT } from '@/i18n';
import { HEAD_BTN } from './inspector-fields';

export function MotionLibrary({ projectId, filesTick, onInsert }: {
  projectId: string;
  filesTick: number;
  onInsert: (component: MotionComponent, rev: string) => Promise<string | null>;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const [catalog, setCatalog] = React.useState<MotionCatalog | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setFailure(null);
    void api.motionCatalog(projectId).then((next) => { if (live) setCatalog(next); }).catch((error: unknown) => { if (live) setFailure(error instanceof Error ? error.message : String(error)); });
    return () => { live = false; };
  }, [projectId, filesTick, tick, open]);
  const insert = (component: MotionComponent) => {
    if (!catalog || busy) return;
    setBusy(component.source === 'builtin' ? component.ref! : component.src); setFailure(null);
    void onInsert(component, catalog.rev).then((error) => { if (error) setFailure(error); else setTick((n) => n + 1); }).catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error))).finally(() => setBusy(null));
  };
  return <div data-motion-library className="shrink-0 border-b border-[var(--border)] px-2.5 pb-1.5 pt-1">
    <div className="flex h-7 items-center gap-1">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[11px] font-medium text-[var(--text)]"><ChevronRight size={12} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} /><Shapes size={13} /><span className="truncate">{t('motion.library')}</span></button>
      {open ? <button type="button" className={HEAD_BTN} aria-label={t('motion.refresh')} disabled={Boolean(busy)} onClick={() => setTick((n) => n + 1)}><RefreshCw size={11} /></button> : null}
    </div>
    {open ? <div className="max-h-60 space-y-1 overflow-y-auto pb-1">
      <p className="px-1 text-[10px] leading-4 text-[var(--text-faint)]">{t('motion.libraryHint')}</p>
      {failure ? <p role="alert" className="px-1 text-[10px] text-[var(--text)]">{failure}</p> : null}
      {!catalog && !failure ? <p role="status" className="px-1 text-[10px] text-[var(--text-faint)]">{t('motion.loading')}</p> : null}
      {catalog?.components.map((component) => <div key={`${component.source}:${component.ref ?? component.src}`} className="flex items-start gap-1 rounded-[7px] bg-[var(--fill-tsp)] px-2 py-1.5">
        <div className="min-w-0 flex-1"><p className="truncate text-[11px] text-[var(--text)]" title={component.manifest.name}>{component.manifest.name}</p><p className="line-clamp-2 text-[10px] leading-[14px] text-[var(--text-faint)]">{component.manifest.description}</p><span className="text-[9px] text-[var(--text-faint)]">{t(component.source === 'builtin' ? 'motion.builtin' : 'motion.project')}</span></div>
        <button type="button" className={HEAD_BTN} aria-label={`${t('motion.insert')}: ${component.manifest.name}`} title={t('motion.insert')} disabled={Boolean(busy)} onClick={() => insert(component)}><Plus size={13} /></button>
      </div>)}
      {catalog?.problems.length ? <details className="px-1 text-[10px] text-[var(--text-faint)]"><summary>{t('motion.invalidComponents')}</summary>{catalog.problems.map((problem, i) => <p key={i}>{typeof problem === 'string' ? problem : JSON.stringify(problem)}</p>)}</details> : null}
    </div> : null}
  </div>;
}
