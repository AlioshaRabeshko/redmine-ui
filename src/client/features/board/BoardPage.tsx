import { useMemo, useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, CalendarDays, Check, ChevronDown, CircleDot, Clock3, Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AppSettings, BoardData, Filters, Issue, Person, Priority, Project, SavedView, Status, View } from '../../../shared/types';
import { filterIssues, groupBoard, sortIssues, toggleAssignedToMe } from '../../../shared/domain';
import { Avatar, Button, IconButton, Notice } from '../../components/ui';
import { MultiPicker, PeoplePicker, Picker, Popover } from '../../components/pickers';

export interface BoardPageProps {
  project: Project;
  data: BoardData;
  statuses: Status[];
  priorities: Priority[];
  me: Person;
  settings: AppSettings;
  view: View;
  filters: Filters;
  canWrite: boolean;
  pendingIssueIds: ReadonlySet<number>;
  onFiltersChange: (filters: Filters) => void;
  onSettingsChange: (patch: Partial<AppSettings>) => void;
  onViewChange: (view: View) => void;
  onSelectSavedView: (saved: SavedView) => void;
  onDeleteSavedView: (saved: SavedView) => void;
  onOpenIssue: (issue: Issue) => void;
  onCreateIssue: (defaults?: { statusId?: number; fixedVersionId?: number | null }) => void;
  onMoveIssue: (issue: Issue, target: { statusId?: number; fixedVersionId?: number | null }) => void;
  onSaveView: (name: string, filters: Filters, view: View) => void;
  onToast: (message: string) => void;
  savedViews: SavedView[];
}

const defaultFilters: Filters = {};

function BoardCard({ issue, data, statuses, priorities, canWrite, pending = false, onOpen, onToast, isDragging = false }: {
  issue: Issue; data: BoardData; statuses: Status[]; priorities: Priority[]; canWrite: boolean; pending?: boolean; onOpen: (issue: Issue) => void; onToast: (message: string) => void; isDragging?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const activeVersion = data.versions.find((version) => version.id === issue.fixedVersionId && version.projectId === issue.projectId && version.status !== 'closed');
  const status = statuses.find((entry) => entry.id === issue.statusId);
  const assigned = data.members.find((person) => person.id === issue.assignedToId);
  const developer = data.members.find((person) => person.id === issue.developerId);
  const qa = data.members.find((person) => person.id === issue.qaId);
  const author = data.members.find((person) => person.id === issue.authorId);
  const priority = priorities.find((item) => item.id === issue.priorityId);
  const overdue = !!issue.dueDate && issue.dueDate < new Date().toISOString().slice(0, 10) && status && !status.isClosed;
  const { attributes, listeners, setNodeRef, transform, isDragging: dragging } = useDraggable({ id: `issue:${issue.id}`, disabled: !canWrite || pending });
  const style = { transform: CSS.Translate.toString(transform), opacity: (dragging || isDragging) ? 0.35 : 1 };
  const onCopyBranch = async (event: React.MouseEvent) => {
    event.stopPropagation();
    try { await navigator.clipboard.writeText(issue.branch); onToast(t('copied')); } catch { onToast(t('error')); }
  };
  return <article ref={setNodeRef} style={style} className={`issue-card${activeVersion ? ' issue-card-roadmap' : ''}${isDragging ? ' issue-card-overlay' : ''}${pending ? ' issue-card-pending' : ''}`} data-testid={`issue-card-${issue.id}`} data-issue-id={issue.id} aria-busy={pending || undefined}>
    <div className="card-hit-area" {...attributes} {...listeners} role="button" tabIndex={pending ? -1 : 0} aria-disabled={pending} aria-label={`#${issue.id} ${issue.subject}`} onClick={() => !pending && onOpen(issue)} onKeyDown={(event) => { if (!pending && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen(issue); } }}>
      <div className="card-topline">
        <span className="issue-ref">{issue.trackerName} <span>#{issue.id}</span></span>
        {priority && <span className={`priority-mark priority-${Math.max(0, Math.min(4, priority.rank))}`} title={`${t('priorityField')}: ${priority.name}`}><CircleDot size={13} />{priority.name}</span>}
      </div>
      <h3>{issue.subject}</h3>
      {issue.labels.length > 0 && <div className="card-labels">{issue.labels.slice(0, 3).map((label) => <span key={label} className="label-chip">{label}</span>)}{issue.labels.length > 3 && <span className="label-more">+{issue.labels.length - 3}</span>}</div>}
      {issue.branch && <div className="branch-row"><span aria-label={t('branch')}>{issue.branch}</span><button type="button" onClick={onCopyBranch} title={t('copyBranchShortcut')} aria-label={`${t('copyBranchShortcut')}: ${issue.branch}`}><Check size={12} /></button></div>}
      {activeVersion && <div className="roadmap-row"><span className="roadmap-pill"><CalendarDays size={12} />{activeVersion.name}</span>
        {status?.key !== 'deploy' && <span className="not-ready" title={`${t('notReady')} · ${t('actualStatus')}: ${status?.name || t('unknown')}`}><AlertTriangle size={13} />{status?.name || t('unknown')}</span>}
        {status?.key === 'deploy' && <span className="actual-status status-deploy">{status.name}</span>}
      </div>}
      <div className="card-bottom">
        <div className="card-people">
          <span className="person-stack" title={`${t('assignee')}: ${assigned?.name || t('noAssignee')}`}><Avatar person={assigned} size="md" /></span>
          {developer && developer.id !== assigned?.id && <span className="person-mini" title={`${t('developer')}: ${developer.name}`}><Avatar person={developer} size="xs" /></span>}
          {qa && qa.id !== assigned?.id && qa.id !== developer?.id && <span className="person-mini qa-mini" title={`${t('qa')}: ${qa.name}`}><Avatar person={qa} size="xs" /></span>}
          {author && ![assigned?.id, developer?.id, qa?.id].includes(author.id) && <span className="author-dot" title={`${t('author')}: ${author.name}`}>{author.name.slice(0, 1).toUpperCase()}</span>}
        </div>
        <div className="card-meta">
          {pending && <span className="actual-status">{t('savingIssue')}</span>}
          {overdue && <span className="due-chip due-overdue"><Clock3 size={12} />{t('overdue')}</span>}
          {!!issue.dueDate && !overdue && <span className="due-chip"><Clock3 size={12} />{new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' }).format(new Date(`${issue.dueDate}T00:00:00`))}</span>}
          {status && !activeVersion && <span className={`actual-status status-${status.key}`}>{status.name}</span>}
        </div>
      </div>
    </div>
    <button className="card-open-action" type="button" onClick={() => onOpen(issue)} aria-label={t('open')}><ChevronDown size={14} /></button>
  </article>;
}

function Lane({ column, data, statuses, priorities, canWrite, pendingIssueIds, onOpenIssue, onCreateIssue, onToast, activeIssueId }: {
  column: ReturnType<typeof groupBoard>[number]; data: BoardData; statuses: Status[]; priorities: Priority[]; canWrite: boolean; pendingIssueIds: ReadonlySet<number>; onOpenIssue: (issue: Issue) => void; onCreateIssue: BoardPageProps['onCreateIssue']; onToast: (message: string) => void; activeIssueId?: number;
}) {
  const { t, i18n } = useTranslation();
  const { isOver, setNodeRef } = useDroppable({ id: `lane:${column.id}`, disabled: !canWrite });
  const road = Boolean(column.version);
  return <section className={`board-lane${road ? ' lane-roadmap' : ''}${isOver ? ' lane-over' : ''}`} ref={setNodeRef} data-testid={`lane-${column.id}`} aria-label={column.name}>
    <header className="lane-header">
      <span className={`lane-dot${road ? ' lane-dot-roadmap' : ` dot-${column.status?.key || 'unknown'}`}`} />
      <h2>{column.name}</h2>
      {road && <span className="lane-roadmap-icon"><CalendarDays size={14} /></span>}
      <span className="lane-count">{column.issues.length}</span>
      <IconButton className="lane-create" label={t('createInColumn', { column: column.name })} disabled={!canWrite} onClick={() => onCreateIssue({
        statusId: column.status?.id ?? statuses.find(status => status.key === 'todo')?.id ?? statuses[0]?.id,
        fixedVersionId: column.version?.id ?? null,
      })}><Plus size={16} /></IconButton>
    </header>
    {road && <div className="lane-caption">{column.version?.dueDate ? `${t('dueDate')} · ${new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' }).format(new Date(`${column.version.dueDate}T00:00:00`))}` : t('roadmap')}</div>}
    <div className="lane-content">
      {column.issues.map((issue) => <BoardCard key={issue.id} issue={issue} data={data} statuses={statuses} priorities={priorities} canWrite={canWrite} pending={pendingIssueIds.has(issue.id)} onOpen={onOpenIssue} onToast={onToast} isDragging={activeIssueId === issue.id} />)}
      {column.issues.length === 0 && <div className="lane-empty">{isOver ? <span>{t('moveTo')} {column.name}</span> : <span className="lane-empty-mark">· · ·</span>}</div>}
    </div>
  </section>;
}

export function BoardPage({ project, data, statuses, priorities, me, settings, view, filters, canWrite, pendingIssueIds, onFiltersChange, onSettingsChange, onViewChange, onSelectSavedView, onDeleteSavedView, onOpenIssue, onCreateIssue, onMoveIssue, onSaveView, onToast, savedViews }: BoardPageProps) {
  const { t } = useTranslation();
  const [showFilters, setShowFilters] = useState(false);
  const [savingView, setSavingView] = useState(false);
  const [viewName, setViewName] = useState('');
  const [draggedId, setDraggedId] = useState<number>();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const filtered = useMemo(() => sortIssues(filterIssues(data.issues, statuses, view, me.id, filters, data.members), priorities, settings.sort), [data.issues, data.members, statuses, priorities, view, me.id, filters, settings.sort]);
  const columns = useMemo(() => groupBoard(filtered, statuses, data.versions, view), [filtered, statuses, data.versions, view]);
  const selectedLabels = [...new Set([...(filters.labels || []), ...(filters.label ? [filters.label] : [])])];
  const hasFilters = Boolean(filters.assignedToMe || filters.assigneeId !== undefined || selectedLabels.length || filters.search || filters.statusIds?.length || filters.priorityIds?.length || filters.versionId !== undefined || filters.includeClosed);
  const mineActive = Boolean(filters.assignedToMe || view === 'mine');
  const onDragEnd = (event: DragEndEvent) => {
    const from = String(event.active.id);
    const to = String(event.over?.id || '');
    const issueId = Number(from.replace('issue:', ''));
    if (pendingIssueIds.has(issueId)) return;
    const issue = data.issues.find((entry) => entry.id === issueId);
    setDraggedId(undefined);
    if (!issue || !to.startsWith('lane:')) return;
    const targetId = to.slice(5);
    if (targetId.startsWith('version:')) {
      const versionId = Number(targetId.slice(8));
      if (issue.fixedVersionId !== versionId) onMoveIssue(issue, { fixedVersionId: versionId });
    } else if (targetId.startsWith('status:')) {
      const statusId = Number(targetId.slice(7));
      if (issue.statusId !== statusId) onMoveIssue(issue, { statusId, fixedVersionId: issue.fixedVersionId });
    }
  };
  const clearFilters = () => { onFiltersChange(defaultFilters); };
  const submitSavedView = (event: React.FormEvent) => { event.preventDefault(); if (viewName.trim()) { onSaveView(viewName.trim(), filters, view); setViewName(''); setSavingView(false); } };
  const changeView = (next: View) => onViewChange(next);

  const changeSort = (value: string) => {
    const [field, direction] = value.split(':') as [AppSettings['sort']['field'], AppSettings['sort']['direction']];
    if (field && direction) onSettingsChange({ sort: { field, direction } });
  };
  const stableFilterKey = (value: Filters) => JSON.stringify(Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, Array.isArray(entry) ? [...entry].sort() : entry]));
  const activeSaved = (saved: SavedView) => view === saved.view && stableFilterKey(filters) === stableFilterKey(saved.filters);
  const activeChips: { key: string; label: string; remove: () => void }[] = [];
  if (filters.search) activeChips.push({ key: 'search', label: `${t('search')}: ${filters.search}`, remove: () => onFiltersChange({ ...filters, search: undefined }) });
  if (filters.assignedToMe) activeChips.push({ key: 'assignedToMe', label: t('mine'), remove: () => onFiltersChange(toggleAssignedToMe(filters)) });
  if (filters.assigneeId !== undefined) {
    const person = data.members.find(item => item.id === filters.assigneeId);
    activeChips.push({ key: 'assignee', label: `${t('assignee')}: ${person?.name || `#${filters.assigneeId}`}`, remove: () => onFiltersChange({ ...filters, assigneeId: undefined }) });
  }
  for (const label of selectedLabels) activeChips.push({ key: `label:${label}`, label: `${t('label')}: ${label}`, remove: () => {
    const nextLabels = selectedLabels.filter(item => item !== label);
    onFiltersChange({ ...filters, label: undefined, labels: nextLabels.length ? nextLabels : undefined });
  } });
  for (const id of filters.statusIds || []) {
    const status = statuses.find(item => item.id === id);
    activeChips.push({ key: `status:${id}`, label: `${t('status')}: ${status?.name || `#${id}`}`, remove: () => { const next = filters.statusIds?.filter(item => item !== id) || []; onFiltersChange({ ...filters, statusIds: next.length ? next : undefined }); } });
  }
  for (const id of filters.priorityIds || []) {
    const priority = priorities.find(item => item.id === id);
    activeChips.push({ key: `priority:${id}`, label: `${t('priority')}: ${priority?.name || `#${id}`}`, remove: () => { const next = filters.priorityIds?.filter(item => item !== id) || []; onFiltersChange({ ...filters, priorityIds: next.length ? next : undefined }); } });
  }
  if (filters.versionId !== undefined) {
    const version = data.versions.find(item => item.id === filters.versionId);
    activeChips.push({ key: 'version', label: `${t('release')}: ${version?.name || `#${filters.versionId}`}`, remove: () => onFiltersChange({ ...filters, versionId: undefined }) });
  }
  if (filters.includeClosed) activeChips.push({ key: 'closed', label: t('includeClosed'), remove: () => onFiltersChange({ ...filters, includeClosed: undefined }) });
  const sortOptions = (['priority', 'updated', 'created', 'id', 'subject'] as const).flatMap(field => (['desc', 'asc'] as const).map(direction => ({
    value: `${field}:${direction}`,
    label: `${t(field === 'id' ? 'issueId' : field === 'subject' ? 'subject' : field)} · ${t(direction)}`,
  })));
  const viewLabelKeys: Record<View, string> = { all: 'viewAll', mine: 'viewMine', watching: 'viewWatching', backlog: 'viewBacklog' };
  return <main className="page board-page" data-testid="board">
    <div className="page-heading board-title-row">
      <div><div className="eyebrow">{project.identifier}</div><h1>{view === 'backlog' ? t('backlog') : t('board')}</h1><p className="page-subtitle">{project.description || t('workspace')} <span className="inline-separator">·</span> {t('issueCount', { count: data.total })}</p></div>
      <div className="heading-actions">
        <Popover trigger={<button type="button" className={`filter-toggle${showFilters || hasFilters ? ' is-active' : ''}`} aria-haspopup="dialog" aria-expanded={showFilters}><SlidersHorizontal size={16} />{t('filters')}{hasFilters && <span className="filter-dot" />}</button>} label={t('filters')} open={showFilters} onOpenChange={setShowFilters} className="board-filter-popover">
          <div className="board-filter-panel">
            <div className="board-filter-head"><strong>{t('filters')}</strong>{hasFilters && <Button size="sm" variant="quiet" onClick={clearFilters}><X size={14} />{t('clear')}</Button>}</div>
            <div className="board-filter-grid">
              <div className="board-filter-field"><span>{t('filterAssignee')}</span><PeoplePicker label={t('filterAssignee')} placeholder={t('viewAll')} members={data.members} value={filters.assigneeId} recommendations={data.peopleRecommendations?.assignee || []} onChange={value => onFiltersChange({ ...filters, assigneeId: value })} /></div>
              <div className="board-filter-field"><span>{t('labels')}</span><MultiPicker label={t('labels')} placeholder={t('viewAll')} options={data.labels.map(label => ({ value: label, label }))} values={selectedLabels} onChange={labels => onFiltersChange({ ...filters, label: undefined, labels: labels.length ? labels : undefined })} /></div>
              <div className="board-filter-field"><span>{t('filterStatus')}</span><MultiPicker label={t('filterStatus')} placeholder={t('viewAll')} options={statuses.map(status => ({ value: String(status.id), label: status.name }))} values={(filters.statusIds || []).map(String)} onChange={values => { const ids = values.map(Number).filter(Number.isFinite); onFiltersChange({ ...filters, statusIds: ids.length ? ids : undefined }); }} /></div>
              <div className="board-filter-field"><span>{t('filterPriority')}</span><MultiPicker label={t('filterPriority')} placeholder={t('viewAll')} options={priorities.map(priority => ({ value: String(priority.id), label: priority.name }))} values={(filters.priorityIds || []).map(String)} onChange={values => { const ids = values.map(Number).filter(Number.isFinite); onFiltersChange({ ...filters, priorityIds: ids.length ? ids : undefined }); }} /></div>
              <div className="board-filter-field"><span>{t('release')}</span><Picker label={t('release')} placeholder={t('viewAll')} options={data.versions.map(version => ({ value: String(version.id), label: version.name, description: version.status === 'closed' ? t('closed') : undefined }))} value={filters.versionId === undefined ? undefined : String(filters.versionId)} onChange={value => onFiltersChange({ ...filters, versionId: value ? Number(value) : undefined })} clearable /></div>
              <label className="closed-filter"><input type="checkbox" checked={!!filters.includeClosed} onChange={event => onFiltersChange({ ...filters, includeClosed: event.target.checked || undefined })} />{t('includeClosed')}</label>
            </div>
            <div className="board-filter-footer"><span className="filter-result-count">{t('issueCount', { count: filtered.length })}</span><Button size="sm" variant="outline" onClick={() => setSavingView(true)}>{t('saveView')}</Button></div>
            {savingView && <form className="board-filter-save" onSubmit={submitSavedView}><input autoFocus aria-label={t('viewName')} placeholder={t('viewName')} value={viewName} onChange={event => setViewName(event.target.value)} /><Button type="submit" size="sm" variant="primary" disabled={!viewName.trim()}>{t('save')}</Button><Button type="button" size="sm" onClick={() => setSavingView(false)}>{t('cancel')}</Button></form>}
          </div>
        </Popover>
        <div className="board-sort-picker"><Picker label={t('sort')} options={sortOptions} value={`${settings.sort.field}:${settings.sort.direction}`} onChange={changeSort} /></div>
        <Button variant="primary" onClick={() => onCreateIssue()} disabled={!canWrite} data-testid="new-issue"><Plus size={16} />{t('create')}</Button>
      </div>
    </div>

    <nav className="board-view-switcher" aria-label={t('boardViews')}>
      {(['all', 'mine', 'watching', 'backlog'] as const).map(item => {
        const active = item === 'mine' ? mineActive : item === 'all' ? view === 'all' && !mineActive : item === 'backlog' ? view === 'backlog' : item === view;
        return <button key={item} type="button" className={`board-view-button${active ? ' is-active' : ''}`} aria-pressed={active} onClick={() => changeView(item)}>{t(viewLabelKeys[item])}</button>;
      })}
      {savedViews.length > 0 && <span className="board-view-divider" aria-hidden="true" />}
      {savedViews.map(saved => <span className="saved-filter-item" key={saved.id}><button type="button" className={`saved-filter-button${activeSaved(saved) ? ' is-active' : ''}`} aria-pressed={activeSaved(saved)} onClick={() => onSelectSavedView(saved)}>{saved.name}</button><IconButton label={`${t('deleteView')}: ${saved.name}`} className="saved-filter-remove" onClick={() => onDeleteSavedView(saved)}><X size={13} /></IconButton></span>)}
    </nav>

    {activeChips.length > 0 && <div className="board-active-filters" aria-label={t('activeFilters')}><span className="active-filter-label">{t('activeFilters')}:</span>{activeChips.map(chip => <button key={chip.key} type="button" className="filter-chip" onClick={chip.remove} aria-label={`${t('clear')} · ${chip.label}`} title={`${t('clear')} · ${chip.label}`}>{chip.label}<X size={12} /></button>)}<Button size="sm" variant="quiet" onClick={clearFilters}>{t('clear')}</Button></div>}

    {view !== 'backlog' && <div className="board-hint"><span><CalendarDays size={15} />{t('roadmap')}</span><span>{t('keepRoadmapHint')}</span></div>}
    {filtered.length === 0 && columns.length > 0 && <p className="board-empty-hint" role="status">{hasFilters ? t('emptySearch') : t('noIssues')} · {t('noIssuesHint')}</p>}
    {columns.length === 0 ? <div className="empty-state board-empty"><div className="empty-illustration"><Search size={24} /></div><h2>{hasFilters ? t('emptySearch') : t('noIssues')}</h2><p>{t('noIssuesHint')}</p>{!hasFilters && canWrite && <Button variant="primary" onClick={() => onCreateIssue()}><Plus size={15} />{t('createFirstIssue')}</Button>}</div> : <DndContext sensors={sensors} onDragStart={(event) => setDraggedId(Number(String(event.active.id).replace('issue:', '')))} onDragCancel={() => setDraggedId(undefined)} onDragEnd={onDragEnd}>
      <div className="board-scroll"><div className="board-lanes">
        {columns.map((column) => <Lane key={column.id} column={{ ...column, issues: sortIssues(column.issues, priorities, settings.sort) }} data={data} statuses={statuses} priorities={priorities} canWrite={canWrite} pendingIssueIds={pendingIssueIds} onOpenIssue={onOpenIssue} onCreateIssue={onCreateIssue} onToast={onToast} activeIssueId={draggedId} />)}
      </div></div>
      <DragOverlay>{draggedId ? (() => { const issue = data.issues.find((entry) => entry.id === draggedId); return issue ? <BoardCard issue={issue} data={data} statuses={statuses} priorities={priorities} canWrite={false} onOpen={onOpenIssue} onToast={onToast} isDragging /> : null; })() : null}</DragOverlay>
    </DndContext>}
    {!canWrite && <Notice className="board-readonly-note">{t('readOnlyNote')}</Notice>}
  </main>;
}
