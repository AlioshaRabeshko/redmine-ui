import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Bell, BellDot, Check, ChevronDown, Command, Inbox, LayoutDashboard, ListTodo, LoaderCircle, PanelLeftClose, PanelLeftOpen, Plus, Rocket, Search, Settings2, ShieldCheck, Sparkles, UserRound, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AppSettings, BoardData, Bootstrap, Command as WorkspaceCommand, CommandResult, Filters, Issue, IssueDetail, Notification, Operation, Person, Project, SavedView, SettingsPatch, Status, View } from '../../shared/types';
import { api, ApiRequestError, friendlyError, issueUrl } from '../lib/api';
import { useWorkspaceNavigation, type NavigationState, type Screen } from '../lib/workspaceNavigation';
import { isEditableTarget, resolveIssueShortcutTarget, shortcutForEvent } from '../lib/shortcuts';
import { toggleAssignedToMe } from '../../shared/domain';
import { Avatar, Button, dispatchActiveFormSave, IconButton, Modal, Notice, Spinner, Toast } from '../components/ui';
import { BoardPage } from '../features/board/BoardPage';
import { IssueDialog, CreateIssueDialog, type IssueEditPatch } from '../features/issues/IssueDialog';
import { InboxPage } from '../features/inbox/InboxPage';
import { ReleasesPage } from '../features/releases/ReleasesPage';
import { SettingsPage } from '../features/settings/SettingsPage';

function mergeSettingsPatch(current: AppSettings, patch: SettingsPatch): AppSettings {
  const { projectQa, subscriptions, personRoleOverrides, projectBackgrounds, ...simpleFields } = patch;
  const next: AppSettings = { ...current, ...simpleFields };
  if (projectBackgrounds) {
    next.projectBackgrounds = { ...current.projectBackgrounds };
    for (const [projectId, url] of Object.entries(projectBackgrounds)) {
      if (url === null) delete next.projectBackgrounds[projectId]; else next.projectBackgrounds[projectId] = url;
    }
  }
  if (projectQa) {
    next.projectQa = { ...current.projectQa };
    for (const [projectId, personId] of Object.entries(projectQa)) {
      if (personId === null) delete next.projectQa[projectId]; else next.projectQa[projectId] = personId;
    }
  }
  if (subscriptions) {
    next.subscriptions = { ...current.subscriptions };
    for (const [projectId, subscription] of Object.entries(subscriptions)) {
      if (subscription === null) delete next.subscriptions[projectId]; else next.subscriptions[projectId] = subscription;
    }
  }
  if (personRoleOverrides) {
    next.personRoleOverrides = structuredClone(current.personRoleOverrides);
    for (const [projectId, people] of Object.entries(personRoleOverrides)) {
      if (people === null) { delete next.personRoleOverrides[projectId]; continue; }
      const projectPeople = { ...(next.personRoleOverrides[projectId] || {}) };
      for (const [personId, roles] of Object.entries(people)) {
        if (roles === null) delete projectPeople[personId]; else projectPeople[personId] = roles;
      }
      if (Object.keys(projectPeople).length) next.personRoleOverrides[projectId] = projectPeople; else delete next.personRoleOverrides[projectId];
    }
  }
  return next;
}

function restoreSettingsPatch(current: AppSettings, confirmed: AppSettings, optimistic: AppSettings, patch: SettingsPatch): AppSettings {
  const restored = { ...current };
  const mapFields = new Set(['projectQa', 'subscriptions', 'personRoleOverrides', 'projectBackgrounds']);
  for (const key of Object.keys(patch) as (keyof AppSettings)[]) {
    if (mapFields.has(key)) continue;
    if (current[key] === optimistic[key]) Object.assign(restored, { [key]: confirmed[key] });
  }
  for (const projectId of Object.keys(patch.projectQa || {})) {
    if (current.projectQa[projectId] === optimistic.projectQa[projectId]) {
      const values = { ...restored.projectQa };
      if (confirmed.projectQa[projectId] === undefined) delete values[projectId]; else values[projectId] = confirmed.projectQa[projectId];
      restored.projectQa = values;
    }
  }
  for (const projectId of Object.keys(patch.projectBackgrounds || {})) {
    if (current.projectBackgrounds[projectId] === optimistic.projectBackgrounds[projectId]) {
      const values = { ...restored.projectBackgrounds };
      if (confirmed.projectBackgrounds[projectId] === undefined) delete values[projectId]; else values[projectId] = confirmed.projectBackgrounds[projectId];
      restored.projectBackgrounds = values;
    }
  }
  for (const projectId of Object.keys(patch.subscriptions || {})) {
    if (current.subscriptions[projectId] === optimistic.subscriptions[projectId]) {
      const values = { ...restored.subscriptions };
      if (confirmed.subscriptions[projectId] === undefined) delete values[projectId]; else values[projectId] = confirmed.subscriptions[projectId];
      restored.subscriptions = values;
    }
  }
  for (const [projectId, people] of Object.entries(patch.personRoleOverrides || {})) {
    if (people === null) {
      if (current.personRoleOverrides[projectId] === optimistic.personRoleOverrides[projectId]) {
        const values = { ...restored.personRoleOverrides };
        if (confirmed.personRoleOverrides[projectId] === undefined) delete values[projectId]; else values[projectId] = confirmed.personRoleOverrides[projectId];
        restored.personRoleOverrides = values;
      }
      continue;
    }
    const currentPeople = current.personRoleOverrides[projectId] || {};
    const optimisticPeople = optimistic.personRoleOverrides[projectId] || {};
    const confirmedPeople = confirmed.personRoleOverrides[projectId] || {};
    const restoredPeople = { ...(restored.personRoleOverrides[projectId] || {}) };
    for (const personId of Object.keys(people)) {
      if (currentPeople[personId] !== optimisticPeople[personId]) continue;
      if (confirmedPeople[personId] === undefined) delete restoredPeople[personId]; else restoredPeople[personId] = confirmedPeople[personId];
    }
    const values = { ...restored.personRoleOverrides };
    if (Object.keys(restoredPeople).length) values[projectId] = restoredPeople; else delete values[projectId];
    restored.personRoleOverrides = values;
  }
  return restored;
}

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
  const { location, navigate, close: closeNavigation } = useWorkspaceNavigation();
  const [initialProjectId] = useState(() => {
    let stored = 0;
    try { stored = Number(localStorage.getItem('redmine-workspace:project')); } catch { /* URL still works without storage. */ }
    return bootstrap.projects.some(project => project.id === stored) ? stored : bootstrap.projects[0]?.id || 0;
  });
  const fallbackProjectId = bootstrap.projects.some(project => project.id === initialProjectId) ? initialProjectId : bootstrap.projects[0]?.id || 0;
  const selectedProjectId = bootstrap.projects.some(project => project.id === location.projectId) ? location.projectId! : fallbackProjectId;
  const { screen, view, filters, issueId, versionId: selectedVersionId, archived, journalId: initialJournalId, createIssue: createIssueDefaults } = location;
  const issueOpen = issueId !== undefined;
  const projectPickerOpen = location.overlay === 'projects';
  const showActivity = location.overlay === 'activity';
  const showPalette = location.overlay === 'commands';
  const quickMoveIssueId = location.overlay === 'move' ? location.moveIssueId : undefined;
  const [freshIssueDetailId, setFreshIssueDetailId] = useState<number>();
  const [issueLoadAttempt, setIssueLoadAttempt] = useState(0);
  const [issueLoadError, setIssueLoadError] = useState<string>();
  const [projectSearch, setProjectSearch] = useState('');
  const searchEditingRef = useRef(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [toastText, setToastText] = useState('');
  const [busySync, setBusySync] = useState(false);
  const [pendingIssueIds, setPendingIssueIds] = useState<Set<number>>(() => new Set());
  const pendingIssueIdsRef = useRef(new Set<number>());
  const issueOpenSequenceRef = useRef(0);
  const notificationOpenSequenceRef = useRef(0);
  const settingsQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const settingsWriteSequenceRef = useRef(0);
  const confirmedSettingsRef = useRef(bootstrap.settings);
  const scrollPositionsRef = useRef<Record<string, number>>({});
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusSearchAfterCloseRef = useRef(false);
  const project = bootstrap.projects.find((item) => item.id === selectedProjectId) || bootstrap.projects[0];
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const projectRef = useRef(project);
  projectRef.current = project;
  const notify = useCallback((text: string) => setToastText(text), []);
  const translateRef = useRef(t);
  translateRef.current = t;

  const boardQuery = useQuery({ queryKey: ['board', selectedProjectId], queryFn: () => api.get<import('../../shared/types').BoardData>(`/api/projects/${selectedProjectId}/board`), enabled: !!selectedProjectId, staleTime: 15_000, retry: 1 });
  const unreadQuery = useQuery({ queryKey: ['notifications', 'unread'], queryFn: () => api.get<Notification[]>('/api/notifications'), staleTime: 15_000, refetchInterval: 30_000 });
  const archivedQuery = useQuery({ queryKey: ['notifications', 'archived'], queryFn: () => api.get<Notification[]>('/api/notifications?archived=true'), enabled: screen === 'inbox' && archived, staleTime: 15_000 });
  const operationsQuery = useQuery({ queryKey: ['operations'], queryFn: () => api.get<Operation[]>('/api/operations'), staleTime: 10_000, refetchInterval: 12_000 });
  const issueQuery = useQuery({ queryKey: ['issue', issueId], queryFn: () => api.get<IssueDetail>(`/api/issues/${issueId}`), enabled: issueOpen && !!issueId, staleTime: 5_000 });
  const quickMoveQuery = useQuery({ queryKey: ['issue', quickMoveIssueId], queryFn: () => api.get<IssueDetail>(`/api/issues/${quickMoveIssueId}`), enabled: !!quickMoveIssueId, staleTime: 0, retry: false });
  const board = boardQuery.data;
  const statuses = bootstrap.statuses;
  const canWrite = bootstrap.mode === 'demo' && !bootstrap.readOnly && bootstrap.capabilities.canWrite;
  const members = board?.members || [];
  const activeIssue = board?.issues.find((item) => item.id === issueId);
  const issueDetailIssue = freshIssueDetailId === issueId
    ? issueQuery.data?.issue || activeIssue
    : activeIssue || issueQuery.data?.issue;
  const issueDetail = issueDetailIssue
    ? { ...(issueQuery.data || { journals: [], watchers: members.filter(person => issueDetailIssue.watcherIds.includes(person.id)) }), issue: issueDetailIssue }
    : undefined;
  const quickMoveIssue = quickMoveQuery.data?.issue || board?.issues.find(issue => issue.id === quickMoveIssueId);
  const notifications = screen === 'inbox' && archived ? archivedQuery.data || [] : unreadQuery.data || [];
  const customViews = settings.savedViews.filter((saved) => saved.projectId === selectedProjectId);
  const mineFilterActive = Boolean(filters.assignedToMe || view === 'mine');
  const unreadCount = unreadQuery.data?.length || 0;

  useEffect(() => {
    navigate({ projectId: selectedProjectId || undefined }, { replace: true });
  }, [selectedProjectId, navigate]);

  useEffect(() => {
    if (location.overlay === 'commands' || !focusSearchAfterCloseRef.current) return;
    focusSearchAfterCloseRef.current = false;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [location.overlay]);

  useEffect(() => {
    if (quickMoveIssueId && quickMoveQuery.data) navigate({ projectId: quickMoveQuery.data.issue.projectId }, { replace: true });
  }, [quickMoveIssueId, quickMoveQuery.data, navigate]);

  useEffect(() => {
    const sequence = ++issueOpenSequenceRef.current;
    setFreshIssueDetailId(undefined);
    setIssueLoadError(undefined);
    if (!issueId) return;
    let cancelled = false;
    void queryClient.fetchQuery({ queryKey: ['issue', issueId], queryFn: () => api.get<IssueDetail>(`/api/issues/${issueId}`), staleTime: 0 })
      .then(async detail => {
        if (cancelled || sequence !== issueOpenSequenceRef.current) return;
        navigate(current => current.issueId === issueId ? { projectId: detail.issue.projectId } : {}, { replace: true });
        await queryClient.fetchQuery({ queryKey: ['board', detail.issue.projectId], queryFn: () => api.get<BoardData>(`/api/projects/${detail.issue.projectId}/board`), staleTime: 15_000 });
        if (!cancelled && sequence === issueOpenSequenceRef.current) setFreshIssueDetailId(issueId);
      })
      .catch(error => { if (!cancelled && sequence === issueOpenSequenceRef.current) setIssueLoadError(friendlyError(error, translateRef.current)); });
    return () => { cancelled = true; };
  }, [issueId, issueLoadAttempt, queryClient, navigate]);

  useEffect(() => {
    if (!board) return;
    const patch: Partial<NavigationState> = {};
    const selectedVersion = board.versions.find(version => version.id === selectedVersionId);
    if (selectedVersionId && !selectedVersion) {
      patch.versionId = undefined; patch.releaseForm = undefined;
    }
    if (selectedVersion?.status === 'closed' && (location.releaseForm === 'edit' || location.releaseForm === 'assign')) patch.releaseForm = undefined;
    if (createIssueDefaults) {
      const defaults = { ...createIssueDefaults };
      if (defaults.statusId && !statuses.some(status => status.id === defaults.statusId)) delete defaults.statusId;
      if (defaults.fixedVersionId && !board.versions.some(version => version.id === defaults.fixedVersionId && version.status !== 'closed')) delete defaults.fixedVersionId;
      if (JSON.stringify(defaults) !== JSON.stringify(createIssueDefaults)) patch.createIssue = defaults;
    }
    if (Object.keys(patch).length) navigate(patch, { replace: true });
  }, [board, statuses, selectedVersionId, createIssueDefaults, location.releaseForm, navigate]);

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
    try { if (selectedProjectId) localStorage.setItem('redmine-workspace:project', String(selectedProjectId)); } catch { /* URL retains the project when storage is unavailable. */ }
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
      for (const eventName of ['sync', 'issue', 'release', 'settings', 'operation', 'notifications', 'peopleRecommendations']) {
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

  const patchSettings = useCallback((patch: SettingsPatch, quiet = true) => {
    const optimistic = mergeSettingsPatch(settingsRef.current, patch);
    settingsRef.current = optimistic;
    setSettings(optimistic);
    const sequence = ++settingsWriteSequenceRef.current;
    const write = settingsQueueRef.current.catch(() => undefined).then(async () => {
      const persistedBefore = confirmedSettingsRef.current;
      let patchCommitted = false;
      try {
        const saved = await api.patch<AppSettings>('/api/settings', patch);
        const confirmed = saved || mergeSettingsPatch(persistedBefore, patch);
        confirmedSettingsRef.current = confirmed;
        patchCommitted = true;
        if (sequence === settingsWriteSequenceRef.current) {
          settingsRef.current = confirmed;
          setSettings(confirmed);
        }
        if (patch.automationEnabled !== undefined && patch.automationEnabled !== persistedBefore.automationEnabled && bootstrap.mode === 'demo' && !bootstrap.readOnly && bootstrap.capabilities.canWrite) {
          await commandMutation.mutateAsync({ type: 'runAutomation', input: { enabled: patch.automationEnabled } });
        }
        if (!quiet) notify(t('settingsSaved'));
      } catch (error) {
        if (!patchCommitted) {
          const restored = restoreSettingsPatch(settingsRef.current, confirmedSettingsRef.current, optimistic, patch);
          settingsRef.current = restored;
          setSettings(restored);
        }
        throw new Error(friendlyError(error, t));
      }
    });
    settingsQueueRef.current = write;
    return write;
  }, [bootstrap, commandMutation, notify, t]);
  const renderedHref = window.location.href;
  const clearForms = { issueId: undefined, journalId: undefined, createIssue: undefined, releaseForm: undefined, overlay: undefined, moveIssueId: undefined };
  const openIssue = useCallback((issue: Issue, journalId?: number) => {
    navigate({ projectId: issue.projectId, issueId: issue.id, journalId, createIssue: undefined, releaseForm: undefined, overlay: undefined, moveIssueId: undefined });
  }, [navigate]);
  const closeIssue = useCallback(() => closeNavigation({ issueId: undefined, journalId: undefined }), [closeNavigation]);
  const openCreateIssue = (defaults: NavigationState['createIssue'] = {}) => navigate({ ...clearForms, createIssue: defaults });
  const closeCreateIssue = () => { if (window.location.href === renderedHref) closeNavigation({ createIssue: undefined }); };
  const openScreen = (next: Screen, replace = false) => navigate({ ...clearForms, screen: next, archived: next === 'inbox' ? false : archived, versionId: next === 'releases' ? undefined : selectedVersionId }, { replace });
  const setFilters = (update: Filters | ((current: Filters) => Filters), replace = false) => navigate(current => ({ filters: typeof update === 'function' ? update(current.filters) : update }), { replace });
  const openOverlay = (overlay: NavigationState['overlay'], moveIssueId?: number) => navigate({ overlay, moveIssueId });
  const closeOverlay = () => closeNavigation({ overlay: undefined, moveIssueId: undefined });
  const pickProject = (nextProject: Project) => {
    if (projectPickerOpen && nextProject.id === selectedProjectId) { closeOverlay(); setProjectSearch(''); return; }
    navigate({ ...clearForms, projectId: nextProject.id, screen: 'board', view: 'all', filters: {}, versionId: undefined, archived: false }, { replace: projectPickerOpen });
    setProjectSearch('');
  };
  const selectView = (next: View) => {
    navigate(current => {
      const base = { ...clearForms, screen: next === 'backlog' || (next === 'mine' && current.view === 'backlog') ? 'backlog' as const : 'board' as const };
      if (next === 'mine') return { ...base, view: current.view === 'mine' ? 'all' : current.view, filters: toggleAssignedToMe(current.filters) };
      return { ...base, view: next, filters: next === 'all' && current.filters.assignedToMe ? toggleAssignedToMe(current.filters) : current.filters };
    });
  };
  const selectSavedView = (saved: SavedView) => navigate({ ...clearForms, screen: saved.view === 'backlog' ? 'backlog' : 'board', view: saved.view, filters: saved.filters });
  const selectVersion = (versionId?: number) => {
    if (versionId === undefined) closeNavigation({ versionId: undefined, releaseForm: undefined });
    else navigate({ versionId, releaseForm: undefined });
  };
  const changeReleaseForm = (releaseForm: NavigationState['releaseForm']) => {
    if (releaseForm === undefined) {
      if (window.location.href === renderedHref) closeNavigation({ releaseForm: undefined });
    } else navigate({ releaseForm });
  };
  const onSaveView = async (name: string, nextFilters: Filters, savedView: View) => {
    const next: SavedView[] = [...settingsRef.current.savedViews.filter((item) => !(item.projectId === selectedProjectId && item.name === name)), { id: crypto.randomUUID(), projectId: selectedProjectId, name, filters: nextFilters, view: savedView }];
    await patchSettings({ savedViews: next });
    notify(t('saved'));
  };
  const removeSavedView = async (saved: SavedView) => {
    await patchSettings({ savedViews: settingsRef.current.savedViews.filter((item) => item.id !== saved.id) });
  };
  const saveIssue = async (issue: Issue, patch: IssueEditPatch, operationId?: string): Promise<Issue | void> => {
    const input: Record<string, unknown> = { ...patch };
    for (const optionalKey of ['assignedToId', 'fixedVersionId', 'dueDate'] as const) {
      if (optionalKey in patch && patch[optionalKey] === undefined) input[optionalKey] = null;
    }
    const result = await runCommand({ type: 'updateIssue', issueId: issue.id, operationId, input });
    if (result.operation.status !== 'done') throw new Error(t('operationRunning'));
    await refreshQueries();
    return result.issue;
  };
  const saveIssueRoles = async (issue: Issue, rolePatch: { developerId?: number | null; qaId?: number | null }, operationId?: string): Promise<Issue | void> => {
    let updated: Issue | undefined;
    try { updated = await api.post<Issue>(`/api/issues/${issue.id}/roles`, { ...rolePatch, operationId }); }
    catch (error) { throw new Error(friendlyError(error, t)); }
    await refreshQueries();
    return updated;
  };
  const commentIssue = async (issue: Issue, notes: string) => { const result = await runCommand({ type: 'comment', issueId: issue.id, input: { notes } }); if (result.operation.status !== 'done') throw new Error(t('operationRunning')); };
  const createIssue = async (input: { subject: string; description: string; statusId?: number; priorityId?: number; trackerId?: number; assignedToId?: number; fixedVersionId?: number }, operationId?: string) => {
    const fromUrl = window.location.href;
    const result = await runCommand({ type: 'createIssue', projectId: selectedProjectId, operationId, input });
    if (result.operation.status !== 'done') throw new Error(t('operationRunning'));
    await refreshQueries();
    if (window.location.href === fromUrl) navigate({ createIssue: undefined }, { complete: true });
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
    const fromUrl = window.location.href;
    const result = await runCommand({ type: 'createRelease', projectId: selectedProjectId, input });
    if (result.operation.status !== 'done' && result.operation.status !== 'running') throw new Error(t('operationRunning'));
    await refreshQueries();
    if (result.version && window.location.href === fromUrl) navigate({ versionId: result.version.id, releaseForm: undefined }, { replace: true });
    notify(t('releaseCreated'));
  };
  const assignRelease = async (versionId: number, issueIds: number[], fixedVersionId: number | null) => {
    if (issueIds.length === 0) return;
    const fromUrl = window.location.href;
    await runCommand({ type: 'assignRelease', projectId: selectedProjectId, versionId, input: { issueIds, fixedVersionId } });
    await refreshQueries();
    if (location.releaseForm === 'assign' && window.location.href === fromUrl) navigate({ releaseForm: undefined }, { complete: true });
  };
  const updateRelease = async (version: import('../../shared/types').Version, patch: Omit<Partial<import('../../shared/types').Version>, 'dueDate'> & { dueDate?: string | null }) => {
    const fromUrl = window.location.href;
    await runCommand({ type: 'updateRelease', projectId: selectedProjectId, versionId: version.id, input: patch as Record<string, unknown> });
    await refreshQueries();
    if (location.releaseForm === 'edit' && window.location.href === fromUrl) navigate({ releaseForm: undefined }, { complete: true });
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
    const sequence = ++notificationOpenSequenceRef.current;
    const fromUrl = window.location.href;
    try {
      const detail = await queryClient.fetchQuery({ queryKey: ['issue', notification.issueId], queryFn: () => api.get<IssueDetail>(`/api/issues/${notification.issueId}`), staleTime: 0 });
      if (window.location.href !== fromUrl || sequence !== notificationOpenSequenceRef.current) return;
      navigate({ ...clearForms, projectId: detail.issue.projectId, issueId: notification.issueId, journalId: notification.journalId });
      if (!notification.readAt) await markRead(notification);
    } catch (error) { notify(friendlyError(error, t)); }
  };
  const manualSync = async () => {
    setBusySync(true);
    try { await api.post('/api/sync'); await refreshQueries(); notify(t('synced', { time: new Date().toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' }) })); }
    catch (error) { notify(friendlyError(error, t)); }
    finally { setBusySync(false); }
  };
  const copyIssueUrl = useCallback(async (targetIssueId: number) => {
    try { await navigator.clipboard.writeText(issueUrl(bootstrap.redmineUrl, targetIssueId)); notify(t('copied')); } catch { notify(t('error')); }
  }, [bootstrap.redmineUrl, notify, t]);
  const copyIssueBranch = useCallback(async (targetIssueId: number) => {
    const issue = board?.issues.find((entry) => entry.id === targetIssueId) || queryClient.getQueryData<IssueDetail>(['issue', targetIssueId])?.issue;
    if (!issue?.branch) return;
    try { await navigator.clipboard.writeText(issue.branch); notify(t('copied')); } catch { notify(t('error')); }
  }, [board?.issues, notify, queryClient, t]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      const activeSelection = window.getSelection()?.toString();
      const shortcuts = settingsRef.current.shortcuts;
      const match = shortcuts.find((shortcut) => shortcutForEvent(shortcut, event));
      if (!match) return;
      const action = match.action === 'view' && match.value === 'mine' ? 'view/mine' : match.action;
      const isSaveFormShortcut = action === 'saveForm' && (event.metaKey || event.ctrlKey);
      if (isEditableTarget(event.target) && !isSaveFormShortcut) return;
      if (document.querySelector('[data-workspace-popover]') && !isSaveFormShortcut) return;
      if (action === 'saveForm') {
        if (isSaveFormShortcut && dispatchActiveFormSave(event.target instanceof Element ? event.target : null)) event.preventDefault();
        return;
      }
      if ((action === 'createIssue' || action === 'moveStatus') && !canWrite) return;
      const topModal = [...document.querySelectorAll<HTMLElement>('.modal[aria-modal="true"]')].at(-1);
      const focusedCard = document.activeElement instanceof Element ? document.activeElement.closest<HTMLElement>('.issue-card') : null;
      const focusedCardIssueId = Number(focusedCard?.dataset.issueId) || undefined;
      const modalIssueId = topModal?.classList.contains('issue-dialog') && issueOpen ? issueId : undefined;
      const targetIssueId = resolveIssueShortcutTarget({ hasModal: Boolean(topModal), modalIssueId, focusedCardIssueId });
      if ((action === 'copyBranch' || action === 'copyRedmineUrl') && (activeSelection || !targetIssueId)) return;
      if (action === 'moveStatus' && !targetIssueId) return;
      event.preventDefault();
      if (action === 'view/mine') navigate(current => ({ filters: toggleAssignedToMe(current.filters), view: current.view === 'mine' ? 'all' : current.view }));
      else if (action === 'projectPicker') openOverlay('projects');
      else if (action === 'search') searchRef.current?.focus();
      else if (action === 'createIssue') openCreateIssue();
      else if (action === 'commandPalette') openOverlay('commands');
      else if (action === 'copyBranch') void copyIssueBranch(targetIssueId!);
      else if (action === 'copyRedmineUrl') void copyIssueUrl(targetIssueId!);
      else if (action === 'moveStatus') {
        const targeted = match.value && statuses.find((status) => String(status.id) === match.value || status.key === match.value);
        const targetIssue = targetIssueId ? board?.issues.find(issue => issue.id === targetIssueId) || queryClient.getQueryData<IssueDetail>(['issue', targetIssueId])?.issue : undefined;
        if (targeted && targetIssue) void moveIssue(targetIssue, { statusId: targeted.id, fixedVersionId: targetIssue.fixedVersionId }).catch((error) => notify(friendlyError(error, t)));
        else if (targetIssue) openOverlay('move', targetIssue.id);
      }
      else if (action === 'label' && match.value) setFilters((current) => ({ ...current, label: match.value }));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [board?.issues, canWrite, copyIssueBranch, copyIssueUrl, issueId, issueOpen, notify, queryClient, statuses, t, view, navigate, location]);

  const visibleProjects = bootstrap.projects.filter((item) => `${item.name} ${item.identifier}`.toLocaleLowerCase().includes(projectSearch.toLocaleLowerCase()));
  const statusesReady = statuses.length > 0;
  if (!project) return <div className="startup-state startup-error"><div className="startup-brand"><span className="brand-mark"><LayoutDashboard size={18} /></span><strong>{t('appName')}</strong></div><div className="empty-illustration"><ShieldCheck size={24} /></div><h1>{t('noProjects')}</h1><p>{bootstrap.mode === 'redmine' ? t('readOnlyNote') : t('offline')}</p><Button variant="primary" onClick={onReload}>{t('retry')}</Button></div>;
  return <div className={`app-frame${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
    <aside className="sidebar">
      <div className="sidebar-top"><a href="#home" className="brand-lockup" onClick={(e) => e.preventDefault()}><span className="brand-mark"><LayoutDashboard size={17} /></span><span className="brand-name">Redmine<span>Workspace</span></span></a><IconButton label={sidebarCollapsed ? t('open') : t('close')} className="sidebar-collapse" onClick={() => setSidebarCollapsed((value) => !value)}>{sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</IconButton></div>
      <button type="button" className="project-selector" onClick={() => { openOverlay('projects'); setProjectSearch(''); }} aria-haspopup="dialog"><span className="project-symbol">{project.name.trim().charAt(0).toUpperCase()}</span><span className="project-selector-text"><small>{t('projects')}</small><strong>{project.name}</strong></span><ChevronDown size={15} /></button>
      <div className="sidebar-scroll">
        <div className="nav-group"><span className="nav-label">{t('workspace')}</span>
          <NavItem active={screen === 'board' && view === 'all' && !mineFilterActive} label={t('viewAll')} icon={<LayoutDashboard size={17} />} collapsed={sidebarCollapsed} onClick={() => selectView('all')} />
          <NavItem active={(screen === 'board' || screen === 'backlog') && mineFilterActive} label={t('viewMine')} icon={<UserRound size={17} />} collapsed={sidebarCollapsed} shortcut="Q" onClick={() => selectView('mine')} />
          <NavItem active={screen === 'board' && view === 'watching'} label={t('watching')} icon={<Bell size={17} />} collapsed={sidebarCollapsed} onClick={() => selectView('watching')} />
          <NavItem active={screen === 'backlog'} label={t('backlog')} icon={<ListTodo size={17} />} collapsed={sidebarCollapsed} onClick={() => selectView('backlog')} />
        </div>
        <div className="nav-group"><span className="nav-label">{t('personal')}</span>
          <NavItem active={screen === 'inbox'} label={t('inbox')} icon={unreadCount > 0 ? <BellDot size={17} /> : <Inbox size={17} />} collapsed={sidebarCollapsed} count={unreadCount} onClick={() => openScreen('inbox')} />
          <NavItem active={screen === 'releases'} label={t('releases')} icon={<Rocket size={17} />} collapsed={sidebarCollapsed} onClick={() => openScreen('releases')} />
          <NavItem active={screen === 'settings'} label={t('settings')} icon={<Settings2 size={17} />} collapsed={sidebarCollapsed} onClick={() => openScreen('settings')} />
        </div>
      </div>
      <div className="sidebar-bottom"><div className="mode-footer"><span className={`connection-indicator ${bootstrap.connected ? 'is-connected' : 'is-offline'}`} /><span>{bootstrap.mode === 'demo' ? t('demo') : t('readonly')}</span></div><div className="user-footer"><Avatar person={bootstrap.me} size="sm" /><span><strong>{bootstrap.me.name}</strong><small>{bootstrap.mode === 'demo' ? t('demo') : t('readOnlyBadge')}</small></span></div></div>
    </aside>
    <div className="app-main">
      <header className="topbar">
        <div className="breadcrumbs"><span>{project.name}</span><span className="crumb-separator">/</span><strong>{screen === 'board' ? view === 'mine' || (view === 'all' && filters.assignedToMe) ? t('viewMine') : view === 'watching' ? t('viewWatching') : t('board') : screen === 'backlog' ? t('viewBacklog') : screen === 'inbox' ? t('inbox') : screen === 'releases' ? t('releases') : t('settings')}</strong></div>
        <div className="topbar-actions">
          <label className="global-search"><Search size={16} /><input ref={searchRef} type="search" aria-label={t('search')} placeholder={t('searchPlaceholder')} value={filters.search || ''} onFocus={() => { searchEditingRef.current = false; }} onBlur={() => { searchEditingRef.current = false; }} onChange={e => { setFilters(current => ({ ...current, search: e.target.value || undefined }), searchEditingRef.current); searchEditingRef.current = true; }} /><kbd>⌘ K</kbd></label>
          <div className={`connection-pill ${bootstrap.connected ? 'connection-online' : 'connection-offline'}`} title={bootstrap.connected ? t('connected') : t('offline')}><span />{bootstrap.connected ? (bootstrap.mode === 'demo' ? t('demo') : t('connected')) : t('offline')}</div>
          <IconButton label={t('operationTitle')} onClick={() => openOverlay('activity')} className="activity-trigger"><Activity size={17} /></IconButton>
          <Button variant="quiet" size="sm" onClick={manualSync} disabled={busySync}>{busySync ? <Spinner /> : <Sparkles size={15} />}{t('sync')}</Button>
        </div>
      </header>
      <div className="content-scroll" ref={contentScrollRef} onScroll={(event) => { scrollPositionsRef.current[`${selectedProjectId}:${screen}`] = event.currentTarget.scrollTop; }}>
        {(screen === 'board' || screen === 'backlog') && <>{boardQuery.isLoading && <div className="page-loading"><Spinner label={t('loading')} /></div>}{boardQuery.isError && <div className="page-error"><Notice tone="error">{t('boardFailed')} <Button size="sm" onClick={() => boardQuery.refetch()}>{t('retry')}</Button></Notice></div>}{board && statusesReady && <BoardPage project={project} data={board} statuses={statuses} priorities={bootstrap.priorities} me={bootstrap.me} settings={settings} view={screen === 'backlog' ? 'backlog' : view} filters={filters} canWrite={canWrite} pendingIssueIds={pendingIssueIds} onFiltersChange={setFilters} onSettingsChange={(patch) => { void patchSettings(patch).catch((error) => notify(error instanceof Error ? error.message : t('error'))); }} onViewChange={selectView} onSelectSavedView={selectSavedView} onDeleteSavedView={(saved) => { void removeSavedView(saved).catch((error) => notify(error instanceof Error ? error.message : t('error'))); }} onOpenIssue={openIssue} onCreateIssue={openCreateIssue} onMoveIssue={(issue, target) => { void moveIssue(issue, target).catch((error) => notify(error instanceof Error ? error.message : t('error'))); }} onSaveView={(name, nextFilters, savedView) => { void onSaveView(name, nextFilters, savedView).catch((error) => notify(error instanceof Error ? error.message : t('error'))); }} onToast={notify} savedViews={customViews} />}</>}
        {screen === 'inbox' && <InboxPage notifications={notifications} projects={bootstrap.projects} archived={archived} onToggleArchived={() => navigate({ archived: !archived })} onMarkRead={(notification) => { void markRead(notification).catch((error) => notify(friendlyError(error, t))); }} onOpenIssue={(notification) => { void openNotification(notification); }} />}
        {screen === 'releases' && !board && <div className="page-loading">{boardQuery.isError ? <Notice tone="error">{friendlyError(boardQuery.error, t)} <Button size="sm" onClick={() => boardQuery.refetch()}>{t('retry')}</Button></Notice> : <Spinner label={t('loading')} />}</div>}
        {screen === 'releases' && board && <ReleasesPage project={project} board={board} statuses={statuses} priorities={bootstrap.priorities} members={members} versions={board.versions} selectedVersionId={selectedVersionId} canWrite={canWrite} onSelectVersion={selectVersion} form={location.releaseForm} onFormChange={changeReleaseForm} draftScope={`${bootstrap.mode}:${bootstrap.redmineUrl}:${bootstrap.me.id}`}  onOpenIssue={openIssue} onCreateRelease={createRelease} onAssign={assignRelease} onUpdateRelease={updateRelease} onFinish={finishRelease} onToast={notify} />}
        {screen === 'settings' && <SettingsPage key={selectedProjectId} settings={settings} members={members} peopleRecommendations={board?.peopleRecommendations} project={project} projects={bootstrap.projects} statuses={statuses} labels={board?.labels || []} readOnly={bootstrap.mode === 'redmine' || bootstrap.readOnly} onPatchSettings={patch => patchSettings(patch)} onResetViews={() => { void patchSettings({ savedViews: settingsRef.current.savedViews.filter((saved) => saved.projectId !== selectedProjectId) }).catch(error => notify(error instanceof Error ? error.message : t('error'))); }} onToast={notify} />}
      </div>
    </div>

    {issueOpen && issueId && issueDetail && freshIssueDetailId === issueId && <IssueDialog key={`${bootstrap.mode}:${bootstrap.redmineUrl}:${bootstrap.me.id}:${issueId}`} draftScope={`${bootstrap.mode}:${bootstrap.redmineUrl}:${bootstrap.me.id}`} detail={issueDetail} board={queryClient.getQueryData<import('../../shared/types').BoardData>(['board', issueDetail.issue.projectId]) || board || emptyBoard()} statuses={statuses} priorities={bootstrap.priorities} redmineUrl={bootstrap.redmineUrl} canWrite={canWrite} initialJournalId={initialJournalId} onClose={closeIssue} onSave={saveIssue} onComment={commentIssue} onSaveRoles={saveIssueRoles} onToast={notify} />}
    {issueOpen && issueId && (freshIssueDetailId !== issueId || !issueDetail) && <Modal title={`#${issueId}`} onClose={closeIssue} size="sm"><div className="center-loading">{issueLoadError ? <><Notice tone="error">{issueLoadError}</Notice><Button size="sm" onClick={() => setIssueLoadAttempt(attempt => attempt + 1)}>{t('retry')}</Button></> : <Spinner label={t('loading')} />}</div></Modal>}
    {createIssueDefaults && board && <CreateIssueDialog key={`${bootstrap.mode}:${bootstrap.redmineUrl}:${bootstrap.me.id}:${selectedProjectId}`} project={project} board={board || emptyBoard()} statuses={statuses} priorities={bootstrap.priorities} canWrite={canWrite} defaults={createIssueDefaults} draftScope={`${bootstrap.mode}:${bootstrap.redmineUrl}:${bootstrap.me.id}:${selectedProjectId}`} onClose={closeCreateIssue} onCreate={createIssue} />}
    {createIssueDefaults && !board && <Modal title={t('createIssue')} onClose={closeCreateIssue} size="sm"><div className="center-loading">{boardQuery.isError ? <><Notice tone="error">{friendlyError(boardQuery.error, t)}</Notice><Button size="sm" onClick={() => boardQuery.refetch()}>{t('retry')}</Button></> : <Spinner label={t('loading')} />}</div></Modal>}
    {projectPickerOpen && <ProjectPickerDialog projects={visibleProjects} current={project} search={projectSearch} onSearch={setProjectSearch} onPick={pickProject} onClose={closeOverlay} />}
    {showPalette && <CommandPalette onClose={closeOverlay} onSearch={() => { focusSearchAfterCloseRef.current = true; closeOverlay(); }} onCreate={() => navigate({ ...clearForms, createIssue: {} }, { replace: true })} onProject={() => navigate({ overlay: 'projects' }, { replace: true })} onInbox={() => openScreen('inbox', true)} onRelease={() => openScreen('releases', true)} />}
    {quickMoveIssue && <QuickMoveDialog issue={quickMoveIssue} statuses={statuses} onMove={(statusId) => { closeOverlay(); void moveIssue(quickMoveIssue, { statusId, fixedVersionId: quickMoveIssue.fixedVersionId }).catch((error) => notify(error instanceof Error ? error.message : t('error'))); }} onClose={() => closeOverlay()} canWrite={canWrite} />}
    {quickMoveIssueId && !quickMoveIssue && <Modal title={`#${quickMoveIssueId}`} onClose={closeOverlay} size="sm"><div className="center-loading">{quickMoveQuery.isError ? <><Notice tone="error">{friendlyError(quickMoveQuery.error, t)}</Notice><Button size="sm" onClick={() => quickMoveQuery.refetch()}>{t('retry')}</Button></> : <Spinner label={t('loading')} />}</div></Modal>}
    {showActivity && <OperationsDrawer operations={operationsQuery.data || []} mode={bootstrap.mode} onClose={closeOverlay} onRetry={(operation) => { void retryOperation(operation, runCommand, notify, t); }} />}
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
