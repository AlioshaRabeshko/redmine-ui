import { useMemo, useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, ArrowDownUp, CalendarDays, Check, ChevronDown, CircleDot, Clock3, Filter, Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AppSettings, BoardData, Filters, Issue, Person, Priority, Project, SavedView, Status, View } from '../../../shared/types';
import { filterIssues, groupBoard, sortIssues } from '../../../shared/domain';
import { Avatar, Button, IconButton, Notice } from '../../components/ui';

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
  onSettingsChange: (settings: AppSettings) => void;
  onOpenIssue: (issue: Issue) => void;
  onCreateIssue: () => void;
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
  return <article ref={setNodeRef} style={style} className={`issue-card${activeVersion ? ' issue-card-roadmap' : ''}${isDragging ? ' issue-card-overlay' : ''}${pending ? ' issue-card-pending' : ''}`} data-testid={`issue-card-${issue.id}`} aria-busy={pending || undefined}>
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

function Lane({ column, data, statuses, priorities, canWrite, pendingIssueIds, onOpenIssue, onToast, activeIssueId }: {
  column: ReturnType<typeof groupBoard>[number]; data: BoardData; statuses: Status[]; priorities: Priority[]; canWrite: boolean; pendingIssueIds: ReadonlySet<number>; onOpenIssue: (issue: Issue) => void; onToast: (message: string) => void; activeIssueId?: number;
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
    </header>
    {road && <div className="lane-caption">{column.version?.dueDate ? `${t('dueDate')} · ${new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' }).format(new Date(`${column.version.dueDate}T00:00:00`))}` : t('roadmap')}</div>}
    <div className="lane-content">
      {column.issues.map((issue) => <BoardCard key={issue.id} issue={issue} data={data} statuses={statuses} priorities={priorities} canWrite={canWrite} pending={pendingIssueIds.has(issue.id)} onOpen={onOpenIssue} onToast={onToast} isDragging={activeIssueId === issue.id} />)}
      {column.issues.length === 0 && <div className="lane-empty">{isOver ? <span>{t('moveTo')} {column.name}</span> : <span className="lane-empty-mark">· · ·</span>}</div>}
    </div>
  </section>;
}

export function BoardPage({ project, data, statuses, priorities, me, settings, view, filters, canWrite, pendingIssueIds, onFiltersChange, onSettingsChange, onOpenIssue, onCreateIssue, onMoveIssue, onSaveView, onToast, savedViews }: BoardPageProps) {
  const { t } = useTranslation();
  const [showFilters, setShowFilters] = useState(false);
  const [savingView, setSavingView] = useState(false);
  const [viewName, setViewName] = useState('');
  const [draggedId, setDraggedId] = useState<number>();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const filtered = useMemo(() => sortIssues(filterIssues(data.issues, statuses, view, me.id, filters), priorities, settings.sort), [data.issues, statuses, priorities, view, me.id, filters, settings.sort]);
  const columns = useMemo(() => groupBoard(filtered, statuses, data.versions, view), [filtered, statuses, data.versions, view]);
  const people = [...data.members].sort((a, b) => a.name.localeCompare(b.name));
  const hasFilters = Boolean(filters.assigneeId !== undefined || filters.label || filters.search || filters.statusIds?.length || filters.priorityIds?.length || filters.versionId !== undefined || filters.includeClosed);
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
  const setSingle = (key: keyof Filters, value: string) => {
    const n = value ? Number(value) : undefined;
    if (key === 'label') onFiltersChange({ ...filters, label: value || undefined });
    else if (key === 'includeClosed') onFiltersChange({ ...filters, includeClosed: value === 'true' || undefined });
    else onFiltersChange({ ...filters, [key]: Number.isFinite(n) ? n : undefined });
  };
  const clearFilters = () => { onFiltersChange(defaultFilters); };
  const submitSavedView = (event: React.FormEvent) => { event.preventDefault(); if (viewName.trim()) { onSaveView(viewName.trim(), filters, view); setViewName(''); setSavingView(false); } };
  const updateSort = (field: AppSettings['sort']['field'], direction: AppSettings['sort']['direction']) => onSettingsChange({ ...settings, sort: { field, direction } });
  return <main className="page board-page" data-testid="board">
    <div className="page-heading board-title-row">
      <div><div className="eyebrow">{project.identifier}</div><h1>{view === 'backlog' ? t('backlog') : t('board')}</h1><p className="page-subtitle">{project.description || t('workspace')} <span className="inline-separator">·</span> {t('issueCount', { count: data.total })}</p></div>
      <div className="heading-actions">
        <button type="button" className={`filter-toggle${showFilters || hasFilters ? ' is-active' : ''}`} onClick={() => setShowFilters((v) => !v)}><SlidersHorizontal size={16} />{t('filters')}{hasFilters && <span className="filter-dot" />}</button>
        <div className="sort-control"><ArrowDownUp size={15} /><label className="sr-only" htmlFor="sort-select">{t('sort')}</label><select id="sort-select" value={`${settings.sort.field}:${settings.sort.direction}`} onChange={(e) => { const [field, direction] = e.target.value.split(':') as [AppSettings['sort']['field'], AppSettings['sort']['direction']]; updateSort(field, direction); }}>
          {(['priority', 'updated', 'created', 'id', 'subject'] as const).map((field) => <optgroup key={field} label={t(field === 'id' ? 'issueId' : field === 'subject' ? 'subject' : field)}><option value={`${field}:desc`}>{t('desc')}</option><option value={`${field}:asc`}>{t('asc')}</option></optgroup>)}
        </select></div>
        <Button variant="primary" onClick={onCreateIssue} disabled={!canWrite} data-testid="new-issue"><Plus size={16} />{t('create')}</Button>
      </div>
    </div>

    {showFilters && <section className="filter-panel" aria-label={t('filters')}>
      <div className="filter-panel-head"><div><Filter size={16} /><strong>{t('filters')}</strong></div>{hasFilters && <Button size="sm" variant="quiet" onClick={clearFilters}><X size={14} />{t('clear')}</Button>}</div>
      <div className="filter-grid">
        <label className="filter-field"><span>{t('filterAssignee')}</span><select value={filters.assigneeId ?? ''} onChange={(e) => setSingle('assigneeId', e.target.value)}><option value="">{t('all')}</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
        <label className="filter-field"><span>{t('label')}</span><select value={filters.label || ''} onChange={(e) => setSingle('label', e.target.value)}><option value="">{t('all')}</option>{data.labels.map((label) => <option key={label}>{label}</option>)}</select></label>
        <label className="filter-field"><span>{t('filterStatus')}</span><select multiple value={filters.statusIds?.map(String) || []} onChange={(e) => onFiltersChange({ ...filters, statusIds: [...e.target.selectedOptions].map((o) => Number(o.value)) })}>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select></label>
        <label className="filter-field"><span>{t('filterPriority')}</span><select multiple value={filters.priorityIds?.map(String) || []} onChange={(e) => onFiltersChange({ ...filters, priorityIds: [...e.target.selectedOptions].map((o) => Number(o.value)) })}>{priorities.map((priority) => <option key={priority.id} value={priority.id}>{priority.name}</option>)}</select></label>
        <label className="filter-field"><span>{t('release')}</span><select value={filters.versionId ?? ''} onChange={(e) => setSingle('versionId', e.target.value)}><option value="">{t('all')}</option>{data.versions.map((version) => <option key={version.id} value={version.id}>{version.name}</option>)}</select></label>
        <label className="closed-filter"><input type="checkbox" checked={!!filters.includeClosed} onChange={(e) => onFiltersChange({ ...filters, includeClosed: e.target.checked || undefined })} />{t('includeClosed')}</label>
      </div>
      <div className="filter-panel-footer">
        <span className="filter-result-count">{t('issueCount', { count: filtered.length })}</span>
        <div className="saved-view-actions">{savedViews.length > 0 && <span className="saved-view-label">{t('savedViews')} · {savedViews.length}</span>}
          <Button size="sm" variant="outline" onClick={() => setSavingView(true)}>{t('saveView')}</Button>
        </div>
      </div>
      {savingView && <form className="save-view-form" onSubmit={submitSavedView}><input autoFocus aria-label={t('viewName')} placeholder={t('viewName')} value={viewName} onChange={(e) => setViewName(e.target.value)} /><Button type="submit" size="sm" variant="primary" disabled={!viewName.trim()}>{t('save')}</Button><Button type="button" size="sm" onClick={() => setSavingView(false)}>{t('cancel')}</Button></form>}
    </section>}

    {view !== 'backlog' && <div className="board-hint"><span><CalendarDays size={15} />{t('roadmap')}</span><span>{t('keepRoadmapHint')}</span></div>}
    {filtered.length === 0 ? <div className="empty-state board-empty"><div className="empty-illustration"><Search size={24} /></div><h2>{hasFilters ? t('emptySearch') : t('noIssues')}</h2><p>{t('noIssuesHint')}</p>{!hasFilters && canWrite && <Button variant="primary" onClick={onCreateIssue}><Plus size={15} />{t('createFirstIssue')}</Button>}</div> : <DndContext sensors={sensors} onDragStart={(event) => setDraggedId(Number(String(event.active.id).replace('issue:', '')))} onDragCancel={() => setDraggedId(undefined)} onDragEnd={onDragEnd}>
      <div className="board-scroll"><div className="board-lanes">
        {columns.map((column) => <Lane key={column.id} column={{ ...column, issues: sortIssues(column.issues, priorities, settings.sort) }} data={data} statuses={statuses} priorities={priorities} canWrite={canWrite} pendingIssueIds={pendingIssueIds} onOpenIssue={onOpenIssue} onToast={onToast} activeIssueId={draggedId} />)}
      </div></div>
      <DragOverlay>{draggedId ? (() => { const issue = data.issues.find((entry) => entry.id === draggedId); return issue ? <BoardCard issue={issue} data={data} statuses={statuses} priorities={priorities} canWrite={false} onOpen={onOpenIssue} onToast={onToast} isDragging /> : null; })() : null}</DragOverlay>
    </DndContext>}
    {!canWrite && <Notice className="board-readonly-note">{t('readOnlyNote')}</Notice>}
  </main>;
}
