import { useTranslation } from 'react-i18next';
import { Archive, Bell, CheckCheck, Inbox } from 'lucide-react';
import type { Notification, Project } from '../../../shared/types';
import { Avatar, Button } from '../../components/ui';
import { groupNotificationsByIssue } from '../../lib/notificationGroups';
import { presentNotification } from '../../lib/notificationPresentation';
import './inbox-round3.css';

export function InboxPage({ notifications, projects, archived, onToggleArchived, onMarkRead, onMarkManyRead, onOpenIssue }: {
  notifications: Notification[]; projects: Project[]; archived: boolean; onToggleArchived: () => void;
  onMarkRead: (notification: Notification) => void; onMarkManyRead: (notifications: Notification[]) => void; onOpenIssue: (notification: Notification) => void;
}) {
  const { t, i18n } = useTranslation();
  const groups = groupNotificationsByIssue(notifications);
  const markAllRead = () => onMarkManyRead(notifications.filter((notification) => !notification.readAt));
  const formatDate = (value: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

  return <main className="page inbox-page inbox-round3" data-testid="notification-center">
    <div className="page-heading">
      <div><div className="eyebrow"><Bell size={13} />{t('workspace')}</div><h1>{t('inboxTitle')}</h1><p className="page-subtitle">{archived ? t('archived') : t('unread')} · {notifications.length}</p></div>
      <div className="heading-actions"><Button variant={archived ? 'outline' : 'soft'} onClick={onToggleArchived}>{archived ? <Bell size={15} /> : <Archive size={15} />}{archived ? t('unread') : t('archived')}</Button>{!archived && notifications.some((notification) => !notification.readAt) && <Button onClick={markAllRead}><CheckCheck size={15} />{t('markAllRead')}</Button>}</div>
    </div>
    <section className="inbox-list">
      {groups.length === 0 ? <div className="empty-state"><div className="empty-illustration"><Inbox size={24} /></div><h2>{t('noNotifications')}</h2><p>{t('noNotificationsHint')}</p></div> : groups.map((group) => {
        const latest = group.notifications[0]!;
        const project = projects.find((item) => item.id === group.projectId);
        const unreadEvents = group.notifications.filter((notification) => !notification.readAt);
        const issueTitle = group.notifications.find((notification) => notification.issueSubject?.trim())?.issueSubject?.trim()
          ?? t('notificationIssueFallback', { issueId: group.issueId });
        return <article className={`notification-group${archived ? ' notification-group-archived' : ''}`} key={group.issueId} data-testid={`notification-group-${group.issueId}`}>
          <header className="notification-group-header">
            <div className="notification-group-heading">
              <span className="notification-avatar"><Avatar person={latest.actor} size="md" />{unreadEvents.length > 0 && <span className="unread-indicator" aria-hidden="true" />}</span>
              <span className="notification-group-meta">
                <strong><span className="notification-issue-id">#{group.issueId}</span><span>{issueTitle}</span></strong>
                <small>{project?.name || t('projects')} · {t('notificationEventCount', { count: group.notifications.length })} · {formatDate(latest.createdOn)}</small>
              </span>
            </div>
            {unreadEvents.length > 0 && <Button size="sm" variant="quiet" className="notification-group-mark-read" onClick={() => onMarkManyRead(unreadEvents)}><CheckCheck size={14} />{t('markRead')}</Button>}
          </header>
          <div className="notification-group-events" data-testid={`notification-events-${group.issueId}`}>
            {group.notifications.map((notification) => {
              const isUnread = !notification.readAt;
              const presentation = presentNotification(notification, t);
              return <article className={`notification-row${isUnread ? '' : ' notification-read'}`} key={notification.id} data-testid={`notification-${notification.id}`}>
                <button type="button" className="notification-open" onClick={() => onOpenIssue(notification)} aria-label={`${notification.actor.name}: ${presentation.notes || presentation.changes.map((change) => change.field).join(', ') || presentation.fallback}`}>
                  <span className="notification-avatar"><Avatar person={notification.actor} size="md" />{isUnread && <span className="unread-indicator" aria-hidden="true" />}</span>
                  <span className="notification-content">
                    <span className="notification-title"><strong>{notification.actor.name}</strong></span>
                    {presentation.notes && <span className="notification-note">{presentation.notes}</span>}
                    {presentation.changes.length > 0 && <ul className="notification-changes">
                      {presentation.changes.map((change, index) => <li key={`${notification.id}-${index}`}>
                        <strong>{change.field}</strong><span>{change.oldValue}</span><span className="notification-change-arrow" aria-hidden="true">→</span><span>{change.newValue}</span>
                      </li>)}
                    </ul>}
                    {presentation.fallback && <span className="notification-detail-fallback">{presentation.fallback}</span>}
                    <span className="notification-subline"><span>#{notification.issueId}</span><span>{formatDate(notification.createdOn)}</span></span>
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
