import type { AppConfig } from '../config.js';
import type { AssigneeOption, Attachment, Issue, Journal, LabelOption, Person, Priority, Project, ProjectTracker, RedmineRole, SearchResponse, SearchResult, Status, StatusKey, Version } from '../../shared/types.js';
import type { WorkspaceStore } from '../db/store.js';
import { load as loadHtml } from 'cheerio';
import { RedmineRequestError, RedmineTransport, type FetchLike } from './transport.js';

interface RedmineUser { id: number; name?: string; firstname?: string; lastname?: string; login?: string; avatar_url?: string }
interface RedmineIssueStatus { id: number; name: string; is_closed?: boolean }
interface RedminePriority { id: number; name: string; position?: number }
interface RedmineProject { id: number; name: string; identifier: string; description?: string; trackers?: unknown }
interface RedmineMembership { user?: RedmineUser; group?: { id: number; name?: string }; roles?: RedmineRole[] }
interface RedmineVersion { id: number; project?: { id: number }; name: string; status?: string; due_date?: string; description?: string }
interface RedmineJournalDetail { name?: string; property?: string; old_value?: unknown; new_value?: unknown }
interface RedmineJournal { id: number; user?: RedmineUser; notes?: string; created_on: string; details?: RedmineJournalDetail[] }
interface RedmineCustomField {
  id: number; name: string; possible_values?: unknown; projects?: { id: number }[]; trackers?: { id: number }[];
  customized_type?: string; field_format?: string; multiple?: boolean;
}
interface RedmineSearchItem { id: number; type?: string; title?: string; description?: string; url?: string; datetime?: string; project?: { id: number } }
interface RedmineIssue {
  id: number; project?: { id: number }; subject: string; description?: string; status: RedmineIssueStatus;
  priority?: { id: number }; tracker?: { id: number; name: string }; author?: RedmineUser; assigned_to?: RedmineUser & { type?: string };
  fixed_version?: { id: number }; created_on: string; updated_on: string; due_date?: string; parent?: { id: number };
  watchers?: RedmineUser[]; journals?: RedmineJournal[]; attachments?: { id: number; filename: string; content_url: string; filesize: number; content_type?: string }[];
  custom_fields?: { id: number; name: string; value: unknown }[]; labels?: string[]; allowed_statuses?: RedmineIssueStatus[];
}

export interface RedmineWriteFieldMetadata {
  branchFieldId?: number;
  primaryAssigneeFieldId?: number;
  sampleIssueId?: number;
  labelFieldIds: number[];
  labelOptions: LabelOption[];
}

export interface RedmineProjectMemberships {
  userIds: number[];
  groups: { id: number; name?: string; memberIds?: number[] }[];
}

interface CachedProjectMemberships {
  expiresAt: number;
  value: RedmineProjectMemberships;
}

interface CachedLabelFormOptions {
  expiresAt: number;
  value: LabelOption[];
}

const metadataCacheTtlMs = 5 * 60_000;
const maxCachedProjects = 128;
const maxCachedLabelForms = 256;

export interface RedmineSnapshot {
  me: Person;
  projects: Project[];
  statuses: Status[];
  priorities: Priority[];
  versions: Version[];
  issues: Issue[];
  people: Person[];
  projectMembers: Record<string, number[]>;
  projectMembershipIds?: Record<string, number[]>;
  projectGroupIds?: Record<string, number[]>;
  projectGroups?: Record<string, { id: number; name: string; memberIds?: number[] }[]>;
  projectMembershipRoles?: Record<string, Record<string, RedmineRole[]>>;
  journals: { issueId: number; journal: Journal }[];
  labelOptions?: Record<string, LabelOption[]>;
  branchFieldId?: number;
  labelsFieldId?: number;
  primaryAssigneeFieldIds?: Record<string, number>;
  textFormat?: string;
  warnings: string[];
}

export interface RedmineIssueDetail {
  issue: Issue;
  journals: Journal[];
  journalsIncluded?: boolean;
  people: Person[];
}

export class RedmineAdapter {
  readonly transport: RedmineTransport;
  private customFieldCatalogCache?: { expiresAt: number; value: RedmineCustomField[] };
  private customFieldCatalogFlight?: Promise<RedmineCustomField[]>;
  private readonly projectMembershipCache = new Map<number, CachedProjectMemberships>();
  private readonly labelFormOptionsCache = new Map<string, CachedLabelFormOptions>();
  private readonly labelFormOptionsFlights = new Map<string, Promise<LabelOption[]>>();
  constructor(private readonly config: AppConfig, fetcher?: FetchLike) {
    this.transport = new RedmineTransport(config, fetcher);
  }

  async currentUser(): Promise<Person> {
    const response = await this.transport.request<{ user: RedmineUser }>('users/current.json');
    return person(response.user);
  }

  async snapshot(since?: string, knownMe?: Person, hydrateDetails = true, includeClosedDeploy = false,
    knownLabelOptions: Record<string, LabelOption[]> = {}): Promise<RedmineSnapshot> {
    const [me, rawProjects, rawStatuses, rawPriorities] = await Promise.all([
      knownMe ? Promise.resolve(knownMe) : this.currentUser(),
      this.readPaged<RedmineProject>('projects.json?include=trackers', 'projects'),
      this.transport.request<{ issue_statuses: RedmineIssueStatus[] }>('issue_statuses.json'),
      this.transport.request<{ issue_priorities: RedminePriority[] }>('enumerations/issue_priorities.json'),
    ]);
    const projects: Project[] = rawProjects.map(mapProject);
    const statuses: Status[] = rawStatuses.issue_statuses.map(mapStatus);
    const priorities: Priority[] = rawPriorities.issue_priorities.map((item, index) => ({ id: item.id, name: item.name, rank: item.position ?? index + 1 }));
    const peopleById = new Map<number, Person>([[me.id, me]]);
    const projectMembers: Record<string, number[]> = {};
    const projectMembershipIds: Record<string, number[]> = {};
    const projectMembershipRoles: Record<string, Record<string, RedmineRole[]>> = {};
    const projectGroupIds: Record<string, number[]> = {};
    const projectGroups: Record<string, { id: number; name: string; memberIds?: number[] }[]> = {};
    const warnings: string[] = [];
    const allIssues: Issue[] = [];
    const allVersions: Version[] = [];
    const allJournals: { issueId: number; journal: Journal }[] = [];
    const labelOptions: Record<string, LabelOption[]> = {};
    const primaryAssigneeFieldIds: Record<string, number> = {};
    const conflictingPrimaryAssigneeProjects = new Set<string>();
    const unresolvedPrimaryAssigneeIds = new Set<number>();
    const rawFieldDefinitions = await this.readCustomFieldCatalog();
    let branchFieldId: number | undefined;
    let labelsFieldId: number | undefined;

    for (const project of projects) {
      const updatedFilter = since ? `&updated_on=%3E%3D${encodeURIComponent(since.replace(/\.\d+Z$/, 'Z'))}` : '';
      const query = `issues.json?project_id=${project.id}&subproject_id=%21%2A&status_id=${since ? '*' : 'open'}&${updatedFilter ? `${updatedFilter.slice(1)}&` : ''}limit=100&offset=0`;
      const [rawIssues, rawVersions, membershipResponse] = await Promise.all([
        this.readPaged<RedmineIssue>(query, 'issues'),
        this.readPaged<RedmineVersion>(`projects/${encodeURIComponent(String(project.id))}/versions.json`, 'versions').catch(() => {
          warnings.push(`Не вдалося прочитати релізи проєкту ${project.name}.`); return [] as RedmineVersion[];
        }),
        this.readPaged<RedmineMembership>(`projects/${encodeURIComponent(String(project.id))}/memberships.json`, 'memberships').catch(() => {
          warnings.push(`Список учасників проєкту ${project.name} недоступний для цього токена.`); return undefined;
        }),
      ]);
      const detailIssueIds = new Set(rawIssues.map(issue => issue.id));
      const listOnlyDeployIds = new Set<number>();
      // Initial boards need open work and every task in active releases, not years of archived history.
      if (!since) {
        const releaseIssues = await mapLimit(rawVersions.filter(version => version.status !== 'closed' && (!version.project || version.project.id === project.id)), 2,
          version => this.readPaged<RedmineIssue>(`issues.json?project_id=${project.id}&subproject_id=%21%2A&status_id=closed&fixed_version_id=${version.id}`, 'issues'));
        const uniqueIssues = new Map(rawIssues.map(issue => [issue.id, issue]));
        for (const issue of releaseIssues.flat()) { uniqueIssues.set(issue.id, issue); detailIssueIds.add(issue.id); }
        rawIssues.splice(0, rawIssues.length, ...uniqueIssues.values());
      }
      if (!since || includeClosedDeploy) {
        // Deploy is a workflow state for this workspace, even when Redmine marks it closed.
        // Query its exact status so closed Deploy issues join open work and release members.
        const deployStatusIds = statuses.filter(status => status.key === 'deploy').map(status => status.id);
        const deployIssues = await mapLimit(deployStatusIds, 2, statusId => this.readPaged<RedmineIssue>(
          `issues.json?project_id=${project.id}&subproject_id=%21%2A&status_id=${statusId}`, 'issues'));
        const uniqueIssues = new Map(rawIssues.map(issue => [issue.id, issue]));
        for (const issue of deployIssues.flat()) {
          if (!detailIssueIds.has(issue.id)) listOnlyDeployIds.add(issue.id);
          uniqueIssues.set(issue.id, issue);
        }
        rawIssues.splice(0, rawIssues.length, ...uniqueIssues.values());
      }
      const projectFields = uniqueFields(rawIssues.flatMap(issue => issue.custom_fields ?? []).filter(field => isLabelOrTagField(field.name)));
      const projectFieldIds = new Set(projectFields.map(field => field.id));
      const fieldDefinitions = rawFieldDefinitions.filter(field => isLabelOrTagField(field.name)
        && (!field.projects?.length || field.projects.some(item => item.id === project.id))
        && (!projectFieldIds.size || projectFieldIds.has(field.id)));
      const optionsFromApi = fieldDefinitions.flatMap(field => normalizePossibleValues(field, project.id));
      const cachedOptions = knownLabelOptions[String(project.id)] ?? [];
      const numericValueNeedsNames = rawIssues.some(issue => (issue.custom_fields ?? []).some(field => projectFieldIds.has(field.id)
        && flattenLabels(field.value).some(value => /^\d+$/.test(value)
          && ![...optionsFromApi, ...cachedOptions].some(option => option.fieldId === field.id && option.id === value && option.name !== value))));
      let optionsFromForm: LabelOption[] = [];
      const sampleIssueId = rawIssues.find(issue => (issue.custom_fields ?? []).some(field => projectFieldIds.has(field.id)))?.id;
      if (sampleIssueId && projectFieldIds.size && (!since || !cachedOptions.length) && (!optionsFromApi.length || numericValueNeedsNames)) {
        optionsFromForm = await this.cachedLabelOptionsFromEditForm(sampleIssueId, projectFieldIds);
      }
      labelOptions[String(project.id)] = mergeLabelOptions(cachedOptions, optionsFromApi, optionsFromForm);
      const unresolvedNumericLabels = rawIssues.some(issue => (issue.custom_fields ?? []).filter(field => projectFieldIds.has(field.id))
        .some(field => flattenLabels(field.value).some(value => /^\d+$/.test(value)
          && !labelOptions[String(project.id)].some(option => option.fieldId === field.id && option.id === value && option.name !== value))));
      if (unresolvedNumericLabels) warnings.push(`Не вдалося визначити назви всіх Labels/Tags у проєкті ${project.name}; частину значень показано як ID.`);
      const rawMemberships = membershipResponse ?? [];
      const projectPeople = new Set<number>([me.id]);
      const projectMemberIds: number[] = [];
      const membershipRoles: Record<string, RedmineRole[]> = {};
      for (const membership of rawMemberships) {
        if (!membership.user) continue;
        const mapped = person(membership.user);
        peopleById.set(mapped.id, mapped);
        projectPeople.add(mapped.id);
        projectMemberIds.push(mapped.id);
        membershipRoles[String(mapped.id)] = (membership.roles ?? []).filter((role) => Number.isSafeInteger(role.id) && typeof role.name === 'string')
          .map(role => ({ id: role.id, name: role.name.trim() }));
      }
      if (membershipResponse !== undefined) {
        projectMembershipIds[String(project.id)] = [...new Set(projectMemberIds)];
        projectMembershipRoles[String(project.id)] = membershipRoles;
        const groupMemberships = [...new Map(rawMemberships.flatMap(membership => {
          const id = positiveId(membership.group?.id);
          const name = safeText(membership.group?.name);
          return id && name ? [[id, { id, name } as { id: number; name: string }]] : [];
        })).values()];
        projectGroupIds[String(project.id)] = groupMemberships.map(group => group.id);
        this.projectGroupIds.set(project.id, new Set(projectGroupIds[String(project.id)]));
        projectGroups[String(project.id)] = groupMemberships;
        this.rememberProjectMemberships(project.id, { userIds: [...new Set(projectMemberIds)], groups: groupMemberships });
      }
      this.projectGroupIds.set(project.id, new Set(projectGroupIds[String(project.id)] ?? []));
      if (!hydrateDetails) {
        const watched = await this.readPaged<RedmineIssue>(`${query}&watcher_id=me`, 'issues');
        const watchedReleaseIssues = await mapLimit(rawVersions.filter(version => version.status !== 'closed' && (!version.project || version.project.id === project.id)), 2,
          version => this.readPaged<RedmineIssue>(`issues.json?project_id=${project.id}&subproject_id=%21%2A&status_id=closed&fixed_version_id=${version.id}&watcher_id=me`, 'issues'));
        const deployStatusIds = statuses.filter(status => status.key === 'deploy').map(status => status.id);
        const watchedDeployIssues = await mapLimit(deployStatusIds, 2, statusId => this.readPaged<RedmineIssue>(
          `issues.json?project_id=${project.id}&subproject_id=%21%2A&status_id=${statusId}&watcher_id=me`, 'issues'));
        const watchedIds = new Set([...watched, ...watchedReleaseIssues.flat(), ...watchedDeployIssues.flat()].map(issue => issue.id));
        for (const raw of rawIssues) {
          if (watchedIds.has(raw.id)) raw.watchers = [...(raw.watchers ?? []).filter(user => user.id !== me.id), { id: me.id, name: me.name }];
        }
      }
      let transitionMetadataIncomplete = false;
      const permissionHydratedIssues = !hydrateDetails ? await mapLimit(rawIssues, 4, async (listIssue) => {
        try {
          const detail = await this.transport.request<{ issue?: RedmineIssue }>(`issues/${listIssue.id}.json?include=allowed_statuses`);
          if (!detail.issue) { transitionMetadataIncomplete = true; return listIssue; }
          return { ...listIssue, allowed_statuses: detail.issue.allowed_statuses };
        } catch {
          // Keep the board readable if this Redmine version/permission cannot expose workflow
          // choices. The missing field remains undefined, which disables unverified transitions.
          transitionMetadataIncomplete = true;
          return listIssue;
        }
      }) : rawIssues;
      if (transitionMetadataIncomplete) warnings.push(`Для частини задач проєкту ${project.name} не вдалося перевірити доступні переходи статусу.`);
      const hydratedIssues = !hydrateDetails ? permissionHydratedIssues : await mapLimit(rawIssues, 4, async (listIssue) => {
        const detail = await this.transport.request<{ issue: RedmineIssue }>(
          `issues/${listIssue.id}.json?include=journals%2Cwatchers%2Cattachments%2Callowed_statuses`);
        if (!detail.issue) throw new RedmineRequestError(`Redmine не повернув задачу ${listIssue.id}.`);
        return detail.issue;
      });
      for (const raw of hydratedIssues) {
        const primaryAssigneeFieldId = findPrimaryAssigneeFieldId(raw.custom_fields ?? [], rawFieldDefinitions, project.id, raw.tracker?.id);
        const mapped = mapIssue(raw, project.id, labelOptions[String(project.id)], {
          groupIds: new Set(projectGroupIds[String(project.id)] ?? []), userIds: new Set(projectMembershipIds[String(project.id)] ?? []),
          primaryAssigneeFieldId,
        });
        for (const user of [raw.author, ...(mapped.assignedToType === 'group' ? [] : [raw.assigned_to]), ...(raw.watchers ?? [])]) {
          if (!user) continue;
          const mapped = person(user);
          peopleById.set(mapped.id, mapped);
          projectPeople.add(mapped.id);
        }
        if (mapped.primaryAssigneeId && !peopleById.has(mapped.primaryAssigneeId)) unresolvedPrimaryAssigneeIds.add(mapped.primaryAssigneeId);
        const fieldMap = raw.custom_fields ?? [];
        branchFieldId ??= fieldMap.find(field => /\bbranch\b/i.test(field.name))?.id;
        labelsFieldId ??= fieldMap.find(field => isLabelOrTagField(field.name))?.id;
        if (primaryAssigneeFieldId && !conflictingPrimaryAssigneeProjects.has(String(project.id))) {
          const previousFieldId = primaryAssigneeFieldIds[String(project.id)];
          if (previousFieldId !== undefined && previousFieldId !== primaryAssigneeFieldId) {
            delete primaryAssigneeFieldIds[String(project.id)];
            conflictingPrimaryAssigneeProjects.add(String(project.id));
          } else primaryAssigneeFieldIds[String(project.id)] = primaryAssigneeFieldId;
        }
        allIssues.push(mapped);
        const customFieldNames = new Map((raw.custom_fields ?? []).map(field => [field.id, field.name]));
        for (const rawJournal of raw.journals ?? []) {
          if (!rawJournal.id) continue;
          if (rawJournal.user) peopleById.set(rawJournal.user.id, person(rawJournal.user));
          allJournals.push({ issueId: mapped.id, journal: mapJournal(rawJournal, customFieldNames, labelOptions[String(project.id)]) });
        }
      }
      projectMembers[String(project.id)] = [...projectPeople];
      for (const raw of rawVersions) {
        const version = mapVersion(raw, project.id);
        if (version.projectId === project.id) allVersions.push(version);
      }
    }
    await mapLimit([...unresolvedPrimaryAssigneeIds], 4, async id => {
      try {
        const response = await this.transport.request<{ user?: RedmineUser }>(`users/${id}.json`);
        if (response.user) peopleById.set(response.user.id, person(response.user));
      } catch { /* custom-field user names are best-effort metadata */ }
    });
    if (!branchFieldId) warnings.push('Поле Branch не знайдено у доступних задачах.');
    if (!labelsFieldId) warnings.push('Поле Labels не визначено у доступних задачах.');
    const textFormat = await this.readTextFormat().catch(() => undefined);
    return { me, projects, statuses, priorities, versions: allVersions, issues: allIssues,
      people: [...peopleById.values()], projectMembers, projectMembershipIds, projectMembershipRoles,
      projectGroupIds, projectGroups, journals: allJournals, labelOptions, branchFieldId, labelsFieldId,
      ...(Object.keys(primaryAssigneeFieldIds).length ? { primaryAssigneeFieldIds } : {}), ...(textFormat ? { textFormat } : {}), warnings };
  }

  async releaseIssues(versionId: number, projectId: number, labelOptions: LabelOption[] = []): Promise<Issue[]> {
    const raw = await this.readPaged<RedmineIssue>(`issues.json?project_id=${projectId}&subproject_id=%21%2A&status_id=*&fixed_version_id=${versionId}`, 'issues');
    const definitions = await this.readCustomFieldCatalog();
    return raw.map(issue => mapIssue(issue, projectId, labelOptions, { groupIds: this.knownGroupIds(projectId),
      primaryAssigneeFieldId: findPrimaryAssigneeFieldId(issue.custom_fields ?? [], definitions, projectId, issue.tracker?.id) }));
  }

  async issueDetail(issueId: number, cachedLabelOptions: LabelOption[] | Record<string, LabelOption[]> = [],
    includeHistoryPeopleLookup = true, membership?: { userIds?: Set<number>; groupIds?: Set<number> }): Promise<RedmineIssueDetail> {
    const detail = await this.transport.request<{ issue: RedmineIssue }>(`issues/${issueId}.json?include=journals%2Cwatchers%2Cattachments%2Callowed_statuses`);
    if (!detail.issue || !detail.issue.project) throw new RedmineRequestError(`Redmine не повернув задачу ${issueId}.`);
    const raw = detail.issue;
    const fieldNames = new Map((raw.custom_fields ?? []).map(field => [field.id, field.name]));
    const projectFields = (raw.custom_fields ?? []).filter(field => isLabelOrTagField(field.name));
    const projectFieldIds = new Set(projectFields.map(field => field.id));
    const cachedForProject = Array.isArray(cachedLabelOptions) ? cachedLabelOptions : cachedLabelOptions[String(raw.project!.id)] ?? [];
    let detailOptions = cachedForProject.filter(option => option.fieldId !== undefined && projectFieldIds.has(option.fieldId));
    if (!detailOptions.length && projectFields.length) {
      // Opening a card must not wait for the administrator-only custom field catalog. The
      // board sync owns remote catalog refreshes; issue payload names still identify a unique
      // Primary Assignee field when that optional catalog is unavailable.
      const definitions = this.cachedCustomFieldCatalog();
      const fromApi = definitions.filter(field => projectFieldIds.has(field.id) && isLabelOrTagField(field.name))
        .flatMap(field => normalizePossibleValues(field, raw.project!.id));
      const numericValues = projectFields.some(field => flattenLabels(field.value).some(value => /^\d+$/.test(value)));
      const fromForm = numericValues || !fromApi.length
        ? await this.cachedLabelOptionsFromEditForm(issueId, projectFieldIds) : [];
      detailOptions = mergeLabelOptions(fromApi, fromForm);
    }
    const journals = (raw.journals ?? []).map(journal => mapJournal(journal, fieldNames, detailOptions));
    // The issue response is fresh. Use already-known field definitions only to reject a
    // conflicting binding; never make an administrator-catalog request block opening a card.
    const primaryAssigneeFieldId = findPrimaryAssigneeFieldId(raw.custom_fields ?? [], this.cachedCustomFieldCatalog(), raw.project!.id, raw.tracker?.id);
    const peopleById = new Map<number, Person>();
    const mappedIssue = mapIssue(raw, raw.project!.id, detailOptions, { groupIds: this.knownGroupIds(raw.project!.id), primaryAssigneeFieldId });
    for (const user of [raw.author, ...(mappedIssue.assignedToType === 'group' ? [] : [raw.assigned_to]), ...(raw.watchers ?? []), ...(raw.journals ?? []).map(journal => journal.user)]) {
      if (user) peopleById.set(user.id, person(user));
    }
    const referencedUserIds = new Set<number>();
    if (mappedIssue.primaryAssigneeId && !peopleById.has(mappedIssue.primaryAssigneeId)) referencedUserIds.add(mappedIssue.primaryAssigneeId);
    for (const journal of raw.journals ?? []) for (const detail of journal.details ?? []) {
      if (!/assigned_to|author|user/i.test(detail.name ?? '')) continue;
      for (const value of [detail.old_value, detail.new_value]) {
        const id = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : 0;
        if (Number.isSafeInteger(id) && id > 0 && !peopleById.has(id)) referencedUserIds.add(id);
      }
    }
    // Historical journals can reference people omitted from the current issue response. Bound these optional lookups.
    const missingPeople = includeHistoryPeopleLookup ? await mapLimit([...referencedUserIds].slice(0, 12), 4, async id => {
      try {
        const response = await this.transport.request<{ user?: RedmineUser }>(`users/${id}.json`);
        return response.user ? person(response.user) : undefined;
      } catch { return undefined; }
    }) : [];
    for (const user of missingPeople) if (user) peopleById.set(user.id, user);
    const people = [...peopleById.values()];
    return { issue: mapIssue(raw, raw.project!.id, detailOptions, {
      userIds: membership?.userIds, groupIds: membership?.groupIds ?? this.knownGroupIds(raw.project!.id),
      primaryAssigneeFieldId,
    }), journals, journalsIncluded: Array.isArray(raw.journals), people };
  }

  async issueAssigneeOptions(projectId: number, people: Person[] = []): Promise<AssigneeOption[] | undefined> {
    // These are presentation choices sourced from the latest successful snapshot. Writes use
    // projectMemberships() directly and always reread Redmine before validating membership.
    const memberships = this.cachedProjectMemberships(projectId);
    if (!memberships) return undefined;
    const usersById = new Map(people.map(person => [person.id, person]));
    const users = memberships.userIds.flatMap(id => {
      const user = usersById.get(id);
      return user ? [{ type: 'user' as const, id, name: user.name, ...(user.avatar ? { avatar: user.avatar } : {}) }] : [];
    });
    return [...users, ...memberships.groups.flatMap(group => group.name ? [{ type: 'group' as const, id: group.id, name: group.name,
      ...(group.memberIds ? { memberIds: group.memberIds } : {}) }] : [])];
  }

  async createIssue(fields: Record<string, unknown>, labelOptions: LabelOption[] = [], primaryAssigneeFieldId?: number): Promise<Issue> {
    const response = await this.transport.request<{ issue?: RedmineIssue }>('issues.json', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issue: fields }),
    });
    const raw = response.issue;
    const projectId = positiveId(raw?.project?.id) ?? positiveId(fields.project_id);
    if (!raw || !positiveId(raw.id) || !projectId || !raw.status || !positiveId(raw.status.id) || typeof raw.subject !== 'string'
      || typeof raw.created_on !== 'string' || typeof raw.updated_on !== 'string') {
      throw new RedmineRequestError('Redmine прийняв створення, але не повернув достатньо даних для визначення задачі. Перевірте її в Redmine перед повтором.', 201, undefined, true);
    }
    // Redmine returns the created object. Mapping it here retains its ID without a second request.
    return mapIssue(raw, projectId, labelOptions, { groupIds: this.knownGroupIds(projectId), primaryAssigneeFieldId });
  }

  async updateIssue(issueId: number, fields: Record<string, unknown>): Promise<void> {
    await this.transport.requestVoid(`issues/${resourceId(issueId, 'задачі')}.json`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issue: fields }),
    });
  }

  async createVersion(projectId: number, fields: Record<string, unknown>): Promise<Version> {
    const id = resourceId(projectId, 'проєкту');
    const response = await this.transport.request<{ version?: RedmineVersion }>(`projects/${id}/versions.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: fields }),
    });
    const raw = response.version;
    if (!raw || !positiveId(raw.id) || typeof raw.name !== 'string') {
      throw new RedmineRequestError('Redmine прийняв створення релізу, але не повернув його ID. Перевірте реліз у Redmine перед повтором.', 201, undefined, true);
    }
    return mapVersion(raw, id);
  }

  async updateVersion(versionId: number, fields: Record<string, unknown>): Promise<void> {
    await this.transport.requestVoid(`versions/${resourceId(versionId, 'релізу')}.json`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: fields }),
    });
  }

  async versionDetail(versionId: number): Promise<Version> {
    const id = resourceId(versionId, 'релізу');
    const response = await this.transport.request<{ version?: RedmineVersion }>(`versions/${id}.json`);
    const projectId = positiveId(response.version?.project?.id);
    if (!response.version || !positiveId(response.version.id) || !projectId || typeof response.version.name !== 'string'
      || !['open', 'locked', 'closed'].includes(response.version.status ?? '')) {
      throw new RedmineRequestError(`Redmine не повернув реліз ${id}.`);
    }
    return mapVersion(response.version, projectId);
  }

  async updateJournal(journalId: number, notes: string): Promise<void> {
    await this.transport.requestVoid(`journals/${resourceId(journalId, 'коментаря')}.json`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ journal: { notes } }),
    });
  }

  async writeFieldMetadata(projectId: number, sampleIssueId?: number, trackerId?: number): Promise<RedmineWriteFieldMetadata> {
    const id = resourceId(projectId, 'проєкту');
    let sample: RedmineIssue | undefined;
    if (sampleIssueId !== undefined) {
      const issueId = resourceId(sampleIssueId, 'задачі');
      const response = await this.transport.request<{ issue?: RedmineIssue }>(`issues/${issueId}.json`);
      sample = response.issue;
      if (!sample || sample.project?.id !== id) throw new RedmineRequestError('Зразок поля не належить вибраному проєкту.', 404);
    } else {
      const trackerFilter = trackerId ? `&tracker_id=${trackerId}` : '';
      const response = await this.transport.request<{ issues?: RedmineIssue[] }>(
        `issues.json?project_id=${id}&subproject_id=%21%2A&status_id=*&${trackerFilter ? `${trackerFilter.slice(1)}&` : ''}limit=1&offset=0`);
      sample = response.issues?.[0];
    }
    const definitions = await this.readCustomFieldCatalog();
    const definitionById = new Map(definitions
      .filter(field => !field.projects?.length || field.projects.some(item => item.id === id))
      .map(field => [field.id, field]));
    for (const field of sample?.custom_fields ?? []) if (!definitionById.has(field.id)) {
      definitionById.set(field.id, field);
    }
    const fields = [...definitionById.values()];
    const branchFieldId = fields.find(field => /\bbranch\b/i.test(field.name))?.id;
    const sampleMatchesTracker = !sample || sample.tracker?.id === undefined || trackerId === undefined || sample.tracker.id === trackerId;
    const primaryAssigneeFieldId = sampleMatchesTracker
      ? findPrimaryAssigneeFieldId(sample?.custom_fields ?? [], definitions, id, trackerId ?? sample?.tracker?.id)
      : undefined;
    const labelFields = fields.filter(field => isLabelOrTagField(field.name));
    const labelFieldIds = [...new Set(labelFields.map(field => field.id))].sort((a, b) => a - b);
    let labelOptions = mergeLabelOptions(...labelFields.map(field => normalizePossibleValues(field, id)));
    const sampleLabelFields = (sample?.custom_fields ?? []).filter(field => labelFieldIds.includes(field.id));
    const hasUnresolvedNumericValues = sampleLabelFields.some(field => flattenLabels(field.value).some(value => /^\d+$/.test(value)
      && !labelOptions.some(option => option.fieldId === field.id && option.id === value && option.name !== value)));
    if (sample && labelFieldIds.length && (!labelOptions.length || hasUnresolvedNumericValues)) {
      const fromForm = await this.cachedLabelOptionsFromEditForm(sample.id, new Set(labelFieldIds));
      labelOptions = mergeLabelOptions(labelOptions, fromForm);
    }
    return { ...(branchFieldId ? { branchFieldId } : {}), ...(primaryAssigneeFieldId ? { primaryAssigneeFieldId } : {}),
      ...(sample?.id ? { sampleIssueId: sample.id } : {}), labelFieldIds, labelOptions };
  }

  async projectMemberships(projectId: number): Promise<RedmineProjectMemberships> {
    const id = resourceId(projectId, 'проєкту');
    const memberships = await this.readPaged<RedmineMembership>(`projects/${id}/memberships.json`, 'memberships');
    const userIds = [...new Set(memberships.map(item => positiveId(item.user?.id)).filter((value): value is number => Boolean(value)))];
    const groups = [...new Map(memberships.flatMap(item => {
      const groupId = positiveId(item.group?.id);
      if (!groupId) return [];
      const name = safeText(item.group?.name);
      return [[groupId, { id: groupId, ...(name ? { name } : {}) } as { id: number; name?: string }]];
    })).values()];
    const fresh = { userIds, groups };
    this.projectGroupIds.set(projectId, new Set(groups.map(group => group.id)));
    this.rememberProjectMemberships(projectId, fresh);
    return fresh;
  }

  async mentionUsers(projectId: number): Promise<Person[]> {
    const id = resourceId(projectId, 'проєкту');
    const memberships = await this.readPaged<RedmineMembership>(`projects/${id}/memberships.json`, 'memberships');
    const users = [...new Map(memberships.flatMap(item => item.user?.id ? [[item.user.id, item.user] as const] : [])).values()];
    const resolved = await mapLimit(users, 4, async user => {
      if (user.login) return person(user);
      try {
        const response = await this.transport.request<{ user?: RedmineUser }>(`users/${resourceId(user.id, 'користувача')}.json`);
        return response.user ? person({ ...user, ...response.user }) : person(user);
      } catch { return person(user); }
    });
    return resolved;
  }

  private knownGroupIds(projectId: number): Set<number> {
    return this.projectGroupIds.get(projectId) ?? new Set<number>();
  }

  private readonly projectGroupIds = new Map<number, Set<number>>();

  async search(q: string, options: { projectIdentifier?: string; offset: number; limit: number }): Promise<SearchResponse> {
    // Redmine uses presence, not boolean parsing: even "0" enables these flags.
    // Omit title/open restrictions and other resource flags to search issue bodies and closed work only.
    const params = new URLSearchParams({ q, issues: '1',
      offset: String(options.offset), limit: String(options.limit) });
    let path = 'search.json';
    if (options.projectIdentifier) path = `projects/${encodeURIComponent(options.projectIdentifier)}/search.json`;
    else params.set('scope', 'all');
    const response = await this.transport.request<{ results?: RedmineSearchItem[]; total_count?: number; offset?: number; limit?: number }>(`${path}?${params}`);
    if (!Array.isArray(response.results)) throw new RedmineRequestError('Redmine не повернув список результатів пошуку.');
    const results: SearchResult[] = response.results.filter(item => !item.type || item.type.toLocaleLowerCase().startsWith('issue'))
      .filter(item => Number.isSafeInteger(item.id) && item.id > 0)
      .map(item => ({ id: item.id, title: item.title ?? `#${item.id}`, description: item.description ?? '',
        ...(item.project?.id ? { projectId: item.project.id } : {}),
        ...(statusFromSearchTitle(item.title) ? { statusName: statusFromSearchTitle(item.title) } : {}),
        url: `${this.config.redmineUrl.replace(/\/$/, '')}/issues/${item.id}`,
        ...(item.datetime ? { updatedOn: item.datetime } : {}) }));
    return { results, total: Number.isSafeInteger(response.total_count) ? response.total_count! : results.length,
      offset: Number.isSafeInteger(response.offset) ? response.offset! : options.offset,
      limit: Number.isSafeInteger(response.limit) && response.limit! > 0 ? response.limit! : options.limit };
  }

  async attachmentContent(attachmentId: number): Promise<{ data: Buffer; contentType: string }> {
    if (!Number.isSafeInteger(attachmentId) || attachmentId <= 0) throw new RedmineRequestError('Вкладення не знайдено.');
    // Build the destination from a validated numeric ID; never proxy a URL supplied by Redmine or a caller.
    const asset = await this.transport.requestRaster(`attachments/download/${attachmentId}`);
    return { data: asset.data, contentType: asset.contentType };
  }

  private async readPaged<T>(initialPath: string, collection: string): Promise<T[]> {
    const question = initialPath.indexOf('?');
    const pathname = question < 0 ? initialPath : initialPath.slice(0, question);
    const params = new URLSearchParams(question < 0 ? '' : initialPath.slice(question + 1));
    params.set('limit', '100');
    params.set('offset', '0');
    const result: T[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      params.set('offset', String(offset));
      const response = await this.transport.request<Record<string, unknown>>(`${pathname}?${params.toString()}`);
      const rows = response[collection];
      if (!Array.isArray(rows)) throw new RedmineRequestError(`Redmine не повернув список ${collection}.`);
      result.push(...rows as T[]);
      const reportedLimit = Number(response.limit);
      const limit = Number.isSafeInteger(reportedLimit) && reportedLimit > 0 ? reportedLimit : rows.length;
      total = Number.isFinite(Number(response.total_count)) ? Number(response.total_count) : result.length;
      // Some endpoints return the entire collection with only total_count, without limit/offset.
      if (rows.length === 0 || response.total_count === undefined || result.length >= total) break;
      offset += limit;
    }
    return result;
  }

  private async readTextFormat(): Promise<string | undefined> {
    // Redmine publishes this instance setting on its normal layout body. Keep this a bounded GET;
    // it is metadata only and does not require reading application configuration or credentials.
    const html = await this.transport.requestText('login', {}, 512 * 1024);
    const value = safeText(loadHtml(html)('body').attr('data-text-formatting'))?.toLowerCase();
    return value && /^[a-z][a-z0-9_-]{0,31}$/.test(value) ? value : undefined;
  }

  private async readCustomFieldCatalog(): Promise<RedmineCustomField[]> {
    if (this.customFieldCatalogCache && this.customFieldCatalogCache.expiresAt > Date.now()) return this.customFieldCatalogCache.value;
    if (this.customFieldCatalogFlight) return this.customFieldCatalogFlight;
    const flight = (async () => {
      let value: RedmineCustomField[] = [];
      try {
        const response = await this.transport.request<{ custom_fields?: RedmineCustomField[] }>('custom_fields.json');
        value = Array.isArray(response.custom_fields) ? response.custom_fields.filter(field => Number.isSafeInteger(field.id) && field.id > 0
          && typeof field.name === 'string') : [];
      } catch {
        // Redmine restricts this endpoint to administrators on many installations. Cache the
        // unavailable result briefly so concurrent sync/read paths do not repeat the same GET.
      }
      this.customFieldCatalogCache = { value, expiresAt: Date.now() + metadataCacheTtlMs };
      return value;
    })();
    this.customFieldCatalogFlight = flight;
    try { return await flight; }
    finally { if (this.customFieldCatalogFlight === flight) this.customFieldCatalogFlight = undefined; }
  }

  private cachedCustomFieldCatalog(): RedmineCustomField[] {
    // A stale definition may conservatively reject an issue-field binding, but it must never
    // establish the binding by itself. The positive identity always comes from the fresh issue.
    return this.customFieldCatalogCache?.value ?? [];
  }

  private rememberProjectMemberships(projectId: number, value: RedmineProjectMemberships): void {
    const copy = { userIds: [...value.userIds], groups: value.groups.map(group => ({ ...group,
      ...(group.memberIds ? { memberIds: [...group.memberIds] } : {}) })) };
    this.projectMembershipCache.delete(projectId);
    this.projectMembershipCache.set(projectId, { value: copy, expiresAt: Date.now() + metadataCacheTtlMs });
    while (this.projectMembershipCache.size > maxCachedProjects) {
      const oldestProjectId = this.projectMembershipCache.keys().next().value as number | undefined;
      if (oldestProjectId === undefined) break;
      this.projectMembershipCache.delete(oldestProjectId);
    }
  }

  private cachedProjectMemberships(projectId: number): RedmineProjectMemberships | undefined {
    const cached = this.projectMembershipCache.get(projectId);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
      this.projectMembershipCache.delete(projectId);
      return undefined;
    }
    this.projectMembershipCache.delete(projectId);
    this.projectMembershipCache.set(projectId, cached);
    return { userIds: [...cached.value.userIds], groups: cached.value.groups.map(group => ({ ...group,
      ...(group.memberIds ? { memberIds: [...group.memberIds] } : {}) })) };
  }

  private async cachedLabelOptionsFromEditForm(issueId: number, fieldIds: Set<number>): Promise<LabelOption[]> {
    const ids = [...fieldIds].filter(id => Number.isSafeInteger(id) && id > 0).sort((left, right) => left - right);
    if (!ids.length) return [];
    const key = `${issueId}:${ids.join(',')}`;
    const cached = this.labelFormOptionsCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.labelFormOptionsCache.delete(key);
      this.labelFormOptionsCache.set(key, cached);
      return cached.value.map(option => ({ ...option }));
    }
    if (cached) this.labelFormOptionsCache.delete(key);
    const existingFlight = this.labelFormOptionsFlights.get(key);
    if (existingFlight) return (await existingFlight).map(option => ({ ...option }));

    const flight = this.readLabelOptionsFromEditForm(issueId, new Set(ids)).catch(() => []);
    this.labelFormOptionsFlights.set(key, flight);
    try {
      const value = await flight;
      this.labelFormOptionsCache.delete(key);
      this.labelFormOptionsCache.set(key, { value: value.map(option => ({ ...option })), expiresAt: Date.now() + metadataCacheTtlMs });
      while (this.labelFormOptionsCache.size > maxCachedLabelForms) {
        const oldestKey = this.labelFormOptionsCache.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        this.labelFormOptionsCache.delete(oldestKey);
      }
      return value.map(option => ({ ...option }));
    } finally {
      if (this.labelFormOptionsFlights.get(key) === flight) this.labelFormOptionsFlights.delete(key);
    }
  }

  private async readLabelOptionsFromEditForm(issueId: number, fieldIds: Set<number>): Promise<LabelOption[]> {
    let fromEdit: LabelOption[] = [];
    try {
      fromEdit = parseLabelOptionsFromEditHtml(await this.transport.requestText(`issues/${issueId}/edit`), fieldIds);
    } catch {
      // The edit page is commonly restricted to browser sessions even when API-key reads work.
    }
    if (fromEdit.length) return fromEdit;

    // Some Redmine installations expose the project's checkbox choices on the read-only issue page.
    // This is a GET-only fallback; never submit the form or reuse browser cookies.
    const showHtml = await this.transport.requestText(`issues/${issueId}`);
    return parseLabelOptionsFromEditHtml(showHtml, fieldIds);
  }
}

async function mapLimit<T, U>(values: T[], limit: number, map: (value: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(values.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const current = index++;
      if (current >= values.length) return;
      results[current] = await map(values[current]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export function mapStatus(status: RedmineIssueStatus): Status {
  const name = status.name.trim();
  return { id: status.id, name, key: statusKey(name), isClosed: Boolean(status.is_closed) };
}

function statusKey(name: string): StatusKey {
  const normalized = name.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (normalized.includes('suspend') || normalized.includes('paused')) return 'suspended';
  if (normalized === 'new' || normalized === 'todo') return 'todo';
  if (normalized.includes('progress') || normalized.includes('working')) return 'progress';
  if (normalized.includes('review')) return 'review';
  if (normalized === 'qa' || normalized.includes('quality')) return 'qa';
  if (normalized.includes('deploy')) return 'deploy';
  if (normalized === 'done') return 'done';
  if (normalized.includes('reject')) return 'rejected';
  if (normalized.includes('backlog')) return 'backlog';
  return 'unknown';
}

function person(user: RedmineUser): Person {
  const login = safeText(user.login);
  const mentionToken = login && /^[^\s@<>]{1,100}$/.test(login) ? `@${login}` : undefined;
  return { id: user.id, name: user.name || [user.firstname, user.lastname].filter(Boolean).join(' ') || `#${user.id}`,
    ...(login ? { login } : {}), ...(mentionToken ? { mentionToken } : {}), ...(user.avatar_url ? { avatar: user.avatar_url } : {}) };
}
function mapProject(project: RedmineProject): Project {
  const trackers = mapProjectTrackers(project.trackers);
  return { id: project.id, name: project.name, identifier: project.identifier,
    ...(project.description ? { description: project.description } : {}), ...(trackers !== undefined ? { trackers } : {}) };
}
function mapProjectTrackers(value: unknown): ProjectTracker[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<number>();
  const trackers: ProjectTracker[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { id, name } = item as { id?: unknown; name?: unknown };
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || seen.has(id) || typeof name !== 'string') continue;
    const safeName = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!safeName || safeName.length > 100) continue;
    seen.add(id);
    trackers.push({ id, name: safeName });
  }
  return trackers;
}
function mapVersion(version: RedmineVersion, projectId: number): Version {
  const status = ['open', 'locked', 'closed'].includes(version.status ?? '') ? version.status as Version['status'] : 'open';
  return { id: version.id, projectId: version.project?.id ?? projectId, name: version.name, status,
    ...(version.due_date ? { dueDate: version.due_date } : {}), ...(version.description ? { description: version.description } : {}) };
}
function positiveId(value: unknown): number | undefined {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
function resourceId(value: unknown, resource: string): number {
  const id = positiveId(value);
  if (id === undefined) throw new RedmineRequestError(`Некоректний ID ${resource}.`, 400);
  return id;
}
function flattenLabels(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(item => flattenLabels(item));
  if (typeof value !== 'string') return [];
  return value.split(/[\n,;]+/).map(label => label.trim()).filter(Boolean);
}
function isLabelOrTagField(name: string): boolean { return /\b(labels?|tags?)\b/i.test(name); }

function uniqueFields<T extends { id: number }>(fields: T[]): T[] {
  return [...new Map(fields.map(field => [field.id, field])).values()];
}

function normalizePossibleValues(field: RedmineCustomField, _projectId: number): LabelOption[] {
  if (!Array.isArray(field.possible_values)) return [];
  const options: LabelOption[] = [];
  for (const raw of field.possible_values) {
    if (raw === null || raw === undefined) continue;
    let id: string;
    let name: string;
    if (typeof raw === 'string' || typeof raw === 'number') {
      id = String(raw).trim(); name = id;
    } else if (typeof raw === 'object') {
      const item = raw as { id?: unknown; value?: unknown; name?: unknown; label?: unknown };
      const rawId = item.id ?? item.value ?? item.name ?? item.label;
      const rawName = item.label ?? item.name ?? item.value ?? item.id;
      id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).trim() : '';
      name = typeof rawName === 'string' || typeof rawName === 'number' ? String(rawName).trim() : '';
    } else continue;
    if (!id || !name) continue;
    options.push({ id, name, fieldId: field.id });
  }
  return options;
}

function mergeLabelOptions(...groups: LabelOption[][]): LabelOption[] {
  const merged = new Map<string, LabelOption>();
  for (const option of groups.flat()) {
    const id = String(option.id).trim();
    const name = option.name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!id || !name || !Number.isSafeInteger(option.fieldId) || option.fieldId! <= 0) continue;
    const key = `${option.fieldId}:${id}`;
    const previous = merged.get(key);
    // A readable form label carries better information than a REST option value.
    merged.set(key, previous && previous.name !== previous.id && option.name === option.id
      ? previous : { id, name, fieldId: option.fieldId });
  }
  return [...merged.values()];
}

function parseLabelOptionsFromEditHtml(html: string, fieldIds: Set<number>): LabelOption[] {
  const $ = loadHtml(html);
  const options: LabelOption[] = [];
  for (const fieldId of fieldIds) {
    const names = new Set([`issue[custom_field_values][${fieldId}]`, `issue[custom_field_values][${fieldId}][]`]);
    $('select[name], input[name]').each((_index, element) => {
      const control = $(element);
      const controlName = control.attr('name') ?? '';
      if (!names.has(controlName)) return;
      if (element.tagName.toLowerCase() === 'select') {
        control.find('option').each((_optionIndex, optionElement) => {
          const option = $(optionElement);
          const id = option.attr('value')?.trim();
          const label = option.text().replace(/[\u0000-\u001f\u007f]/g, '').trim();
          if (id && id !== '0' && label) options.push({ id, name: label, fieldId });
        });
      } else {
        const id = control.attr('value')?.trim();
        if (!id || id === '0') return;
        const inputId = control.attr('id');
        let label = '';
        if (inputId) {
          label = $('label[for]').filter((_labelIndex, labelElement) => $(labelElement).attr('for') === inputId).first().text();
        }
        if (!label) label = control.closest('label').text();
        label = label.replace(/[\u0000-\u001f\u007f]/g, '').trim();
        if (label) options.push({ id, name: label, fieldId });
      }
    });
  }
  return mergeLabelOptions(options);
}

function mapOptionValue(value: string, fieldId: number, catalog: LabelOption[]): string {
  return catalog.find(option => option.fieldId === fieldId && (option.id === value || option.name === value))?.name ?? value;
}

function mapCustomFieldValues(value: unknown, fieldId: number, catalog: LabelOption[]): string[] {
  return flattenLabels(value).map(item => mapOptionValue(item, fieldId, catalog));
}

function mapIssue(raw: RedmineIssue, fallbackProjectId: number, catalog: LabelOption[] = [],
  membership: { userIds?: Set<number>; groupIds?: Set<number>; primaryAssigneeFieldId?: number } = {}): Issue {
  const customFields = raw.custom_fields ?? [];
  const branchField = customFields.find(field => /\bbranch\b/i.test(field.name));
  const primaryFields = membership.primaryAssigneeFieldId === undefined ? []
    : customFields.filter(field => field.id === membership.primaryAssigneeFieldId && field.name === 'Primary Assignee');
  const primaryAssigneeId = primaryFields.length === 1 ? positiveId(primaryFields[0]!.value) : undefined;
  const assignedId = positiveId(raw.assigned_to?.id);
  const declaredType = raw.assigned_to?.type?.toLocaleLowerCase();
  const groupIds = membership.groupIds ?? new Set<number>();
  const userIds = membership.userIds;
  const assignedToType = declaredType?.includes('group') ? 'group'
    : declaredType?.includes('user') ? 'user'
    : assignedId && groupIds.has(assignedId) && !userIds?.has(assignedId) ? 'group'
    : raw.assigned_to ? 'user' : undefined;
  const labels = [...new Set([...(raw.labels ?? []), ...customFields.filter(field => isLabelOrTagField(field.name))
    .flatMap(field => mapCustomFieldValues(field.value, field.id, catalog))])];
  const watchers = (raw.watchers ?? []).map(user => user.id);
  const attachments: Attachment[] = (raw.attachments ?? []).map(item => {
    const url = typeof item.content_url === 'string' ? item.content_url : '';
    const isRaster = /^image\/(?:png|jpeg|gif|webp)$/i.test(item.content_type ?? '');
    const contentPath = `/api/issues/${raw.id}/attachments/${item.id}/content`;
    return { id: item.id, filename: item.filename, url, size: item.filesize,
      ...(item.content_type ? { contentType: item.content_type } : {}),
      ...(isRaster ? { thumbnailUrl: contentPath } : {}) };
  });
  const allowedStatusIds = normalizeAllowedStatusIds(raw.allowed_statuses);
  return {
    id: raw.id, projectId: raw.project?.id ?? fallbackProjectId, subject: raw.subject, description: raw.description ?? '',
    ...(raw.status?.name ? { statusName: raw.status.name } : {}),
    statusId: raw.status.id, priorityId: raw.priority?.id ?? 0, trackerId: raw.tracker?.id ?? 0, trackerName: raw.tracker?.name ?? 'Task',
    authorId: raw.author?.id ?? 0, ...(assignedId ? { assignedToId: assignedId } : {}),
    ...(assignedToType ? { assignedToType } : {}), ...(safeText(raw.assigned_to?.name) ? { assignedToName: safeText(raw.assigned_to?.name) } : {}),
    ...(membership.primaryAssigneeFieldId ? { primaryAssigneeFieldId: membership.primaryAssigneeFieldId } : {}),
    ...(primaryAssigneeId ? { primaryAssigneeId, developerId: primaryAssigneeId } : {}),
    ...(raw.fixed_version ? { fixedVersionId: raw.fixed_version.id } : {}), branch: typeof branchField?.value === 'string' ? branchField.value : '',
    labels, watcherIds: watchers, createdOn: raw.created_on, updatedOn: raw.updated_on,
    ...(raw.due_date ? { dueDate: raw.due_date } : {}), attachments,
    ...(raw.parent?.id ? { parentId: raw.parent.id } : {}),
    ...(allowedStatusIds !== undefined ? { allowedStatusIds } : {}),
  };
}

function normalizeAllowedStatusIds(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: number[] = [];
  for (const status of value) {
    if (!status || typeof status !== 'object') return undefined;
    const id = (status as { id?: unknown }).id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return undefined;
    ids.push(id);
  }
  return [...new Set(ids)];
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text && text.length <= 300 ? text : undefined;
}

function findPrimaryAssigneeFieldId(issueFields: { id: number; name: string; value?: unknown }[],
  definitions: RedmineCustomField[], projectId: number, trackerId?: number): number | undefined {
  // Prefer the issue payload as the source of the real field ID: the Redmine API key may read
  // issues while /custom_fields.json is admin-only. The exact, unique field name on this issue
  // confirms both its identity and project/tracker applicability. When the catalog is available,
  // reject any metadata that contradicts an issue User field; absence of metadata is not evidence
  // that this explicitly named field is something else.
  const matches = issueFields.filter(field => field.name === 'Primary Assignee');
  if (matches.length !== 1) return undefined;
  const candidate = matches[0]!;
  if (!positiveId(candidate.id) || Array.isArray(candidate.value)) return undefined;

  const definition = definitions.find(field => field.id === candidate.id);
  if (definition) {
    if (definition.name !== 'Primary Assignee'
      || definition.customized_type && definition.customized_type.toLocaleLowerCase() !== 'issue'
      || definition.field_format && definition.field_format.toLocaleLowerCase() !== 'user'
      || definition.multiple === true
      || definition.projects?.length && !definition.projects.some(item => item.id === projectId)
      || trackerId !== undefined && definition.trackers?.length && !definition.trackers.some(item => item.id === trackerId)) return undefined;
  }
  return candidate.id;
}
function mapJournal(raw: RedmineJournal, customFieldNames: Map<number, string> = new Map(), catalog: LabelOption[] = []): Journal {
  const changes = (raw.details ?? []).map(detail => {
    const customFieldId = detail.property === 'cf' && Number.isSafeInteger(Number(detail.name)) ? Number(detail.name) : undefined;
    const field = customFieldId !== undefined ? customFieldNames.get(customFieldId) ?? `cf_${detail.name}` : detail.name ?? detail.property ?? 'field';
    const mapValue = (value: unknown) => {
      if (value === undefined || value === null) return undefined;
      const rawValue = String(value);
      return customFieldId !== undefined && isLabelOrTagField(field)
        ? mapCustomFieldValues(rawValue, customFieldId, catalog).join(', ') : rawValue;
    };
    const oldValue = mapValue(detail.old_value);
    const newValue = mapValue(detail.new_value);
    return { field, ...(oldValue === undefined ? {} : { oldValue }), ...(newValue === undefined ? {} : { newValue }) };
  });
  return { id: raw.id, user: raw.user ? person(raw.user) : { id: 0, name: 'Redmine' }, notes: raw.notes ?? '', createdOn: raw.created_on, changes };
}

function statusFromSearchTitle(title?: string): string | undefined {
  return title?.match(/\(([^)]+)\)/)?.[1]?.trim() || undefined;
}
