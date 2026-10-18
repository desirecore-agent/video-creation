/** 确认与通知共用的轻卡片；浮层、按钮及状态跟随 Studio 的宿主语义样式。 */
import React from 'react';
import { X } from 'lucide-react';
import { useT } from '@/i18n';

/** The shell of things that float up (menus, dropdowns): the card's shadow on the floating surface. */
export const POPOVER_CHROME: React.CSSProperties = {
  background: 'var(--modal-bg)',
  border: '0.5px solid var(--border-strong)',
  borderRadius: 'var(--host-radius-base, 10px)',
  boxShadow: 'var(--shadow-popover)',
  backdropFilter: 'blur(24px) saturate(1.3)',
};

export function Card({
  icon,
  title,
  body,
  onClose,
  children,
  role,
  className = '',
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  onClose?: () => void;
  children?: React.ReactNode;
  role?: React.AriaRole;
  className?: string;
}) {
  const t = useT();
  return (
    <div
      {...(role ? { role } : {})}
      className={`studio-card relative border border-[var(--card-border)] bg-[var(--card-bg)] px-3.5 pb-3 pt-3 ${className}`}
    >
      {onClose ? (
        <div className="absolute right-2 top-2 flex items-center gap-0.5">
          <button
            type="button"
            onClick={onClose}
            aria-label={t('project.close')}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-faint)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        </div>
      ) : null}
      <div className={`flex items-start gap-2 ${onClose ? 'pr-7' : ''}`}>
        {icon ? <span className="mt-[2px] shrink-0 text-[var(--text-muted)]">{icon}</span> : null}
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-medium leading-snug text-[var(--text)]">{title}</h3>
          {body ? <div className="mt-1 whitespace-pre-line break-words text-[12px] leading-relaxed text-[var(--text-muted)]">{body}</div> : null}
        </div>
      </div>
      {children}
    </div>
  );
}

export function CardActions({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`mt-3 flex items-center justify-end gap-2 ${className}`}>{children}</div>;
}

type Weight = 'primary' | 'secondary' | 'quiet' | 'danger';

const WEIGHT: Record<Weight, string> = {
  primary: 'studio-action',
  secondary: 'text-[var(--text)] ring-1 ring-inset ring-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
  quiet: 'text-[var(--text-muted)] hover:text-[var(--text)]',
  danger: 'bg-[var(--err)] text-white hover:brightness-110',
};

export const CardButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { weight?: Weight }
>(function CardButton({ weight = 'secondary', className = '', type = 'button', ...props }, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={`studio-button inline-flex h-8 shrink-0 items-center justify-center gap-1.5 px-3 outline-none disabled:pointer-events-none ${WEIGHT[weight]} ${className}`}
    />
  );
});
