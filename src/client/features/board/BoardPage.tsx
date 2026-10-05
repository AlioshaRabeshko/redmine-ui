import { useMemo, useState, type CSSProperties } from 'react';
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Bell, CalendarDays, ChevronDown, CircleDot, Clock3, Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AppSettings, BoardData, Filters, Issue, Notification, Person, Priority, Project, SavedView, Status, View } from '../../../shared/types';
import { filterIssues, groupBoard, sortIssues, toggleAssignedToMe } from '../../../shared/domain';
import { Avatar, Button, IconButton } from '../../components/ui';
import { MultiPicker, PeoplePicker, Picker, Popover } from '../../components/pickers';
import { groupUnreadNotifications, oldestUnreadNotification } from './unreadNotifications';
import { BacklogList } from './BacklogList';
import './board-round3.css';
import './board-round4.css';

export interface BoardPageProps {
  project: Project;
  data: BoardData;
  statuses: Status[];
  priorities: Priority[];
  me: Person;
  settings: AppSettings;
  view: View;
  filters: Filters;
  unreadNotifications: Notification[];
  canWrite: boolean;
  pendingIssueIds: ReadonlySet<number>;
  checkingIssueIds?: ReadonlySet<number>;
  onFiltersChange: (filters: Filters) => void;
  onSettingsChange: (patch: Partial<AppSettings>) => void;
  onViewChange: (view: View) => void;
  onSelectSavedView: (saved: SavedView) => void;
  onDeleteSavedView: (saved: SavedView) => void;
  onOpenIssue: (issue: Issue) => void;
  onOpenNotification: (notification: Notification) => void;
  onCreateIssue: (defaults?: { statusId?: number; fixedVersionId?: number | null }) => void;
  onMoveIssue: (issue: Issue, target: { statusId?: number; fixedVersionId?: number | null }) => void;
  onSaveView: (name: string, filters: Filters, view: View) => void;
  onToast: (message: string) => void;
  savedViews: SavedView[];
}

const defaultFilters: Filters = {};

function releaseToneClass(versionId: number): string {
  return `release-tone-${Math.abs(versionId) % 6}`;
}

function labelTone(label: string): number {
  const normalized = label.trim().toLocaleLowerCase();
  if (normalized.includes('ci: deployed')) return 2;
  if (normalized.includes('ci: failed') || normalized.includes('urgent') || normalized.includes('blocked')) return 4;
  if (normalized.includes('ci: in progress')) return 0;
  if (normalized.includes('qa') || normalized.includes('review')) return 1;
  let hash = 0;
  for (const character of normalized) hash = (hash * 31 + character.codePointAt(0)!) | 0;
  return Math.abs(hash) % 6;
}

function BoardCard({ issue, data, statuses, priorities, canWrite, pending = false, checking = false, onOpen, isDragging = false, unreadCount = 0, oldestUnread, onOpenNotification }: {
  issue: Issue; data: BoardData; statuses: Status[]; priorities: Priority[]; canWrite: boolean; pending?: boolean; checking?: boolean; onOpen: (issue: Issue) => void; isDragging?: boolean;
  unreadCount?: number; oldestUnread?: Notification; onOpenNotification?: (notification: Notification) => void;
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
  const pinnedInStatusLane = activeVersion && status?.key !== 'deploy';
  return <article ref={setNodeRef} style={style} className={`issue-card${activeVersion ? ` issue-card-roadmap ${releaseToneClass(activeVersion.id)}` : ''}${isDragging ? ' issue-card-overlay' : ''}${pending ? ' issue-card-pending' : ''}${unreadCount > 0 ? ' has-unread' : ''}`} data-testid={`issue-card-${issue.id}`} data-issue-id={issue.id} aria-busy={pending || undefined}>
    <div className="card-hit-area" {...attributes} {...listeners} role="button" tabIndex={pending ? -1 : 0} aria-disabled={pending} aria-label={`#${issue.id} ${issue.subject}`} onClick={() => !pending && onOpen(issue)} onKeyDown={(event) => { if (!pending && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen(issue); } }}>
      <div className="card-topline">
        <span className="issue-ref">{issue.trackerName} <span>#{issue.id}</span></span>
        <span className="card-topline-actions">
          {priority && <span className={`priority-mark priority-${Math.max(0, Math.min(4, priority.rank))}`} title={`${t('priorityField')}: ${priority.name}`}><CircleDot size={13} />{priority.name}</span>}
        </span>
      </div>
      <h3>{issue.subject}</h3>
      {issue.labels.length > 0 && <div className="card-labels">{issue.labels.slice(0, 3).map((label) => <span key={label} className={`label-chip label-tone-${labelTone(label)}`} title={label}>{label}</span>)}{issue.labels.length > 3 && <span className="label-more" title={issue.labels.slice(3).join(', ')}>+{issue.labels.length - 3}</span>}</div>}
      {pinnedInStatusLane && <div className="roadmap-row"><span className="roadmap-pill"><CalendarDays size={12} />{activeVersion.name}</span></div>}
      <div className="card-bottom">
        <div className="card-people">
          <span className="person-stack" title={`${t('assignee')}: ${assigned?.name || t('noAssignee')}`}><Avatar person={assigned} size="md" /></span>
          {developer && developer.id !== assigned?.id && <span className="person-mini" title={`${t('developer')}: ${developer.name}`}><Avatar person={developer} role="developer" size="xs" /></span>}
          {qa && qa.id !== assigned?.id && qa.id !== developer?.id && <span className="person-mini qa-mini" title={`${t('qa')}: ${qa.name}`}><Avatar person={qa} role="qa" size="xs" /></span>}
          {author && ![assigned?.id, developer?.id, qa?.id].includes(author.id) && <span className="person-mini author-mini" title={`${t('author')}: ${author.name}`}><Avatar person={author} size="xs" /></span>}
        </div>
        <div className="card-meta">
          {pending && <span className="actual-status">{checking ? t('checkingIssue') : t('savingIssue')}</span>}
          {overdue && <span className="due-chip due-overdue"><Clock3 size={12} />{t('overdue')}</span>}
          {!!issue.dueDate && !overdue && <span className="due-chip"><Clock3 size={12} />{new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' }).format(new Date(`${issue.dueDate}T00:00:00`))}</span>}
        </div>
      </div>
    </div>
    {unreadCount > 0 && oldestUnread && onOpenNotification && <button type="button" className="issue-unread-badge" data-testid={`issue-unread-badge-${issue.id}`} aria-label={`${t('openOldestUnreadEvent', { count: unreadCount })} · #${issue.id}`} title={`${t('openOldestUnreadEvent', { count: unreadCount })} · #${issue.id}`} onClick={event => { event.stopPropagation(); onOpenNotification(oldestUnread); }}>
      <Bell size={13} aria-hidden="true" />{unreadCount}
    </button>}
    <button className="card-open-action" type="button" onClick={() => onOpen(issue)} aria-label={t('open')}><ChevronDown size={14} /></button>
  </article>;
}

function Lane({ column, data, statuses, priorities, canWrite, pendingIssueIds, checkingIssueIds, onOpenIssue, onOpenNotification, notificationsByIssue, onCreateIssue, activeIssueId }: {
  column: ReturnType<typeof groupBoard>[number]; data: BoardData; statuses: Status[]; priorities: Priority[]; canWrite: boolean; pendingIssueIds: ReadonlySet<number>; checkingIssueIds: ReadonlySet<number>; onOpenIssue: (issue: Issue) => void; onOpenNotification: (notification: Notification) => void; notificationsByIssue: Map<number, Notification[]>; onCreateIssue: BoardPageProps['onCreateIssue']; activeIssueId?: number;
}) {
  const { t, i18n } = useTranslation();
  const { isOver, setNodeRef } = useDroppable({ id: `lane:${column.id}`, disabled: !canWrite });
  const road = Boolean(column.version);
  return <section className={`board-lane${road ? ` lane-roadmap ${releaseToneClass(column.version!.id)}` : ''}${isOver ? ' lane-over' : ''}`} data-testid={`lane-${column.id}`} aria-label={column.name}>
    <header className="lane-header">
      <span className={`lane-dot${road ? ' lane-dot-roadmap' : ` dot-${column.status?.key || 'unknown'}`}`} />
      <h2>{column.name}</h2>
      {road && <span className="lane-roadmap-icon" title={t('releaseLaneHint')} aria-label={t('releaseLaneHint')}><CalendarDays size={14} /></span>}
      <span className="lane-count">{column.issues.length}</span>
      <IconButton className="lane-create" label={t('createInColumn', { column: column.name })} disabled={!canWrite} onClick={() => onCreateIssue({
        statusId: column.status?.id ?? statuses.find(status => status.key === 'todo')?.id ?? statuses[0]?.id,
        fixedVersionId: column.version?.id ?? null,
      })}><Plus size={16} /></IconButton>
    </header>
    {road && column.version?.dueDate && <div className="lane-caption">{t('dueDate')} · {new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' }).format(new Date(`${column.version.dueDate}T00:00:00`))}</div>}
    <div className="lane-content">
      <div className="lane-dropzone" ref={setNodeRef}>
        {column.issues.map((issue) => {
          const unread = notificationsByIssue.get(issue.id) || [];
          return <BoardCard key={issue.id} issue={issue} data={data} statuses={statuses} priorities={priorities} canWrite={canWrite} pending={pendingIssueIds.has(issue.id)} checking={checkingIssueIds.has(issue.id)} onOpen={onOpenIssue} isDragging={activeIssueId === issue.id} unreadCount={unread.length} oldestUnread={oldestUnreadNotification(unread)} onOpenNotification={onOpenNotification} />;
        })}
        {column.issues.length === 0 && <div className="lane-empty">{isOver ? <span>{t('moveTo')} {column.name}</span> : <span className="lane-empty-mark">· · ·</span>}</div>}
      </div>
    </div>
  </section>;
}

const noPendingIssues: ReadonlySet<number> = new Set();

export function BoardPage({ project, data, statuses, priorities, me, settings, view, filters, unreadNotifications, canWrite, pendingIssueIds, checkingIssueIds = noPendingIssues, onFiltersChange, onSettingsChange, onViewChange, onSelectSavedView, onDeleteSavedView, onOpenIssue, onOpenNotification, onCreateIssue, onMoveIssue, onSaveView, savedViews }: BoardPageProps) {
  const { t } = useTranslation();
  const [showFilters, setShowFilters] = useState(false);
  const [savingView, setSavingView] = useState(false);
  const [viewName, setViewName] = useState('');
  const [draggedId, setDraggedId] = useState<number>();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const notificationsByIssue = useMemo(() => groupUnreadNotifications(unreadNotifications), [unreadNotifications]);
  const unreadIssueIds = useMemo(() => new Set(notificationsByIssue.keys()), [notificationsByIssue]);
  const filtered = useMemo(() => sortIssues(filterIssues(data.issues, statuses, view, me.id, filters, data.members, unreadIssueIds), priorities, settings.sort), [data.issues, data.members, statuses, priorities, view, me.id, filters, settings.sort, unreadIssueIds]);
  const columns = useMemo(() => groupBoard(filtered, statuses, data.versions, view), [filtered, statuses, data.versions, view]);
  const selectedLabels = [...new Set([...(filters.labels || []), ...(filters.label ? [filters.label] : [])])];
  const hasFilters = Boolean(filters.assignedToMe || filters.assigneeId !== undefined || selectedLabels.length || filters.search || filters.statusIds?.length || filters.priorityIds?.length || filters.versionId !== undefined || filters.includeClosed || filters.hasNotifications);
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
  if (filters.hasNotifications) activeChips.push({ key: 'hasNotifications', label: t('unreadNotificationsFilter'), remove: () => onFiltersChange({ ...filters, hasNotifications: undefined }) });
  const sortOptions = (['priority', 'updated', 'created', 'id', 'subject'] as const).flatMap(field => (['desc', 'asc'] as const).map(direction => ({
    value: `${field}:${direction}`,
    label: `${t(field === 'id' ? 'issueId' : field === 'subject' ? 'subject' : field)} · ${t(direction)}`,
  })));
  const viewLabelKeys: Record<View, string> = { all: 'viewAll', mine: 'viewMine', watching: 'viewWatching', backlog: 'viewBacklog' };
  const createDefaults = view === 'backlog' ? { statusId: statuses.find(status => status.key === 'backlog')?.id } : undefined;
  const background = settings.projectBackgrounds?.[project.id];
  const backgroundStyle = background ? { '--project-background': `url("${background}")` } as CSSProperties : undefined;
  return <main className={`page board-page${background ? ' has-project-background' : ''}`} style={backgroundStyle} data-testid="board" data-modal-focus-fallback tabIndex={-1}>
    <h1 className="sr-only">{view === 'backlog' ? t('backlog') : t('board')} · {project.name}</h1>
    <div className="board-toolbar">
      <nav className="board-view-switcher" aria-label={t('boardViews')}>
        {(['all', 'mine', 'watching', 'backlog'] as const).map(item => {
          const active = item === 'mine' ? mineActive : item === 'all' ? view === 'all' && !mineActive : item === 'backlog' ? view === 'backlog' : item === view;
          return <button key={item} type="button" className={`board-view-button${active ? ' is-active' : ''}`} aria-pressed={active} onClick={() => changeView(item)}>{t(viewLabelKeys[item])}</button>;
        })}
        {savedViews.length > 0 && <span className="board-view-divider" aria-hidden="true" />}
        {savedViews.map(saved => <span className="saved-filter-item" key={saved.id}><button type="button" className={`saved-filter-button${activeSaved(saved) ? ' is-active' : ''}`} aria-pressed={activeSaved(saved)} onClick={() => onSelectSavedView(saved)}>{saved.name}</button><IconButton label={`${t('deleteView')}: ${saved.name}`} className="saved-filter-remove" onClick={() => onDeleteSavedView(saved)}><X size={13} /></IconButton></span>)}
      </nav>
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
              <label className="closed-filter"><input type="checkbox" checked={!!filters.hasNotifications} onChange={event => onFiltersChange({ ...filters, hasNotifications: event.target.checked || undefined })} />{t('unreadNotificationsFilter')}</label>
              <label className="closed-filter"><input type="checkbox" checked={!!filters.includeClosed} onChange={event => onFiltersChange({ ...filters, includeClosed: event.target.checked || undefined })} />{t('includeClosed')}</label>
            </div>
            <div className="board-filter-footer"><span className="filter-result-count">{t('issueCount', { count: filtered.length })}</span><Button size="sm" variant="outline" onClick={() => setSavingView(true)}>{t('saveView')}</Button></div>
            {savingView && <form className="board-filter-save" onSubmit={submitSavedView}><input autoFocus aria-label={t('viewName')} placeholder={t('viewName')} value={viewName} onChange={event => setViewName(event.target.value)} /><Button type="submit" size="sm" variant="primary" disabled={!viewName.trim()}>{t('save')}</Button><Button type="button" size="sm" onClick={() => setSavingView(false)}>{t('cancel')}</Button></form>}
          </div>
        </Popover>
        <div className="board-sort-picker"><Picker label={t('sort')} options={sortOptions} value={`${settings.sort.field}:${settings.sort.direction}`} onChange={changeSort} /></div>
        <Button variant="primary" onClick={() => onCreateIssue(createDefaults)} disabled={!canWrite} data-testid="new-issue"><Plus size={16} />{t('create')}</Button>
      </div>
    </div>

    {activeChips.length > 0 && <div className="board-active-filters" aria-label={t('activeFilters')}><span className="active-filter-label">{t('activeFilters')}:</span>{activeChips.map(chip => <button key={chip.key} type="button" className="filter-chip" onClick={chip.remove} aria-label={`${t('clear')} · ${chip.label}`} title={`${t('clear')} · ${chip.label}`}>{chip.label}<X size={12} /></button>)}<Button size="sm" variant="quiet" onClick={clearFilters}>{t('clear')}</Button></div>}

    {view !== 'backlog' && filtered.length === 0 && columns.length > 0 && <p className="board-empty-hint" role="status">{hasFilters ? t('emptySearch') : t('noIssues')} · {t('noIssuesHint')}</p>}
    {view === 'backlog' ? <BacklogList issues={filtered} data={data} priorities={priorities} statuses={statuses} canWrite={canWrite} pendingIssueIds={pendingIssueIds} checkingIssueIds={checkingIssueIds} notificationsByIssue={notificationsByIssue} onOpenIssue={onOpenIssue} onOpenNotification={onOpenNotification} onMoveIssue={onMoveIssue} />
      : columns.length === 0 ? <div className="empty-state board-empty"><div className="empty-illustration"><Search size={24} /></div><h2>{hasFilters ? t('emptySearch') : t('noIssues')}</h2><p>{t('noIssuesHint')}</p>{!hasFilters && canWrite && <Button variant="primary" onClick={() => onCreateIssue()}><Plus size={15} />{t('createFirstIssue')}</Button>}</div> : <DndContext sensors={sensors} onDragStart={(event) => setDraggedId(Number(String(event.active.id).replace('issue:', '')))} onDragCancel={() => setDraggedId(undefined)} onDragEnd={onDragEnd}>
      <div className="board-scroll"><div className="board-lanes">
        {columns.map((column) => <Lane key={column.id} column={column} data={data} statuses={statuses} priorities={priorities} canWrite={canWrite} pendingIssueIds={pendingIssueIds} checkingIssueIds={checkingIssueIds} onOpenIssue={onOpenIssue} onOpenNotification={onOpenNotification} notificationsByIssue={notificationsByIssue} onCreateIssue={onCreateIssue} activeIssueId={draggedId} />)}
      </div></div>
      <DragOverlay>{draggedId ? (() => { const issue = data.issues.find((entry) => entry.id === draggedId); return issue ? <BoardCard issue={issue} data={data} statuses={statuses} priorities={priorities} canWrite={false} onOpen={onOpenIssue} isDragging /> : null; })() : null}</DragOverlay>
    </DndContext>}
  </main>;
}
