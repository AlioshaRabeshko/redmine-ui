import { useEffect, useMemo, useRef } from 'react';
import type { Notification } from '../../../shared/types';
import type { VisibleJournal } from '../../lib/issueActivity';
import { parseNavigation } from '../../lib/workspaceNavigation';
import { visibleUnreadEvents } from './visibleUnreadEvents';

const visibleDwellMs = 1_000;
const sampleEveryMs = 100;

type RootRef = { current: HTMLDivElement | null };
type VisibleEventsCallback = (issueId: number, ids: string[]) => void | Promise<void>;

interface UseVisibleUnreadEventsOptions {
  issueId: number;
  projectId: number;
  notifications: Notification[];
  activity: VisibleJournal[];
  bufferedJournalIds: ReadonlySet<number>;
  excludedJournalIds: ReadonlySet<number>;
  rootRef: RootRef;
  onVisible: VisibleEventsCallback;
}

interface PartDwell {
  startedAt: number;
}

interface EventExposure {
  routeKey: string;
  signature: string;
  parts: Map<string, PartDwell>;
  seen: Set<string>;
}

/** Acknowledge only event content that stays visible in the active issue dialog for about one second. */
export function useVisibleUnreadEvents({
  issueId,
  projectId,
  notifications,
  activity,
  bufferedJournalIds,
  excludedJournalIds,
  rootRef,
  onVisible,
}: UseVisibleUnreadEventsOptions): void {
  const candidates = useMemo(() => visibleUnreadEvents({
    issueId,
    projectId,
    notifications,
    activity,
    bufferedJournalIds,
    excludedJournalIds,
  }), [activity, bufferedJournalIds, excludedJournalIds, issueId, notifications, projectId]);
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  const attemptedIdsRef = useRef(new Set<string>());

  useEffect(() => {
    attemptedIdsRef.current.clear();
  }, [issueId, projectId]);

  useEffect(() => {
    const exposures = new Map<string, EventExposure>();
    let previousRouteKey = currentRouteKey();

    const resetDwell = () => exposures.clear();
    const checkVisibility = () => {
      const root = rootRef.current;
      if (!root || !isActiveIssueDialog(root, issueId, projectId)) {
        resetDwell();
        return;
      }

      const routeKey = currentRouteKey();
      if (routeKey !== previousRouteKey) {
        previousRouteKey = routeKey;
        resetDwell();
      }

      const currentCandidates = candidatesRef.current;
      const currentIds = new Set(currentCandidates.map((candidate) => candidate.notificationId));
      for (const id of exposures.keys()) if (!currentIds.has(id)) exposures.delete(id);

      const now = Date.now();
      const due: string[] = [];
      for (const candidate of currentCandidates) {
        const id = candidate.notificationId;
        if (attemptedIdsRef.current.has(id)) continue;

        let exposure = exposures.get(id);
        if (!exposure || exposure.routeKey !== routeKey || exposure.signature !== candidate.signature) {
          exposure = { routeKey, signature: candidate.signature, parts: new Map(), seen: new Set() };
          exposures.set(id, exposure);
        }

        const requiredParts = ['heading', ...candidate.contentKinds];
        for (const part of requiredParts) {
          const element = part === 'heading'
            ? root.querySelector<HTMLElement>(`[data-unread-event-heading="${candidate.journalId}"]`)
            : root.querySelector<HTMLElement>(`[data-unread-event-content="${candidate.journalId}:${part}"]`);
          const visible = Boolean(element && isVisibleContentStart(element, root));
          if (visible) {
            let dwell = exposure.parts.get(part);
            if (!dwell) {
              dwell = { startedAt: now };
              exposure.parts.set(part, dwell);
            } else if (now - dwell.startedAt >= visibleDwellMs) {
              exposure.seen.add(part);
              exposure.parts.delete(part);
            }
          } else if (!exposure.seen.has(part)) {
            exposure.parts.delete(part);
          }
        }

        if (requiredParts.every((part) => exposure!.seen.has(part))) {
          exposures.delete(id);
          attemptedIdsRef.current.add(id);
          due.push(id);
        }
      }

      if (due.length) {
        try {
          const result = onVisibleRef.current(issueId, due);
          if (result && typeof result.then === 'function') void result.catch(() => undefined);
        } catch { /* Keep the event unread and wait for a later dialog open to retry. */ }
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) resetDwell();
      else checkVisibility();
    };
    const onBlur = resetDwell;
    const interval = window.setInterval(checkVisibility, sampleEveryMs);
    const root = rootRef.current;
    root?.addEventListener('scroll', checkVisibility, { passive: true });
    window.addEventListener('resize', checkVisibility);
    window.addEventListener('focus', checkVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('popstate', checkVisibility);
    window.addEventListener('hashchange', checkVisibility);
    document.addEventListener('visibilitychange', onVisibilityChange);
    checkVisibility();

    return () => {
      window.clearInterval(interval);
      root?.removeEventListener('scroll', checkVisibility);
      window.removeEventListener('resize', checkVisibility);
      window.removeEventListener('focus', checkVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('popstate', checkVisibility);
      window.removeEventListener('hashchange', checkVisibility);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      resetDwell();
    };
  }, [issueId, projectId, rootRef]);
}

function currentRouteKey(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function isActiveIssueDialog(root: HTMLDivElement | null, issueId: number, projectId: number): boolean {
  if (!root?.isConnected || document.visibilityState !== 'visible' || !document.hasFocus()) return false;
  const dialog = root.closest<HTMLElement>('[role="dialog"][aria-modal="true"]');
  if (!dialog?.classList.contains('issue-dialog')) return false;
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')];
  if (dialogs.at(-1) !== dialog) return false;

  const route = parseNavigation(window.location.search);
  return route.issueId === issueId && route.projectId === projectId;
}

function isVisibleContentStart(element: HTMLElement, root: HTMLElement): boolean {
  if (!element.isConnected || !root.contains(element)) return false;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;

  const elementRect = element.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  const clipTop = Math.max(rootRect.top + root.clientTop, 0);
  const clipLeft = Math.max(rootRect.left + root.clientLeft, 0);
  const clipBottom = Math.min(rootRect.top + root.clientTop + root.clientHeight, window.innerHeight);
  const clipRight = Math.min(rootRect.left + root.clientLeft + root.clientWidth, window.innerWidth);

  // Requiring the element's top edge keeps a long note from being read when only its middle is on screen.
  return elementRect.width > 0 && elementRect.height > 0
    && elementRect.top >= clipTop && elementRect.top < clipBottom
    && elementRect.bottom > clipTop
    && elementRect.left < clipRight && elementRect.right > clipLeft;
}
