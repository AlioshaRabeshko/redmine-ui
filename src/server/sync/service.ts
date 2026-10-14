import { createHash } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { ActivityKind, Issue, LabelOption, Notification, Operation, OperationStep, Person, Status, Version } from '../../shared/types.js';
import { RedmineAdapter, type RedmineSnapshot } from '../redmine/adapter.js';
import { RedmineConfigError, RedmineRequestError } from '../redmine/transport.js';
import { WorkspaceStore, type OperationRecord } from '../db/store.js';
import type { Command } from '../../shared/types.js';
import { activityKindsForJournal, issueCreatedSubscriptionCursorKey, resolveNotificationEligibility } from '../notifications.js';

export interface SyncResult { syncedAt: string; issuesUpdated: number; notificationsAdded: number; warnings: string[] }
export interface EventHub { publish(event: string, data?: unknown): void }
const deployReadRevision = 1;

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
      const storedFirstBaseline = await this.store.getCursor('first-baseline');
      const firstBaseline = storedFirstBaseline ?? initialCursor;
      const lastFullSync = await this.store.getCursor('full-sync');
      const fullSync = !lastFullSync || Date.now() - Date.parse(lastFullSync) > 6 * 60 * 60_000;
      const storedDeployRevision = await this.store.getValue<number>('deployReadRevision') ?? 0;
      const refreshClosedDeploy = storedDeployRevision < deployReadRevision;
      const oldLabelOptions = await this.store.getValue<Record<string, LabelOption[]>>('labelOptions') ?? {};
      const since = !fullSync && initialCursor ? new Date(Date.parse(initialCursor) - 5 * 60_000).toISOString() : undefined;
      const snapshot = await this.adapter.snapshot(since, remoteMe, Boolean(initialCursor), refreshClosedDeploy, oldLabelOptions);
      this.lastSnapshot = snapshot;
      const previousIssues = new Map((await this.store.getIssues()).map(issue => [issue.id, issue]));
      // The catalog can contain rows from a sync that failed halfway through. Only a scope
      // recorded together with the last successful sync is allowed to emit creation events.
      const previousProjectIds = new Set(await this.store.getValue<number[]>('successfulProjectIds') ?? []);
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
        if (issue.assignedToId && issue.assignedToType !== 'group') members.add(issue.assignedToId);
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
      await this.store.setValue('projectGroupIds', snapshot.projectGroupIds ?? {});
      await this.store.setValue('projectGroups', snapshot.projectGroups ?? {});
      const labelOptions = mergeCatalogByProject(oldLabelOptions, snapshot.labelOptions ?? {});
      await this.store.setValue('labelOptions', labelOptions);
      const previousCapabilities = await this.store.getValue<{ branchFieldId?: number; labelsFieldId?: number; primaryAssigneeFieldIds?: Record<string, number>; textFormat?: string; warnings?: string[] }>('capabilities');
      await this.store.setValue('capabilities', { canWrite: this.config.writeEnabled,
        // Journal operations stay fail-closed until this API identity's permission is verified.
        // Never carry prior-user/instance capability bits through a new successful sync.
        journalEditing: false, journalDeleting: false, journalLikes: false,
        branchFieldId: snapshot.branchFieldId ?? previousCapabilities?.branchFieldId,
        labelsFieldId: snapshot.labelsFieldId ?? previousCapabilities?.labelsFieldId,
        primaryAssigneeFieldIds: snapshot.primaryAssigneeFieldIds ?? {}, textFormat: snapshot.textFormat,
        warnings: snapshot.warnings });
      const settings = await this.store.ensureSubscriptionDefaults(snapshot.projects.map(project => project.id));
      const quietIssueCreatedBaseline = new Set<number>();
      for (const project of snapshot.projects) {
        const subscription = settings.subscriptions[String(project.id)];
        if (!subscription?.enabled || !subscription.events.includes('issue_created')) continue;
        const key = issueCreatedSubscriptionCursorKey(project.id);
        const cutoff = await this.store.getCursor(key);
        if (!cutoff) {
          const inserted = await this.store.setCursorIfAbsent(key, syncStartedAt);
          if (inserted) quietIssueCreatedBaseline.add(project.id);
        } else if (!Number.isFinite(Date.parse(cutoff))) {
          // Replace only the invalid value we observed; a concurrent opt-in may have installed
          // a valid cursor after this read and must win.
          if (await this.store.replaceCursorIfValue(key, cutoff, syncStartedAt)) quietIssueCreatedBaseline.add(project.id);
        }
      }
      let notificationsAdded = 0;
      const ciTransitions = new Set<number>();
      const automationEnabled = settings.automationEnabled;
      const refreshedIds = new Set(snapshot.issues.map(issue => issue.id));
      for (const issue of previousIssues.values()) {
        if (refreshedIds.has(issue.id)) continue;
        const labels = remapCachedLabelsByCatalog(issue.labels, labelOptions[String(issue.projectId)] ?? []);
        if (labels.some((label, index) => label !== issue.labels[index]) || labels.length !== issue.labels.length) {
          await this.store.saveIssue({ ...issue, labels });
        }
      }
      for (const issue of snapshot.issues) {
        const previous = previousIssues.get(issue.id);
        await this.store.saveIssue({ ...issue, qaId: previous?.qaId });
      }
      // Creation events are scoped to projects that were already in the last successful
      // snapshot. A newly accessible project starts with a quiet baseline; otherwise old issues
      // first discovered during a full refresh could look like new events.
      for (const issue of snapshot.issues) {
        const sourceEventId = `issue-created:${issue.id}`;
        if (await this.store.hasSeenSourceEvent(sourceEventId)) continue;
        const createdAt = Date.parse(issue.createdOn);
        const previousSyncAt = initialCursor ? Date.parse(initialCursor) : Number.NaN;
        // The final subscription and opt-in cursor check happens transactionally with inserting
        // the event, so a concurrent settings PATCH takes effect before or after this commit.
        // This outer check only rules out cache discovery and scopes not in the last success.
        if (!initialCursor || !previousProjectIds.has(issue.projectId) || previousIssues.has(issue.id) || !Number.isFinite(createdAt)
          || !Number.isFinite(previousSyncAt) || quietIssueCreatedBaseline.has(issue.projectId)) {
          await this.store.markSourceEventSeen(sourceEventId);
          continue;
        }
        const project = snapshot.projects.find(item => item.id === issue.projectId);
        const actor = snapshot.people.find(person => person.id === issue.authorId);
        const notification: Notification | undefined = project && actor && actor.id !== snapshot.me.id ? {
          id: sourceEventId, projectId: project.id, issueId: issue.id, actor, issueSubject: issue.subject,
          kind: 'issue_created', text: issue.subject, createdOn: issue.createdOn, eventKinds: [],
        } : undefined;
        if (await this.store.commitIssueCreatedEvent(sourceEventId, issue.projectId, issue.createdOn, initialCursor, notification)) notificationsAdded++;
      }
      for (const item of snapshot.journals) {
        await this.store.saveJournal(item.issueId, item.journal);
        const sourceEventId = `journal:${item.journal.id}`;
        const wasSeen = await this.store.hasSeenSourceEvent(sourceEventId);
        if (!initialCursor || (firstBaseline && Date.parse(item.journal.createdOn) < Date.parse(firstBaseline))) {
          await this.store.markSourceEventSeen(sourceEventId);
          continue; // The first sync is a quiet historical baseline.
        }
        const added = await this.processJournal(item.issueId, item.journal, { ...snapshot, people: [...people.values()] });
        if (added) notificationsAdded++;
        const issue = snapshot.issues.find(candidate => candidate.id === item.issueId);
        if (!wasSeen && automationEnabled && issue && issue.labels.includes(this.config.ciFailedLabel)
          && snapshot.statuses.find(status => status.key === 'review')?.id === issue.statusId
          && hasCiFailureTransition(item.journal.changes, this.config.ciInProgressLabel, this.config.ciFailedLabel)) {
          await this.recordAutomation(issue, `journal-${item.journal.id}`, previousIssues.get(issue.id)?.primaryAssigneeId);
          ciTransitions.add(issue.id);
        }
      }
      // A snapshot label change is useful for the automation, but cannot issue a write in Redmine mode.
      if (initialCursor && automationEnabled) {
        for (const issue of snapshot.issues) {
          const previous = previousIssues.get(issue.id);
          if (!ciTransitions.has(issue.id) && previous && previous.statusId === this.statusId(snapshot.statuses, 'review')
            && previous.labels.includes(this.config.ciInProgressLabel) && issue.labels.includes(this.config.ciFailedLabel)
            && issue.statusId === this.statusId(snapshot.statuses, 'review')) {
            await this.recordAutomation(issue, `snapshot-${issue.updatedOn.replace(/[^0-9]/g, '')}`, previous?.primaryAssigneeId);
          }
        }
      }
      const syncedAt = new Date().toISOString();
      if (!storedFirstBaseline) await this.store.setCursor('first-baseline', firstBaseline ?? syncStartedAt);
      if (fullSync) await this.store.setCursor('full-sync', syncStartedAt);
      if (refreshClosedDeploy) await this.store.setValue('deployReadRevision', deployReadRevision);
      await this.store.commitSuccessfulSync(snapshot.projects.map(project => project.id), syncStartedAt);
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
    const kinds = activityKindsForJournal(notes, changes);
    const assignmentIsUser = issue?.assignedToType !== 'group';
    const assignedToMe = assignmentIsUser && (issue?.assignedToId === me.id || changes.some(change => /assigned_to|assignee/i.test(change.field)
      && (change.newValue === String(me.id) || change.oldValue === String(me.id))));
    const settings = await this.store.getSettings();
    const subscription = project ? settings.subscriptions[String(project.id)] : undefined;
    const { eligible, visibleKinds } = resolveNotificationEligibility(kinds, subscription, assignedToMe);
    const shouldNotify = !isSelf && kinds.length > 0 && eligible;
    if (!shouldNotify || !issue || !project) return this.store.commitSourceEvent(key);
    // Assignment affects issue eligibility only. It never bypasses the selected event mask.
    if (!visibleKinds.length) return this.store.commitSourceEvent(key);
    const actorPerson = snapshot.people.find(person => person.id === actor.id) ?? actor;
    const kind = preferredActivityKind(visibleKinds);
    const text = visibleKinds.includes('comment') ? notes : '';
    const item: Notification = { id: key, projectId: project.id, issueId, journalId: journal.id, actor: actorPerson,
      issueSubject: issue.subject, kind, text, createdOn: journal.createdOn, eventKinds: kinds,
      notes: notes || undefined, changes: [...changes] };
    return this.store.commitSourceEvent(key, item);
  }

  private statusId(statuses: Status[], key: Status['key']): number | undefined { return statuses.find(status => status.key === key)?.id; }

  private async recordAutomation(issue: Issue, triggerId: string, primaryAssigneeId?: number): Promise<void> {
    const enabled = this.config.writeEnabled && Boolean(this.adapter);
    const id = `${enabled ? 'ci' : 'blocked-ci'}-${issue.id}-${triggerId.replace(/[^a-zA-Z0-9-]/g, '')}`;
    if (await this.store.getOperationRecord(id)) return;
    const command: Command = { type: 'runAutomation', issueId: issue.id, operationId: id, input: {} };
    const signature = createHash('sha256').update(JSON.stringify(sortObject({ type: command.type, issueId: command.issueId, input: command.input }))).digest('hex');
    const steps: OperationStep[] = [
      { name: 'Виявлено налаштовані CI labels у Review', status: 'done' },
      ...(enabled ? [{ name: 'Повернути задачу в To Do розробнику', status: 'pending' as const }]
        : [{ name: 'Повернути задачу в To Do розробнику', status: 'blocked' as const, error: 'Для запису потрібне REDMINE_WRITE_ENABLED=true на backend.' }]),
    ];
    const operation: Operation = { id, type: 'runAutomation', issueId: issue.id, status: enabled ? 'pending' : 'blocked', steps,
      createdOn: new Date().toISOString(), ...(!enabled ? { error: 'Автоматизацію зафіксовано, але запис у Redmine вимкнений.', errorCode: 'READ_ONLY' } : {}) };
    const trigger = { triggerId, expectedUpdatedOn: issue.updatedOn, reviewStatusId: issue.statusId,
      ...(primaryAssigneeId ? { primaryAssigneeId } : {}) };
    const record: OperationRecord = { operation, context: enabled
      ? { realWrite: true, commandSignature: signature, originalCommand: command, automationTrigger: trigger }
      : { triggerId, automationTrigger: trigger } };
    await this.store.saveOperationRecord(record);
  }
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortObject(item)]));
  return value;
}

function mergeCatalogByProject(previous: Record<string, LabelOption[]>, incoming: Record<string, LabelOption[]>): Record<string, LabelOption[]> {
  const result = { ...previous };
  for (const [projectId, fresh] of Object.entries(incoming)) {
    if (!fresh.length) continue; // Preserve a previously readable dictionary after a restricted/empty metadata response.
    const old = new Map((previous[projectId] ?? []).map(option => [`${option.fieldId ?? ''}:${option.id}`, option]));
    result[projectId] = fresh.map(option => {
      const cached = old.get(`${option.fieldId ?? ''}:${option.id}`);
      return cached && cached.name !== cached.id && option.name === option.id ? cached : option;
    });
  }
  return result;
}

function remapCachedLabelsByCatalog(labels: string[], catalog: LabelOption[]): string[] {
  const namesById = new Map<string, Set<string>>();
  for (const option of catalog) {
    const names = namesById.get(option.id) ?? new Set<string>();
    names.add(option.name);
    namesById.set(option.id, names);
  }
  return labels.map(label => {
    if (!/^\d+$/.test(label)) return label;
    const names = namesById.get(label);
    return names?.size === 1 ? [...names][0]! : label;
  });
}

export class BackgroundWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private failures = 0;
  constructor(private readonly syncService: SyncService, private readonly store: WorkspaceStore,
    private readonly intervalSeconds: () => Promise<number>, private readonly fallbackIntervalSeconds = 10,
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

function preferredActivityKind(kinds: ActivityKind[]): ActivityKind {
  for (const kind of ['comment', 'status', 'assignee', 'labels', 'field'] as const) {
    if (kinds.includes(kind)) return kind;
  }
  return 'field';
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof RedmineRequestError || error instanceof RedmineConfigError) return error.message;
  return 'Синхронізація з Redmine не вдалася.';
}

function hasCiFailureTransition(changes: { field: string; oldValue?: string; newValue?: string }[],
  inProgressLabel: string, failedLabel: string): boolean {
  const labels = (value: string | undefined) => (value ?? '').split(/[\n,;]+/).map(item => item.trim());
  return changes.some(change => {
    const oldLabels = labels(change.oldValue);
    const newLabels = labels(change.newValue);
    const isLabelField = /label|tag/i.test(change.field) || oldLabels.includes(inProgressLabel)
      || newLabels.includes(inProgressLabel) || oldLabels.includes(failedLabel) || newLabels.includes(failedLabel);
    return isLabelField && oldLabels.includes(inProgressLabel) && newLabels.includes(failedLabel);
  });
}
