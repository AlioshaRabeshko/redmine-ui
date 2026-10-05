import { useState } from 'react';
import { Archive, Bell, CheckCheck, ChevronDown, Inbox, MessageSquareText, Circle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Notification, Project } from '../../../shared/types';
import { Avatar, Button } from '../../components/ui';
import { groupNotificationsByIssue } from '../../lib/notificationGroups';

export function InboxPage({ notifications, projects, archived, onToggleArchived, onMarkRead, onMarkManyRead, onOpenIssue }: {
  notifications: Notification[]; projects: Project[]; archived: boolean; onToggleArchived: () => void;
  onMarkRead: (notification: Notification) => void; onMarkManyRead: (notifications: Notification[]) => void; onOpenIssue: (notification: Notification) => void;
}) {
  const { t, i18n } = useTranslation();
  const groups = groupNotificationsByIssue(notifications);
  const [expandedIssueIds, setExpandedIssueIds] = useState<Set<number>>(() => new Set());
  const toggleExpanded = (issueId: number) => setExpandedIssueIds((current) => {
    const next = new Set(current);
    if (next.has(issueId)) next.delete(issueId); else next.add(issueId);
    return next;
  });
  const markAllRead = () => onMarkManyRead(notifications.filter((notification) => !notification.readAt));

  return <main className="page inbox-page" data-testid="notification-center">
    <div className="page-heading">
      <div><div className="eyebrow"><Bell size={13} />{t('workspace')}</div><h1>{t('inboxTitle')}</h1><p className="page-subtitle">{archived ? t('archived') : t('unread')} · {notifications.length}</p></div>
      <div className="heading-actions"><Button variant={archived ? 'outline' : 'soft'} onClick={onToggleArchived}>{archived ? <Bell size={15} /> : <Archive size={15} />}{archived ? t('unread') : t('archived')}</Button>{!archived && notifications.some((notification) => !notification.readAt) && <Button onClick={markAllRead}><CheckCheck size={15} />{t('markAllRead')}</Button>}</div>
    </div>
    <section className="inbox-list">
      {groups.length === 0 ? <div className="empty-state"><div className="empty-illustration"><Inbox size={24} /></div><h2>{t('noNotifications')}</h2><p>{t('noNotificationsHint')}</p></div> : groups.map((group) => {
        const expanded = expandedIssueIds.has(group.issueId);
        const latest = group.notifications[0]!;
        const project = projects.find((item) => item.id === group.projectId);
        const latestDate = new Date(latest.createdOn);
        const unreadEvents = group.notifications.filter((notification) => !notification.readAt);
        const eventsId = `notification-group-events-${group.issueId}`;
        return <article className={`notification-group${archived ? ' notification-group-archived' : ''}`} key={group.issueId} data-testid={`notification-group-${group.issueId}`}>
          <div className="notification-group-header">
            <button type="button" className="notification-group-toggle" onClick={() => toggleExpanded(group.issueId)} aria-expanded={expanded} aria-controls={eventsId}>
              <span className="notification-avatar"><Avatar person={latest.actor} size="md" />{unreadEvents.length > 0 && <Circle size={8} className="unread-indicator" fill="currentColor" />}</span>
              <span className="notification-group-meta">
                <strong>{t('notificationsForIssue', { issueId: group.issueId })}</strong>
                <span className="notification-group-latest"><b>{latest.actor.name}</b> {latest.text}</span>
                <small>{project?.name || t('projects')} · {t('notificationEventCount', { count: group.notifications.length })} · {new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(latestDate)}</small>
              </span>
              <ChevronDown size={16} className="notification-group-chevron" aria-hidden="true" />
            </button>
            {unreadEvents.length > 0 && <div className="notification-group-actions"><Button size="sm" variant="quiet" className="notification-group-mark-read" onClick={() => onMarkManyRead(unreadEvents)}><CheckCheck size={14} />{t('markRead')}</Button></div>}
          </div>
          <div className="notification-group-events" id={eventsId} hidden={!expanded}>
            {group.notifications.map((notification) => {
              const date = new Date(notification.createdOn);
              const isUnread = !notification.readAt;
              return <article className={`notification-row${isUnread ? '' : ' notification-read'}`} key={notification.id} data-testid={`notification-${notification.id}`}>
                <button type="button" className="notification-open" onClick={() => onOpenIssue(notification)} aria-label={`${notification.actor.name}: ${notification.text}`}>
                  <span className="notification-avatar"><Avatar person={notification.actor} size="md" />{isUnread && <Circle size={8} className="unread-indicator" fill="currentColor" />}</span>
                  <span className="notification-content">
                    <span className="notification-title"><strong>{notification.actor.name}</strong><span>{notification.text}</span></span>
                    <span className="notification-subline"><span>#{notification.issueId}</span><span>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(date)}</span></span>
                    {notification.kind.toLowerCase().includes('comment') && <span className="notification-kind"><MessageSquareText size={13} />{t('comments')}</span>}
                  </span>
                </button>
                {isUnread && <Button size="sm" variant="quiet" onClick={() => onMarkRead(notification)}><CheckCheck size={14} />{t('markRead')}</Button>}
              </article>;
            })}
          </div>
        </article>;
      })}
    </section>
  </main>;
}
