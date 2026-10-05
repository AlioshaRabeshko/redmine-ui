import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Check, ChevronDown, ChevronUp, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const LARGE_CATALOG_THRESHOLD = 12;

function labelHue(value: string): number {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) % 360;
}

export function LabelsTiles({ options, values, onChange, label, disabled }: {
  options: string[];
  values: string[];
  onChange: (values: string[]) => void;
  label: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const catalog = useMemo(() => [...new Set([...options, ...values])].sort((a, b) => a.localeCompare(b)), [options, values]);
  const largeCatalog = catalog.length > LARGE_CATALOG_THRESHOLD;
  const selected = new Set(values);
  const shown = catalog.filter((value) => {
    if (largeCatalog && !expanded && !selected.has(value)) return false;
    return !query || value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  });
  const focusValue = shown.find((value) => selected.has(value)) ?? shown[0];

  const onTileKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key) || shown.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const currentIndex = shown.indexOf(event.currentTarget.dataset.labelValue || '');
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? shown.length - 1
      : (currentIndex + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
    refs.current.get(shown[nextIndex]!)?.focus();
  };

  const toggle = (value: string) => {
    if (disabled) return;
    if (largeCatalog && !expanded) setExpanded(true);
    onChange(selected.has(value) ? values.filter((item) => item !== value) : [...values, value]);
  };

  return <div className="labels-tiles-control" data-testid="labels-tiles-control">
    {largeCatalog && <div className="labels-tiles-tools">
      <button type="button" className="labels-catalog-toggle" aria-expanded={expanded} onClick={() => { setExpanded((current) => !current); setQuery(''); }}>
        {expanded ? <><ChevronUp size={13} />{t('hideLabels')}</> : <><ChevronDown size={13} />{t('showAllLabels')}</>}
      </button>
      {expanded && <div className="labels-catalog-search"><Search size={14} /><input type="search" aria-label={t('labelsSearch')} placeholder={t('labelsSearch')} value={query} onChange={(event) => setQuery(event.target.value)} /></div>}
    </div>}
    <div className="labels-tile-grid" role="group" aria-label={label} data-testid="labels-tiles">
      {shown.map((value) => {
        const isSelected = selected.has(value);
        const inCatalog = options.includes(value);
        return <button
          key={value}
          ref={(element) => { if (element) refs.current.set(value, element); else refs.current.delete(value); }}
          type="button"
          className={`label-tile${isSelected ? ' is-selected' : ''}${inCatalog ? '' : ' is-current-value'}`}
          style={{ '--label-hue': String(labelHue(value)) } as CSSProperties}
          data-label-value={value}
          data-in-catalog={inCatalog}
          aria-pressed={isSelected}
          aria-label={value}
          title={value}
          disabled={disabled}
          tabIndex={value === focusValue ? 0 : -1}
          onClick={() => toggle(value)}
          onKeyDown={onTileKeyDown}
        >{isSelected && <Check size={13} aria-hidden="true" />}<span>{value}</span></button>;
      })}
      {shown.length === 0 && <span className="labels-tiles-empty">{t('noOptions')}</span>}
    </div>
  </div>;
}
