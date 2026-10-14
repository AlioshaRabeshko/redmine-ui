import { Bell, CircleDot, CornerDownRight, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AppSettings, AssigneeOption, BoardData, Issue, Notification, Priority, Status } from '../../../shared/types';
import { Avatar } from '../../components/ui';
import { GroupAvatar } from '../../components/GroupAvatar';
import { oldestUnreadNotification } from './unreadNotifications';

type BacklogListProps = {
  issues: Issue[];
  data: BoardData;
  settings: AppSettings;
  priorities: Priority[];
  statuses: Status[];
  canWrite: boolean;
  pendingIssueIds: ReadonlySet<number>;
  checkingIssueIds?: ReadonlySet<number>;
  notificationsByIssue: Map<number, Notification[]>;
  onOpenIssue: (issue: Issue) => void;
  onOpenNotification: (notification: Notification) => void;
  onMoveIssue: (issue: Issue, target: { statusId?: number; fixedVersionId?: number | null }) => void;
};

function exactDate(value: string, locale: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function relativeDate(value: string, locale: string, now: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  const seconds = (timestamp - now) / 1000;
  const absolute = Math.abs(seconds);
  const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] = absolute < 60 ? [seconds, 'second']
    : absolute < 60 * 60 ? [seconds / 60, 'minute']
      : absolute < 24 * 60 * 60 ? [seconds / 3600, 'hour']
        : absolute < 30 * 24 * 60 * 60 ? [seconds / 86400, 'day']
          : absolute < 365 * 24 * 60 * 60 ? [seconds / (30 * 86400), 'month'] : [seconds / (365 * 86400), 'year'];
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(amount), unit);
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

function groupAssigneeOption(data: BoardData, issue: Issue): Extract<AssigneeOption, { type: 'group' }> | undefined {
  if (issue.assignedToType !== 'group' || issue.assignedToId === undefined) return undefined;
  const current = data.assigneeOptions?.find((option): option is Extract<AssigneeOption, { type: 'group' }> =>
    option.type === 'group' && option.id === issue.assignedToId);
  return current ?? { type: 'group', id: issue.assignedToId, name: issue.assignedToName || `#${issue.assignedToId}` };
}

function IssuePeople({ issue, data, settings }: { issue: Issue; data: BoardData; settings: AppSettings }) {
  const { t } = useTranslation();
  const assigned = issue.assignedToType === 'group' ? undefined : data.members.find(person => person.id === issue.assignedToId);
  const assignedGroup = groupAssigneeOption(data, issue);
  const developer = data.members.find(person => person.id === issue.developerId);
  const qa = data.members.find(person => person.id === issue.qaId);
  const author = data.members.find(person => person.id === issue.authorId);
  const assignedLabel = issue.assignedToType === 'group' ? `${t('group')}: ${assignedGroup?.name || t('unknown')}` : `${t('assignee')}: ${assigned?.name || t('noAssignee')}`;
  return <span className="backlog-people" aria-label={[assignedLabel, developer && `${t('developer')}: ${developer.name}`, qa && `${t('qa')}: ${qa.name}`].filter(Boolean).join(', ')}>
    {issue.assignedToType === 'group' ? assignedGroup ? <GroupAvatar group={assignedGroup} override={settings.groupAvatarOverrides[String(assignedGroup.id)]} size="xs" label={assignedLabel} /> : <span className="group-assignee-mark group-assignee-mark-small" role="img" aria-label={assignedLabel} title={assignedLabel}><Users size={14} /></span>
      : <span title={assignedLabel}><Avatar person={assigned} size="xs" /></span>}
    {developer && developer.id !== assigned?.id && <span title={`${t('developer')}: ${developer.name}`}><Avatar person={developer} role="developer" size="xs" /></span>}
    {qa && qa.id !== assigned?.id && qa.id !== developer?.id && <span title={`${t('qa')}: ${qa.name}`}><Avatar person={qa} role="qa" size="xs" /></span>}
    {author && ![assigned?.id, developer?.id, qa?.id].includes(author.id) && <span title={`${t('author')}: ${author.name}`}><Avatar person={author} size="xs" /></span>}
  </span>;
}

export function BacklogList({ issues, data, settings, priorities, statuses, canWrite, pendingIssueIds, checkingIssueIds = new Set(), notificationsByIssue,
  onOpenIssue, onOpenNotification, onMoveIssue }: BacklogListProps) {
  const { t, i18n } = useTranslation();
  const todo = statuses.find(status => status.key === 'todo');
  const locale = i18n.resolvedLanguage || i18n.language;
  const now = Date.now();

  return <section className="backlog-scroll" aria-label={t('backlog')} data-testid="backlog-list">
    {issues.length === 0 ? <div className="backlog-empty" role="status">{t('noIssues')} · {t('noIssuesHint')}</div> : <div className="backlog-rows">
      {issues.map(issue => {
        const priority = priorities.find(item => item.id === issue.priorityId);
        const unread = notificationsByIssue.get(issue.id) || [];
        const target = oldestUnreadNotification(unread);
        const pending = pendingIssueIds.has(issue.id);
        const checking = checkingIssueIds.has(issue.id);
        const createdTooltip = exactDate(issue.createdOn, locale);
        const updatedTooltip = exactDate(issue.updatedOn, locale);
        const focusAfterMove = (button: HTMLButtonElement) => {
          if (document.activeElement !== button) return;
          const row = button.closest<HTMLElement>('.backlog-row');
          const rows = row?.parentElement ? [...row.parentElement.querySelectorAll<HTMLElement>('.backlog-row')] : [];
          const index = row ? rows.indexOf(row) : -1;
          const openButton = (candidate?: HTMLElement) => candidate?.querySelector<HTMLButtonElement>('.backlog-row-open');
          const next = index >= 0 ? rows.slice(index + 1).map(openButton).find(Boolean) : undefined;
          const previous = index >= 0 ? rows.slice(0, index).reverse().map(openButton).find(Boolean) : undefined;
          (next || previous || row?.closest<HTMLElement>('[data-modal-focus-fallback]'))?.focus();
        };
        return <article className={`backlog-row${pending ? ' is-pending' : ''}`} key={issue.id} data-testid={`backlog-row-${issue.id}`} data-issue-id={issue.id} aria-busy={pending || undefined}>
          <button type="button" className="backlog-row-open" onClick={() => onOpenIssue(issue)} aria-label={`${t('open')} · ${issue.trackerName} #${issue.id} · ${issue.subject}`}>
            <span className="backlog-row-heading">
              {priority && <span className={`priority-mark priority-${Math.max(0, Math.min(4, priority.rank))}`} title={`${t('priorityField')}: ${priority.name}`}><CircleDot size={12} aria-hidden="true" />{priority.name}</span>}
              <span className="backlog-issue-ref">{issue.trackerName} <span>#{issue.id}</span></span>
              <span className="backlog-issue-title">{issue.subject}</span>
              {pending && <span className="backlog-saving">{checking ? t('checkingIssue') : t('savingIssue')}</span>}
            </span>
            {issue.labels.length > 0 && <span className="backlog-labels">{issue.labels.map(label => <span className={`label-chip label-tone-${labelTone(label)} backlog-label`} key={label} title={label}>{label}</span>)}</span>}
            <span className="backlog-row-meta">
              <IssuePeople issue={issue} data={data} settings={settings} />
              <span className="backlog-dates">
                <time dateTime={issue.createdOn} title={createdTooltip}><span>{t('createdAt')}:</span> {relativeDate(issue.createdOn, locale, now)}</time>
                <time dateTime={issue.updatedOn} title={updatedTooltip}><span>{t('lastActivity')}:</span> {relativeDate(issue.updatedOn, locale, now)}</time>
              </span>
            </span>
          </button>
          <span className="backlog-row-actions">
            {unread.length > 0 && target && <button type="button" className="backlog-unread-badge" data-testid={`backlog-unread-badge-${issue.id}`}
              aria-label={`${t('openOldestUnreadEvent', { count: unread.length })} · #${issue.id}`} title={`${t('openOldestUnreadEvent', { count: unread.length })} · #${issue.id}`}
              onClick={() => onOpenNotification(target)}><Bell size={13} aria-hidden="true" />{unread.length}</button>}
            <button type="button" className="backlog-move-todo" data-testid={`backlog-move-todo-${issue.id}`} disabled={!canWrite || !todo || pending}
              aria-label={`${t('moveToTodo')} · #${issue.id}`} title={todo ? `${t('moveToTodo')} · ${todo.name}` : t('moveToTodo')}
              onClick={event => { if (!todo || pending) return; focusAfterMove(event.currentTarget); onMoveIssue(issue, { statusId: todo.id, fixedVersionId: issue.fixedVersionId }); }}>
              <CornerDownRight size={14} aria-hidden="true" /><span>{t('moveToTodo')}</span>
            </button>
          </span>
        </article>;
      })}
    </div>}
  </section>;
}

export { exactDate as backlogExactDate, relativeDate as backlogRelativeDate };
