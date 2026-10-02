import type { AppConfig } from '../config.js';
import type { Attachment, Issue, Journal, Person, Priority, Project, Status, StatusKey, Version } from '../../shared/types.js';
import type { WorkspaceStore } from '../db/store.js';
import { RedmineRequestError, RedmineTransport, type FetchLike } from './transport.js';

interface RedmineUser { id: number; name?: string; firstname?: string; lastname?: string; avatar_url?: string }
interface RedmineIssueStatus { id: number; name: string; is_closed?: boolean }
interface RedminePriority { id: number; name: string; position?: number }
interface RedmineProject { id: number; name: string; identifier: string; description?: string }
interface RedmineVersion { id: number; project?: { id: number }; name: string; status?: string; due_date?: string; description?: string }
interface RedmineJournalDetail { name?: string; property?: string; old_value?: unknown; new_value?: unknown }
interface RedmineJournal { id: number; user?: RedmineUser; notes?: string; created_on: string; details?: RedmineJournalDetail[] }
interface RedmineIssue {
  id: number; project?: { id: number }; subject: string; description?: string; status: RedmineIssueStatus;
  priority?: { id: number }; tracker?: { id: number; name: string }; author?: RedmineUser; assigned_to?: RedmineUser;
  fixed_version?: { id: number }; created_on: string; updated_on: string; due_date?: string; parent?: { id: number };
  watchers?: RedmineUser[]; journals?: RedmineJournal[]; attachments?: { id: number; filename: string; content_url: string; filesize: number }[];
  custom_fields?: { id: number; name: string; value: unknown }[]; labels?: string[]; allowed_statuses?: RedmineIssueStatus[];
}

export interface RedmineSnapshot {
  me: Person;
  projects: Project[];
  statuses: Status[];
  priorities: Priority[];
  versions: Version[];
  issues: Issue[];
  people: Person[];
  projectMembers: Record<string, number[]>;
  journals: { issueId: number; journal: Journal }[];
  branchFieldId?: number;
  labelsFieldId?: number;
  warnings: string[];
}

export class RedmineAdapter {
  readonly transport: RedmineTransport;
  constructor(private readonly config: AppConfig, fetcher?: FetchLike) {
    this.transport = new RedmineTransport(config, fetcher);
  }

  async currentUser(): Promise<Person> {
    const response = await this.transport.request<{ user: RedmineUser }>('users/current.json');
    return person(response.user);
  }

  async snapshot(since?: string, knownMe?: Person): Promise<RedmineSnapshot> {
    const [me, rawProjects, rawStatuses, rawPriorities] = await Promise.all([
      knownMe ? Promise.resolve(knownMe) : this.currentUser(),
      this.readPaged<RedmineProject>('projects.json', 'projects'),
      this.transport.request<{ issue_statuses: RedmineIssueStatus[] }>('issue_statuses.json'),
      this.transport.request<{ issue_priorities: RedminePriority[] }>('enumerations/issue_priorities.json'),
    ]);
    const projects: Project[] = rawProjects.map(mapProject);
    const statuses: Status[] = rawStatuses.issue_statuses.map(mapStatus);
    const priorities: Priority[] = rawPriorities.issue_priorities.map((item, index) => ({ id: item.id, name: item.name, rank: item.position ?? index + 1 }));
    const peopleById = new Map<number, Person>([[me.id, me]]);
    const projectMembers: Record<string, number[]> = {};
    const warnings: string[] = [];
    const allIssues: Issue[] = [];
    const allVersions: Version[] = [];
    const allJournals: { issueId: number; journal: Journal }[] = [];
    let branchFieldId: number | undefined;
    let labelsFieldId: number | undefined;

    for (const project of projects) {
      const updatedFilter = since ? `&updated_on=%3E%3D${encodeURIComponent(since)}` : '';
      const query = `issues.json?project_id=${project.id}&subproject_id=%21%2A&status_id=*&${updatedFilter ? `${updatedFilter.slice(1)}&` : ''}limit=100&offset=0`;
      const [rawIssues, rawVersions, rawMemberships] = await Promise.all([
        this.readPaged<RedmineIssue>(query, 'issues'),
        this.readPaged<RedmineVersion>(`projects/${encodeURIComponent(String(project.id))}/versions.json`, 'versions').catch(() => {
          warnings.push(`Не вдалося прочитати релізи проєкту ${project.name}.`); return [] as RedmineVersion[];
        }),
        this.readPaged<{ user?: RedmineUser }>(`projects/${encodeURIComponent(String(project.id))}/memberships.json`, 'memberships').catch(() => {
          warnings.push(`Список учасників проєкту ${project.name} недоступний для цього токена.`); return [] as { user?: RedmineUser }[];
        }),
      ]);
      const projectPeople = new Set<number>([me.id]);
      for (const membership of rawMemberships) {
        if (!membership.user) continue;
        const mapped = person(membership.user);
        peopleById.set(mapped.id, mapped);
        projectPeople.add(mapped.id);
      }
      const hydratedIssues = await mapLimit(rawIssues, 4, async (listIssue) => {
        const detail = await this.transport.request<{ issue: RedmineIssue }>(
          `issues/${listIssue.id}.json?include=journals%2Cwatchers%2Cattachments%2Callowed_statuses`);
        if (!detail.issue) throw new RedmineRequestError(`Redmine не повернув задачу ${listIssue.id}.`);
        return detail.issue;
      });
      for (const raw of hydratedIssues) {
        for (const user of [raw.author, raw.assigned_to, ...(raw.watchers ?? [])]) {
          if (!user) continue;
          const mapped = person(user);
          peopleById.set(mapped.id, mapped);
          projectPeople.add(mapped.id);
        }
        const fieldMap = raw.custom_fields ?? [];
        branchFieldId ??= fieldMap.find(field => /\bbranch\b/i.test(field.name))?.id;
        labelsFieldId ??= fieldMap.find(field => /\blabels?\b/i.test(field.name))?.id;
        const mapped = mapIssue(raw, project.id);
        allIssues.push(mapped);
        const customFieldNames = new Map((raw.custom_fields ?? []).map(field => [field.id, field.name]));
        for (const rawJournal of raw.journals ?? []) {
          if (!rawJournal.id) continue;
          if (rawJournal.user) peopleById.set(rawJournal.user.id, person(rawJournal.user));
          allJournals.push({ issueId: mapped.id, journal: mapJournal(rawJournal, customFieldNames) });
        }
      }
      projectMembers[String(project.id)] = [...projectPeople];
      for (const raw of rawVersions) {
        const version = mapVersion(raw, project.id);
        if (version.projectId === project.id) allVersions.push(version);
      }
    }
    if (!branchFieldId) warnings.push('Поле Branch не знайдено у доступних задачах.');
    if (!labelsFieldId) warnings.push('Поле Labels не визначено у доступних задачах.');
    return { me, projects, statuses, priorities, versions: allVersions, issues: allIssues,
      people: [...peopleById.values()], projectMembers, journals: allJournals, branchFieldId, labelsFieldId, warnings };
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
      const limit = Number(response.limit) || 100;
      total = Number.isFinite(Number(response.total_count)) ? Number(response.total_count) : result.length;
      if (rows.length === 0) break;
      offset += limit;
      if (response.total_count === undefined && rows.length < limit) break;
    }
    return result;
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
  return { id: user.id, name: user.name || [user.firstname, user.lastname].filter(Boolean).join(' ') || `#${user.id}`,
    ...(user.avatar_url ? { avatar: user.avatar_url } : {}) };
}
function mapProject(project: RedmineProject): Project {
  return { id: project.id, name: project.name, identifier: project.identifier, ...(project.description ? { description: project.description } : {}) };
}
function mapVersion(version: RedmineVersion, projectId: number): Version {
  const status = ['open', 'locked', 'closed'].includes(version.status ?? '') ? version.status as Version['status'] : 'open';
  return { id: version.id, projectId: version.project?.id ?? projectId, name: version.name, status,
    ...(version.due_date ? { dueDate: version.due_date } : {}), ...(version.description ? { description: version.description } : {}) };
}
function flattenLabels(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(item => flattenLabels(item));
  if (typeof value !== 'string') return [];
  return value.split(/[\n,;]+/).map(label => label.trim()).filter(Boolean);
}
function mapIssue(raw: RedmineIssue, fallbackProjectId: number): Issue {
  const customFields = raw.custom_fields ?? [];
  const branchField = customFields.find(field => /\bbranch\b/i.test(field.name));
  const labelsField = customFields.find(field => /\blabels?\b/i.test(field.name));
  const labels = [...new Set([...(raw.labels ?? []), ...flattenLabels(labelsField?.value)])];
  const watchers = (raw.watchers ?? []).map(user => user.id);
  const attachments: Attachment[] = (raw.attachments ?? []).map(item => ({ id: item.id, filename: item.filename, url: item.content_url, size: item.filesize }));
  return {
    id: raw.id, projectId: raw.project?.id ?? fallbackProjectId, subject: raw.subject, description: raw.description ?? '',
    statusId: raw.status.id, priorityId: raw.priority?.id ?? 0, trackerId: raw.tracker?.id ?? 0, trackerName: raw.tracker?.name ?? 'Task',
    authorId: raw.author?.id ?? 0, ...(raw.assigned_to ? { assignedToId: raw.assigned_to.id } : {}),
    ...(raw.fixed_version ? { fixedVersionId: raw.fixed_version.id } : {}), branch: typeof branchField?.value === 'string' ? branchField.value : '',
    labels, watcherIds: watchers, createdOn: raw.created_on, updatedOn: raw.updated_on,
    ...(raw.due_date ? { dueDate: raw.due_date } : {}), attachments,
    ...(raw.parent?.id ? { parentId: raw.parent.id } : {}),
    ...(raw.allowed_statuses?.length ? { allowedStatusIds: raw.allowed_statuses.map(status => status.id) } : {}),
  };
}
function mapJournal(raw: RedmineJournal, customFieldNames: Map<number, string> = new Map()): Journal {
  const changes = (raw.details ?? []).map(detail => ({
    field: detail.property === 'cf' && Number.isSafeInteger(Number(detail.name))
      ? customFieldNames.get(Number(detail.name)) ?? `cf_${detail.name}`
      : detail.name ?? detail.property ?? 'field',
    ...(detail.old_value === undefined || detail.old_value === null ? {} : { oldValue: String(detail.old_value) }),
    ...(detail.new_value === undefined || detail.new_value === null ? {} : { newValue: String(detail.new_value) }),
  }));
  return { id: raw.id, user: raw.user ? person(raw.user) : { id: 0, name: 'Redmine' }, notes: raw.notes ?? '', createdOn: raw.created_on, changes };
}
