import { useLayoutEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Plus, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Person } from '../../shared/types';
import { Avatar } from './ui';

export interface PickerOption { value: string; label: string; description?: string; person?: Person; disabled?: boolean; icon?: ReactNode }
interface CommonProps { options: PickerOption[]; label: string; placeholder?: string; searchPlaceholder?: string; disabled?: boolean; className?: string; clearable?: boolean; iconOnly?: boolean }

const popoverStack: HTMLElement[] = [];

export function Popover({ trigger, children, label, open, onOpenChange, className = '' }: {
  trigger: ReactNode; children: ReactNode; label: string; open: boolean; onOpenChange: (open: boolean) => void; className?: string;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onOpenChange); close.current = onOpenChange;
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number }>({ left: 0, top: 0, maxHeight: 500 });
  useLayoutEffect(() => {
    if (!open) return;
    const currentPanel = panel.current;
    if (currentPanel) popoverStack.push(currentPanel);
    const align = () => {
      const box = anchor.current?.getBoundingClientRect(); if (!box || !panel.current) return;
      const width = panel.current.offsetWidth;
      const below = window.innerHeight - box.bottom - 16;
      const above = box.top - 16;
      const upwards = below < Math.min(panel.current.scrollHeight, 280) && above > below;
      const maxHeight = Math.max(120, (upwards ? above : below) - 8);
      const height = Math.min(panel.current.scrollHeight, maxHeight);
      const next = { left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)), top: upwards ? box.top - height - 8 : box.bottom + 8, maxHeight };
      setPosition(previous => previous.left === next.left && previous.top === next.top && previous.maxHeight === next.maxHeight ? previous : next);
    };
    align();
    panel.current?.querySelector<HTMLElement>('[data-popover-autofocus], input, [role="option"], button')?.focus();
    const frame = requestAnimationFrame(align);
    const pointer = (event: PointerEvent) => {
      const target = event.target as Node;
      const level = currentPanel ? popoverStack.indexOf(currentPanel) : -1;
      const insideChild = level >= 0 && popoverStack.slice(level).some(item => item.contains(target));
      if (!insideChild && !anchor.current?.contains(target)) close.current(false);
    };
    const key = (event: KeyboardEvent) => {
      if (popoverStack.at(-1) !== currentPanel) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(false); anchor.current?.querySelector<HTMLElement>('button')?.focus(); }
      if (event.key === 'Tab') {
        const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') || [])];
        if (!items.length) return;
        const first = items[0], last = items.at(-1)!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    const observer = new ResizeObserver(align); if (panel.current) observer.observe(panel.current);
    document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', key, true);
    window.addEventListener('resize', align); window.addEventListener('scroll', align, true);
    return () => { if (currentPanel) { const level = popoverStack.indexOf(currentPanel); if (level >= 0) popoverStack.splice(level, 1); } cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key, true); window.removeEventListener('resize', align); window.removeEventListener('scroll', align, true); };
  }, [open]);
  return <><span className="popover-anchor" ref={anchor} onClick={() => onOpenChange(!open)}>{trigger}</span>{open && createPortal(<div ref={panel} className={`workspace-popover ${className}`} data-workspace-popover role="dialog" aria-label={label} style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }}>{children}</div>, document.body)}</>;
}

function ChoicePicker({ options, label, placeholder, searchPlaceholder, disabled, className = '', clearable = false, iconOnly = false, values, onChange, multiple }: CommonProps & { values: string[]; onChange: (values: string[]) => void; multiple: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => options.filter(option => `${option.label} ${option.description || ''} ${option.person?.redmineRoles?.map(role => role.name).join(' ') || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [options, query]);
  const selected = options.filter(option => values.includes(option.value));
  const selectedLabel = selected.length ? selected.map(option => option.label).join(', ') : placeholder || t('choose');
  const setExpanded = (next: boolean) => { setOpen(next); if (next) { setQuery(''); setActive(0); } };
  const choose = (option: PickerOption) => {
    if (option.disabled) return;
    onChange(multiple ? values.includes(option.value) ? values.filter(value => value !== option.value) : [...values, option.value] : [option.value]);
    if (!multiple) { setOpen(false); document.getElementById(`${id}-trigger`)?.focus(); }
    else search.current?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      const dir = event.key === 'ArrowDown' ? 1 : -1;
      const enabled = filtered.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
      if (!enabled.length) return;
      const current = enabled.indexOf(active); const next = enabled[(current + dir + enabled.length) % enabled.length]; setActive(next);
      requestAnimationFrame(() => document.getElementById(`${id}-option-${next}`)?.scrollIntoView({ block: 'nearest' }));
    } else if (event.key === 'Enter' && open) { event.preventDefault(); event.stopPropagation(); if (filtered[active]) choose(filtered[active]); }
  };
  const trigger = <button id={`${id}-trigger`} type="button" role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined} disabled={disabled} className={`picker-trigger${iconOnly ? ' picker-trigger-compact' : ''} ${className}`} title={`${label}: ${selectedLabel}`} onKeyDown={event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); setExpanded(true); }
    else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1 && event.key !== ' ') { event.preventDefault(); event.stopPropagation(); setExpanded(true); setQuery(event.key); }
  }}>
    {!iconOnly && selected.length === 1 && selected[0].person && <Avatar person={selected[0].person} size="sm" />}
    {!iconOnly && selected.length === 1 && selected[0].icon}
    {iconOnly ? <Plus size={16} /> : <><span className="picker-value">{selectedLabel}</span>{multiple && selected.length > 1 && <span className="picker-count">{selected.length}</span>}<ChevronDown size={14} /></>}
  </button>;
  return <Popover trigger={trigger} label={label} open={open} onOpenChange={disabled ? () => undefined : setExpanded} className="picker-popover">
    <div className="picker-search"><Search size={15} /><input ref={search} data-popover-autofocus aria-label={`${t('search')} · ${label}`} placeholder={searchPlaceholder || t('searchOptions')} value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKeyDown} role="combobox" aria-controls={`${id}-list`} aria-expanded="true" aria-autocomplete="list" aria-activedescendant={filtered[active] ? `${id}-option-${active}` : undefined} /></div>
    <div id={`${id}-list`} className="picker-options" role="listbox" aria-label={label} aria-multiselectable={multiple || undefined}>
      {filtered.length === 0 && <p className="picker-empty">{t('noOptions')}</p>}
      {filtered.map((option, index) => <button type="button" id={`${id}-option-${index}`} key={option.value} data-value={option.value} role="option" aria-selected={values.includes(option.value)} disabled={option.disabled} className={`picker-option${values.includes(option.value) ? ' is-selected' : ''}${index === active ? ' is-focused' : ''}`} onMouseEnter={() => setActive(index)} onClick={() => choose(option)} onKeyDown={onKeyDown}>
        {multiple && <span className={`picker-checkbox${values.includes(option.value) ? ' is-checked' : ''}`}>{values.includes(option.value) && <Check size={12} />}</span>}
        {option.person && <Avatar person={option.person} size="sm" />}{option.icon}
        <span className="picker-option-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}{option.person?.roles?.length ? <small className="person-role-label">{option.person.roles.map(role => t(`role_${role}`)).join(' · ')}</small> : null}</span>
        {!multiple && values.includes(option.value) && <Check size={15} />}
      </button>)}
    </div>
    {clearable && values.length > 0 && <button type="button" className="picker-clear" onClick={() => { onChange([]); if (!multiple) { setOpen(false); document.getElementById(`${id}-trigger`)?.focus(); } }}><X size={13} />{t('clear')}</button>}
  </Popover>;
}

export function Picker({ value, onChange, ...props }: CommonProps & { value?: string; onChange: (value: string) => void }) {
  return <ChoicePicker {...props} multiple={false} values={value === undefined || value === '' ? [] : [value]} onChange={values => onChange(values[0] || '')} />;
}
export function MultiPicker({ values, onChange, ...props }: CommonProps & { values: string[]; onChange: (values: string[]) => void }) {
  return <ChoicePicker {...props} multiple values={values} onChange={onChange} />;
}
export function PeoplePicker({ members, value, onChange, label, placeholder, disabled, recommendations = [], className = '', compact = false }: {
  members: Person[]; value?: number; onChange: (value?: number) => void; label: string; placeholder?: string; disabled?: boolean; recommendations?: number[]; className?: string; compact?: boolean;
}) {
  const { t } = useTranslation();
  const ranked = useMemo(() => [...members].sort((a, b) => {
    const ai = recommendations.indexOf(a.id), bi = recommendations.indexOf(b.id);
    return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || a.name.localeCompare(b.name);
  }), [members, recommendations]);
  return <Picker label={label} iconOnly={compact} placeholder={placeholder || t('noAssignee')} className={`people-picker ${className}`} value={value === undefined ? undefined : String(value)} onChange={next => onChange(next ? Number(next) : undefined)} disabled={disabled} clearable options={ranked.map(person => ({ value: String(person.id), label: person.name, person, description: recommendations.includes(person.id) ? t('frequentPerson') : undefined }))} />;
}
