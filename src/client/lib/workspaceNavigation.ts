import { useCallback, useEffect, useRef, useState } from 'react';
import type { Filters, View } from '../../shared/types';

export type Screen = 'board' | 'backlog' | 'inbox' | 'releases' | 'settings';
export type ReleaseForm = 'new' | 'edit' | 'assign';

export interface NavigationState {
  projectId?: number;
  screen: Screen;
  view: View;
  filters: Filters;
  issueId?: number;
  journalId?: number;
  createIssue?: { statusId?: number; fixedVersionId?: number | null };
  versionId?: number;
  archived: boolean;
  releaseForm?: ReleaseForm;
  overlay?: 'projects' | 'commands' | 'activity' | 'move';
  moveIssueId?: number;
}

export type NavigationChange = Partial<NavigationState> | ((current: NavigationState) => Partial<NavigationState>);
export interface NavigationOptions { replace?: boolean; complete?: boolean }

const defaultState: NavigationState = { screen: 'board', view: 'all', filters: {}, archived: false };
const historyNamespace = '__redmineWorkspaceNavigation';
const screens = new Set<Screen>(['board', 'backlog', 'inbox', 'releases', 'settings']);
const views = new Set<View>(['all', 'mine', 'watching', 'backlog']);
const releaseForms: Record<string, ReleaseForm> = {
  'new-release': 'new', 'edit-release': 'edit', 'assign-release': 'assign',
};
const overlayValues = new Set<NonNullable<NavigationState['overlay']>>(['projects', 'commands', 'activity', 'move']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function positiveId(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePositiveId(value: string | null): number | undefined {
  return value === null ? undefined : positiveId(value);
}

function parseIdList(params: URLSearchParams, key: string): number[] | undefined {
  const ids = [...new Set(params.getAll(key).flatMap(value => value.split(',')).map(positiveId).filter((id): id is number => id !== undefined))]
    .sort((a, b) => a - b);
  return ids.length ? ids : undefined;
}

function parseBoolean(value: string | null): boolean {
  return value === '1' || value?.toLocaleLowerCase() === 'true';
}

function parseFilters(params: URLSearchParams): Filters {
  const filters: Filters = {};
  const search = params.get('q');
  if (search?.trim()) filters.search = search;
  if (parseBoolean(params.get('mine'))) filters.assignedToMe = true;
  const assigneeId = parsePositiveId(params.get('assignee'));
  if (assigneeId !== undefined) filters.assigneeId = assigneeId;
  const labels = [...new Set(params.getAll('label').map(value => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (labels.length) filters.labels = labels;
  const statusIds = parseIdList(params, 'statusFilter');
  if (statusIds) filters.statusIds = statusIds;
  const priorityIds = parseIdList(params, 'priorityFilter');
  if (priorityIds) filters.priorityIds = priorityIds;
  const versionId = parsePositiveId(params.get('versionFilter'));
  if (versionId !== undefined) filters.versionId = versionId;
  if (parseBoolean(params.get('closed'))) filters.includeClosed = true;
  return filters;
}

function normalizeFilters(value: unknown): Filters {
  const raw = record(value) ?? {};
  const filters: Filters = {};
  if (typeof raw.search === 'string' && raw.search.trim()) filters.search = raw.search;
  if (raw.assignedToMe === true) filters.assignedToMe = true;
  const assigneeId = positiveId(raw.assigneeId);
  if (assigneeId !== undefined) filters.assigneeId = assigneeId;
  const rawLabels = [...(Array.isArray(raw.labels) ? raw.labels : []), ...(typeof raw.label === 'string' ? [raw.label] : [])];
  const labels = [...new Set(rawLabels.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  if (labels.length) filters.labels = labels;
  const normalizeIds = (items: unknown): number[] | undefined => {
    if (!Array.isArray(items)) return undefined;
    const ids = [...new Set(items.map(positiveId).filter((id): id is number => id !== undefined))].sort((a, b) => a - b);
    return ids.length ? ids : undefined;
  };
  const statusIds = normalizeIds(raw.statusIds);
  if (statusIds) filters.statusIds = statusIds;
  const priorityIds = normalizeIds(raw.priorityIds);
  if (priorityIds) filters.priorityIds = priorityIds;
  const versionId = positiveId(raw.versionId);
  if (versionId !== undefined) filters.versionId = versionId;
  if (raw.includeClosed === true) filters.includeClosed = true;
  return filters;
}

function normalizeState(value: Partial<NavigationState> | NavigationState): NavigationState {
  const raw = value as Record<string, unknown>;
  const screen = screens.has(raw.screen as Screen) ? raw.screen as Screen : defaultState.screen;
  let view = views.has(raw.view as View) ? raw.view as View : defaultState.view;
  const filters = normalizeFilters(raw.filters);
  if (view === 'mine') {
    view = 'all';
    filters.assignedToMe = true;
  }
  const state: NavigationState = {
    screen,
    view,
    filters,
    archived: raw.archived === true,
  };
  for (const key of ['projectId', 'issueId', 'journalId', 'versionId', 'moveIssueId'] as const) {
    const id = positiveId(raw[key]);
    if (id !== undefined) state[key] = id;
  }
  if (raw.createIssue && typeof raw.createIssue === 'object') {
    const defaults = raw.createIssue as Record<string, unknown>;
    const createIssue: NonNullable<NavigationState['createIssue']> = {};
    const statusId = positiveId(defaults.statusId);
    if (statusId !== undefined) createIssue.statusId = statusId;
    if (defaults.fixedVersionId === null) createIssue.fixedVersionId = null;
    else {
      const fixedVersionId = positiveId(defaults.fixedVersionId);
      if (fixedVersionId !== undefined) createIssue.fixedVersionId = fixedVersionId;
    }
    state.createIssue = createIssue;
  }
  if (raw.releaseForm === 'new' || raw.releaseForm === 'edit' || raw.releaseForm === 'assign') state.releaseForm = raw.releaseForm;
  if (overlayValues.has(raw.overlay as NonNullable<NavigationState['overlay']>)) state.overlay = raw.overlay as NavigationState['overlay'];
  // A single URL form cannot describe both issue creation and a release form.
  if ((state.releaseForm === 'edit' || state.releaseForm === 'assign') && state.versionId === undefined) delete state.releaseForm;
  if (state.releaseForm) {
    state.screen = 'releases';
    delete state.createIssue;
  }
  if (state.createIssue || state.releaseForm) {
    delete state.issueId;
    delete state.journalId;
  }
  if (state.screen === 'backlog') state.view = 'backlog';
  if (state.overlay === 'move') {
    if (state.moveIssueId === undefined) delete state.overlay;
  } else {
    delete state.moveIssueId;
  }
  if (state.issueId === undefined) delete state.journalId;
  return state;
}

function queryFromSearch(search: string): URLSearchParams {
  const question = search.indexOf('?');
  const query = question >= 0 ? search.slice(question + 1).split('#', 1)[0]! : search;
  return new URLSearchParams(query);
}

/** Parse the supported workspace query contract; unrelated query values are ignored. */
export function parseNavigation(search: string): NavigationState {
  const params = queryFromSearch(search);
  const tab = params.get('tab') as Screen | null;
  const view = params.get('view') as View | null;
  const state: NavigationState = {
    screen: tab && screens.has(tab) ? tab : defaultState.screen,
    view: view && views.has(view) ? view : defaultState.view,
    filters: parseFilters(params),
    archived: parseBoolean(params.get('archive')),
  };
  const projectId = parsePositiveId(params.get('project'));
  const issueId = parsePositiveId(params.get('issue'));
  const journalId = parsePositiveId(params.get('journal'));
  const versionId = parsePositiveId(params.get('release'));
  const moveIssueId = parsePositiveId(params.get('move'));
  if (projectId !== undefined) state.projectId = projectId;
  if (issueId !== undefined) state.issueId = issueId;
  if (journalId !== undefined) state.journalId = journalId;
  if (versionId !== undefined) state.versionId = versionId;
  if (moveIssueId !== undefined) state.moveIssueId = moveIssueId;

  const form = params.get('form');
  if (form === 'new-issue') {
    const createIssue: NonNullable<NavigationState['createIssue']> = {};
    const statusId = parsePositiveId(params.get('status'));
    if (statusId !== undefined) createIssue.statusId = statusId;
    const roadmap = params.get('roadmap');
    if (roadmap === 'none') createIssue.fixedVersionId = null;
    else {
      const fixedVersionId = parsePositiveId(roadmap);
      if (fixedVersionId !== undefined) createIssue.fixedVersionId = fixedVersionId;
    }
    state.createIssue = createIssue;
  } else if (form && releaseForms[form]) {
    state.releaseForm = releaseForms[form];
  }
  const overlay = params.get('overlay') as NavigationState['overlay'] | null;
  if (overlay && overlayValues.has(overlay)) state.overlay = overlay;
  return normalizeState(state);
}

function appendId(params: URLSearchParams, key: string, value: number | undefined): void {
  if (value !== undefined) params.set(key, String(value));
}

/** Build a canonical URL containing only workspace navigation state. */
export function navigationUrl(stateValue: NavigationState, pathname = '/'): string {
  const state = normalizeState(stateValue);
  const params = new URLSearchParams();
  appendId(params, 'project', state.projectId);
  if (state.screen !== 'board') params.set('tab', state.screen);
  if (state.view !== 'all') params.set('view', state.view);
  appendId(params, 'issue', state.issueId);
  appendId(params, 'journal', state.journalId);
  if (state.createIssue) {
    params.set('form', 'new-issue');
    appendId(params, 'status', state.createIssue.statusId);
    if (state.createIssue.fixedVersionId === null) params.set('roadmap', 'none');
    else appendId(params, 'roadmap', state.createIssue.fixedVersionId);
  } else if (state.releaseForm) {
    params.set('form', state.releaseForm === 'new' ? 'new-release' : state.releaseForm === 'edit' ? 'edit-release' : 'assign-release');
  }
  appendId(params, 'release', state.versionId);
  if (state.archived) params.set('archive', '1');
  if (state.overlay) params.set('overlay', state.overlay);
  appendId(params, 'move', state.moveIssueId);

  const filters = state.filters;
  if (filters.search?.trim()) params.set('q', filters.search);
  if (filters.assignedToMe) params.set('mine', '1');
  appendId(params, 'assignee', filters.assigneeId);
  for (const label of filters.labels ?? []) params.append('label', label);
  for (const id of filters.statusIds ?? []) params.append('statusFilter', String(id));
  for (const id of filters.priorityIds ?? []) params.append('priorityFilter', String(id));
  appendId(params, 'versionFilter', filters.versionId);
  if (filters.includeClosed) params.set('closed', '1');
  const query = params.toString();
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return query ? `${path}?${query}` : path;
}

function currentHref(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function canonicalHref(href: string, origin = window.location.origin): string | undefined {
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin) return undefined;
    return `${url.pathname}${url.search}`;
  } catch { return undefined; }
}

function parentHrefFromHistoryState(historyState: unknown, origin: string): string | undefined {
  const metadata = record(record(historyState)?.[historyNamespace]);
  const parent = metadata?.previousUrl;
  return typeof parent === 'string' ? canonicalHref(parent, origin) : undefined;
}

/** True only for a history entry created by this router whose recorded parent is the close target. */
export function shouldUseHistoryBack(historyState: unknown, desiredHref: string, origin = 'http://workspace.local'): boolean {
  const parentHref = parentHrefFromHistoryState(historyState, origin);
  const desired = canonicalHref(desiredHref, origin);
  return parentHref !== undefined && desired !== undefined && parentHref === desired;
}

function objectState(value: unknown): Record<string, unknown> {
  return record(value) ?? {};
}

function historyStateForReplace(existing: unknown, targetHref: string, origin: string): Record<string, unknown> {
  const next = { ...objectState(existing) };
  const parentHref = parentHrefFromHistoryState(existing, origin);
  if (parentHref && parentHref !== targetHref) next[historyNamespace] = { previousUrl: parentHref };
  else delete next[historyNamespace];
  return next;
}

function historyStateForPush(existing: unknown, parentHref: string): Record<string, unknown> {
  return { ...objectState(existing), [historyNamespace]: { previousUrl: parentHref } };
}

export function useWorkspaceNavigation(): {
  location: NavigationState;
  navigate(change: NavigationChange, options?: NavigationOptions): void;
  close(change: Partial<NavigationState>): void;
} {
  const [location, setLocation] = useState<NavigationState>(() =>
    typeof window === 'undefined' ? defaultState : parseNavigation(window.location.search));
  const latest = useRef(location);
  const pendingBack = useRef(false);
  latest.current = location;

  useEffect(() => {
    const onPopState = () => {
      pendingBack.current = false;
      const next = parseNavigation(window.location.search);
      latest.current = next;
      setLocation(next);
    };
    window.addEventListener('popstate', onPopState);
    const canonical = navigationUrl(latest.current, window.location.pathname);
    if (currentHref() !== canonical) {
      window.history.replaceState(historyStateForReplace(window.history.state, canonical, window.location.origin), '', canonical);
    }
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((change: NavigationChange, options: NavigationOptions = {}) => {
    if (pendingBack.current) return;
    const requested = typeof change === 'function' ? change(latest.current) : change;
    const next = normalizeState({ ...latest.current, ...requested });
    if (typeof window === 'undefined') {
      latest.current = next;
      setLocation(next);
      return;
    }
    const targetHref = navigationUrl(next, window.location.pathname);
    const currentHrefValue = currentHref();
    const currentCanonical = navigationUrl(parseNavigation(window.location.search), window.location.pathname);
    if (targetHref === currentCanonical) {
      if (currentHrefValue !== targetHref) {
        window.history.replaceState(historyStateForReplace(window.history.state, targetHref, window.location.origin), '', targetHref);
      }
      return;
    }
    const collapseCompletedForm = options.complete && shouldUseHistoryBack(window.history.state, targetHref, window.location.origin);
    if (options.replace || options.complete) {
      window.history.replaceState(historyStateForReplace(window.history.state, targetHref, window.location.origin), '', targetHref);
    } else {
      // Normalize the current entry before recording it as a parent so Back returns to a canonical URL.
      if (currentHrefValue !== currentCanonical) {
        window.history.replaceState(historyStateForReplace(window.history.state, currentCanonical, window.location.origin), '', currentCanonical);
      }
      window.history.pushState(historyStateForPush(window.history.state, currentCanonical), '', targetHref);
    }
    const normalized = parseNavigation(new URL(targetHref, window.location.origin).search);
    latest.current = normalized;
    setLocation(normalized);
    // Rewrite the forward entry so it cannot revive a submitted form.
    // Return to the identical parent now, rather than spending the user's next Back on it.
    if (collapseCompletedForm) {
      pendingBack.current = true;
      window.history.back();
    }
  }, []);

  const close = useCallback((change: Partial<NavigationState>) => {
    if (pendingBack.current) return;
    const next = normalizeState({ ...latest.current, ...change });
    if (typeof window === 'undefined') {
      latest.current = next;
      setLocation(next);
      return;
    }
    const desiredHref = navigationUrl(next, window.location.pathname);
    const currentCanonical = navigationUrl(parseNavigation(window.location.search), window.location.pathname);
    if (desiredHref === currentCanonical) return;
    if (shouldUseHistoryBack(window.history.state, desiredHref, window.location.origin)) {
      pendingBack.current = true;
      window.history.back();
      return;
    }
    navigate(change, { replace: true });
  }, [navigate]);

  return { location, navigate, close };
}
