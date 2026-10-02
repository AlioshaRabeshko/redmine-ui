import { Bell, CheckCheck, Inbox, MessageSquareText, Archive, Circle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Notification, Project } from '../../../shared/types';
import { Avatar, Button, IconButton } from '../../components/ui';

export function InboxPage({ notifications, projects, archived, onToggleArchived, onMarkRead, onOpenIssue }: {
  notifications: Notification[]; projects: Project[]; archived: boolean; onToggleArchived: () => void; onMarkRead: (notification: Notification) => void; onOpenIssue: (notification: Notification) => void;
}) {
  const { t, i18n } = useTranslation();
  const sorted = [...notifications].sort((a, b) => b.createdOn.localeCompare(a.createdOn));
  return <main className="page inbox-page" data-testid="notification-center">
    <div className="page-heading">
      <div><div className="eyebrow"><Bell size={13} />{t('workspace')}</div><h1>{t('inboxTitle')}</h1><p className="page-subtitle">{archived ? t('archived') : t('unread')} · {notifications.length}</p></div>
      <div className="heading-actions"><Button variant={archived ? 'outline' : 'soft'} onClick={onToggleArchived}>{archived ? <Bell size={15} /> : <Archive size={15} />}{archived ? t('unread') : t('archived')}</Button>{!archived && notifications.length > 0 && <Button onClick={() => notifications.forEach(onMarkRead)}><CheckCheck size={15} />{t('markAllRead')}</Button>}</div>
    </div>
    <section className="inbox-list">
      {sorted.length === 0 ? <div className="empty-state"><div className="empty-illustration"><Inbox size={24} /></div><h2>{t('noNotifications')}</h2><p>{t('noNotificationsHint')}</p></div> : sorted.map((notification) => {
        const project = projects.find((item) => item.id === notification.projectId);
        const date = new Date(notification.createdOn);
        return <article className={`notification-row${archived ? ' notification-read' : ''}`} key={notification.id}>
          <button type="button" className="notification-open" onClick={() => onOpenIssue(notification)} aria-label={`${notification.actor.name}: ${notification.text}`}>
            <span className="notification-avatar"><Avatar person={notification.actor} size="md" />{!archived && <Circle size={8} className="unread-indicator" fill="currentColor" />}</span>
            <span className="notification-content">
              <span className="notification-title"><strong>{notification.actor.name}</strong><span>{notification.text}</span></span>
              <span className="notification-subline"><span className="notification-project">{project?.name || t('projects')}</span><span>#{notification.issueId}</span><span>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(date)}</span></span>
              {notification.kind.toLowerCase().includes('comment') && <span className="notification-kind"><MessageSquareText size={13} />{t('comments')}</span>}
            </span>
          </button>
          {!archived && <Button size="sm" variant="quiet" onClick={() => onMarkRead(notification)}><CheckCheck size={14} />{t('markRead')}</Button>}
        </article>;
      })}
    </section>
  </main>;
}
