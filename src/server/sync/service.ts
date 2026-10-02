import type { AppConfig } from '../config.js';
import type { Issue, Notification, Operation, OperationStep, Person, Status, Version } from '../../shared/types.js';
import { RedmineAdapter, type RedmineSnapshot } from '../redmine/adapter.js';
import { RedmineConfigError, RedmineRequestError } from '../redmine/transport.js';
import { WorkspaceStore } from '../db/store.js';

export interface SyncResult { syncedAt: string; issuesUpdated: number; notificationsAdded: number; warnings: string[] }
export interface EventHub { publish(event: string, data?: unknown): void }

export class SyncService {
  private activeSync?: Promise<SyncResult>;
  private connected = false;
  private lastError?: string;
  private lastSnapshot?: RedmineSnapshot;

  constructor(private readonly config: AppConfig, readonly store: WorkspaceStore, private readonly adapter?: RedmineAdapter,
    private readonly events?: EventHub) {}

  get isConnected(): boolean { return this.config.mode === 'demo' || this.connected; }
  get connectionError(): string | undefined { return this.lastError; }

  async bootstrapRead(): Promise<void> {
    if (this.config.mode === 'redmine' && !this.connected) await this.sync().catch(() => undefined);
  }

  async sync(): Promise<SyncResult> {
    if (this.activeSync) return this.activeSync;
    this.activeSync = this.runSync();
    try { return await this.activeSync; }
    finally { this.activeSync = undefined; }
  }

  private async runSync(): Promise<SyncResult> {
    if (this.config.mode === 'demo') {
      await this.store.initializeDemo();
      return { syncedAt: new Date().toISOString(), issuesUpdated: 0, notificationsAdded: 0, warnings: [] };
    }
    if (!this.adapter) {
      const message = this.config.configurationError ?? 'Додайте REDMINE_API_TOKEN у .env, щоб підключити Redmine.';
      this.connected = false;
      this.lastError = message;
      throw new RedmineConfigError(message);
    }

    try {
      const syncStartedAt = new Date().toISOString();
      const remoteMe = await this.adapter.currentUser();
      // Scope persisted Redmine data by both instance and current user, never by token value.
      const baseScope = this.config.scope;
      this.store.adoptInitialSettingsIntoUserScope(`${baseScope}:user:${remoteMe.id}`, baseScope);
      const initialCursor = await this.store.getCursor('baseline');
      const lastFullSync = await this.store.getCursor('full-sync');
      const fullSync = !lastFullSync || Date.now() - Date.parse(lastFullSync) > 6 * 60 * 60_000;
      const since = !fullSync && initialCursor ? new Date(Date.parse(initialCursor) - 5 * 60_000).toISOString() : undefined;
      const snapshot = await this.adapter.snapshot(since, remoteMe);
      this.lastSnapshot = snapshot;
      const previousIssues = new Map((await this.store.getIssues()).map(issue => [issue.id, issue]));
      for (const project of snapshot.projects) await this.store.saveProject(project);
      for (const version of snapshot.versions) await this.store.saveVersion(version);
      await this.store.removeProjectsExcept(snapshot.projects.map(project => project.id));
      await this.store.setValue('me', snapshot.me);
      const oldPeople = await this.store.getValue<Person[]>('people') ?? [];
      const people = new Map<number, Person>(oldPeople.map(person => [person.id, person]));
      for (const person of snapshot.people) people.set(person.id, person);
      await this.store.setValue('people', [...people.values()]);
      await this.store.setValue('statuses', snapshot.statuses);
      await this.store.setValue('priorities', snapshot.priorities);
      const previousProjectMembers = await this.store.getValue<Record<string, number[]>>('projectMembers') ?? {};
      const allOldIssues = await this.store.getIssues();
      const mergedProjectMembers: Record<string, Set<number>> = {};
      for (const project of snapshot.projects) mergedProjectMembers[String(project.id)] = new Set(snapshot.projectMembers[String(project.id)] ?? []);
      for (const issue of [...allOldIssues, ...snapshot.issues]) {
        if (!mergedProjectMembers[String(issue.projectId)] && previousProjectMembers[String(issue.projectId)]) continue;
        const members = mergedProjectMembers[String(issue.projectId)] ?? new Set<number>();
        members.add(issue.authorId);
        if (issue.assignedToId) members.add(issue.assignedToId);
        for (const watcherId of issue.watcherIds) members.add(watcherId);
        mergedProjectMembers[String(issue.projectId)] = members;
      }
      const projectMembers = Object.fromEntries(Object.entries(mergedProjectMembers).map(([projectId, ids]) => [projectId, [...ids]]));
      await this.store.setValue('projectMembers', projectMembers);
      const previousMembershipIds = await this.store.getValue<Record<string, number[]>>('projectMembershipIds') ?? {};
      const previousMembershipRoles = await this.store.getValue<Record<string, Record<string, { id: number; name: string }[]>>>('projectMembershipRoles') ?? {};
      const currentProjectIds = new Set(snapshot.projects.map(project => String(project.id)));
      const membershipIds: Record<string, number[]> = {};
      const membershipRoles: Record<string, Record<string, { id: number; name: string }[]>> = {};
      for (const projectId of currentProjectIds) {
        const currentIds = snapshot.projectMembershipIds?.[projectId];
        const currentRoles = snapshot.projectMembershipRoles?.[projectId];
        if (currentIds !== undefined) membershipIds[projectId] = currentIds;
        else if (previousMembershipIds[projectId] !== undefined) membershipIds[projectId] = previousMembershipIds[projectId]!;
        if (currentRoles !== undefined) membershipRoles[projectId] = currentRoles;
        else if (previousMembershipRoles[projectId] !== undefined) membershipRoles[projectId] = previousMembershipRoles[projectId]!;
      }
      await this.store.setValue('projectMembershipIds', membershipIds);
      await this.store.setValue('projectMembershipRoles', membershipRoles);
      const previousCapabilities = await this.store.getValue<{ branchFieldId?: number; labelsFieldId?: number; warnings?: string[] }>('capabilities');
      await this.store.setValue('capabilities', { canWrite: false,
        branchFieldId: snapshot.branchFieldId ?? previousCapabilities?.branchFieldId,
        labelsFieldId: snapshot.labelsFieldId ?? previousCapabilities?.labelsFieldId, warnings: snapshot.warnings });
      const settings = await this.store.getSettings();
      const newSubscriptions = { ...settings.subscriptions };
      for (const project of snapshot.projects) newSubscriptions[String(project.id)] ??= { enabled: true, events: ['comment'] };
      await this.store.setSettings({ ...settings, subscriptions: newSubscriptions });
      let notificationsAdded = 0;
      const ciTransitions = new Set<number>();
      const automationEnabled = (await this.store.getSettings()).automationEnabled;
      for (const issue of snapshot.issues) {
        const previous = previousIssues.get(issue.id);
        await this.store.saveIssue({ ...issue, developerId: previous?.developerId, qaId: previous?.qaId });
      }
      for (const item of snapshot.journals) {
        await this.store.saveJournal(item.issueId, item.journal);
        const sourceEventId = `journal:${item.journal.id}`;
        const wasSeen = await this.store.hasSeenSourceEvent(sourceEventId);
        if (!initialCursor) {
          await this.store.markSourceEventSeen(sourceEventId);
          continue; // The first sync is a quiet historical baseline.
        }
        const added = await this.processJournal(item.issueId, item.journal, { ...snapshot, people: [...people.values()] });
        if (added) notificationsAdded++;
        const issue = snapshot.issues.find(candidate => candidate.id === item.issueId);
        if (!wasSeen && automationEnabled && issue && issue.labels.includes('Build: Failed')
          && snapshot.statuses.find(status => status.key === 'review')?.id === issue.statusId
          && hasCiFailureTransition(item.journal.changes)) {
          await this.recordBlockedAutomation(issue, `journal-${item.journal.id}`);
          ciTransitions.add(issue.id);
        }
      }
      // A snapshot label change is useful for the automation, but cannot issue a write in Redmine mode.
      if (initialCursor && automationEnabled) {
        for (const issue of snapshot.issues) {
          const previous = previousIssues.get(issue.id);
          if (!ciTransitions.has(issue.id) && previous && previous.statusId === this.statusId(snapshot.statuses, 'review')
            && previous.labels.includes('Build: Running') && issue.labels.includes('Build: Failed')
            && issue.statusId === this.statusId(snapshot.statuses, 'review')) {
            await this.recordBlockedAutomation(issue, `snapshot-${issue.updatedOn.replace(/[^0-9]/g, '')}`);
          }
        }
      }
      const syncedAt = new Date().toISOString();
      if (fullSync) await this.store.setCursor('full-sync', syncStartedAt);
      await this.store.setCursor('baseline', syncStartedAt);
      this.connected = true;
      this.lastError = undefined;
      this.events?.publish('sync', { syncedAt, issuesUpdated: snapshot.issues.length, notificationsAdded });
      return { syncedAt, issuesUpdated: snapshot.issues.length, notificationsAdded, warnings: snapshot.warnings };
    } catch (error) {
      this.connected = false;
      this.lastError = safeErrorMessage(error);
      throw error;
    }
  }

  get snapshot(): RedmineSnapshot | undefined { return this.lastSnapshot; }

  private async processJournal(issueId: number, journal: { id: number; user: Person; notes: string; changes: { field: string; oldValue?: string; newValue?: string }[]; createdOn: string }, snapshot: RedmineSnapshot): Promise<boolean> {
    const key = `journal:${journal.id}`;
    const actor = journal.user;
    const me = snapshot.me;
    const issue = (await this.store.getIssue(issueId));
    const project = snapshot.projects.find(item => item.id === issue?.projectId);
    const isSelf = actor.id === me.id;
    const notes = journal.notes.trim();
    const changes = journal.changes;
    const kinds = new Set<string>();
    if (notes) kinds.add('comment');
    for (const change of changes) {
      if (/status/i.test(change.field)) kinds.add('status');
      else if (/assigned_to|assignee/i.test(change.field)) kinds.add('assignee');
      else if (/label|tag/i.test(change.field)) kinds.add('labels');
      else kinds.add('field');
    }
    const kind = kinds.values().next().value as string | undefined;
    const assignedToMe = issue?.assignedToId === me.id || changes.some(change => /assigned_to|assignee/i.test(change.field)
      && (change.newValue === String(me.id) || change.oldValue === String(me.id)));
    const settings = await this.store.getSettings();
    const subscription = project ? settings.subscriptions[String(project.id)] : undefined;
    const subscribed = Boolean(subscription?.enabled && [...kinds].some(event => subscription.events.includes(event)));
    const shouldNotify = !isSelf && kind && (subscribed || assignedToMe);
    if (!shouldNotify || !issue || !project) return this.store.commitSourceEvent(key);
    const actorPerson = snapshot.people.find(person => person.id === actor.id) ?? actor;
    const text = notes || changes.map(change => `${change.field}: ${change.oldValue ?? '—'} → ${change.newValue ?? '—'}`).join('; ');
    const item: Notification = { id: key, projectId: project.id, issueId, journalId: journal.id, actor: actorPerson,
      kind: kind!, text, createdOn: journal.createdOn };
    return this.store.commitSourceEvent(key, item);
  }

  private statusId(statuses: Status[], key: Status['key']): number | undefined { return statuses.find(status => status.key === key)?.id; }

  private async recordBlockedAutomation(issue: Issue, triggerId: string): Promise<void> {
    const id = `blocked-ci-${issue.id}-${triggerId.replace(/[^a-zA-Z0-9-]/g, '')}`;
    if (await this.store.getOperationRecord(id)) return;
    const steps: OperationStep[] = [
      { name: 'Виявлено Build: Running → Build: Failed у Review', status: 'done' },
      { name: 'Повернути задачу в To Do і призначити розробника', status: 'blocked', error: 'Тимчасове обмеження розробки блокує записи в реальний Redmine.' },
    ];
    const operation: Operation = { id, type: 'runAutomation', issueId: issue.id, status: 'blocked', steps,
      createdOn: new Date().toISOString(), error: 'Автоматизацію зафіксовано, але тимчасове обмеження розробки блокує запис у Redmine.', errorCode: 'READ_ONLY' };
    await this.store.saveOperationRecord({ operation, context: { triggerId } });
  }
}

export class BackgroundWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private failures = 0;
  constructor(private readonly syncService: SyncService, private readonly store: WorkspaceStore,
    private readonly intervalSeconds: () => Promise<number>, private readonly fallbackIntervalSeconds = 30,
    private readonly afterSync: () => Promise<void> = async () => undefined) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.run();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
  private async run(): Promise<void> {
    if (this.stopped) return;
    try { await this.syncService.sync(); await this.afterSync(); this.failures = 0; }
    catch { this.failures = Math.min(8, this.failures + 1); /* sanitized error is exposed via /api/bootstrap */ }
    const configuredInterval = await this.intervalSeconds().catch(() => this.fallbackIntervalSeconds);
    const interval = Math.min(15 * 60, configuredInterval * (this.failures ? 2 ** this.failures : 1));
    if (!this.stopped) this.timer = setTimeout(() => { void this.run(); }, interval * 1000);
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof RedmineRequestError || error instanceof RedmineConfigError) return error.message;
  return 'Синхронізація з Redmine не вдалася.';
}

function hasCiFailureTransition(changes: { field: string; oldValue?: string; newValue?: string }[]): boolean {
  const labels = (value: string | undefined) => (value ?? '').split(/[\n,;]+/).map(item => item.trim());
  return changes.some(change => {
    const oldLabels = labels(change.oldValue);
    const newLabels = labels(change.newValue);
    const isLabelField = /label|tag/i.test(change.field) || oldLabels.some(label => label.startsWith('CI:')) || newLabels.some(label => label.startsWith('CI:'));
    return isLabelField && oldLabels.includes('Build: Running') && newLabels.includes('Build: Failed');
  });
}
