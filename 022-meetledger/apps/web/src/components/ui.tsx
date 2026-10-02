import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Link, NavLink, type LinkProps } from 'react-router-dom';
import { Icon, type IconName } from './Icon';
import { useI18n } from '../i18n';
import { ApiError, NetworkError, errorMessage } from '../lib/api';
import type { ApiState } from '../lib/hooks';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean; icon?: IconName }) {
  return (
    <button
      type="button"
      {...rest}
      className={`btn btn-${variant} btn-${size}${className ? ` ${className}` : ''}`}
      disabled={rest.disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="spinner spinner-sm" aria-hidden="true" /> : icon ? <Icon name={icon} size={size === 'sm' ? 16 : 18} /> : null}
      {children !== undefined && children !== null && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ icon, label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button type="button" {...rest} className={`icon-btn${className ? ` ${className}` : ''}`} aria-label={label} title={label}>
      <Icon name={icon} />
    </button>
  );
}

export function LinkButton({ variant = 'secondary', size = 'md', icon, children, className, ...rest }: LinkProps & { variant?: Variant; size?: 'sm' | 'md'; icon?: IconName }) {
  return (
    <Link {...rest} className={`btn btn-${variant} btn-${size}${className ? ` ${className}` : ''}`}>
      {icon && <Icon name={icon} size={size === 'sm' ? 16 : 18} />}
      <span>{children}</span>
    </Link>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
  candidate,
  headingLevel = 2,
  id,
  footer,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  candidate?: boolean;
  headingLevel?: 2 | 3 | 4;
  id?: string;
  footer?: ReactNode;
}) {
  const H = `h${headingLevel}` as 'h2';
  return (
    <section className={`card${candidate ? ' card-candidate' : ''}${className ? ` ${className}` : ''}`} id={id} aria-labelledby={title && id ? `${id}-title` : undefined}>
      {(title || actions) && (
        <header className="card-header">
          {title && (
            <H className="card-title" id={id ? `${id}-title` : undefined}>
              {title}
            </H>
          )}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
      {footer && <footer className="card-footer">{footer}</footer>}
    </section>
  );
}

export type Tone = 'neutral' | 'info' | 'success' | 'warn' | 'danger' | 'candidate' | 'ai' | 'sample' | 'primary';

export function Badge({ tone = 'neutral', children, title, icon }: { tone?: Tone; children: ReactNode; title?: string; icon?: IconName }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

export function AiBadge() {
  const { t } = useI18n();
  return (
    <Badge tone="ai" icon="sparkle" title={t('ai.label.title')}>
      {t('ai.label')}
    </Badge>
  );
}

export function CandidateBadge() {
  const { t } = useI18n();
  return (
    <Badge tone="candidate" title={t('candidate.title')}>
      {t('candidate.label')}
    </Badge>
  );
}

export function SampleBadge() {
  const { t } = useI18n();
  return <Badge tone="sample">{t('sample.label')}</Badge>;
}

// ------------------------------------------------------------------ form fields
interface FieldShell {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  required?: boolean;
}

function FieldWrap({ id, label, hint, error, className, required, children }: FieldShell & { id: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className={`field${error ? ' field-error' : ''}${className ? ` ${className}` : ''}`}>
      <label htmlFor={id} className="field-label">
        {label}
        {required && <span className="req"> {t('form.required')}</span>}
      </label>
      {children}
      {hint && (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-msg" id={`${id}-err`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextField({ label, hint, error, className, ...rest }: FieldShell & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const id = rest.id ?? auto;
  return (
    <FieldWrap id={id} label={label} hint={hint} error={error} className={className} required={rest.required}>
      <input
        {...rest}
        id={id}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={[hint ? `${id}-hint` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined}
      />
    </FieldWrap>
  );
}

export function TextArea({ label, hint, error, className, ...rest }: FieldShell & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const id = rest.id ?? auto;
  return (
    <FieldWrap id={id} label={label} hint={hint} error={error} className={className} required={rest.required}>
      <textarea
        {...rest}
        id={id}
        className="input textarea"
        aria-invalid={error ? true : undefined}
        aria-describedby={[hint ? `${id}-hint` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined}
      />
    </FieldWrap>
  );
}

export function SelectField({
  label,
  hint,
  error,
  className,
  options,
  ...rest
}: FieldShell & SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string; disabled?: boolean }[] }) {
  const auto = useId();
  const id = rest.id ?? auto;
  return (
    <FieldWrap id={id} label={label} hint={hint} error={error} className={className} required={rest.required}>
      <select {...rest} id={id} className="input select" aria-describedby={hint ? `${id}-hint` : undefined}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldWrap>
  );
}

export function Checkbox({ label, hint, className, ...rest }: { label: ReactNode; hint?: ReactNode; className?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const id = rest.id ?? auto;
  return (
    <div className={`check${className ? ` ${className}` : ''}`}>
      <input type="checkbox" {...rest} id={id} aria-describedby={hint ? `${id}-hint` : undefined} />
      <label htmlFor={id}>
        {label}
        {hint && (
          <span className="field-hint" id={`${id}-hint`}>
            {hint}
          </span>
        )}
      </label>
    </div>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange(v: boolean): void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="toggle-row">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={hint ? `${id}-h` : undefined}
        className="switch"
        onClick={() => onChange(!checked)}
        disabled={disabled}
      >
        <span className="switch-knob" />
      </button>
      <div>
        <span id={`${id}-l`} className="toggle-label">
          {label}
        </span>
        {hint && (
          <p id={`${id}-h`} className="field-hint">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

export function RadioGroup<T extends string>({
  legend,
  value,
  onChange,
  options,
  name,
  hint,
  inline,
}: {
  legend: ReactNode;
  value: T | '';
  onChange(v: T): void;
  options: { value: T; label: ReactNode; hint?: ReactNode; disabled?: boolean }[];
  name?: string;
  hint?: ReactNode;
  inline?: boolean;
}) {
  const auto = useId();
  const n = name ?? auto;
  return (
    <fieldset className={`radio-group${inline ? ' radio-inline' : ''}`}>
      <legend className="field-label">{legend}</legend>
      {hint && <p className="field-hint">{hint}</p>}
      {options.map((o) => (
        <label key={o.value} className={`radio${value === o.value ? ' radio-checked' : ''}${o.disabled ? ' radio-disabled' : ''}`}>
          <input type="radio" name={n} value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} />
          <span>
            <span className="radio-label">{o.label}</span>
            {o.hint && <span className="field-hint">{o.hint}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

// ------------------------------------------------------------------ status views
export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label ?? t('common.loading')}</span>
    </div>
  );
}

export function EmptyState({ title, body, action, icon = 'inbox' }: { title: ReactNode; body?: ReactNode; action?: ReactNode; icon?: IconName }) {
  return (
    <div className="empty">
      <Icon name={icon} size={28} />
      <p className="empty-title">{title}</p>
      {body && <p className="empty-body">{body}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function ErrorView({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const { t } = useI18n();
  let title = t('error.generic');
  let body: string | null = errorMessage(error);
  if (error instanceof NetworkError) {
    title = t('error.offline');
    body = t('error.offline.body');
  } else if (error instanceof ApiError && error.status === 404) {
    title = t('error.notAvailable');
    body = t('error.notAvailable.body');
  } else if (error instanceof ApiError && error.status === 403) {
    title = t('error.forbidden');
  }
  return (
    <div className={`alert alert-warn${compact ? ' alert-compact' : ''}`} role="alert">
      <Icon name="alert" />
      <div>
        <p className="alert-title">{title}</p>
        {body && <p className="alert-body">{body}</p>}
        {onRetry && (
          <Button size="sm" variant="ghost" icon="sync" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        )}
      </div>
    </div>
  );
}

export function Alert({ tone = 'info', title, children, icon }: { tone?: 'info' | 'warn' | 'danger' | 'success'; title?: ReactNode; children?: ReactNode; icon?: IconName }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon name={icon ?? (tone === 'success' ? 'check' : tone === 'info' ? 'info' : 'alert')} />
      <div>
        {title && <p className="alert-title">{title}</p>}
        {children && <div className="alert-body">{children}</div>}
      </div>
    </div>
  );
}

export function CachedNotice({ at }: { at: string | null }) {
  const { t, fmt } = useI18n();
  if (!at) return null;
  return (
    <p className="cached-notice" role="status">
      <Icon name="offline" size={14} /> {t('offline.cachedAt', { time: fmt.dateTime(at) })}
    </p>
  );
}

/** Renders loading / error / data for a useApi state. */
export function Async<T>({ state, children, empty }: { state: ApiState<T>; children: (data: T) => ReactNode; empty?: (data: T) => boolean }) {
  if (state.loading && state.data === undefined) return <Loading />;
  if (state.error && state.data === undefined) return <ErrorView error={state.error} onRetry={state.reload} />;
  if (state.data === undefined) return null;
  return (
    <>
      <CachedNotice at={state.cachedAt} />
      {empty && empty(state.data) ? null : children(state.data)}
    </>
  );
}

export function ProgressBar({ value, max = 100, label }: { value: number; max?: number; label: string }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
      <div className="progress-bar" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, badges }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; badges?: ReactNode }) {
  return (
    <div className="page-header">
      <div className="page-header-text">
        <h1 className="page-title">{title}</h1>
        {badges && <div className="badges">{badges}</div>}
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ dialog
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { t } = useI18n();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus], input, select, textarea, button:not([data-close])');
    (first ?? el)?.focus();
    document.body.classList.add('modal-open');
    return () => {
      document.body.classList.remove('modal-open');
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && dismissible) {
      e.stopPropagation();
      onClose();
    }
    if (e.key === 'Tab' && ref.current) {
      const f = Array.from(ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'));
      if (!f.length) return;
      const firstEl = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        firstEl.focus();
      }
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && dismissible && onClose()}>
      <div className={`modal modal-${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1} onKeyDown={onKey}>
        <header className="modal-header">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          {dismissible && <IconButton icon="x" label={t('common.close')} onClick={onClose} data-close />}
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ popover
export function Popover({
  label,
  icon,
  children,
  align = 'right',
  buttonClassName,
  buttonContent,
  buttonLabel,
}: {
  label: string;
  icon?: IconName;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  buttonClassName?: string;
  buttonContent?: ReactNode;
  /** Accessible name of the trigger when its visible content is not descriptive. */
  buttonLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div className="popover-wrap" ref={ref} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        className={buttonClassName ?? 'icon-btn'}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={id}
        aria-label={buttonLabel ?? (buttonContent ? undefined : label)}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        {buttonContent ?? (icon ? <Icon name={icon} /> : label)}
      </button>
      {open && (
        <div className={`popover popover-${align}`} id={id} role="dialog" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ tabs
export function Tabs<T extends string>({ tabs, active, onChange, label }: { tabs: { id: T; label: ReactNode; count?: number }[]; active: T; onChange(id: T): void; label: string }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: KeyboardEvent, idx: number) => {
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    onChange(tabs[next].id);
    refs.current[tabs[next].id]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          ref={(el) => {
            refs.current[tab.id] = el;
          }}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={active === tab.id}
          aria-controls={`panel-${tab.id}`}
          tabIndex={active === tab.id ? 0 : -1}
          className={`tab${active === tab.id ? ' tab-active' : ''}`}
          onClick={() => onChange(tab.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {tab.label}
          {typeof tab.count === 'number' && <span className="tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} className="tab-panel">
      {children}
    </div>
  );
}

/** Route based tab navigation (each tab is a URL). */
export function TabNav({ items, label }: { items: { to: string; label: ReactNode; end?: boolean; badge?: ReactNode }[]; label: string }) {
  return (
    <nav className="tabnav" aria-label={label}>
      {items.map((it) => (
        <NavLink key={it.to} to={it.to} end={it.end} className={({ isActive }) => `tab${isActive ? ' tab-active' : ''}`}>
          {it.label}
          {it.badge}
        </NavLink>
      ))}
    </nav>
  );
}

export function KeyValue({ items }: { items: { k: ReactNode; v: ReactNode }[] }) {
  return (
    <dl className="kv">
      {items.map((it, i) => (
        <div className="kv-row" key={i}>
          <dt>{it.k}</dt>
          <dd>{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}

/** "n / total" + "もっと見る" for cursor-paged lists. Renders nothing when everything is shown. */
export function LoadMore({ shown, total, hasMore, loading, error, onMore }: { shown: number; total?: number; hasMore: boolean; loading?: boolean; error?: unknown; onMore(): void }) {
  const { t } = useI18n();
  if (!hasMore && (total === undefined || total <= shown)) return typeof total === 'number' && total > 0 ? <p className="list-count muted">{t('list.totalN', { n: total })}</p> : null;
  return (
    <div className="load-more-row">
      <span className="list-count muted" aria-live="polite">
        {typeof total === 'number' ? t('list.shownOfTotal', { shown, total }) : t('list.shownN', { n: shown })}
      </span>
      {hasMore && (
        <Button onClick={onMore} loading={loading} icon="chevronDown">
          {t('list.more')}
        </Button>
      )}
      {!!error && <span className="field-error">{errorMessage(error)}</span>}
    </div>
  );
}
