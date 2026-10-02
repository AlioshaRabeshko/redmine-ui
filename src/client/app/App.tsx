import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Bell, BellDot, BookOpen, Check, ChevronDown, Command, Inbox, LayoutDashboard, ListTodo, LoaderCircle, PanelLeftClose, PanelLeftOpen, Plus, Rocket, Search, Settings2, ShieldCheck, Sparkles, UserRound, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AppSettings, BoardData, Bootstrap, Command as WorkspaceCommand, CommandResult, Filters, Issue, IssueDetail, Notification, Operation, Person, Project, SavedView, Status, View } from '../../shared/types';
import { api, ApiRequestError, friendlyError, issueUrl } from '../lib/api';
import { isEditableTarget, shortcutForEvent } from '../lib/shortcuts';
import { Avatar, Button, IconButton, Modal, Notice, Spinner, Toast } from '../components/ui';
import { BoardPage } from '../features/board/BoardPage';
import { IssueDialog, CreateIssueDialog, type IssueEditPatch } from '../features/issues/IssueDialog';
import { InboxPage } from '../features/inbox/InboxPage';
import { ReleasesPage } from '../features/releases/ReleasesPage';
import { SettingsPage } from '../features/settings/SettingsPage';

type Screen = 'board' | 'backlog' | 'inbox' | 'releases' | 'settings';

export default function App() {
  const { t } = useTranslation();
  const bootstrap = useQuery({ queryKey: ['bootstrap'], queryFn: () => api.get<Bootstrap>('/api/bootstrap'), retry: false, staleTime: 10_000, refetchOnWindowFocus: true });
  if (bootstrap.isLoading) return <div className="startup-state"><div className="startup-brand"><span className="brand-mark"><LayoutDashboard size={18} /></span><strong>{t('appName')}</strong></div><Spinner label={t('loading')} /></div>;
  if (bootstrap.isError || !bootstrap.data) return <div className="startup-state startup-error"><div className="startup-brand"><span className="brand-mark"><LayoutDashboard size={18} /></span><strong>{t('appName')}</strong></div><div className="empty-illustration"><ShieldCheck size={24} /></div><h1>{t('loadFailed')}</h1><p>{bootstrap.error ? friendlyError(bootstrap.error, t) : t('offline')}</p><Button variant="primary" onClick={() => bootstrap.refetch()}><LoaderCircle size={15} />{t('retry')}</Button></div>;
  return <Workspace key={`${bootstrap.data.mode}-${bootstrap.data.me.id}`} bootstrap={bootstrap.data} onReload={() => bootstrap.refetch()} />;
}

function Workspace({ bootstrap, onReload }: { bootstrap: Bootstrap; onReload: () => void }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState<AppSettings>(bootstrap.settings);
  const [selectedProjectId, setSelectedProjectId] = useState<number>(() => {
    const stored = Number(localStorage.getItem('redmine-workspace:project'));
    return bootstrap.projects.some((project) => project.id === stored) ? stored : bootstrap.projects[0]?.id || 0;
  });
  const [screen, setScreen] = useState<Screen>('board');
  const [view, setView] = useState<View>('all');
  const [filters, setFilters] = useState<Filters>({});
  const [issueId, setIssueId] = useState<number>();
  const [issueOpen, setIssueOpen] = useState(false);
  const [initialJournalId, setInitialJournalId] = useState<number>();
  const [createIssueOpen, setCreateIssueOpen] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<number>();
  const [archived, setArchived] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const [showActivity, setShowActivity] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showQuickMove, setShowQuickMove] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [toastText, setToastText] = useState('');
  const [busySync, setBusySync] = useState(false);
  const [pendingIssueIds, setPendingIssueIds] = useState<Set<number>>(() => new Set());
  const pendingIssueIdsRef = useRef(new Set<number>());
  const scrollPositionsRef = useRef<Record<string, number>>({});
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const project = bootstrap.projects.find((item) => item.id === selectedProjectId) || bootstrap.projects[0];
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const projectRef = useRef(project);
  projectRef.current = project;
  const notify = useCallback((text: string) => setToastText(text), []);

  const boardQuery = useQuery({ queryKey: ['board', selectedProjectId], queryFn: () => api.get<import('../../shared/types').BoardData>(`/api/projects/${selectedProjectId}/board`), enabled: !!selectedProjectId, staleTime: 15_000, retry: 1 });
  const unreadQuery = useQuery({ queryKey: ['notifications', 'unread'], queryFn: () => api.get<Notification[]>('/api/notifications'), staleTime: 15_000, refetchInterval: 30_000 });
  const archivedQuery = useQuery({ queryKey: ['notifications', 'archived'], queryFn: () => api.get<Notification[]>('/api/notifications?archived=true'), enabled: screen === 'inbox' && archived, staleTime: 15_000 });
  const operationsQuery = useQuery({ queryKey: ['operations'], queryFn: () => api.get<Operation[]>('/api/operations'), staleTime: 10_000, refetchInterval: 12_000 });
  const issueQuery = useQuery({ queryKey: ['issue', issueId], queryFn: () => api.get<IssueDetail>(`/api/issues/${issueId}`), enabled: issueOpen && !!issueId, staleTime: 5_000 });
  const board = boardQuery.data;
  const statuses = bootstrap.statuses;
  const canWrite = bootstrap.mode === 'demo' && !bootstrap.readOnly && bootstrap.capabilities.canWrite;
  const members = board?.members || [];
  const activeIssue = board?.issues.find((item) => item.id === issueId);
  const issueDetail = issueQuery.data || (activeIssue ? { issue: activeIssue, journals: [], watchers: members.filter((person) => activeIssue.watcherIds.includes(person.id)) } : undefined);
  const notifications = screen === 'inbox' && archived ? archivedQuery.data || [] : unreadQuery.data || [];
  const customViews = settings.savedViews.filter((saved) => saved.projectId === selectedProjectId);
  const unreadCount = unreadQuery.data?.length || 0;

  useEffect(() => {
    setSettings(bootstrap.settings);
  }, [bootstrap.settings]);
  useEffect(() => {
    void i18n.changeLanguage(settings.locale);
    document.documentElement.lang = settings.locale;
  }, [settings.locale, i18n]);
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      root.dataset.themeChoice = settings.theme;
      root.dataset.theme = settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : settings.theme;
      root.dataset.palette = settings.palette;
    };
    apply();
    if (settings.theme === 'system') media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [settings.theme, settings.palette]);
  useEffect(() => {
    if (selectedProjectId) localStorage.setItem('redmine-workspace:project', String(selectedProjectId));
  }, [selectedProjectId]);
  useEffect(() => {
    const key = `${selectedProjectId}:${screen}`;
    const frame = requestAnimationFrame(() => {
      if (contentScrollRef.current) contentScrollRef.current.scrollTop = scrollPositionsRef.current[key] || 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [screen, selectedProjectId]);
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    if (!unreadCount) { link.href = '/favicon.svg'; return; }
    const count = unreadCount > 9 ? '9+' : String(unreadCount);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="5" y="5" width="54" height="54" rx="17" fill="#4263eb"/><path d="M20 29c0-8 5-13 12-13s12 5 12 13v7l4 6H16l4-6z" fill="white"/><circle cx="32" cy="47" r="3" fill="white"/><circle cx="49" cy="15" r="13" fill="#f05252"/><text x="49" y="19" font-family="Arial,sans-serif" font-size="11" text-anchor="middle" fill="white">${count}</text></svg>`;
    link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }, [unreadCount]);
  useEffect(() => {
    let stream: EventSource | undefined;
    try {
      stream = new EventSource('/api/events');
      stream.onmessage = () => { void queryClient.invalidateQueries(); };
      for (const eventName of ['sync', 'issue', 'release', 'settings', 'operation', 'notifications']) {
        stream.addEventListener(eventName, () => { void queryClient.invalidateQueries(); });
      }
      stream.onerror = () => { /* EventSource reconnects automatically; cached state remains visible. */ };
    } catch { /* The app still works with polling if EventSource is unavailable. */ }
    return () => stream?.close();
  }, [queryClient]);

  const refreshQueries = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['board', selectedProjectId] }),
      queryClient.invalidateQueries({ queryKey: ['issue'] }),
      queryClient.invalidateQueries({ queryKey: ['release'] }),
      queryClient.invalidateQueries({ queryKey: ['operations'] }),
      queryClient.invalidateQueries({ queryKey: ['notifications'] }),
    ]);
  }, [queryClient, selectedProjectId]);
  const commandMutation = useMutation({ mutationFn: (command: WorkspaceCommand) => api.command(command), onSuccess: () => refreshQueries() });
  const runCommand = useCallback(async (command: WorkspaceCommand): Promise<CommandResult> => {
    if (!canWrite) throw new ApiRequestError({ code: 'READ_ONLY', message: t('readOnlyNote') }, t('readOnlyNote'), 403);
    let result: CommandResult;
    try { result = await commandMutation.mutateAsync(command); }
    catch (error) { throw new Error(friendlyError(error, t)); }
    if (result.operation.status === 'failed' || result.operation.status === 'blocked') {
      const code = result.operation.errorCode;
      const mapped = code ? friendlyError(new ApiRequestError({ code, message: '' }, '', 400), t) : t('errorGeneric');
      throw new Error(mapped);
    }
    return result;
  }, [canWrite, commandMutation, t]);

  const updateSettings = useCallback(async (next: AppSettings, quiet = false) => {
    const previous = settingsRef.current;
    setSettings(next);
    try {
      const saved = await api.put<AppSettings>('/api/settings', next);
      setSettings(saved || next);
      if (next.automationEnabled !== previous.automationEnabled && bootstrap.mode === 'demo' && !bootstrap.readOnly && bootstrap.capabilities.canWrite) {
        await commandMutation.mutateAsync({ type: 'runAutomation', input: { enabled: next.automationEnabled } });
      }
      if (!quiet) notify(t('settingsSaved'));
    } catch (error) {
      setSettings(previous);
      throw new Error(friendlyError(error, t));
    }
  }, [bootstrap, commandMutation, notify, t]);
  const saveSettings = useCallback(async (next: AppSettings) => {
    await updateSettings(next);
  }, [updateSettings]);

  const openIssue = useCallback((issue: Issue, journalId?: number) => {
    setIssueId(issue.id);
    setInitialJournalId(journalId);
    setIssueOpen(true);
  }, []);
  const closeIssue = useCallback(() => { setIssueOpen(false); setInitialJournalId(undefined); }, []);
  const pickProject = (nextProject: Project) => {
    setSelectedProjectId(nextProject.id);
    setProjectPickerOpen(false);
    setProjectSearch('');
    setScreen('board'); setView('all'); setFilters({}); setSelectedVersionId(undefined);
  };
  const selectView = (next: View) => { setScreen(next === 'backlog' ? 'backlog' : 'board'); setView(next); setFilters({}); };
  const selectSavedView = (saved: SavedView) => { setScreen('board'); setView(saved.view); setFilters(saved.filters); };
  const onSaveView = async (name: string, nextFilters: Filters, savedView: View) => {
    const next: SavedView[] = [...settingsRef.current.savedViews.filter((item) => !(item.projectId === selectedProjectId && item.name === name)), { id: crypto.randomUUID(), projectId: selectedProjectId, name, filters: nextFilters, view: savedView }];
    await updateSettings({ ...settingsRef.current, savedViews: next }, true);
    notify(t('saved'));
  };
  const removeSavedView = async (saved: SavedView) => {
    await updateSettings({ ...settingsRef.current, savedViews: settingsRef.current.savedViews.filter((item) => item.id !== saved.id) }, true);
  };
  const saveIssue = async (issue: Issue, patch: IssueEditPatch): Promise<Issue | void> => {
    const input: Record<string, unknown> = { ...patch };
    for (const optionalKey of ['assignedToId', 'fixedVersionId', 'dueDate'] as const) {
      if (optionalKey in patch && patch[optionalKey] === undefined) input[optionalKey] = null;
    }
    const result = await runCommand({ type: 'updateIssue', issueId: issue.id, input });
    if (result.operation.status !== 'done') throw new Error(t('operationRunning'));
    await refreshQueries();
    return result.issue;
  };
  const saveIssueRoles = async (issue: Issue, rolePatch: { developerId?: number | null; qaId?: number | null }): Promise<Issue | void> => {
    let updated: Issue | undefined;
    try { updated = await api.post<Issue>(`/api/issues/${issue.id}/roles`, rolePatch); }
    catch (error) { throw new Error(friendlyError(error, t)); }
    await refreshQueries();
    return updated;
  };
  const commentIssue = async (issue: Issue, notes: string) => { const result = await runCommand({ type: 'comment', issueId: issue.id, input: { notes } }); if (result.operation.status !== 'done') throw new Error(t('operationRunning')); };
  const createIssue = async (input: { subject: string; description: string; statusId?: number; priorityId?: number; trackerId?: number; assignedToId?: number; fixedVersionId?: number }) => {
    const result = await runCommand({ type: 'createIssue', projectId: selectedProjectId, input });
    if (result.operation.status !== 'done') throw new Error(t('operationRunning'));
    await refreshQueries();
    notify(t('saved'));
  };
  const moveIssue = async (issue: Issue, target: { statusId?: number; fixedVersionId?: number | null }) => {
    if (pendingIssueIdsRef.current.has(issue.id)) return;
    pendingIssueIdsRef.current.add(issue.id);
    setPendingIssueIds(new Set(pendingIssueIdsRef.current));
    const input: Record<string, unknown> = { ...target };
    try {
      const result = await runCommand({ type: 'moveIssue', issueId: issue.id, input });
      if (result.operation.status !== 'done') throw new Error(t('operationRunning'));
      if (target.statusId && issue.fixedVersionId) notify(t('keepRoadmapHint'));
      await refreshQueries();
    } finally {
      pendingIssueIdsRef.current.delete(issue.id);
      setPendingIssueIds(new Set(pendingIssueIdsRef.current));
    }
  };
  const createRelease = async (input: { name: string; dueDate?: string; description?: string; issueIds?: number[] }) => {
    const result = await runCommand({ type: 'createRelease', projectId: selectedProjectId, input });
    if (result.operation.status !== 'done' && result.operation.status !== 'running') throw new Error(t('operationRunning'));
    await refreshQueries();
    if (result.version) setSelectedVersionId(result.version.id);
    notify(t('releaseCreated'));
  };
  const assignRelease = async (versionId: number, issueIds: number[], fixedVersionId: number | null) => {
    if (issueIds.length === 0) return;
    await runCommand({ type: 'assignRelease', projectId: selectedProjectId, versionId, input: { issueIds, fixedVersionId } });
    await refreshQueries();
  };
  const updateRelease = async (version: import('../../shared/types').Version, patch: Partial<import('../../shared/types').Version>) => {
    await runCommand({ type: 'updateRelease', projectId: selectedProjectId, versionId: version.id, input: patch as Record<string, unknown> });
    await refreshQueries();
  };
  const finishRelease = async (version: import('../../shared/types').Version) => {
    const result = await runCommand({ type: 'finishRelease', projectId: selectedProjectId, versionId: version.id, input: {} });
    await refreshQueries();
    notify(result.operation.status === 'done' ? t('saved') : t('operationRunning'));
  };
  const markRead = async (notification: Notification) => {
    await api.post('/api/notifications/read', { ids: [notification.id] });
    await queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };
  const openNotification = async (notification: Notification) => {
    try {
      const [detail] = await Promise.all([
        queryClient.fetchQuery({ queryKey: ['issue', notification.issueId], queryFn: () => api.get<IssueDetail>(`/api/issues/${notification.issueId}`), staleTime: 0 }),
        queryClient.fetchQuery({ queryKey: ['board', notification.projectId], queryFn: () => api.get<import('../../shared/types').BoardData>(`/api/projects/${notification.projectId}/board`) }),
      ]);
      setSelectedProjectId(notification.projectId);
      setIssueId(notification.issueId);
      setInitialJournalId(notification.journalId);
      setIssueOpen(true);
      if (!notification.readAt) await markRead(notification);
      if (detail.issue.projectId !== notification.projectId) notify(t('errorGeneric'));
    } catch (error) { notify(friendlyError(error, t)); }
  };
  const manualSync = async () => {
    setBusySync(true);
    try { await api.post('/api/sync'); await refreshQueries(); notify(t('synced', { time: new Date().toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' }) })); }
    catch (error) { notify(friendlyError(error, t)); }
    finally { setBusySync(false); }
  };
  const moveActiveIssue = async (statusId: number) => {
    if (!activeIssue) return;
    setShowQuickMove(false);
    await moveIssue(activeIssue, { statusId, fixedVersionId: activeIssue.fixedVersionId });
  };
  const copyActiveUrl = useCallback(async () => {
    if (!issueId) return;
    try { await navigator.clipboard.writeText(issueUrl(bootstrap.redmineUrl, issueId)); notify(t('copied')); } catch { notify(t('error')); }
  }, [bootstrap.redmineUrl, issueId, notify, t]);
  const copyActiveBranch = useCallback(async () => {
    const issue = board?.issues.find((entry) => entry.id === issueId);
    if (!issue?.branch) return;
    try { await navigator.clipboard.writeText(issue.branch); notify(t('copied')); } catch { notify(t('error')); }
  }, [board?.issues, issueId, notify, t]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || isEditableTarget(event.target)) return;
      const activeSelection = window.getSelection()?.toString();
      const shortcuts = settingsRef.current.shortcuts;
      const match = shortcuts.find((shortcut) => shortcutForEvent(shortcut, event));
      if (!match) return;
      if (match.action === 'copyRedmineUrl') {
        if (activeSelection) return;
        const focusedCard = document.activeElement?.closest('.issue-card');
        if (!issueOpen && !focusedCard) return;
        event.preventDefault(); void copyActiveUrl(); return;
      }
      const action = match.action === 'view' && match.value === 'mine' ? 'view/mine' : match.action;
      if ((action === 'createIssue' || action === 'moveStatus') && !canWrite) return;
      event.preventDefault();
      if (action === 'view/mine') selectView('mine');
      else if (action === 'projectPicker') setProjectPickerOpen(true);
      else if (action === 'search') searchRef.current?.focus();
      else if (action === 'createIssue') setCreateIssueOpen(true);
      else if (action === 'commandPalette') setShowPalette(true);
      else if (action === 'copyBranch') void copyActiveBranch();
      else if (action === 'moveStatus') {
        const targeted = match.value && statuses.find((status) => String(status.id) === match.value || status.key === match.value);
        if (targeted && activeIssue) void moveIssue(activeIssue, { statusId: targeted.id, fixedVersionId: activeIssue.fixedVersionId }).catch((error) => notify(friendlyError(error, t)));
        else setShowQuickMove(true);
      }
      else if (action === 'label' && match.value) setFilters((current) => ({ ...current, label: match.value }));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeIssue, canWrite, copyActiveBranch, copyActiveUrl, issueOpen, notify, statuses, t]);

  const visibleProjects = bootstrap.projects.filter((item) => `${item.name} ${item.identifier}`.toLocaleLowerCase().includes(projectSearch.toLocaleLowerCase()));
  const statusesReady = statuses.length > 0;
  if (!project) return <div className="startup-state startup-error"><div className="startup-brand"><span className="brand-mark"><LayoutDashboard size={18} /></span><strong>{t('appName')}</strong></div><div className="empty-illustration"><ShieldCheck size={24} /></div><h1>{t('noProjects')}</h1><p>{bootstrap.mode === 'redmine' ? t('readOnlyNote') : t('offline')}</p><Button variant="primary" onClick={onReload}>{t('retry')}</Button></div>;
  return <div className={`app-frame${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
    <aside className="sidebar">
      <div className="sidebar-top"><a href="#home" className="brand-lockup" onClick={(e) => e.preventDefault()}><span className="brand-mark"><LayoutDashboard size={17} /></span><span className="brand-name">Redmine<span>Workspace</span></span></a><IconButton label={sidebarCollapsed ? t('open') : t('close')} className="sidebar-collapse" onClick={() => setSidebarCollapsed((value) => !value)}>{sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</IconButton></div>
      <button type="button" className="project-selector" onClick={() => { setProjectPickerOpen(true); setProjectSearch(''); }} aria-haspopup="dialog"><span className="project-symbol">{project.name.trim().charAt(0).toUpperCase()}</span><span className="project-selector-text"><small>{t('projects')}</small><strong>{project.name}</strong></span><ChevronDown size={15} /></button>
      <div className="sidebar-scroll">
        <div className="nav-group"><span className="nav-label">{t('workspace')}</span>
          <NavItem active={screen === 'board' && view === 'all'} label={t('all')} icon={<LayoutDashboard size={17} />} collapsed={sidebarCollapsed} onClick={() => selectView('all')} />
          <NavItem active={screen === 'board' && view === 'mine'} label={t('mine')} icon={<UserRound size={17} />} collapsed={sidebarCollapsed} shortcut="Q" onClick={() => selectView('mine')} />
          <NavItem active={screen === 'board' && view === 'watching'} label={t('watching')} icon={<Bell size={17} />} collapsed={sidebarCollapsed} onClick={() => selectView('watching')} />
          <NavItem active={screen === 'backlog'} label={t('backlog')} icon={<ListTodo size={17} />} collapsed={sidebarCollapsed} onClick={() => selectView('backlog')} />
        </div>
        <div className="nav-group"><span className="nav-label">{t('personal')}</span>
          <NavItem active={screen === 'inbox'} label={t('inbox')} icon={unreadCount > 0 ? <BellDot size={17} /> : <Inbox size={17} />} collapsed={sidebarCollapsed} count={unreadCount} onClick={() => { setScreen('inbox'); setArchived(false); }} />
          <NavItem active={screen === 'releases'} label={t('releases')} icon={<Rocket size={17} />} collapsed={sidebarCollapsed} onClick={() => { setScreen('releases'); setSelectedVersionId(undefined); }} />
          <NavItem active={screen === 'settings'} label={t('settings')} icon={<Settings2 size={17} />} collapsed={sidebarCollapsed} onClick={() => setScreen('settings')} />
        </div>
        {customViews.length > 0 && <div className="nav-group saved-nav-group"><div className="nav-label-row"><span className="nav-label">{t('customViews')}</span><IconButton label={t('filters')} onClick={() => setScreen('settings')}><Plus size={13} /></IconButton></div>{customViews.map((saved) => <div className="saved-view-row" key={saved.id}><NavItem active={screen === 'board' && filters.search === saved.filters.search && view === saved.view} label={saved.name} icon={<BookOpen size={16} />} collapsed={sidebarCollapsed} onClick={() => selectSavedView(saved)} /><IconButton label={t('deleteView')} className="saved-view-remove" onClick={() => void removeSavedView(saved)}><X size={12} /></IconButton></div>)}</div>}
      </div>
      <div className="sidebar-bottom"><div className="mode-footer"><span className={`connection-indicator ${bootstrap.connected ? 'is-connected' : 'is-offline'}`} /><span>{bootstrap.mode === 'demo' ? t('demo') : t('readonly')}</span></div><div className="user-footer"><Avatar person={bootstrap.me} size="sm" /><span><strong>{bootstrap.me.name}</strong><small>{bootstrap.mode === 'demo' ? t('demo') : t('readOnlyBadge')}</small></span></div></div>
    </aside>
    <div className="app-main">
      <header className="topbar">
        <div className="breadcrumbs"><span>{project.name}</span><span className="crumb-separator">/</span><strong>{screen === 'board' ? view === 'mine' ? t('mine') : view === 'watching' ? t('watching') : t('board') : screen === 'backlog' ? t('backlog') : screen === 'inbox' ? t('inbox') : screen === 'releases' ? t('releases') : t('settings')}</strong></div>
        <div className="topbar-actions">
          <label className="global-search"><Search size={16} /><input ref={searchRef} type="search" aria-label={t('search')} placeholder={t('searchPlaceholder')} value={filters.search || ''} onChange={(e) => setFilters((current) => ({ ...current, search: e.target.value || undefined }))} /><kbd>⌘ K</kbd></label>
          <div className={`connection-pill ${bootstrap.connected ? 'connection-online' : 'connection-offline'}`} title={bootstrap.connected ? t('connected') : t('offline')}><span />{bootstrap.connected ? (bootstrap.mode === 'demo' ? t('demo') : t('connected')) : t('offline')}</div>
          <IconButton label={t('operationTitle')} onClick={() => setShowActivity(true)} className="activity-trigger"><Activity size={17} /></IconButton>
          <Button variant="quiet" size="sm" onClick={manualSync} disabled={busySync}>{busySync ? <Spinner /> : <Sparkles size={15} />}{t('sync')}</Button>
        </div>
      </header>
      <div className="mode-banner"><span className={`mode-banner-mark ${bootstrap.mode === 'demo' ? 'is-demo' : 'is-readonly'}`}>{bootstrap.mode === 'demo' ? <Sparkles size={14} /> : <ShieldCheck size={14} />}</span><span><strong>{bootstrap.mode === 'demo' ? t('demo') : t('readonly')}</strong><small>{bootstrap.mode === 'demo' ? t('demoNote') : t('readOnlyNote')}</small></span>{bootstrap.mode === 'redmine' && <span className="mode-banner-trailing">{t('readOnlyBadge')}</span>}</div>
      <div className="content-scroll" ref={contentScrollRef} onScroll={(event) => { scrollPositionsRef.current[`${selectedProjectId}:${screen}`] = event.currentTarget.scrollTop; }}>
        {(screen === 'board' || screen === 'backlog') && <>{boardQuery.isLoading && <div className="page-loading"><Spinner label={t('loading')} /></div>}{boardQuery.isError && <div className="page-error"><Notice tone="error">{t('boardFailed')} <Button size="sm" onClick={() => boardQuery.refetch()}>{t('retry')}</Button></Notice></div>}{board && statusesReady && <BoardPage project={project} data={board} statuses={statuses} priorities={bootstrap.priorities} me={bootstrap.me} settings={settings} view={screen === 'backlog' ? 'backlog' : view} filters={filters} canWrite={canWrite} pendingIssueIds={pendingIssueIds} onFiltersChange={setFilters} onSettingsChange={(next) => { setSettings(next); void updateSettings(next, true).catch((error) => notify(error instanceof Error ? error.message : t('error'))); }} onOpenIssue={openIssue} onCreateIssue={() => setCreateIssueOpen(true)} onMoveIssue={(issue, target) => { void moveIssue(issue, target).catch((error) => notify(error instanceof Error ? error.message : t('error'))); }} onSaveView={(name, nextFilters, savedView) => { void onSaveView(name, nextFilters, savedView).catch((error) => notify(error instanceof Error ? error.message : t('error'))); }} onToast={notify} savedViews={customViews} />}</>}
        {screen === 'inbox' && <InboxPage notifications={notifications} projects={bootstrap.projects} archived={archived} onToggleArchived={() => setArchived((value) => !value)} onMarkRead={(notification) => { void markRead(notification).catch((error) => notify(friendlyError(error, t))); }} onOpenIssue={(notification) => { void openNotification(notification); }} />}
        {screen === 'releases' && board && <ReleasesPage project={project} board={board} statuses={statuses} priorities={bootstrap.priorities} members={members} versions={board.versions} selectedVersionId={selectedVersionId} canWrite={canWrite} onSelectVersion={setSelectedVersionId} onOpenIssue={openIssue} onCreateRelease={createRelease} onAssign={assignRelease} onUpdateRelease={updateRelease} onFinish={finishRelease} onToast={notify} />}
        {screen === 'settings' && <SettingsPage key={`${selectedProjectId}-${settings.savedViews.length}`} settings={settings} members={members} project={project} projects={bootstrap.projects} statuses={statuses} labels={board?.labels || []} readOnly={bootstrap.mode === 'redmine' || bootstrap.readOnly} onSave={saveSettings} onResetViews={() => void updateSettings({ ...settings, savedViews: settings.savedViews.filter((saved) => saved.projectId !== selectedProjectId) })} onToast={notify} />}
      </div>
    </div>

    {issueOpen && issueId && issueDetail && <IssueDialog key={`${bootstrap.mode}:${bootstrap.redmineUrl}:${bootstrap.me.id}:${issueId}`} draftScope={`${bootstrap.mode}:${bootstrap.redmineUrl}:${bootstrap.me.id}`} detail={issueDetail} board={queryClient.getQueryData<import('../../shared/types').BoardData>(['board', issueDetail.issue.projectId]) || board || emptyBoard()} statuses={statuses} priorities={bootstrap.priorities} redmineUrl={bootstrap.redmineUrl} canWrite={canWrite} initialJournalId={initialJournalId} onClose={closeIssue} onSave={saveIssue} onComment={commentIssue} onSaveRoles={saveIssueRoles} onToast={notify} />}
    {issueOpen && issueId && !issueDetail && <Modal title={`#${issueId}`} onClose={closeIssue} size="sm"><div className="center-loading"><Spinner label={issueQuery.isError ? t('issueNotFound') : t('loading')} />{issueQuery.isError && <Button size="sm" onClick={() => issueQuery.refetch()}>{t('retry')}</Button>}</div></Modal>}
    {createIssueOpen && <CreateIssueDialog key={`${bootstrap.mode}:${bootstrap.redmineUrl}:${bootstrap.me.id}:${selectedProjectId}`} project={project} board={board || emptyBoard()} statuses={statuses} priorities={bootstrap.priorities} canWrite={canWrite} draftScope={`${bootstrap.mode}:${bootstrap.redmineUrl}:${bootstrap.me.id}:${selectedProjectId}`} onClose={() => setCreateIssueOpen(false)} onCreate={createIssue} />}
    {projectPickerOpen && <ProjectPickerDialog projects={visibleProjects} current={project} search={projectSearch} onSearch={setProjectSearch} onPick={pickProject} onClose={() => setProjectPickerOpen(false)} />}
    {showPalette && <CommandPalette onClose={() => setShowPalette(false)} onSearch={() => { setShowPalette(false); searchRef.current?.focus(); }} onCreate={() => { setShowPalette(false); setCreateIssueOpen(true); }} onProject={() => { setShowPalette(false); setProjectPickerOpen(true); }} onInbox={() => { setShowPalette(false); setScreen('inbox'); setArchived(false); }} onRelease={() => { setShowPalette(false); setScreen('releases'); }} />}
    {showQuickMove && activeIssue && <QuickMoveDialog issue={activeIssue} statuses={statuses} onMove={(statusId) => { void moveActiveIssue(statusId).catch((error) => notify(error instanceof Error ? error.message : t('error'))); }} onClose={() => setShowQuickMove(false)} canWrite={canWrite} />}
    {showActivity && <OperationsDrawer operations={operationsQuery.data || []} mode={bootstrap.mode} onClose={() => setShowActivity(false)} onRetry={(operation) => { void retryOperation(operation, runCommand, notify, t); }} />}
    {toastText && <Toast text={toastText} onClose={() => setToastText('')} />}
  </div>;
}

function emptyBoard(): BoardData { return { issues: [], versions: [], members: [], labels: [], total: 0 }; }

function NavItem({ active, label, icon, collapsed, shortcut, count, onClick }: { active: boolean; label: string; icon: React.ReactNode; collapsed: boolean; shortcut?: string; count?: number; onClick: () => void }) {
  return <button type="button" className={`nav-item${active ? ' nav-active' : ''}`} onClick={onClick} aria-label={label} title={label}><span className="nav-icon">{icon}</span>{!collapsed && <><span className="nav-text">{label}</span>{typeof count === 'number' && count > 0 && <span className="nav-count">{count > 99 ? '99+' : count}</span>}{shortcut && <kbd>{shortcut}</kbd>}</>}</button>;
}

function ProjectPickerDialog({ projects, current, search, onSearch, onPick, onClose }: { projects: Project[]; current: Project; search: string; onSearch: (query: string) => void; onPick: (project: Project) => void; onClose: () => void }) {
  const { t } = useTranslation();
  return <Modal title={t('projectPicker')} eyebrow={t('projects')} onClose={onClose} size="sm" testId="project-picker" className="project-picker-modal">
    <div className="project-picker-content"><label className="search-field"><Search size={16} /><input autoFocus value={search} onChange={(e) => onSearch(e.target.value)} placeholder={t('searchPlaceholder')} /></label><div className="project-picker-list">{projects.length === 0 ? <p>{t('noProjects')}</p> : projects.map((project) => <button key={project.id} type="button" className={`project-picker-option${project.id === current.id ? ' selected' : ''}`} onClick={() => onPick(project)}><span className="project-symbol">{project.name.trim()[0]?.toUpperCase()}</span><span><strong>{project.name}</strong><small>{project.identifier}</small></span>{project.id === current.id && <Check size={16} />}</button>)}</div><div className="picker-shortcut-hint"><kbd>Esc</kbd>{t('close')}<span><kbd>B</kbd>{t('openProjectPicker')}</span></div></div>
  </Modal>;
}

function CommandPalette({ onClose, onSearch, onCreate, onProject, onInbox, onRelease }: { onClose: () => void; onSearch: () => void; onCreate: () => void; onProject: () => void; onInbox: () => void; onRelease: () => void }) {
  const { t } = useTranslation();
  return <Modal title={t('showHelp')} eyebrow={t('shortcuts')} onClose={onClose} size="sm" className="palette-modal">
    <div className="palette-list"><button onClick={onSearch}><Search size={17} /><span>{t('openSearch')}</span><kbd>/</kbd></button><button onClick={onCreate}><Plus size={17} /><span>{t('createShortcut')}</span><kbd>N</kbd></button><button onClick={onProject}><LayoutDashboard size={17} /><span>{t('openProjectPicker')}</span><kbd>B</kbd></button><button onClick={onInbox}><Inbox size={17} /><span>{t('inbox')}</span></button><button onClick={onRelease}><Rocket size={17} /><span>{t('releases')}</span></button></div>
    <div className="palette-footer"><Command size={14} />{t('shortcutHint')}</div>
  </Modal>;
}

function QuickMoveDialog({ issue, statuses, canWrite, onMove, onClose }: { issue: Issue; statuses: Status[]; canWrite: boolean; onMove: (statusId: number) => void; onClose: () => void }) {
  const { t } = useTranslation();
  return <Modal title={t('moveShortcut')} eyebrow={`#${issue.id} ${issue.subject}`} onClose={onClose} size="sm" className="quick-move-modal"><p className="form-intro">{t('actualStatus')}: {statuses.find((status) => status.id === issue.statusId)?.name || t('unknown')}</p><div className="quick-move-list">{statuses.map((status) => <button key={status.id} type="button" className={status.id === issue.statusId ? 'selected' : ''} onClick={() => onMove(status.id)} disabled={!canWrite || status.id === issue.statusId}><span className={`lane-dot dot-${status.key}`} />{status.name}<ChevronDown size={14} /></button>)}</div>{issue.fixedVersionId && <Notice>{t('keepRoadmapHint')}</Notice>}</Modal>;
}

function OperationsDrawer({ operations, mode, onClose, onRetry }: { operations: Operation[]; mode: string; onClose: () => void; onRetry: (operation: Operation) => void }) {
  const { t, i18n } = useTranslation();
  const statusLabel = (status: Operation['status']) => status === 'done' ? t('operationDone') : status === 'running' || status === 'pending' ? t('operationRunning') : status === 'blocked' ? t('operationBlocked') : t('operationFailed');
  const stepStatusLabel = (status: Operation['steps'][number]['status']) => status === 'done' ? t('stepDone') : status === 'pending' ? t('stepPending') : status === 'skipped' ? t('stepSkipped') : status === 'blocked' ? t('stepBlocked') : t('stepFailed');
  const labels: Record<string, string> = { createIssue: 'opCreateIssue', updateIssue: 'opUpdateIssue', moveIssue: 'opMoveIssue', handoffToQA: 'opHandoffToQA', returnToDeveloper: 'opReturnToDeveloper', comment: 'opComment', generateBranch: 'opGenerateBranch', createRelease: 'opCreateRelease', updateRelease: 'opUpdateRelease', assignRelease: 'opAssignRelease', finishRelease: 'opFinishRelease', runAutomation: 'opRunAutomation' };
  const operationError = (operation: Operation) => operation.errorCode ? friendlyError(new ApiRequestError({ code: operation.errorCode, message: '' }, '', 400), t) : t('errorGeneric');
  return <div className="drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><aside className="operations-drawer" role="dialog" aria-modal="true" aria-label={t('operationTitle')}>
    <div className="drawer-head"><div><span className="eyebrow">{t('workspace')}</span><h2>{t('operationTitle')}</h2></div><IconButton label={t('close')} onClick={onClose}><X size={17} /></IconButton></div>
    {mode === 'redmine' && <Notice tone="warning">{t('readOnlyNote')}</Notice>}
    <div className="operations-list">{operations.length === 0 ? <div className="empty-state"><div className="empty-illustration"><Activity size={23} /></div><p>{t('noOperations')}</p></div> : operations.map((operation) => <article className="operation-card" key={operation.id}><div className="operation-card-top"><span className={`operation-mark operation-${operation.status}`}><span /></span><strong>{labels[operation.type] ? t(labels[operation.type]) : t('operationTitle')}</strong><span>{statusLabel(operation.status)}</span></div><small>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(operation.createdOn))}{operation.issueId ? ` · #${operation.issueId}` : ''}</small>{operation.error && <p className="operation-error">{operationError(operation)}</p>}{operation.steps.length > 0 && <ul>{operation.steps.map((step, index) => <li key={`${operation.id}-${index}`} className={`step-${step.status}`}><span />{t('operationStep', { count: index + 1 })} · {stepStatusLabel(step.status)}</li>)}</ul>}{(operation.error || operation.steps.some((step) => step.name || step.error)) && <details className="operation-technical-details"><summary>{t('technicalDetails')}</summary>{operation.error && <p>{operation.error}</p>}{operation.steps.length > 0 && <ul>{operation.steps.map((step, index) => <li key={`detail-${operation.id}-${index}`}>{step.name}{step.error ? ` · ${step.error}` : ''}</li>)}</ul>}</details>}{mode === 'demo' && ['failed', 'blocked'].includes(operation.status) && <Button size="sm" variant="outline" onClick={() => onRetry(operation)}>{t('retryOperation')}</Button>}</article>)}</div>
  </aside></div>;
}

async function retryOperation(operation: Operation, runCommand: (command: WorkspaceCommand) => Promise<CommandResult>, notify: (text: string) => void, t: (key: string) => string) {
  const available: WorkspaceCommand['type'][] = ['createIssue', 'updateIssue', 'moveIssue', 'handoffToQA', 'returnToDeveloper', 'comment', 'generateBranch', 'createRelease', 'updateRelease', 'assignRelease', 'finishRelease', 'runAutomation'];
  const type = available.find((candidate) => candidate.toLowerCase() === operation.type.replaceAll('_', '').toLowerCase() || candidate.toLowerCase() === operation.type.toLowerCase());
  if (!type) { notify(t('error')); return; }
  try { await runCommand({ type, issueId: operation.issueId, versionId: operation.versionId, operationId: operation.id, input: {} }); notify(t('saved')); }
  catch (error) { notify(error instanceof Error ? error.message : t('error')); }
}
