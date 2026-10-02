import { describe, expect, it } from 'vitest';
import { navigationUrl, parseNavigation, shouldUseHistoryBack, type NavigationState } from './workspaceNavigation';

describe('workspace URL navigation', () => {
  it('round-trips project, screen, issue, release form, overlay, and repeated filters canonically', () => {
    const state: NavigationState = {
      projectId: 18,
      screen: 'releases',
      view: 'watching',
      filters: {
        search: 'blue sky', assignedToMe: true, assigneeId: 42,
        labels: ['zeta', 'alpha', 'alpha'], statusIds: [5, 2, 5], priorityIds: [4, 1],
        versionId: 7, includeClosed: true,
      },
      versionId: 22,
      archived: true,
      releaseForm: 'assign',
      overlay: 'move',
      moveIssueId: 31,
    };
    const url = navigationUrl(state, '/workspace');
    const normalized = parseNavigation(url);

    expect(normalized).toEqual({
      ...state,
      filters: {
        search: 'blue sky', assignedToMe: true, assigneeId: 42,
        labels: ['alpha', 'zeta'], statusIds: [2, 5], priorityIds: [1, 4],
        versionId: 7, includeClosed: true,
      },
    });
    expect(navigationUrl(normalized, '/workspace')).toBe(url);
  });

  it('encodes issue-create defaults without putting form draft text in the URL', () => {
    const state: NavigationState = {
      screen: 'board', view: 'all', filters: {}, archived: false,
      createIssue: { statusId: 6, fixedVersionId: null },
    };
    const url = navigationUrl(state);
    expect(url).toBe('/?form=new-issue&status=6&roadmap=none');
    expect(parseNavigation(url)).toMatchObject({ createIssue: { statusId: 6, fixedVersionId: null } });

    const unsafe = { ...state, subject: 'private draft', token: 'must-not-appear' } as NavigationState & Record<string, unknown>;
    expect(navigationUrl(unsafe)).not.toContain('private');
    expect(navigationUrl(unsafe)).not.toContain('token');
  });

  it('drops invalid IDs and enum values while retaining valid repeated filter values', () => {
    const parsed = parseNavigation('/workspace?project=0&tab=invalid&view=unknown&issue=9007199254740992&journal=-2'
      + '&form=new-issue&status=1x&roadmap=none&overlay=unknown&move=0&assignee=NaN'
      + '&label=%20&label=%3Dbug&statusFilter=1,bad&statusFilter=2&priorityFilter=-4&versionFilter=0'
      + '&closed=yes&mine=true&archive=TRUE&token=hidden&draft=private');
    expect(parsed).toEqual({
      screen: 'board', view: 'all', filters: { assignedToMe: true, labels: ['=bug'], statusIds: [1, 2] },
      archived: true, createIssue: { fixedVersionId: null },
    });
  });

  it('normalizes issue journals, mutually exclusive forms, and release form routes', () => {
    expect(parseNavigation('?issue=13&journal=15')).toMatchObject({ issueId: 13, journalId: 15 });
    expect(parseNavigation('?journal=15').journalId).toBeUndefined();
    const issueForm = parseNavigation('?issue=13&journal=15&form=new-issue');
    expect(issueForm.createIssue).toEqual({});
    expect(issueForm.issueId).toBeUndefined();
    expect(issueForm.journalId).toBeUndefined();
    const editRelease = parseNavigation('?tab=board&issue=13&journal=15&form=edit-release&release=22');
    expect(editRelease).toMatchObject({ screen: 'releases', releaseForm: 'edit', versionId: 22 });
    expect(editRelease.issueId).toBeUndefined();
    expect(editRelease.journalId).toBeUndefined();
    expect(parseNavigation('?form=edit-release').releaseForm).toBeUndefined();
    expect(parseNavigation('?form=assign-release').releaseForm).toBeUndefined();
    expect(parseNavigation('?form=new-release')).toMatchObject({ screen: 'releases', releaseForm: 'new' });

    const competingForms = navigationUrl({
      screen: 'board', view: 'all', filters: {}, archived: false, issueId: 13,
      createIssue: {}, releaseForm: 'new',
    });
    const normalizedCompetingForms = parseNavigation(competingForms);
    expect(normalizedCompetingForms).toMatchObject({ screen: 'releases', releaseForm: 'new' });
    expect(normalizedCompetingForms.issueId).toBeUndefined();
    expect(normalizedCompetingForms.createIssue).toBeUndefined();
  });

  it('keeps backlog tab/view consistent and requires a move issue for the move overlay', () => {
    expect(parseNavigation('?tab=backlog&view=all')).toMatchObject({ screen: 'backlog', view: 'backlog' });
    expect(parseNavigation('?tab=board&view=backlog')).toMatchObject({ screen: 'board', view: 'backlog' });
    expect(parseNavigation('?overlay=move').overlay).toBeUndefined();
    expect(parseNavigation('?overlay=projects&move=8').moveIssueId).toBeUndefined();
    expect(parseNavigation('?overlay=move&move=8')).toMatchObject({ overlay: 'move', moveIssueId: 8 });
  });

  it('normalizes the legacy mine view into the assigned-to-me filter', () => {
    expect(parseNavigation('?tab=board&view=mine')).toMatchObject({
      screen: 'board', view: 'all', filters: { assignedToMe: true },
    });
    const savedViewState: NavigationState = { screen: 'board', view: 'mine', filters: {}, archived: false };
    expect(parseNavigation(navigationUrl(savedViewState))).toMatchObject({
      screen: 'board', view: 'all', filters: { assignedToMe: true },
    });
  });

  it('omits default values and unsupported query keys', () => {
    expect(navigationUrl({ screen: 'board', view: 'all', filters: {}, archived: false })).toBe('/');
    expect(parseNavigation('?token=hidden&draft=private')).toEqual({ screen: 'board', view: 'all', filters: {}, archived: false });
  });

  it('uses Back only when the owned history entry records the exact close target', () => {
    const state = { unrelated: { keep: true }, __redmineWorkspaceNavigation: { previousUrl: '/?project=10&tab=board' } };
    expect(shouldUseHistoryBack(state, '/?project=10&tab=board')).toBe(true);
    expect(shouldUseHistoryBack(state, '/?project=20')).toBe(false);
    expect(shouldUseHistoryBack({ unrelated: true }, '/?project=10&tab=board')).toBe(false);
    expect(shouldUseHistoryBack({ __redmineWorkspaceNavigation: { previousUrl: 'https://outside.invalid/' } }, '/')).toBe(false);
  });
});
