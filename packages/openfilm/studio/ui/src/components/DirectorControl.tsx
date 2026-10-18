/** A source-bound, reviewable handoff to the platform's own confirmation surface. */
import React from 'react';
import { createPortal } from 'react-dom';
import { Clapperboard, Loader2, X } from 'lucide-react';
import { useT } from '@/i18n';
import { PRODUCT } from '@/lib/product';
import { DirectorBridgeError, directorHost, boundedStudioRef, type DirectorContext, type DirectorError } from '@/lib/desirecore-host';

export function DirectorControl({ context, className }: { context: () => DirectorContext; className?: string }) {
  const t = useT();
  const latest = React.useRef(context);
  latest.current = context;
  const draft = React.useSyncExternalStore(directorHost.subscribe, directorHost.get, directorHost.get);
  const [instruction, setInstruction] = React.useState('');
  const [state, setState] = React.useState<'idle' | 'preparing' | 'prepared'>('idle');
  const [error, setError] = React.useState<DirectorError | null>(null);
  const dialog = React.useRef<HTMLElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const preparing = React.useRef(false);
  const generation = React.useRef(draft.generation);
  generation.current = draft.generation;
  React.useEffect(() => directorHost.registerContext(() => latest.current()), []);
  React.useEffect(() => { setState(preparing.current ? 'preparing' : 'idle'); setError(null); }, [draft.generation]);
  React.useEffect(() => {
    if (!draft.open) return undefined;
    const previous = document.activeElement;
    dialog.current?.querySelector('textarea')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); directorHost.close(); }
      if (event.key !== 'Tab') return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled)') ?? [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); else trigger.current?.focus(); };
  }, [draft.open]);
  const name = (path: string) => t(path).replaceAll('{director}', PRODUCT.directorName);
  const prepare = async () => {
    if (!draft.context || preparing.current || state === 'prepared') return;
    const started = draft.generation;
    preparing.current = true;
    setState('preparing'); setError(null);
    try { await directorHost.prepare(draft.context, instruction); if (generation.current === started) setState('prepared'); }
    catch (cause) { if (generation.current === started) { setState('idle'); setError(cause instanceof DirectorBridgeError ? cause.code : 'prepare-failed'); } }
    finally { preparing.current = false; if (generation.current !== started) setState('idle'); }
  };
  return <>
    <button ref={trigger} type="button" data-selection-toolbar className={className} title={name('director.open')} aria-label={name('director.open')}
      aria-haspopup="dialog" onClick={() => directorHost.open(context())}>
      <Clapperboard size={15} /><span className="ml-1 hidden text-[11.5px] xl:inline">{name('director.open')}</span>
    </button>
    {draft.open ? createPortal(
      <div data-studio-host-panel className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/35 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) directorHost.close(); }}>
        <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="director-dialog-title" data-studio-host-panel
          className="studio-modal flex max-h-[85vh] w-full max-w-[600px] flex-col overflow-hidden text-[var(--text)]">
          <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-[var(--border-soft)] px-5">
            <Clapperboard size={17} /><h2 id="director-dialog-title" className="flex-1 text-[14px] font-semibold">{name('director.open')}</h2>
            <button type="button" aria-label={t('director.close')} onClick={directorHost.close} className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]"><X size={15} /></button>
          </header>
          <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4 text-[13px]">
            <p className="text-[var(--text-muted)]">{t('director.explanation')}</p>
            <label className="block space-y-2"><span>{t('director.instruction')}</span>
              <textarea rows={4} maxLength={16000} value={instruction} disabled={state !== 'idle'}
                onChange={(event) => setInstruction(event.target.value)} placeholder={t('director.placeholder')}
                className="studio-field w-full resize-y border border-[var(--border)] p-3 outline-none" />
            </label>
            <details className="rounded-lg border border-[var(--border-soft)] p-3">
              <summary className="cursor-pointer text-[var(--text-muted)]">{t('director.selection').replace('{n}', String(draft.context?.refs.length ?? 0))}</summary>
              {draft.context ? <div className="mt-2 max-h-40 space-y-2 overflow-auto break-words text-[12px] text-[var(--text-faint)]">
                <p>{t('director.project')}: {draft.context.projectPath}</p>
                <p>{t('director.playhead')}: {draft.context.time.toFixed(2)} {t('director.seconds')}
                  {draft.context.range ? ` · ${t('director.range')}: ${draft.context.range.start.toFixed(2)}–${draft.context.range.end.toFixed(2)} ${t('director.seconds')}` : ''}</p>
                {draft.context.refs.length ? <ul className="list-inside list-disc">{draft.context.refs.slice(0, 64).map((ref, index) => {
                  const fields = boundedStudioRef(ref);
                  return <li key={index}>{String(fields.label ?? fields.text ?? fields.path ?? fields.title ?? fields.id ?? `${fields.start ?? fields.time ?? draft.context!.time} ${t('director.seconds')}`)}</li>;
                })}</ul> : <p>{t('director.noReferences')}</p>}
              </div> : null}
            </details>
            {error ? <p role="alert" className="text-[var(--err)]">{name(`director.errors.${error}`)}</p> : null}
            {state === 'prepared' ? <p role="status" className="text-[var(--ok)]">{t('director.prepared')}</p> : null}
          </div>
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border-soft)] px-5 py-3">
            <button type="button" onClick={directorHost.close} className="studio-button px-3 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">{t('director.close')}</button>
            <button type="button" disabled={!instruction.trim() || state !== 'idle'} onClick={() => void prepare()}
              className="studio-button studio-action flex items-center gap-2 px-4">
              {state === 'preparing' ? <Loader2 size={14} className="animate-spin" /> : null}{t(state === 'preparing' ? 'director.preparing' : 'director.prepare')}
            </button>
          </footer>
        </section>
      </div>, document.body) : null}
  </>;
}
