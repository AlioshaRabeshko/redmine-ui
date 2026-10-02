import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Bootstrap, BoardData, Command, IssueDetail, PeopleField, Person, PersonRole, RedmineRole, ReleaseDetail } from '../shared/types.js';
import { createConfig, type AppConfig, type ConfigInput } from './config.js';
import { CommandService, ApiFault } from './commands/service.js';
import { openDatabase } from './db/connection.js';
import { applyMigrations } from './db/migrate.js';
import { WorkspaceStore } from './db/store.js';
import { RedmineAdapter } from './redmine/adapter.js';
import type { FetchLike } from './redmine/transport.js';
import { BackgroundWorker, SyncService, type EventHub } from './sync/service.js';

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
  type: z.enum(['createIssue', 'updateIssue', 'moveIssue', 'handoffToQA', 'returnToDeveloper', 'comment', 'generateBranch',
    'createRelease', 'updateRelease', 'assignRelease', 'finishRelease', 'runAutomation']),
  issueId: z.number().int().positive().optional(),
  projectId: z.number().int().positive().optional(),
  versionId: z.number().int().positive().optional(),
  operationId: z.string().min(1).max(200).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
});

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
  const commands = new CommandService(config, store, events);
  const worker = new BackgroundWorker(sync, store, async () => (await store.getSettings()).pollIntervalSeconds,
    config.pollIntervalSeconds, async () => { await commands.processPendingDemoAutomations(); });
  const runtime: BackendRuntime = { config, store, sync, commands, worker,
    stop: () => { worker.stop(); events.close(); }, close: connection.close };
  const app = Fastify({ logger: false, trustProxy: false });
  Object.assign(app, { backend: runtime });

  app.addHook('preHandler', async (request) => assertLocalOrigin(request));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiFault) return reply.code(error.statusCode).send({ code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) });
    const validation = error as Error & { validation?: unknown; statusCode?: number };
    if (validation.validation) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Перевірте формат запиту.' });
    if (error instanceof z.ZodError) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Перевірте формат запиту.' });
    if (validation.statusCode === 400) return reply.code(400).send({ code: 'INVALID_JSON', message: 'Тіло запиту має некоректний JSON.' });
    requestLogSafe(error);
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Внутрішня помилка сервера.' });
  });

  app.get('/api/health', async () => ({ ok: true, mode: config.mode, connected: sync.isConnected,
    readOnly: config.mode === 'redmine', ...(sync.connectionError ? { connectionError: sync.connectionError } : {}) }));

  app.get('/api/bootstrap', async (): Promise<Bootstrap> => {
    await sync.bootstrapRead();
    const [projects, statuses, priorities, settings, me, capabilities] = await Promise.all([
      store.getProjects(), store.getValue<Bootstrap['statuses']>('statuses'), store.getValue<Bootstrap['priorities']>('priorities'),
      store.getSettings(), store.getValue<Person>('me'), store.getValue<Bootstrap['capabilities']>('capabilities'),
    ]);
    const warnings = [...(capabilities?.warnings ?? [])];
    if (config.mode === 'redmine') {
      warnings.unshift('Тимчасове обмеження розробки: редагування реального Redmine наразі вимкнено.');
      if (sync.connectionError && !warnings.includes(sync.connectionError)) warnings.push(sync.connectionError);
    }
    return {
      mode: config.mode, readOnly: config.mode === 'redmine', connected: sync.isConnected,
      redmineUrl: config.redmineUrl, me: me ?? { id: 0, name: 'Підключення Redmine' }, projects,
      statuses: statuses ?? [], priorities: priorities ?? [], settings,
      capabilities: { canWrite: config.mode === 'demo', ...(capabilities?.branchFieldId ? { branchFieldId: capabilities.branchFieldId } : {}),
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
      .map(person => {
        if (!membershipIds.has(person.id)) return person;
        const redmineRoles = membershipRoles[String(person.id)] ?? [];
        const override = settings.personRoleOverrides[String(projectId)]?.[String(person.id)];
        const roles = override ?? personRolesFromRedmine(redmineRoles);
        return { ...person, ...(redmineRoles.length ? { redmineRoles } : {}), ...(roles.length ? { roles } : override ? { roles: override } : {}) };
      });
    const peopleRecommendations: Partial<Record<PeopleField, number[]>> = {
      assignee: await store.getPeopleRecommendations(projectId, 'assignee'),
      developer: await store.getPeopleRecommendations(projectId, 'developer'),
      qa: await store.getPeopleRecommendations(projectId, 'qa'),
    };
    const syncedAt = await store.getCursor('baseline');
    return { issues, versions, members, labels: [...new Set(issues.flatMap(issue => issue.labels))].sort((a, b) => a.localeCompare(b)),
      ...(project.trackers !== undefined ? { trackers: project.trackers } : {}),
      total: issues.length, peopleRecommendations, ...(syncedAt ? { syncedAt } : {}) };
  });

  app.get<{ Params: { id: string } }>('/api/issues/:id', async (request): Promise<IssueDetail> => {
    await sync.bootstrapRead();
    const issueId = positiveId(request.params.id, 'ISSUE_NOT_FOUND');
    const issue = await store.getIssue(issueId);
    if (!issue) throw new ApiFault(404, 'ISSUE_NOT_FOUND', 'Задачу не знайдено.');
    const people = await store.getValue<Person[]>('people') ?? [];
    return { issue, journals: await store.getJournals(issueId), watchers: issue.watcherIds.map(id => people.find(person => person.id === id)).filter((person): person is Person => Boolean(person)) };
  });

  app.get<{ Params: { id: string } }>('/api/releases/:id', async (request): Promise<ReleaseDetail> => {
    await sync.bootstrapRead();
    const versionId = positiveId(request.params.id, 'VERSION_NOT_FOUND');
    const version = await store.getVersion(versionId);
    if (!version) throw new ApiFault(404, 'VERSION_NOT_FOUND', 'Реліз не знайдено.');
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

  app.get<{ Querystring: { archived?: string } }>('/api/notifications', async (request) => store.getNotifications(request.query.archived === 'true'));
  app.post('/api/notifications/read', async (request) => {
    const body = z.object({ ids: z.array(z.string().min(1).max(200)).max(500) }).parse(request.body);
    const updated = await store.markNotificationsRead([...new Set(body.ids)]);
    const unreadCount = (await store.getNotifications(false)).length;
    events.publish('notifications', { unreadCount });
    return { updated, unreadCount };
  });
  app.get('/api/operations', async () => (await store.getOperations()).filter(operation => operation.type !== 'saveIssueRoles'));
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

function personRolesFromRedmine(redmineRoles: RedmineRole[]): PersonRole[] {
  const roles = new Set<PersonRole>();
  for (const role of redmineRoles) {
    const name = role.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
    if (/(^|\W)qa(\W|$)|quality\s*assurance|\btest(?:er|ing)\b/.test(name)) roles.add('qa');
    if (/(^|\W)support(\W|$)|help\s*desk/.test(name)) roles.add('support');
    if (/(^|\W)developer(?:s)?(\W|$)|\bdevelopment\b/.test(name)) roles.add('developer');
  }
  const orderedRoles: PersonRole[] = ['qa', 'support', 'developer'];
  return orderedRoles.filter(role => roles.has(role));
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
