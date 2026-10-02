import { useId, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { PickerOption } from './pickers';

export interface ChoiceTileOption extends PickerOption { rank?: number }

type TileKind = 'priority' | 'tracker';

function normalized(value: string) { return value.normalize('NFKD').toLocaleLowerCase().replace(/[\u0300-\u036f]/g, ''); }

function semanticColor(option: ChoiceTileOption, index: number, options: ChoiceTileOption[], kind: TileKind) {
  const name = normalized(option.label);
  if (kind === 'tracker') {
    if (/bug|defect|error|issue/.test(name)) return 'bug';
    if (/feature|enhancement|story/.test(name)) return 'feature';
    if (/task|support/.test(name)) return 'task';
  } else {
    if (/urgent|immediate|critical|highest|blocker/.test(name)) return 'urgent';
    if (/high|important/.test(name)) return 'high';
    if (/normal|medium|default/.test(name)) return 'normal';
    if (/low|minor|trivial/.test(name)) return 'low';
    if (typeof option.rank === 'number') {
      const ranks = [...new Set(options.map(item => item.rank).filter((rank): rank is number => typeof rank === 'number'))].sort((a, b) => a - b);
      const rankIndex = ranks.indexOf(option.rank);
      if (ranks.length > 1 && rankIndex >= 0) return (['low', 'normal', 'high', 'urgent'] as const)[Math.round(rankIndex / (ranks.length - 1) * 3)];
    }
  }
  return `tone-${(index % 5) + 1}`;
}

export function ChoiceTiles({ options, value, onChange, label, kind, disabled, className = '' }: {
  options: ChoiceTileOption[]; value?: string; onChange: (value: string) => void; label: string; kind: TileKind; disabled?: boolean; className?: string;
}) {
  const id = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  const selectedIndex = options.findIndex(option => option.value === value);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key) || options.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : (index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    const option = options[next];
    if (!option.disabled) onChange(option.value);
    requestAnimationFrame(() => groupRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-option-${next}`)}`)?.focus());
  };
  return <div ref={groupRef} className={`choice-tiles choice-tiles-${kind}${className ? ` ${className}` : ''}`} role="radiogroup" aria-label={label}>
    {options.map((option, index) => {
      const selected = option.value === value;
      const color = semanticColor(option, index, options, kind);
      return <button key={option.value} id={`${id}-option-${index}`} type="button" role="radio" aria-checked={selected} aria-label={option.label} title={option.label} data-value={option.value} data-rank={option.rank} className={`choice-tile choice-tile-${kind} choice-tile-${color}${selected ? ' is-selected' : ''}`} disabled={disabled || option.disabled} tabIndex={selected || selectedIndex < 0 && index === 0 ? 0 : -1} onClick={() => onChange(option.value)} onKeyDown={event => onKeyDown(event, index)}>
        <span>{option.label}</span>
      </button>;
    })}
  </div>;
}
