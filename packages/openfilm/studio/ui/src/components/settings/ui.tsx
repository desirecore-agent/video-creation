/**
 * The parts every section of Settings is made of. A page reads like a document: titled groups with room between them,
 * and in each a list of rows parted by hairlines, each its title and what it does on the left, its control on the
 * right. Controls are quiet until pointed at: a choice of two or three is a segmented control, on/off a switch, a
 * longer list a select.
 */
import React from 'react';

/** A section's body: an optional note, then its groups. */
export function SettingsPage({ note, children }: { note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex max-w-[880px] flex-col">
      {note ? <p className="mb-6 text-[12px] leading-relaxed text-[var(--text-muted)]">{note}</p> : null}
      {children}
    </div>
  );
}

/** A titled group of rows; `footnote` goes under it. */
export function SettingsGroup({ title, footnote, children }: { title?: React.ReactNode; footnote?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-7 last:mb-0">
      {title ? <h3 className="mb-1 text-[14px] font-semibold tracking-[-0.01em] text-[var(--text)]">{title}</h3> : null}
      <div className="flex flex-col divide-y divide-[var(--border)]">{children}</div>
      {footnote ? <p className="pt-2 text-[11px] leading-relaxed text-[var(--text-faint)]">{footnote}</p> : null}
    </section>
  );
}

/** One row: a mark, a title (with a badge beside it), what it does, its control; `children` open under it. */
export function SettingsItem({ mark, title, badge, description, control, children }: {
  mark?: React.ReactNode;
  title: React.ReactNode;
  badge?: React.ReactNode;
  description?: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="py-3">
      <div className="flex min-h-8 flex-wrap items-center gap-3">
        {mark ? <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-[var(--fill-tsp)] text-[var(--text)]">{mark}</span> : null}
        <div className="min-w-[min(160px,100%)] flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[13px] text-[var(--text)]">{title}</span>
            {badge}
          </div>
          {description ? <div className="mt-1 text-[12px] leading-[1.55] text-[var(--text-muted)]">{description}</div> : null}
        </div>
        {control ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
      </div>
      {children ? <div className="pt-3">{children}</div> : null}
    </div>
  );
}

/** "Connected", with a green dot and whatever tells which connection it is. */
export function SettingsStatus({ tone = 'ok', children }: { tone?: 'ok' | 'muted'; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-muted)]">
      <span className={`h-1.5 w-1.5 rounded-full ${tone === 'ok' ? 'bg-[var(--ok)]' : 'bg-[var(--text-faint)]'}`} aria-hidden />
      {children}
    </span>
  );
}

const BUTTON = {
  default: 'border border-[var(--border)] text-[var(--text)] hover:bg-[var(--bg-hover)]',
  primary: 'studio-action border border-transparent',
  quiet: 'border border-transparent text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]',
};

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON };

export function SettingsButton({ variant = 'default', className = '', ...props }: ButtonProps) {
  return (
    <button type="button" {...props}
      className={`studio-button inline-flex h-8 shrink-0 items-center justify-center gap-1.5 px-3 disabled:pointer-events-none ${BUTTON[variant]} ${className}`} />
  );
}

/** A link that looks like a button (an install page, a key page). */
export function SettingsLinkButton({ className = '', ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a target="_blank" rel="noreferrer" {...props}
      className={`studio-button inline-flex h-8 shrink-0 items-center justify-center gap-1.5 px-3 ${BUTTON.default} ${className}`} />
  );
}

/** On or off. */
export function SettingsSwitch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={`relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-40 ${checked ? 'bg-[var(--action-solid)]' : 'bg-[var(--surface-3)]'}`}>
      <span className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-[var(--shadow-sm)] transition-[left,background-color] ${checked ? 'left-[19px]' : 'left-[3px]'}`} />
    </button>
  );
}

/** One of two or three, all in view: the chosen one raised out of a quiet track. */
export function SettingsSegmented<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; icon?: React.ReactNode }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 gap-0.5 rounded-[8px] bg-[var(--fill-tsp)] p-0.5">
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button key={option.value} type="button" role="radio" aria-checked={on} onClick={() => { if (!on) onChange(option.value); }}
            className={`inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2.5 text-[12px] transition-colors ${
              on ? 'bg-[var(--surface)] text-[var(--accent)] shadow-[var(--shadow-sm)] ring-1 ring-[var(--border)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}>
            {option.icon ? <span className="flex shrink-0">{option.icon}</span> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A text field. */
export const SettingsField = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function SettingsField({ className = '', ...props }, ref) {
  return (
    <input ref={ref} {...props}
      className={`studio-field h-8 w-full min-w-0 border border-[var(--border)] px-2.5 text-[13px] text-[var(--text)] outline-none transition placeholder:text-[var(--text-faint)] hover:border-[var(--border-strong)] focus:border-[var(--text-muted)] ${className}`} />
  );
});

/** A form that opened under a row. */
export function SettingsInset({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-2.5 rounded-[10px] border border-[var(--border)] p-4">{children}</div>;
}

export const settingsLink = 'inline-flex items-center gap-1 text-[var(--text-muted)] underline-offset-2 hover:text-[var(--text)] hover:underline';
export const settingsError = 'text-[12px] leading-relaxed text-[var(--err)]';
