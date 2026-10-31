import { useEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { useUi } from '../app/ui.ts';

// 透传其余 props：不给的话 data-testid 这类属性会被静默吞掉，测试就只能靠文案猜
export function Card({ title, desc, actions, children, className = '', ...rest }: {
  title?: ReactNode; desc?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string;
} & HTMLAttributes<HTMLElement>) {
  return (
    <section className={`card ${className}`} {...rest}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h3 className="card-title">{title}</h3>}
          {desc && <span className="card-desc">{desc}</span>}
          <span className="spacer" />
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ num, label, hint }: { num: ReactNode; label: string; hint?: string }) {
  return (
    <div className="stat" title={hint}>
      <div className="stat-num">{num}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/** data-testid 之类的属性要透传，否则界面上找不到锚点、自动化也点不到 */
export function Chip({
  children,
  tone = '',
  ...rest
}: { children: ReactNode; tone?: '' | 'ok' | 'warn' | 'danger' | 'info' | 'accent' } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={`chip ${tone ? `chip-${tone}` : ''}`} {...rest}>
      {children}
    </span>
  );
}

export function Bar({ value }: { value: number }) {
  return (
    <div className="bar" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export function Empty({ title, desc, action }: { title: string; desc?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {desc && <div className="small">{desc}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: {
  value: T; onChange: (v: T) => void; items: { id: T; label: string }[];
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <button key={it.id} className="tab" role="tab" aria-selected={value === it.id} onClick={() => onChange(it.id)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="row muted" style={{ padding: 16 }}>
      <span className="spin" /> {label ?? '载入中…'}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="card" style={{ borderColor: 'var(--danger)' }}>
      <div className="row">
        <strong style={{ color: 'var(--danger)' }}>出错了</strong>
        <span className="spacer" />
        {onRetry && <button className="btn btn-sm" onClick={onRetry}>重试</button>}
      </div>
      <div className="small mono" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{msg}</div>
    </div>
  );
}

/** 弹层：Esc 关闭 + 点遮罩关闭 + 焦点回到触发者 */
export function Overlay({ onClose, children, align = 'center' }: {
  onClose: () => void; children: ReactNode; align?: 'center' | 'right';
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className={`overlay ${align === 'right' ? 'overlay-right' : 'overlay-center'}`}
      ref={ref}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

export function Sheet({ title, desc, onClose, footer, wide, children }: {
  title: string; desc?: string; onClose: () => void; footer?: ReactNode; wide?: boolean; children: ReactNode;
}) {
  return (
    <div className="sheet" style={wide ? { width: 'min(860px, 96vw)' } : undefined} role="dialog" aria-modal="true" aria-label={title}>
      <div className="sheet-head">
        <h3 className="card-title">{title}</h3>
        {desc && <span className="card-desc">{desc}</span>}
        <span className="spacer" />
        <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="关闭" data-testid="sheet-close">✕</button>
      </div>
      <div className="sheet-body">{children}</div>
      {footer && <div className="sheet-foot">{footer}</div>}
    </div>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  if (!toasts.length) return null;
  // 屏幕阅读器要能听见「保存成功 / 撞车了」。成功走 polite，错误走 assertive（role=alert）。
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind === 'err' ? 'toast-err' : t.kind === 'ok' ? 'toast-ok' : ''}`}
          role={t.kind === 'err' ? 'alert' : 'status'}
          aria-live={t.kind === 'err' ? 'assertive' : 'polite'}
          onClick={() => dismiss(t.id)}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function fmtDate(s?: string): string {
  if (!s) return '';
  return s.slice(0, 10);
}

export function fmtTime(s?: string): string {
  if (!s) return '';
  return s.slice(11, 16);
}

export function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
