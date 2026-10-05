import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { X, CircleHelp, Check, AlertCircle, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Person, PersonRole } from '../../shared/types';

let modalCount = 0;

export function Avatar({ person, size = 'md', muted = false, role }: { person?: Person; size?: 'xs' | 'sm' | 'md' | 'lg'; muted?: boolean; role?: PersonRole }) {
  const { t } = useTranslation();
  const roles = person?.roles || [];
  const labelledRoles = [...new Set([...(role ? [role] : []), ...roles])];
  const frameRole = role || roles[0];
  const [failedImage, setFailedImage] = useState<string | undefined>(undefined);
  useEffect(() => { setFailedImage(undefined); }, [person?.id, person?.avatar, person?.localEmoji]);
  const initials = initialsFor(person?.name || '?');
  const image = person?.avatar && failedImage !== person.avatar ? person.avatar : undefined;
  const emoji = !image ? person?.localEmoji : undefined;
  const label = [person?.name || t('noAssignee'), ...labelledRoles.map(item => t(`role_${item}`))].join(' · ');
  const fallbackStyle = person && !image && !emoji ? { '--avatar-hue': String(stableHue(person.id)) } as CSSProperties : undefined;
  return <span className={`avatar avatar-${size}${muted ? ' avatar-muted' : ''}${frameRole ? ` avatar-role-${frameRole}` : ''}${labelledRoles.length > 1 ? ' avatar-multiple-roles' : ''}${fallbackStyle ? ' avatar-fallback-color' : ''}`} style={fallbackStyle} data-person-id={person?.id} title={label} aria-label={label} role="img">
    <span className={emoji ? 'avatar-local-emoji' : 'avatar-initials'}>{emoji || initials}</span>{image && <img src={image} alt="" onError={() => setFailedImage(image)} />}
  </span>;
}

function stableHue(personId: number): number {
  let hash = 2166136261;
  for (const character of String(personId)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) % 360;
}

function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const firstWord = graphemes(words[0]);
  const initials = words.length > 1
    ? `${firstWord[0] || ''}${graphemes(words[1])[0] || ''}`
    : firstWord.slice(0, 2).join('');
  return initials.toLocaleUpperCase() || '?';
}

function graphemes(value: string): string[] {
  type Segment = { segment: string };
  type Segmenter = { segment(input: string): Iterable<Segment> };
  const IntlWithSegmenter = Intl as typeof Intl & {
    Segmenter?: new (locales?: string | string[], options?: { granularity: 'grapheme' }) => Segmenter;
  };
  if (IntlWithSegmenter.Segmenter) {
    return Array.from(new IntlWithSegmenter.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), item => item.segment);
  }
  return Array.from(value);
}

export function Button({ children, variant = 'quiet', size = 'md', disabled, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'quiet' | 'outline' | 'danger' | 'soft'; size?: 'sm' | 'md' }) {
  return <button type="button" className={`button button-${variant} button-${size} ${className}`} disabled={disabled} {...props}>{children}</button>;
}

export function IconButton({ label, children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

export interface ModalFocusScope {
  /** Stable return target shared by loading and loaded dialogs for one navigation session. */
  origin: HTMLElement | null;
}

const ModalFocusScopeContext = createContext<ModalFocusScope | undefined>(undefined);

export function ModalFocusScopeProvider({ scope, children }: { scope: ModalFocusScope; children: ReactNode }) {
  return <ModalFocusScopeContext.Provider value={scope}>{children}</ModalFocusScopeContext.Provider>;
}

export function Modal({ title, heading, headerActions, eyebrow, children, onClose, size = 'md', testId, className = '' }: { title: string; heading?: ReactNode; headerActions?: ReactNode; eyebrow?: string; children: ReactNode; onClose: () => void; size?: 'sm' | 'md' | 'lg'; testId?: string; className?: string }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDivElement>(null);
  const focusScope = useContext(ModalFocusScopeContext);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useLayoutEffect(() => {
    const parentDialog = dialog.current?.parentElement?.closest('[role="dialog"][aria-modal="true"]') ?? null;
    const active = document.activeElement;
    const suppliedOrigin = focusScope?.origin;
    previouslyFocusedRef.current = suppliedOrigin?.isConnected
      ? suppliedOrigin
      : active instanceof HTMLElement && active !== document.body && active.isConnected ? active : null;
    const currentDialog = dialog.current;
    if (currentDialog && !currentDialog.contains(document.activeElement)) {
      const candidates = [...currentDialog.querySelectorAll<HTMLElement>('[data-autofocus], input:not(:disabled), textarea:not(:disabled), button:not(:disabled), summary')];
      const visible = candidates.filter((item) => item.getClientRects().length > 0 && !item.closest('[aria-hidden="true"]'));
      const first = visible.find((item) => item.matches('[data-autofocus]'))
        || visible.find((item) => item.classList.contains('modal-close-button'))
        || visible[0];
      (first || currentDialog).focus();
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const openDialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')];
      const isTop = openDialogs[openDialogs.length - 1] === dialog.current;
      if (!isTop || event.defaultPrevented || document.querySelector('[data-workspace-popover]')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCloseRef.current(); }
      if (event.key === 'Tab' && dialog.current) {
        const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])')]
          .filter((item) => item.getClientRects().length > 0 && !item.closest('[aria-hidden="true"]'));
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    modalCount += 1;
    document.body.classList.add('modal-open');
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      modalCount = Math.max(0, modalCount - 1);
      if (modalCount === 0) document.body.classList.remove('modal-open');
      const returnTarget = previouslyFocusedRef.current;
      // A popover can outlive the modal that opened it; never steal its current focus.
      if (!document.querySelector('[data-workspace-popover]')) {
        if (returnTarget?.isConnected) returnTarget.focus();
        else if (!parentDialog?.isConnected) {
          const fallback = document.querySelector<HTMLElement>('[data-modal-focus-fallback]') || document.querySelector<HTMLElement>('.content-scroll');
          if (fallback) {
            if (!fallback.hasAttribute('tabindex')) fallback.tabIndex = -1;
            fallback.focus();
          }
        }
      }
    };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`modal modal-${size} ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialog} data-testid={testId}>
      <div className="modal-heading">
        <div className="modal-heading-copy">{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{heading ?? title}</h2></div>
        {headerActions && <div className="modal-header-actions">{headerActions}</div>}
        <IconButton className="modal-close-button" label={t('close')} onClick={onClose}><X size={18} /></IconButton>
      </div>
      <ModalFocusScopeContext.Provider value={undefined}>{children}</ModalFocusScopeContext.Provider>
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
  const formControl = target instanceof HTMLInputElement || target instanceof HTMLButtonElement
    || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement ? target.form : null;
  const associated = formControl && scope.contains(formControl) && formControl.matches('[data-workspace-save]') ? formControl : null;
  const form = focused && scope.contains(focused) ? focused : associated || scope.querySelector<HTMLElement>('[data-workspace-save]');
  if (!form) return false;
  form.dispatchEvent(new CustomEvent('workspace:save-form', { bubbles: true, cancelable: true, detail: { target } }));
  return true;
}
