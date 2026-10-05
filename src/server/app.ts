import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Bootstrap, BoardData, Command, Issue, IssueDetail, Journal, LabelOption, Notification, PeopleField, Person, Priority, RedmineRole, ReleaseDetail, SearchResponse, SearchResult, Status, Version } from '../shared/types.js';
import { createConfig, type AppConfig, type ConfigInput } from './config.js';
import { CommandService, ApiFault } from './commands/service.js';
import { openDatabase } from './db/connection.js';
import { applyMigrations } from './db/migrate.js';
import { WorkspaceStore, type OperationRecord, type PersonAvatarContentType, type ProjectBackgroundContentType } from './db/store.js';
import { applyPersonAvatarOverride, projectPerson } from './people.js';
import { RedmineAdapter } from './redmine/adapter.js';
import { RedmineRequestError, type FetchLike } from './redmine/transport.js';
import { BackgroundWorker, SyncService, type EventHub } from './sync/service.js';
import { projectNotifications } from './notifications.js';

export interface BackendRuntime {
  config: AppConfig;
  store: WorkspaceStore;
  sync: SyncService;
  commands: CommandService;
  worker: BackgroundWorker;
  stop: () => void;
  close: () => void;
}

export type WorkspaceApp = FastifyInstance & { backend: BackendRuntime };
export interface CreateAppOptions {
  config?: AppConfig;
  env?: ConfigInput;
  databasePath?: string;
  migrationsFolder?: string;
  fetcher?: FetchLike;
  startWorker?: boolean;
  staticRoot?: string;
}

class LocalEventHub implements EventHub {
  private clients = new Set<{ write: (event: string, data?: unknown) => void; close: () => void }>();
  add(write: (event: string, data?: unknown) => void, close: () => void = () => undefined): () => void {
    const client = { write, close };
    this.clients.add(client);
    return () => this.clients.delete(client);
  }
  publish(event: string, data?: unknown): void {
    for (const client of this.clients) {
      try { client.write(event, data); } catch { this.clients.delete(client); }
    }
  }
  close(): void {
    for (const client of this.clients) {
      try { client.close(); } catch { /* socket is already closed */ }
    }
    this.clients.clear();
  }
}

const commandSchema = z.object({
  type: z.enum(['createIssue', 'updateIssue', 'moveIssue', 'handoffToQA', 'returnToDeveloper', 'comment', 'editJournal', 'deleteJournal', 'setJournalLike', 'generateBranch',
    'createRelease', 'updateRelease', 'assignRelease', 'finishRelease', 'runAutomation']),
  issueId: z.number().int().positive().optional(),
  projectId: z.number().int().positive().optional(),
  versionId: z.number().int().positive().optional(),
  operationId: z.string().min(1).max(200).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
});
const projectBackgroundLimit = 5 * 1024 * 1024;
const personAvatarLimit = 2 * 1024 * 1024;
const projectBackgroundVersionPattern = /^\/api\/projects\/([1-9]\d*)\/background\?v=([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const personAvatarVersionPattern = /^\/api\/people\/([1-9]\d*)\/avatar\?v=([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const projectBackgroundUploadSchema = z.object({ dataUrl: z.string().min(1).max(8 * 1024 * 1024) }).strict();
const personAvatarUploadSchema = z.object({ dataUrl: z.string().min(1).max(3 * 1024 * 1024) }).strict();

export async function createApp(options: CreateAppOptions = {}): Promise<WorkspaceApp> {
  let config = options.config ?? createConfig(options.env ?? process.env);
  if (options.databasePath) config = { ...config, databasePath: options.databasePath };
  const connection = openDatabase(config.databasePath);
  try { await applyMigrations(connection.db, options.migrationsFolder ?? resolve(process.cwd(), 'drizzle')); }
  catch (error) { connection.close(); throw error; }
  const store = new WorkspaceStore(connection.db, config.scope);
  await store.initializeDemo();
  const events = new LocalEventHub();
  let adapter: RedmineAdapter | undefined;
  if (config.mode === 'redmine' && config.tokenConfigured && !config.configurationError) {
    try { adapter = new RedmineAdapter(config, options.fetcher); }
    catch { adapter = undefined; }
  }
  const sync = new SyncService(config, store, adapter, events);
  const commands = new CommandService(config, store, events, adapter);
  const worker = new BackgroundWorker(sync, store, async () => (await store.getSettings()).pollIntervalSeconds,
    config.pollIntervalSeconds, async () => { await commands.processPendingDemoAutomations(); });
  const runtime: BackendRuntime = { config, store, sync, commands, worker,
    stop: () => { worker.stop(); events.close(); }, close: connection.close };
  const app = Fastify({ logger: false, trustProxy: false });
  Object.assign(app, { backend: runtime });

  app.addHook('preHandler', async (request) => assertLocalOrigin(request));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RedmineRequestError && error.statusCode === 404) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Об’єкт не знайдено в Redmine.' });
    if (error instanceof RedmineRequestError && [401, 403].includes(error.statusCode ?? 0)) return reply.code(error.statusCode!).send({ code: 'FORBIDDEN', message: 'Redmine відхилив доступ до цього об’єкта.' });
    if (error instanceof RedmineRequestError && error.statusCode === 413) return reply.code(413).send({ code: 'FILE_TOO_LARGE', message: error.message });
    if (error instanceof RedmineRequestError && error.statusCode === 415) return reply.code(415).send({ code: 'UNSUPPORTED_MEDIA_TYPE', message: error.message });
    if (error instanceof ApiFault) return reply.code(error.statusCode).send({ code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) });
    const validation = error as Error & { validation?: unknown; statusCode?: number };
    if (validation.validation) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Перевірте формат запиту.' });
    if (error instanceof z.ZodError) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Перевірте формат запиту.' });
    if (validation.statusCode === 413) return reply.code(413).send({ code: 'PAYLOAD_TOO_LARGE', message: 'Розмір запиту перевищує дозволені 8 MiB.' });
    if (validation.statusCode === 400) return reply.code(400).send({ code: 'INVALID_JSON', message: 'Тіло запиту має некоректний JSON.' });
    requestLogSafe(error);
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Внутрішня помилка сервера.' });
  });

  app.get('/api/health', async () => ({ ok: true, mode: config.mode, connected: sync.isConnected,
    readOnly: config.mode === 'redmine' && !config.writeEnabled,
    canWrite: config.mode === 'demo' || config.writeEnabled && sync.isConnected && Boolean(adapter),
    ...(sync.connectionError ? { connectionError: sync.connectionError } : {}) }));

  app.put<{ Params: { id: string } }>('/api/projects/:id/background', { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    const projectId = positiveId(request.params.id, 'PROJECT_NOT_FOUND');
    if (!(await store.getProjects()).some(project => project.id === projectId)) {
      throw new ApiFault(404, 'PROJECT_NOT_FOUND', 'Проєкт не знайдено.');
    }
    const parsed = projectBackgroundUploadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_BACKGROUND', message: 'Очікується data URL зображення JPEG, PNG або WebP.' });
    const decoded = decodeProjectBackground(parsed.data.dataUrl);
    if (!decoded) return reply.code(400).send({ code: 'INVALID_BACKGROUND', message: 'Файл має бути справжнім JPEG, PNG або WebP до 5 MiB.' });

    const currentUrl = (await store.getSettings()).projectBackgrounds[String(projectId)];
    const keepVersion = currentUrl?.match(projectBackgroundVersionPattern)?.[2];
    const version = randomUUID();
    await store.saveProjectBackground(projectId, version, decoded.contentType, decoded.data, keepVersion);
    return { url: `/api/projects/${projectId}/background?v=${version}` };
  });

  app.get<{ Params: { id: string }; Querystring: { v?: string } }>('/api/projects/:id/background', async (request, reply) => {
    const projectId = positiveId(request.params.id, 'PROJECT_NOT_FOUND');
    if (!(await store.getProjects()).some(project => project.id === projectId)) {
      throw new ApiFault(404, 'PROJECT_NOT_FOUND', 'Проєкт не знайдено.');
    }
    const requestedVersion = request.query.v;
    if (requestedVersion !== undefined && !isProjectBackgroundVersion(requestedVersion)) {
      return reply.code(404).send({ code: 'BACKGROUND_NOT_FOUND', message: 'Зображення не знайдено.' });
    }
    const background = await store.getProjectBackground(projectId, requestedVersion);
    if (!background) return reply.code(404).send({ code: 'BACKGROUND_NOT_FOUND', message: 'Зображення не знайдено.' });
    return reply.header('Content-Type', background.contentType)
      .header('Cache-Control', 'no-cache')
      .header('X-Content-Type-Options', 'nosniff')
      .send(background.data);
  });

  app.put<{ Params: { id: string } }>('/api/people/:id/avatar', { bodyLimit: 3 * 1024 * 1024 }, async (request, reply) => {
    const personId = positiveId(request.params.id, 'PERSON_NOT_FOUND');
    if (!(await store.getValue<Person[]>('people') ?? []).some(person => person.id === personId)) {
      throw new ApiFault(404, 'PERSON_NOT_FOUND', 'Людину не знайдено.');
    }
    const parsed = personAvatarUploadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_PERSON_AVATAR', message: 'Очікується data URL зображення JPEG, PNG або WebP.' });
    const decoded = decodeRasterImage(parsed.data.dataUrl, personAvatarLimit);
    if (!decoded) return reply.code(400).send({ code: 'INVALID_PERSON_AVATAR', message: 'Файл має бути справжнім JPEG, PNG або WebP до 2 MiB.' });

    const settings = await store.getSettings();
    const currentOverride = settings.personAvatarOverrides[String(personId)];
    const keepVersion = currentOverride?.kind === 'photo' ? currentOverride.url.match(personAvatarVersionPattern)?.[2] : undefined;
    const version = randomUUID();
    await store.savePersonAvatar(personId, version, decoded.contentType as PersonAvatarContentType, decoded.data, keepVersion);
    return { url: `/api/people/${personId}/avatar?v=${version}` };
  });

  app.get<{ Params: { id: string }; Querystring: { v?: string } }>('/api/people/:id/avatar', async (request, reply) => {
    const personId = positiveId(request.params.id, 'PERSON_NOT_FOUND');
    const requestedVersion = request.query.v;
    if (requestedVersion !== undefined && !isPersonAvatarVersion(requestedVersion)) {
      return reply.code(404).send({ code: 'PERSON_AVATAR_NOT_FOUND', message: 'Зображення людини не знайдено.' });
    }
    const avatar = await store.getPersonAvatar(personId, requestedVersion);
    if (!avatar) return reply.code(404).send({ code: 'PERSON_AVATAR_NOT_FOUND', message: 'Зображення людини не знайдено.' });
    return reply.header('Content-Type', avatar.contentType)
      .header('Cache-Control', 'no-cache')
      .header('X-Content-Type-Options', 'nosniff')
      .send(avatar.data);
  });

  app.delete<{ Params: { id: string }; Querystring: { v?: string } }>('/api/people/:id/avatar', async (request, reply) => {
    const personId = positiveId(request.params.id, 'PERSON_NOT_FOUND');
    const version = request.query.v;
    if (!version || !isPersonAvatarVersion(version)) {
      return reply.code(400).send({ code: 'INVALID_PERSON_AVATAR_VERSION', message: 'Не вказано версію локального зображення.' });
    }
    const currentOverride = (await store.getSettings()).personAvatarOverrides[String(personId)];
    if (currentOverride?.kind === 'photo' && currentOverride.url === `/api/people/${personId}/avatar?v=${version}`) {
      return { deleted: false };
    }
    return { deleted: await store.removePersonAvatar(personId, version) };
  });

  app.get('/api/bootstrap', async (): Promise<Bootstrap> => {
    await sync.bootstrapRead();
    const [projects, statuses, priorities, settings, me, capabilities] = await Promise.all([
      store.getProjects(), store.getValue<Bootstrap['statuses']>('statuses'), store.getValue<Bootstrap['priorities']>('priorities'),
      store.getSettings(), store.getValue<Person>('me'), store.getValue<Bootstrap['capabilities']>('capabilities'),
    ]);
    const warnings = [...(capabilities?.warnings ?? [])];
    if (config.mode === 'redmine' && !config.writeEnabled) {
      warnings.unshift('Реальний Redmine відкритий лише для читання. Для запису потрібне backend-налаштування REDMINE_WRITE_ENABLED=true.');
    } else if (config.mode === 'redmine') {
      if (sync.connectionError && !warnings.includes(sync.connectionError)) warnings.push(sync.connectionError);
    }
    return {
      mode: config.mode, readOnly: config.mode === 'redmine' && !config.writeEnabled, connected: sync.isConnected,
      redmineUrl: config.redmineUrl, me: applyPersonAvatarOverride(me ?? { id: 0, name: 'Підключення Redmine' }, settings), projects,
      statuses: statuses ?? [], priorities: priorities ?? [], settings,
      capabilities: { canWrite: config.mode === 'demo' || config.writeEnabled && sync.isConnected && Boolean(adapter),
        journalEditing: config.mode === 'demo', journalDeleting: config.mode === 'demo', journalLikes: config.mode === 'demo',
        ...(capabilities?.branchFieldId ? { branchFieldId: capabilities.branchFieldId } : {}),
        ...(capabilities?.labelsFieldId ? { labelsFieldId: capabilities.labelsFieldId } : {}), warnings },
    };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/board', async (request): Promise<BoardData> => {
    await sync.bootstrapRead();
    const projectId = positiveId(request.params.id, 'PROJECT_NOT_FOUND');
    const project = (await store.getProjects()).find(item => item.id === projectId);
    if (!project) throw new ApiFault(404, 'PROJECT_NOT_FOUND', 'Проєкт не знайдено.');
    const issues = await store.getIssues(projectId);
    const versions = await store.getVersions(projectId);
    const people = await store.getValue<Person[]>('people') ?? [];
    const memberIds = (await store.getValue<Record<string, number[]>>('projectMembers'))?.[String(projectId)] ?? [];
    const membershipIds = new Set((await store.getValue<Record<string, number[]>>('projectMembershipIds'))?.[String(projectId)] ?? []);
    const membershipRoles = (await store.getValue<Record<string, Record<string, RedmineRole[]>>>('projectMembershipRoles'))?.[String(projectId)] ?? {};
    const settings = await store.getSettings();
    const members = [...new Map([...memberIds.map(id => people.find(person => person.id === id)).filter((person): person is Person => Boolean(person)),
      ...issues.flatMap(issue => [people.find(person => person.id === issue.authorId), people.find(person => person.id === issue.assignedToId),
        ...issue.watcherIds.map(id => people.find(person => person.id === id))].filter((person): person is Person => Boolean(person)))].map(person => [person.id, person])).values()]
      .map(person => projectPerson(person, projectId, { membershipIds, membershipRoles }, settings));
    const peopleRecommendations: Partial<Record<PeopleField, number[]>> = {
      assignee: await store.getPeopleRecommendations(projectId, 'assignee'),
      developer: await store.getPeopleRecommendations(projectId, 'developer'),
      qa: await store.getPeopleRecommendations(projectId, 'qa'),
    };
    const syncedAt = await store.getCursor('baseline');
    const labelOptions = (await store.getValue<Record<string, LabelOption[]>>('labelOptions'))?.[String(projectId)];
    return { issues, versions, members, labels: [...new Set([...issues.flatMap(issue => issue.labels), ...(labelOptions ?? []).map(option => option.name)])].sort((a, b) => a.localeCompare(b)),
      ...(project.trackers !== undefined ? { trackers: project.trackers } : {}),
      ...(labelOptions?.length ? { labelOptions } : {}),
      total: issues.length, peopleRecommendations, ...(syncedAt ? { syncedAt } : {}) };
  });

  app.get<{ Querystring: { q?: string; projectId?: string; offset?: string; limit?: string } }>('/api/search', async (request): Promise<SearchResponse> => {
    const parsed = z.object({ q: z.string().trim().min(1).max(300), projectId: z.string().optional(),
      offset: z.coerce.number().int().min(0).max(1_000_000).default(0), limit: z.coerce.number().int().min(1).max(50).default(20) })
      .safeParse(request.query);
    if (!parsed.success) throw new ApiFault(400, 'INVALID_SEARCH', 'Перевірте параметри пошуку.');
    await sync.bootstrapRead();
    const projectId = parsed.data.projectId && parsed.data.projectId !== 'all'
      ? positiveId(parsed.data.projectId, 'PROJECT_NOT_FOUND') : undefined;
    const projects = await store.getProjects();
    const project = projectId === undefined ? undefined : projects.find(item => item.id === projectId);
    if (projectId !== undefined && !project) throw new ApiFault(404, 'PROJECT_NOT_FOUND', 'Проєкт не знайдено.');
    if (config.mode === 'redmine') {
      if (!adapter) throw new ApiFault(503, 'REDMINE_UNAVAILABLE', sync.connectionError ?? 'З’єднання з Redmine недоступне.');
      const exactIssueId = parsed.data.q.match(/^#?([1-9]\d*)$/)?.[1];
      if (exactIssueId) {
        const issueId = Number(exactIssueId);
        if (!Number.isSafeInteger(issueId)) return { results: [], total: 0, offset: parsed.data.offset, limit: parsed.data.limit };
        let detail;
        try {
          detail = await adapter.issueDetail(issueId, await store.getValue<Record<string, LabelOption[]>>('labelOptions') ?? {}, false);
        } catch (error) {
          if (error instanceof RedmineRequestError && error.statusCode === 404) {
            return { results: [], total: 0, offset: parsed.data.offset, limit: parsed.data.limit };
          }
          throw error;
        }
        const visibleProject = projects.some(item => item.id === detail.issue.projectId);
        if (!visibleProject || project && detail.issue.projectId !== project.id) {
          return { results: [], total: 0, offset: parsed.data.offset, limit: parsed.data.limit };
        }
        const statuses = await store.getValue<Bootstrap['statuses']>('statuses') ?? [];
        const result: SearchResult = { id: detail.issue.id, title: detail.issue.subject, description: detail.issue.description,
          projectId: detail.issue.projectId, statusName: statuses.find(status => status.id === detail.issue.statusId)?.name,
          url: `${config.redmineUrl.replace(/\/$/, '')}/issues/${detail.issue.id}`, updatedOn: detail.issue.updatedOn };
        return parsed.data.offset > 0 ? { results: [], total: 1, offset: parsed.data.offset, limit: parsed.data.limit }
          : { results: [result], total: 1, offset: 0, limit: parsed.data.limit };
      }
      const response = await adapter.search(parsed.data.q, { ...(project ? { projectIdentifier: project.identifier } : {}),
        offset: parsed.data.offset, limit: parsed.data.limit });
      const cachedProjects = new Map((await store.getIssues()).map(issue => [issue.id, issue.projectId]));
      const results = response.results.map(item => ({ ...item,
        ...((item.projectId ?? cachedProjects.get(item.id) ?? project?.id) ? { projectId: item.projectId ?? cachedProjects.get(item.id) ?? project!.id } : {}) }));
      return { ...response, results };
    }
    const candidates = await store.getIssues(projectId);
    const statuses = await store.getValue<Bootstrap['statuses']>('statuses') ?? [];
    const results: SearchResult[] = [];
    const query = parsed.data.q.toLocaleLowerCase();
    const exactIssueId = query.match(/^#?([1-9]\d*)$/)?.[1];
    for (const issue of candidates) {
      const journals = await store.getJournals(issue.id);
      const searchable = [String(issue.id), issue.subject, issue.description, issue.branch, ...issue.labels,
        ...journals.flatMap(journal => [journal.notes, ...journal.changes.flatMap(change => [change.field, change.oldValue ?? '', change.newValue ?? ''])])]
        .join('\n').toLocaleLowerCase();
      if (exactIssueId ? issue.id !== Number(exactIssueId) : !searchable.includes(query)) continue;
      results.push({ id: issue.id, title: issue.subject, description: issue.description, projectId: issue.projectId,
        statusName: statuses.find(status => status.id === issue.statusId)?.name });
    }
    return { results: results.slice(parsed.data.offset, parsed.data.offset + parsed.data.limit), total: results.length,
      offset: parsed.data.offset, limit: parsed.data.limit };
  });

  app.get<{ Params: { id: string } }>('/api/issues/:id', async (request): Promise<IssueDetail> => {
    await sync.bootstrapRead();
    const issueId = positiveId(request.params.id, 'ISSUE_NOT_FOUND');
    let remoteJournals: Journal[] | undefined;
    let remotePeople: Person[] | undefined;
    if (config.mode === 'redmine' && adapter) {
      const detail = await adapter.issueDetail(issueId, await store.getValue<Record<string, LabelOption[]>>('labelOptions') ?? {});
      remoteJournals = detail.journals;
      remotePeople = detail.people;
      if (!(await store.getProjects()).some(project => project.id === detail.issue.projectId)) throw new ApiFault(404, 'ISSUE_NOT_FOUND', 'Задачу не знайдено.');
      const cached = await store.getIssue(issueId);
      await store.saveIssue({ ...detail.issue, developerId: cached?.developerId, qaId: cached?.qaId });
      for (const journal of detail.journals) await store.saveJournal(issueId, journal);
      const people = new Map((await store.getValue<Person[]>('people') ?? []).map(person => [person.id, person]));
      for (const person of detail.people) people.set(person.id, person);
      await store.setValue('people', [...people.values()]);
    }
    const issue = await store.getIssue(issueId);
    if (!issue) throw new ApiFault(404, 'ISSUE_NOT_FOUND', 'Задачу не знайдено.');
    const [people, me, storedJournals] = await Promise.all([
      store.getValue<Person[]>('people'), store.getValue<Person>('me'), remoteJournals ?? store.getJournals(issueId),
    ]);
    const settings = await store.getSettings();
    const membershipIds = new Set((await store.getValue<Record<string, number[]>>('projectMembershipIds'))?.[String(issue.projectId)] ?? []);
    const membershipRoles = (await store.getValue<Record<string, Record<string, RedmineRole[]>>>('projectMembershipRoles'))?.[String(issue.projectId)] ?? {};
    const peopleById = new Map((people ?? []).map(person => [person.id, person]));
    for (const person of remotePeople ?? []) peopleById.set(person.id, { ...peopleById.get(person.id), ...person });
    for (const journal of storedJournals) if (!peopleById.has(journal.user.id)) peopleById.set(journal.user.id, journal.user);
    const roleContext = { membershipIds, membershipRoles };
    const projectedPeople = new Map([...peopleById.values()].map(person => [person.id, projectPerson(person, issue.projectId, roleContext, settings)]));
    const currentUser = me ?? { id: 0, name: 'Підключення Redmine' };
    const journals = storedJournals.map(journal => {
      const hasNotes = journal.notes.trim().length > 0;
      const mayManage = config.mode === 'demo' && hasNotes && (journal.user.id === currentUser.id || currentUser.isAdmin === true);
      const { likes: _likes, likedByMe: _likedByMe, canLike: _canLike, canEdit: _canEdit, canDelete: _canDelete, ...publicJournal } = journal;
      const reactions = config.mode === 'demo' && hasNotes ? store.getJournalLikeState(journal.id, currentUser.id) : undefined;
      return { ...publicJournal, user: projectedPeople.get(journal.user.id) ?? projectPerson(journal.user, issue.projectId, roleContext, settings),
        canEdit: mayManage, canDelete: mayManage, canLike: config.mode === 'demo' && hasNotes,
        ...(reactions ? { likes: reactions.count, likedByMe: reactions.likedByMe } : {}) };
    });
    return { issue, journals,
      watchers: issue.watcherIds.map(id => projectedPeople.get(id)).filter((person): person is Person => Boolean(person)),
      ...(remotePeople ? { people: remotePeople.map(person => projectedPeople.get(person.id) ?? projectPerson(person, issue.projectId, roleContext, settings)) } : {}) };
  });

  app.get<{ Params: { id: string; attachmentId: string } }>('/api/issues/:id/attachments/:attachmentId/content', async (request, reply) => {
    await sync.bootstrapRead();
    const issueId = positiveId(request.params.id, 'ISSUE_NOT_FOUND');
    const attachmentId = positiveId(request.params.attachmentId, 'ATTACHMENT_NOT_FOUND');
    if (config.mode !== 'redmine' || !adapter) throw new ApiFault(404, 'ATTACHMENT_NOT_FOUND', 'Вкладення не знайдено.');
    const accessibleProjects = new Set((await store.getProjects()).map(project => project.id));
    let issue = await store.getIssue(issueId);
    if (!issue || !accessibleProjects.has(issue.projectId) || !issue.attachments.some(item => item.id === attachmentId)) {
      const cachedLabels = await store.getValue<Record<string, LabelOption[]>>('labelOptions') ?? {};
      const detail = await adapter.issueDetail(issueId, cachedLabels, false);
      if (!accessibleProjects.has(detail.issue.projectId)) throw new ApiFault(404, 'ISSUE_NOT_FOUND', 'Задачу не знайдено.');
      issue = detail.issue;
      const cached = await store.getIssue(issueId);
      await store.saveIssue({ ...issue, developerId: cached?.developerId, qaId: cached?.qaId });
    }
    const attachment = issue.attachments.find(item => item.id === attachmentId);
    if (!attachment) throw new ApiFault(404, 'ATTACHMENT_NOT_FOUND', 'Вкладення не знайдено.');
    const image = await adapter.attachmentContent(attachmentId);
    return reply.header('Content-Type', image.contentType).header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=300').send(image.data);
  });

  app.get<{ Params: { id: string } }>('/api/releases/:id', async (request): Promise<ReleaseDetail> => {
    await sync.bootstrapRead();
    const versionId = positiveId(request.params.id, 'VERSION_NOT_FOUND');
    const version = await store.getVersion(versionId);
    if (!version) throw new ApiFault(404, 'VERSION_NOT_FOUND', 'Реліз не знайдено.');
    if (config.mode === 'redmine' && adapter) {
      const labelOptions = (await store.getValue<Record<string, LabelOption[]>>('labelOptions'))?.[String(version.projectId)] ?? [];
      const remoteIssues = await adapter.releaseIssues(versionId, version.projectId, labelOptions);
      const cachedIssues = new Map((await store.getIssues(version.projectId)).map(issue => [issue.id, issue]));
      const issues: Issue[] = [];
      for (const issue of remoteIssues) {
        const cached = cachedIssues.get(issue.id);
        const merged = { ...issue, watcherIds: cached?.watcherIds ?? issue.watcherIds, developerId: cached?.developerId, qaId: cached?.qaId };
        await store.saveIssue(merged);
        issues.push(merged);
      }
      return { version, issues };
    }
    const issues = (await store.getIssues(version.projectId)).filter(issue => issue.fixedVersionId === version.id);
    return { version, issues };
  });

  app.post('/api/commands', async (request, reply) => {
    const parsed = commandSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_COMMAND', message: 'Перевірте дані команди.' });
    const result = await commands.execute(parsed.data as Command);
    return reply.send(result);
  });

  app.get('/api/settings', async () => store.getSettings());
  app.put('/api/settings', async (request) => commands.saveSettings(request.body));
  app.patch('/api/settings', async (request) => commands.patchSettings(request.body));

  app.post('/api/people/selection', async (request) => {
    const body = z.object({ projectId: z.number().int().positive(), personId: z.number().int().positive(),
      field: z.enum(['assignee', 'developer', 'qa']), operationId: z.string().min(1).max(200) }).parse(request.body);
    await sync.bootstrapRead();
    return commands.recordPeopleSelection(body);
  });

  app.post<{ Params: { id: string } }>('/api/issues/:id/roles', async (request, reply) => {
    const issueId = positiveId(request.params.id, 'ISSUE_NOT_FOUND');
    const schema = z.object({ developerId: z.number().int().positive().nullable().optional(), qaId: z.number().int().positive().nullable().optional(),
      operationId: z.string().min(1).max(200).optional() });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success || (parsed.data.developerId === undefined && parsed.data.qaId === undefined)) {
      return reply.code(400).send({ code: 'INVALID_ROLE', message: 'Вкажіть розробника або QA.' });
    }
    const { operationId, ...roles } = parsed.data;
    return commands.saveIssueRoles(issueId, roles, operationId);
  });

  app.get<{ Params: { id: string } }>('/api/issues/:id/draft', async (request) => {
    const issueId = positiveId(request.params.id, 'ISSUE_NOT_FOUND');
    return { draft: await store.getDraft(issueId) ?? null };
  });
  app.put<{ Params: { id: string } }>('/api/issues/:id/draft', async (request) => {
    const issueId = positiveId(request.params.id, 'ISSUE_NOT_FOUND');
    const body = z.object({ draft: z.unknown() }).parse(request.body);
    await store.saveDraft(issueId, body.draft);
    return { saved: true };
  });
  app.delete<{ Params: { id: string } }>('/api/issues/:id/draft', async (request) => {
    const issueId = positiveId(request.params.id, 'ISSUE_NOT_FOUND');
    await store.removeDraft(issueId);
    return { deleted: true };
  });

  const loadVisibleNotifications = async (archived = false): Promise<Notification[]> => {
    const stored = await store.getNotifications(archived);
    if (!stored.length) return [];
    const issueIds = [...new Set(stored.map(notification => notification.issueId))];
    const [issues, journalsByIssue, people, settings, membershipIdsByProject, membershipRolesByProject,
      statuses, priorities, versions, labelOptions] = await Promise.all([
      store.getIssues(), store.getJournalsForIssues(issueIds), store.getValue<Person[]>('people'), store.getSettings(),
      store.getValue<Record<string, number[]>>('projectMembershipIds'),
      store.getValue<Record<string, Record<string, RedmineRole[]>>>('projectMembershipRoles'),
      store.getValue<Status[]>('statuses'), store.getValue<Priority[]>('priorities'), store.getVersions(),
      store.getValue<Record<string, LabelOption[]>>('labelOptions'),
    ]);
    const peopleById = new Map((people ?? []).map(person => [person.id, person]));
    const projected = projectNotifications(stored, { issues, journalsByIssue, statuses: statuses ?? [], people: people ?? [],
      priorities: priorities ?? [], versions, labelOptions: labelOptions ?? {}, settings });
    return projected.map(notification => {
      const actor = { ...notification.actor, ...(peopleById.get(notification.actor.id) ?? {}) };
      const projectKey = String(notification.projectId);
      const roleContext = {
        membershipIds: new Set(membershipIdsByProject?.[projectKey] ?? []),
        membershipRoles: membershipRolesByProject?.[projectKey] ?? {},
      };
      return {
        ...notification,
        actor: projectPerson(actor, notification.projectId, roleContext, settings),
        ...(notification.changeLookups ? { changeLookups: { ...notification.changeLookups,
          people: (notification.changeLookups.people ?? []).map(person => projectPerson(person, notification.projectId, roleContext, settings)) } } : {}),
      };
    });
  };
  app.get<{ Querystring: { archived?: string } }>('/api/notifications', async (request) =>
    loadVisibleNotifications(request.query.archived === 'true'));
  app.post('/api/notifications/read', async (request) => {
    const body = z.object({ ids: z.array(z.string().min(1).max(200)).max(500) }).parse(request.body);
    const updated = await store.markNotificationsRead([...new Set(body.ids)]);
    const unreadCount = (await loadVisibleNotifications(false)).length;
    events.publish('notifications', { unreadCount });
    return { updated, unreadCount };
  });
  app.get('/api/operations', async () => (await store.getOperationRecords()).filter(record => record.operation.type !== 'saveIssueRoles')
    .map(record => ({ ...record.operation, retryable: realOperationRetryable(record) })));
  app.post('/api/sync', async (_request, reply) => {
    try { return await sync.sync(); }
    catch {
      const message = sync.connectionError ?? 'Синхронізація з Redmine не вдалася.';
      return reply.code(503).send({ code: 'SYNC_FAILED', message });
    }
  });

  app.get('/api/events', async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.write(`event: connected\ndata: ${JSON.stringify({ mode: config.mode })}\n\n`);
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 25_000);
    const cleanup = () => { clearInterval(heartbeat); remove(); };
    const remove = events.add((event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`), () => {
      cleanup(); response.end();
    });
    request.raw.on('close', cleanup);
  });

  const staticRoot = options.staticRoot ?? resolve(process.cwd(), 'dist/client');
  if (existsSync(resolve(staticRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: resolve(staticRoot), prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith('/api/')) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Маршрут не знайдено.' });
      return reply.sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => { worker.stop(); events.close(); connection.close(); });
  if (options.startWorker) worker.start();
  return app as unknown as WorkspaceApp;
}

function positiveId(value: string, code: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiFault(404, code, 'Ресурс не знайдено.');
  return id;
}

function isProjectBackgroundVersion(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPersonAvatarVersion(value: string): boolean {
  return isProjectBackgroundVersion(value);
}

function decodeProjectBackground(dataUrl: string): { contentType: ProjectBackgroundContentType; data: Buffer } | undefined {
  return decodeRasterImage(dataUrl, projectBackgroundLimit);
}

function decodeRasterImage(dataUrl: string, byteLimit: number): { contentType: PersonAvatarContentType; data: Buffer } | undefined {
  const maxEncodedLength = Math.ceil(byteLimit / 3) * 4;
  if (dataUrl.length > maxEncodedLength + 64) return undefined;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if (!match) return undefined;
  const contentType = match[1]!.toLowerCase() as PersonAvatarContentType;
  const base64 = match[2]!;
  if (base64.length > maxEncodedLength || base64.length % 4 !== 0) return undefined;
  const data = Buffer.from(base64, 'base64');
  if (data.length === 0 || data.length > byteLimit || data.toString('base64') !== base64) return undefined;
  const hasJpegSignature = contentType === 'image/jpeg' && data.length >= 3
    && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const hasPngSignature = contentType === 'image/png' && data.length >= 8
    && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const hasWebpSignature = contentType === 'image/webp' && data.length >= 12
    && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  if (!hasJpegSignature && !hasPngSignature && !hasWebpSignature) return undefined;
  return { contentType, data };
}

function assertLocalOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') throw new ApiFault(403, 'ORIGIN_REJECTED', 'Запит з іншого сайту заборонено.');
  if (origin === undefined) return;
  let parsed: URL;
  try { parsed = new URL(origin); }
  catch { throw new ApiFault(403, 'ORIGIN_REJECTED', 'Запит з іншого сайту заборонено.'); }
  const requestUrl = new URL(`${request.protocol}://${request.headers.host ?? request.hostname}`);
  if (parsed.protocol !== requestUrl.protocol || parsed.hostname !== requestUrl.hostname) {
    throw new ApiFault(403, 'ORIGIN_REJECTED', 'Запит з іншого сайту заборонено.');
  }
  if (parsed.port && parsed.port !== requestUrl.port && parsed.port !== '5173') {
    throw new ApiFault(403, 'ORIGIN_REJECTED', 'Запит з іншого порту заборонено.');
  }
}

function requestLogSafe(_error: unknown): void {
  // Deliberately do not log raw errors: third-party errors can carry URLs, headers, or remote payloads.
}

function realOperationRetryable(record: OperationRecord): boolean {
  return record.context?.realWrite === true
    && ['failed', 'blocked'].includes(record.operation.status)
    && record.operation.errorCode !== 'OUTCOME_UNKNOWN'
    && record.context.outcomeUnknown !== true
    && typeof record.context.inFlightStep !== 'string'
    && !['UNSUPPORTED_CAPABILITY', 'LABEL_UNAVAILABLE', 'LABELS_UNAVAILABLE', 'STALE', 'REMOTE_STATE_MISMATCH', 'USE_FINISH_RELEASE'].includes(record.operation.errorCode ?? '');
}
