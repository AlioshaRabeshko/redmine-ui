import { useEffect, useRef, type ReactNode } from 'react';
import { X, CircleHelp, Check, AlertCircle, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Person } from '../../shared/types';

let modalCount = 0;

export function Avatar({ person, size = 'md', muted = false }: { person?: Person; size?: 'xs' | 'sm' | 'md' | 'lg'; muted?: boolean }) {
  const { t } = useTranslation();
  const roles = person?.roles || [];
  const failedImage = useRef<string | undefined>(undefined);
  const initials = (person?.name || '?').trim().split(/\s+/).slice(0, 2).map((v) => v[0]).join('').toUpperCase();
  const label = [person?.name, ...roles.map(role => t(`role_${role}`))].filter(Boolean).join(' · ');
  return <span className={`avatar avatar-${size}${muted ? ' avatar-muted' : ''}${roles.length ? ` avatar-role-${roles[0]}` : ''}${roles.length > 1 ? ' avatar-multiple-roles' : ''}`} title={label} aria-label={label}>
    <span className="avatar-initials">{initials}</span>{person?.avatar && failedImage.current !== person.avatar && <img src={person.avatar} alt="" onError={(event) => { failedImage.current = person.avatar; event.currentTarget.style.display = 'none'; }} />}
  </span>;
}

export function Button({ children, variant = 'quiet', size = 'md', disabled, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'quiet' | 'outline' | 'danger' | 'soft'; size?: 'sm' | 'md' }) {
  return <button type="button" className={`button button-${variant} button-${size} ${className}`} disabled={disabled} {...props}>{children}</button>;
}

export function IconButton({ label, children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

export function Modal({ title, eyebrow, children, onClose, size = 'md', testId, className = '' }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; size?: 'sm' | 'md' | 'lg'; testId?: string; className?: string }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef(typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previouslyFocused = previouslyFocusedRef.current;
    const timer = window.setTimeout(() => {
      if (!dialog.current || dialog.current.contains(document.activeElement)) return;
      const first = dialog.current.querySelector<HTMLElement>('[data-autofocus], input:not(:disabled), textarea:not(:disabled), button:not(:disabled)');
      (first || dialog.current).focus();
    }, 0);
    const onKeyDown = (event: KeyboardEvent) => {
      const openDialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')];
      const isTop = openDialogs[openDialogs.length - 1] === dialog.current;
      if (!isTop || event.defaultPrevented || document.querySelector('[data-workspace-popover]')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); }
      if (event.key === 'Tab' && dialog.current) {
        const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')];
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    modalCount += 1;
    document.body.classList.add('modal-open');
    return () => { window.clearTimeout(timer); document.removeEventListener('keydown', onKeyDown); modalCount = Math.max(0, modalCount - 1); if (modalCount === 0) document.body.classList.remove('modal-open'); previouslyFocused?.focus?.(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`modal modal-${size} ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialog} data-testid={testId}>
      <div className="modal-heading">
        <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2></div>
        <IconButton label={t('close')} onClick={onClose}><X size={18} /></IconButton>
      </div>
      {children}
    </div>
  </div>;
}

export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return <label className={`field ${className}`}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}

export function Notice({ tone = 'info', children, className = '' }: { tone?: 'info' | 'warning' | 'success' | 'error'; children: ReactNode; className?: string }) {
  const Icon = tone === 'success' ? Check : tone === 'warning' || tone === 'error' ? AlertCircle : CircleHelp;
  return <div className={`notice notice-${tone} ${className}`}><Icon size={16} aria-hidden="true" /><span>{children}</span></div>;
}

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner-wrap"><LoaderCircle className="spinner" size={18} aria-hidden="true" />{label && <span>{label}</span>}</span>;
}

export function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  const { t } = useTranslation();
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { timer.current = window.setTimeout(onClose, 3400); return () => window.clearTimeout(timer.current); }, [onClose]);
  return <div className="toast" role="status"><span>{text}</span><IconButton label={t('close')} onClick={onClose}><X size={15} /></IconButton></div>;
}

/** Route an explicit save to the active top form, never a remembered card or comment. */
export function dispatchActiveFormSave(target: Element | null): boolean {
  const modals = [...document.querySelectorAll<HTMLElement>('.modal[aria-modal="true"]')];
  const scope = modals.at(-1) || document.querySelector<HTMLElement>('.content-scroll');
  if (!scope) return false;
  const focused = target?.closest<HTMLElement>('[data-workspace-save]');
  const form = focused && scope.contains(focused) ? focused : scope.querySelector<HTMLElement>('[data-workspace-save]');
  if (!form) return false;
  form.dispatchEvent(new CustomEvent('workspace:save-form', { bubbles: true, cancelable: true, detail: { target } }));
  return true;
}
