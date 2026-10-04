import { useEffect, useRef, useState, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, LoaderCircle, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Project, SearchResponse } from '../../../shared/types';
import { api, friendlyError } from '../../lib/api';
import { Button, IconButton } from '../../components/ui';
import './search.css';

export function WorkspaceSearch({ inputRef, project, projects, value, onChange, onFocus, onBlur, onOpenIssue }: {
  inputRef: RefObject<HTMLInputElement | null>; project: Project; projects: Project[]; value: string;
  onChange: (value: string) => void; onFocus: () => void; onBlur: () => void;
  onOpenIssue: (id: number, projectId?: number) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [allProjects, setAllProjects] = useState(false);
  const [query, setQuery] = useState(value.trim());
  const [offset, setOffset] = useState(0);
  const [active, setActive] = useState(0);
  const shellRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const limit = 20;
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(value.trim()); setOffset(0); setActive(0); }, 250);
    return () => clearTimeout(timer);
  }, [value]);
  useEffect(() => { setOffset(0); setActive(0); }, [project.id, allProjects]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!shellRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && shellRef.current?.contains(event.target as Node)) { setOpen(false); event.preventDefault(); event.stopPropagation(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [open]);
  const scopeId = allProjects ? undefined : project.id;
  const search = useQuery({
    queryKey: ['search', scopeId ?? 'all', query, offset],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ q: query, offset: String(offset), limit: String(limit) });
      if (scopeId) params.set('projectId', String(scopeId));
      return api.get<SearchResponse>(`/api/search?${params}`, signal);
    },
    enabled: open && !!query && query === value.trim(), staleTime: 15_000, retry: false,
  });
  const results = search.data?.results ?? [];
  const waiting = query !== value.trim() || search.isLoading;
  const choose = (index: number) => {
    const result = results[index];
    if (!result) return;
    setOpen(false);
    onOpenIssue(result.id, result.projectId);
  };
  return <div className="workspace-search" ref={shellRef}>
    <label className="global-search"><Search size={16} /><input ref={inputRef} type="search" aria-label={t('search')} placeholder={t('searchPlaceholder')} value={value} aria-expanded={open && !!value.trim()} aria-controls="workspace-search-results"
      onFocus={() => { onFocus(); setOpen(true); }} onBlur={onBlur}
      onChange={event => { onChange(event.target.value); setOpen(true); }}
      onKeyDown={event => {
        if (!open || !results.length || waiting) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const next = (active + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
          setActive(next); resultsRef.current?.querySelectorAll('button.search-result')[next]?.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter') { event.preventDefault(); choose(active); }
      }} /><kbd>/</kbd></label>
    {open && !!value.trim() && <section className="full-search-panel" aria-label={t('fullSearch')} data-testid="full-search-panel">
      <header className="full-search-header"><strong>{t('fullSearch')}</strong><IconButton label={t('close')} onClick={() => setOpen(false)}><X size={14} /></IconButton></header>
      <div className="search-scope" role="group" aria-label={t('searchScope')}>
        <Button size="sm" variant={!allProjects ? 'soft' : 'quiet'} aria-pressed={!allProjects} onClick={() => setAllProjects(false)}>{project.name}</Button>
        <Button size="sm" variant={allProjects ? 'soft' : 'quiet'} aria-pressed={allProjects} onClick={() => setAllProjects(true)}>{t('searchAllProjects')}</Button>
      </div>
      <p className="full-search-hint">{t('fullSearchHint')}</p>
      <div ref={resultsRef} id="workspace-search-results" className="full-search-results" aria-busy={waiting}>
        {waiting ? <div className="search-message" role="status"><LoaderCircle size={16} className="spin" />{t('loading')}</div>
          : search.isError ? <div className="search-message search-error" role="alert">{friendlyError(search.error, t)}<Button size="sm" onClick={() => search.refetch()}>{t('retry')}</Button></div>
            : results.length ? results.map((result, index) => <button type="button" key={result.id} className={`search-result${active === index ? ' search-result-active' : ''}`} onPointerMove={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => choose(index)}>
              <span className="search-result-heading"><span>#{result.id}</span><strong>{result.title}</strong></span>
              {result.description && <span className="search-result-description">{result.description}</span>}
              <span className="search-result-meta">{projects.find(item => item.id === result.projectId)?.name ?? ''}{result.statusName && <> · {result.statusName}</>}</span>
            </button>) : <div className="search-message">{t('fullSearchEmpty')}</div>}
      </div>
      {!waiting && !search.isError && search.data && <footer className="full-search-footer"><span>{t('searchResultCount', { count: search.data.total })}</span><div>
        <IconButton label={t('searchPrevious')} disabled={!offset} onClick={() => { setOffset(Math.max(0, offset - limit)); setActive(0); }}><ChevronLeft size={15} /></IconButton>
        <IconButton label={t('searchNext')} disabled={offset + results.length >= search.data.total} onClick={() => { setOffset(offset + limit); setActive(0); }}><ChevronRight size={15} /></IconButton>
      </div></footer>}
    </section>}
  </div>;
}
