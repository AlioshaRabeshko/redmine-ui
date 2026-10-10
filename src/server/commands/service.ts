import { createHash, randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { AppSettings, Command, CommandResult, Issue, Journal, Operation, OperationStep, PeopleField, StatusKey, Version } from '../../shared/types.js';
import { branchForIssue, releaseReadiness } from '../../shared/domain.js';
import { WorkspaceStore, type OperationRecord } from '../db/store.js';
import { applySettingsPatch, parseSettings, parseSettingsPatch } from '../settings.js';
import type { EventHub } from '../sync/service.js';
import { ApiFault } from './errors.js';
import { RealCommandExecutor } from './real-executor.js';
import type { RedmineAdapter } from '../redmine/adapter.js';

export { ApiFault } from './errors.js';

const now = () => new Date().toISOString();
function numberField(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}
function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}
function readOnlyFault(): ApiFault {
  return new ApiFault(403, 'READ_ONLY', 'Запис у Redmine вимкнений. Для нього потрібно задати REDMINE_WRITE_ENABLED=true на backend.');
}

export class CommandService {
  private commandTail: Promise<void> = Promise.resolve();
  private readonly realExecutor?: RealCommandExecutor;

  constructor(private readonly config: AppConfig, readonly store: WorkspaceStore, private readonly events?: EventHub, adapter?: RedmineAdapter) {
    if (config.mode === 'redmine' && adapter) this.realExecutor = new RealCommandExecutor(config, adapter, store, events);
  }

  async execute(command: Command): Promise<CommandResult> {
    // Reject before queuing or inspecting mutation data. All demo writes are serialized to avoid ID and workflow races.
    if (this.config.mode === 'redmine' && !this.config.writeEnabled && command.type !== 'generateBranch') throw readOnlyFault();
    if (this.config.mode === 'redmine' && !this.realExecutor) throw new ApiFault(503, 'REDMINE_UNAVAILABLE',
      this.config.configurationError ?? 'З’єднання з Redmine недоступне; деморежим не використовується.');
    const previous = this.commandTail;
    let release!: () => void;
    this.commandTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await this.executeQueued(command); }
    finally { release(); }
  }

  private async executeQueued(command: Command): Promise<CommandResult> {
    if (this.config.mode === 'redmine' && this.config.writeEnabled) return this.realExecutor!.execute(command);
    if (this.config.mode === 'redmine' && command.type === 'generateBranch') return this.generateBranch(command);
    await this.store.initializeDemo();
    let effectiveCommand = command;
    if (command.operationId) {
      const existing = await this.store.getOperationRecord(command.operationId);
      if (existing && existing.operation.type !== command.type) throw new ApiFault(409, 'OPERATION_CONFLICT', 'Цей operationId уже використано для іншої команди.');
      if (existing) {
        const original = existing.context?.originalCommand as Command | undefined;
        if (original && isRetryEnvelope(command, original, existing.operation.issueId, existing.operation.versionId)) effectiveCommand = { ...original, operationId: command.operationId };
      }
      if (existing?.context?.commandSignature && existing.context.commandSignature !== commandSignature(effectiveCommand)) {
        throw new ApiFault(409, 'OPERATION_CONFLICT', 'Цей operationId уже використано з іншими даними.');
      }
      if (existing?.operation.status === 'done') return this.result(existing);
      if (existing && ['blocked', 'failed'].includes(existing.operation.status)) {
        existing.operation.status = 'running';
        delete existing.operation.error;
        delete existing.operation.errorCode;
        existing.operation.steps = existing.operation.steps.filter(step => step.status === 'done' || step.status === 'skipped');
        const { blockedDetails: _blockedDetails, ...context } = existing.context ?? {};
        existing.context = context;
        await this.store.saveOperationRecord(existing);
      }
    }
    command = effectiveCommand;
    if (command.type === 'generateBranch') return this.generateBranch(command);
    const record = await this.startOperation(command);
    try {
      switch (command.type) {
        case 'createIssue': await this.createIssue(record, command); break;
        case 'updateIssue': await this.updateIssue(record, command); break;
        case 'moveIssue': await this.moveIssue(record, command); break;
        case 'handoffToQA': await this.handoffToQA(record, command); break;
        case 'returnToDeveloper': await this.returnToDeveloper(record, command); break;
        case 'comment': await this.comment(record, command); break;
        case 'editJournal': await this.editJournal(record, command); break;
        case 'deleteJournal': await this.deleteJournal(record, command); break;
        case 'setJournalLike': await this.setJournalLike(record, command); break;
        case 'createRelease': await this.createRelease(record, command); break;
        case 'updateRelease': await this.updateRelease(record, command); break;
        case 'assignRelease': await this.assignRelease(record, command); break;
        case 'finishRelease': await this.finishRelease(record, command); break;
        case 'runAutomation': await this.runAutomation(record, command); break;
        default: throw new ApiFault(400, 'UNKNOWN_COMMAND', 'Невідома команда.');
      }
      return this.result(record);
    } catch (error) {
      record.operation.status = 'failed';
      record.operation.error = safeMessage(error);
      record.operation.errorCode = error instanceof ApiFault ? error.code : 'COMMAND_FAILED';
      await this.store.saveOperationRecord(record);
      if (error instanceof ApiFault && error.statusCode < 500) throw error;
      return this.result(record);
    }
  }

  async saveSettings(value: unknown): Promise<AppSettings> {
    let settings: AppSettings;
    try { settings = parseSettings(value); }
    catch { throw new ApiFault(400, 'INVALID_SETTINGS', 'Налаштування мають некоректний формат.'); }
    await this.store.setSettings(settings);
    this.events?.publish('settings', { updatedAt: now() });
    return settings;
  }

  async patchSettings(value: unknown): Promise<AppSettings> {
    let patch: ReturnType<typeof parseSettingsPatch>;
    try { patch = parseSettingsPatch(value); }
    catch { throw new ApiFault(400, 'INVALID_SETTINGS', 'Налаштування мають некоректний формат.'); }
    for (const [projectIdString, personId] of Object.entries(patch.projectQa ?? {})) {
      if (personId !== null) await this.assertProjectMember(Number(projectIdString), personId);
    }
    for (const [projectIdString, people] of Object.entries(patch.personRoleOverrides ?? {})) {
      if (!people) continue;
      const projectId = Number(projectIdString);
      for (const [personIdString, roles] of Object.entries(people)) {
        if (roles !== null) await this.assertProjectPerson(projectId, Number(personIdString));
      }
    }
    const settings = applySettingsPatch(await this.store.getSettings(), patch);
    await this.store.setSettings(settings);
    this.events?.publish('settings', { updatedAt: now() });
    return settings;
  }

  async recordPeopleSelection(selection: { projectId: number; personId: number; field: PeopleField; operationId: string }): Promise<{
    recorded: boolean; duplicate?: boolean; reason?: string;
  }> {
    await this.assertProjectMember(selection.projectId, selection.personId);
    const operationRecord = await this.store.getOperationRecord(selection.operationId);
    let manual = false;
    if (operationRecord) {
      if (operationRecord.operation.status !== 'done') {
        throw new ApiFault(409, 'PEOPLE_CHOICE_NOT_SUCCESSFUL', 'Вибір людини не збережено успішно.');
      }
      manual = isManualPeopleChoice(operationRecord, selection.field, selection.personId, selection.projectId);
    } else if (selection.field === 'qa') {
      const settings = await this.store.getSettings();
      manual = settings.projectQa[String(selection.projectId)] === selection.personId;
    }
    if (!manual) return { recorded: false, reason: 'not-a-successful-manual-choice' };

    const result = await this.store.recordPeopleSelection(selection);
    if (result === 'conflict') throw new ApiFault(409, 'PEOPLE_CHOICE_CONFLICT', 'Цей operationId уже використано для іншого вибору людини.');
    if (result === 'inserted') {
      this.events?.publish('peopleRecommendations', { projectId: selection.projectId });
      return { recorded: true };
    }
    return { recorded: false, duplicate: true };
  }

  private async assertProjectMember(projectId: number, personId: number): Promise<void> {
    if (!(await this.store.getProjects()).some(project => project.id === projectId)) {
      throw new ApiFault(404, 'PROJECT_NOT_FOUND', 'Проєкт не знайдено.');
    }
    if (!(await this.store.isProjectMember(projectId, personId))) {
      throw new ApiFault(400, 'PERSON_NOT_PROJECT_MEMBER', 'Людина не є учасником цього проєкту Redmine.');
    }
  }

  private async assertProjectPerson(projectId: number, personId: number): Promise<void> {
    if (!(await this.store.getProjects()).some(project => project.id === projectId)) {
      throw new ApiFault(404, 'PROJECT_NOT_FOUND', 'Проєкт не знайдено.');
    }
    const participants = await this.store.getValue<Record<string, number[]>>('projectMembers');
    if (!(participants?.[String(projectId)] ?? []).includes(personId)) {
      throw new ApiFault(400, 'PERSON_NOT_PROJECT_MEMBER', 'Людина не належить до людей цього проєкту.');
    }
  }

  async saveIssueRoles(issueId: number, input: { developerId?: number | null; qaId?: number | null }, operationId?: string): Promise<Issue> {
    const issue = await this.store.getIssue(issueId);
    if (!issue) throw new ApiFault(404, 'ISSUE_NOT_FOUND', 'Задачу не знайдено.');
    if (operationId) {
      const existing = await this.store.getOperationRecord(operationId);
      if (existing && existing.operation.type !== 'saveIssueRoles') throw new ApiFault(409, 'OPERATION_CONFLICT', 'Цей operationId уже використано для іншої команди.');
      if (existing?.operation.status === 'done') {
        const signature = createHash('sha256').update(JSON.stringify(sortObject(input))).digest('hex');
        if (existing.operation.issueId !== issueId || existing.context?.rolesSignature !== signature) {
          throw new ApiFault(409, 'OPERATION_CONFLICT', 'Цей operationId уже використано з іншими даними.');
        }
        return existing.issue ?? (await this.store.getIssue(issueId)) ?? issue;
      }
      if (existing) throw new ApiFault(409, 'OPERATION_CONFLICT', 'Цей operationId уже використано для невдалого збереження.');
    }
    if (input.developerId !== undefined && input.developerId !== null && !Number.isSafeInteger(input.developerId)) {
      throw new ApiFault(400, 'INVALID_ROLE', 'ID розробника має бути цілим числом.');
    }
    if (input.qaId !== undefined && input.qaId !== null && !Number.isSafeInteger(input.qaId)) {
      throw new ApiFault(400, 'INVALID_ROLE', 'ID QA має бути цілим числом.');
    }
    for (const personId of [input.developerId, input.qaId]) {
      if (personId !== undefined && personId !== null) await this.assertProjectMember(issue.projectId, personId);
    }
    await this.store.setIssueRoles(issueId, input.developerId, input.qaId);
    const updated = await this.store.getIssue(issueId);
    if (!updated) throw new ApiFault(404, 'ISSUE_NOT_FOUND', 'Задачу не знайдено.');
    if (operationId) {
      const manualRoleChoices: Record<string, number> = {};
      if (input.developerId) manualRoleChoices.developerId = input.developerId;
      if (input.qaId) manualRoleChoices.qaId = input.qaId;
      await this.store.saveOperationRecord({
        operation: { id: operationId, type: 'saveIssueRoles', issueId, status: 'done',
          steps: [{ name: 'Зберегти локальні ролі задачі', status: 'done' }], createdOn: now() },
        issue: updated, context: { manualRoleChoices,
          rolesSignature: createHash('sha256').update(JSON.stringify(sortObject(input))).digest('hex') },
      });
    }
    this.events?.publish('issue', { issueId });
    return updated;
  }

  private async startOperation(command: Command): Promise<OperationRecord> {
    if (command.operationId) {
      const existing = await this.store.getOperationRecord(command.operationId);
      if (existing) return existing;
    }
    const record: OperationRecord = {
      operation: { id: command.operationId ?? randomUUID(), type: command.type, status: 'running',
        ...(command.issueId ? { issueId: command.issueId } : {}), ...(command.versionId ? { versionId: command.versionId } : {}),
        steps: [], createdOn: now() },
      context: { commandSignature: commandSignature(command), originalCommand: structuredClone(command) },
    };
    await this.store.saveOperationRecord(record);
    return record;
  }

  private async generateBranch(command: Command): Promise<CommandResult> {
    const issue = await this.requireIssue(command.issueId);
    let branch: string;
    try { branch = branchForIssue(issue.id, issue.subject); }
    catch { throw new ApiFault(400, 'BRANCH_INVALID', 'Не вдалося сформувати branch для цієї задачі.'); }
    const record: OperationRecord = { operation: { id: command.operationId ?? randomUUID(), type: command.type,
      issueId: issue.id, status: 'done', steps: [{ name: 'Згенерувати branch', status: 'done' }], createdOn: now() },
      issue: { ...issue, branch }, context: { commandSignature: commandSignature(command) } };
    await this.store.saveOperationRecord(record);
    return this.result(record);
  }

  private async createIssue(record: OperationRecord, command: Command): Promise<void> {
    const input = command.input;
    const projectId = command.projectId ?? numberField(input, 'projectId');
    const project = projectId ? (await this.store.getProjects()).find(item => item.id === projectId) : undefined;
    if (!projectId || !project) throw new ApiFault(400, 'PROJECT_REQUIRED', 'Виберіть доступний проєкт.');
    const subject = stringField(input, 'subject')?.trim();
    if (!subject) throw new ApiFault(400, 'SUBJECT_REQUIRED', 'Вкажіть назву задачі.');
    const issues = await this.store.getIssues();
    const plannedId = typeof record.context?.createdIssueId === 'number' ? record.context.createdIssueId : Math.max(0, ...issues.map(issue => issue.id)) + 1;
    record.context = { ...(record.context ?? {}), createdIssueId: plannedId };
    await this.store.saveOperationRecord(record);
    const id = plannedId;
    const statuses = await this.getStatuses();
    const requestedStatus = numberField(input, 'statusId');
    const statusId = requestedStatus ?? statusByKey(statuses, 'todo')?.id ?? statuses[0]?.id;
    if (statusId === undefined || !statuses.some(status => status.id === statusId)) throw new ApiFault(400, 'STATUS_REQUIRED', 'У Redmine не налаштовано статус задачі.');
    const priorities = await this.store.getValue<{ id: number; rank: number }[]>('priorities') ?? [];
    const requestedPriority = numberField(input, 'priorityId');
    const priorityId = requestedPriority ?? [...priorities].sort((a, b) => b.rank - a.rank)[0]?.id ?? 1;
    if (priorities.length && !priorities.some(priority => priority.id === priorityId)) throw new ApiFault(400, 'PRIORITY_REQUIRED', 'Виберіть коректний пріоритет.');
    const issueTrackers = knownTrackers(await this.store.getIssues(projectId));
    const projectTrackers = new Map((project.trackers ?? []).map(tracker => [tracker.id, tracker.name]));
    const hasProjectTrackerMetadata = project.trackers !== undefined;
    const suppliedTrackerId = input.trackerId === undefined ? undefined : numberField(input, 'trackerId');
    if (input.trackerId !== undefined && (!suppliedTrackerId || suppliedTrackerId <= 0)) {
      throw new ApiFault(400, 'TRACKER_REQUIRED', 'Виберіть коректний тип задачі.');
    }
    if (suppliedTrackerId !== undefined && hasProjectTrackerMetadata && !projectTrackers.has(suppliedTrackerId)) {
      throw new ApiFault(400, 'TRACKER_REQUIRED', 'Виберіть тип задачі, доступний у цьому проєкті.');
    }
    const availableTrackerIds = hasProjectTrackerMetadata ? projectTrackers.keys() : issueTrackers.keys();
    const knownTrackerIds = [...availableTrackerIds];
    const defaultTrackerId = (hasProjectTrackerMetadata ? projectTrackers : issueTrackers).has(1) ? 1 : knownTrackerIds[0];
    if (suppliedTrackerId === undefined && hasProjectTrackerMetadata && defaultTrackerId === undefined) {
      throw new ApiFault(400, 'TRACKER_REQUIRED', 'У цьому проєкті немає доступних типів задач.');
    }
    const trackerId = suppliedTrackerId ?? defaultTrackerId ?? 1;
    const trackerName = projectTrackers.get(trackerId) ?? issueTrackers.get(trackerId) ?? validTrackerName(stringField(input, 'trackerName'))
      ?? (this.config.mode === 'demo' ? `Type #${trackerId}` : '');
    const me = await this.store.getValue<{ id: number }>('me') ?? { id: 1 };
    const prepared: Issue = {
      id, projectId, subject, description: stringField(input, 'description') ?? '', statusId,
      priorityId, trackerId, trackerName, authorId: me.id,
      ...(numberField(input, 'assignedToId') ? { assignedToId: numberField(input, 'assignedToId') } : {}),
      ...(numberField(input, 'developerId') ? { developerId: numberField(input, 'developerId') } : {}),
      ...(numberField(input, 'qaId') ? { qaId: numberField(input, 'qaId') } : {}),
      ...(numberField(input, 'fixedVersionId') ? { fixedVersionId: numberField(input, 'fixedVersionId') } : {}),
      branch: '', labels: Array.isArray(input.labels) ? input.labels.filter((value): value is string => typeof value === 'string') : [],
      watcherIds: [me.id], createdOn: now(), updatedOn: now(), attachments: [],
    };
    const version = prepared.fixedVersionId ? await this.store.getVersion(prepared.fixedVersionId) : undefined;
    if (prepared.fixedVersionId && !version) throw new ApiFault(400, 'VERSION_NOT_FOUND', 'Реліз не знайдено.');
    if (version && version.projectId !== projectId) throw new ApiFault(400, 'CROSS_PROJECT_RELEASE', 'Задачу можна додати лише до релізу її проєкту.');
    prepared.branch = branchForIssue(id, subject);
    const previous = await this.store.getIssue(id);
    if (previous && (previous.projectId !== projectId || previous.subject !== subject)) {
      throw new ApiFault(409, 'ISSUE_ID_CONFLICT', 'Повтор операції зіткнувся з іншою задачею.');
    }
    const issue: Issue = previous ? { ...previous, branch: previous.branch || prepared.branch } : prepared;
    await this.store.saveIssue(issue);
    record.issue = issue;
    record.operation.issueId = id;
    record.operation.status = 'done';
    record.operation.steps = [{ name: 'Створити задачу', status: 'done' }, { name: 'Заповнити Branch', status: 'done' }];
    await this.finishRecord(record);
    this.events?.publish('issue', { issueId: id, projectId });
  }

  private async updateIssue(record: OperationRecord, command: Command): Promise<void> {
    const issue = await this.requireIssue(command.issueId);
    const input = command.input;
    assertExpectedUpdatedOn(issue, input);
    const requestedStatusId = typeof input.statusId === 'number' ? input.statusId : undefined;
    const updated: Issue = { ...issue };
    if (typeof input.subject === 'string') updated.subject = input.subject.trim();
    if (!updated.subject) throw new ApiFault(400, 'SUBJECT_REQUIRED', 'Назва задачі не може бути порожньою.');
    if (typeof input.description === 'string') updated.description = input.description;
    if (typeof input.priorityId === 'number') updated.priorityId = input.priorityId;
    const project = (await this.store.getProjects()).find(item => item.id === issue.projectId);
    const issueTrackers = knownTrackers(await this.store.getIssues(issue.projectId));
    const projectTrackers = new Map((project?.trackers ?? []).map(tracker => [tracker.id, tracker.name]));
    const hasProjectTrackerMetadata = project?.trackers !== undefined;
    const previousTrackerId = issue.trackerId;
    if (input.trackerId !== undefined) {
      const trackerId = numberField(input, 'trackerId');
      if (!trackerId || trackerId <= 0) throw new ApiFault(400, 'TRACKER_REQUIRED', 'Виберіть коректний тип задачі.');
      if (hasProjectTrackerMetadata && !projectTrackers.has(trackerId)) {
        throw new ApiFault(400, 'TRACKER_REQUIRED', 'Виберіть тип задачі, доступний у цьому проєкті.');
      }
      updated.trackerId = trackerId;
    }
    const canonicalTrackerName = projectTrackers.get(updated.trackerId) ?? issueTrackers.get(updated.trackerId);
    if (canonicalTrackerName) updated.trackerName = canonicalTrackerName;
    else if (typeof input.trackerName === 'string' && validTrackerName(input.trackerName)) {
      updated.trackerName = validTrackerName(input.trackerName)!;
    } else if (updated.trackerId !== previousTrackerId) {
      updated.trackerName = this.config.mode === 'demo' ? `Type #${updated.trackerId}` : '';
    }
    if (typeof input.assignedToId === 'number' || input.assignedToId === null) updated.assignedToId = input.assignedToId === null ? undefined : input.assignedToId;
    if (typeof input.developerId === 'number' || input.developerId === null) updated.developerId = input.developerId === null ? undefined : input.developerId;
    if (typeof input.qaId === 'number' || input.qaId === null) updated.qaId = input.qaId === null ? undefined : input.qaId;
    if (typeof input.fixedVersionId === 'number' || input.fixedVersionId === null) updated.fixedVersionId = input.fixedVersionId === null ? undefined : input.fixedVersionId;
    if (typeof input.branch === 'string') updated.branch = input.branch;
    if (Array.isArray(input.labels)) updated.labels = input.labels.filter((value): value is string => typeof value === 'string');
    if (typeof input.dueDate === 'string' || input.dueDate === null) updated.dueDate = input.dueDate === null ? undefined : input.dueDate;
    updated.updatedOn = now();
    if (requestedStatusId !== undefined && !(await this.getStatuses()).some(status => status.id === requestedStatusId)) {
      throw new ApiFault(400, 'STATUS_REQUIRED', 'Виберіть коректний статус.');
    }
    const version = updated.fixedVersionId ? await this.store.getVersion(updated.fixedVersionId) : undefined;
    if (updated.fixedVersionId && !version) throw new ApiFault(400, 'VERSION_NOT_FOUND', 'Реліз не знайдено.');
    if (version && version.projectId !== updated.projectId) throw new ApiFault(400, 'CROSS_PROJECT_RELEASE', 'Задачу можна додати лише до релізу її проєкту.');
    const rolesChanged = updated.developerId !== issue.developerId || updated.qaId !== issue.qaId;
    await this.store.saveIssue(updated);
    if (rolesChanged) await this.store.setIssueRoles(updated.id,
      input.developerId === null ? null : updated.developerId,
      input.qaId === null ? null : updated.qaId);
    record.issue = updated;
    if (requestedStatusId !== undefined && requestedStatusId !== issue.statusId) {
      const { expectedUpdatedOn: _expectedUpdatedOn, ...moveInput } = input;
      await this.moveIssue(record, { ...command, type: 'moveIssue', input: { ...moveInput, statusId: requestedStatusId } });
      return;
    }
    if (this.config.mode === 'demo' && issue.statusId === updated.statusId
      && issue.labels.includes(this.config.ciInProgressLabel) && updated.labels.includes(this.config.ciFailedLabel)) {
      await this.queueCiAutomation(issue, updated);
    }
    record.operation.status = 'done';
    record.operation.steps = [{ name: 'Оновити задачу в деморежимі', status: 'done' }];
    await this.finishRecord(record);
    this.events?.publish('issue', { issueId: updated.id, projectId: updated.projectId });
  }

  private async moveIssue(record: OperationRecord, command: Command): Promise<void> {
    const issue = await this.requireIssue(command.issueId);
    assertExpectedUpdatedOn(issue, command.input);
    const statusId = await this.targetStatusId(command.input) ?? issue.statusId;
    const status = (await this.getStatuses()).find(item => item.id === statusId);
    if (!status) throw new ApiFault(400, 'STATUS_REQUIRED', 'Виберіть коректний статус.');
    await this.validateVersionChange(issue, command.input);
    if (status.key === 'qa' && statusByKey(await this.getStatuses(), 'review')?.id === issue.statusId) {
      await this.handoffToQA(record, { ...command, type: 'handoffToQA', issueId: issue.id });
      return;
    }
    if (status.key === 'todo' && ['qa', 'review'].includes(statusById(await this.getStatuses(), issue.statusId)?.key ?? '')) {
      await this.returnToDeveloper(record, { ...command, type: 'returnToDeveloper', issueId: issue.id });
      return;
    }
    if (issue.allowedStatusIds && statusId !== issue.statusId && !issue.allowedStatusIds.includes(statusId)) {
      return this.block(record, `Перехід у ${status.name} недоступний у workflow.`, undefined, 'TRANSITION_NOT_ALLOWED');
    }
    const updated = { ...issue, statusId, updatedOn: now() };
    const changedMembership = await this.versionChanged(updated, command.input);
    const next = changedMembership ?? updated;
    await this.store.saveIssue(next);
    record.issue = next;
    record.operation.status = 'done';
    record.operation.steps = [{ name: `Перемістити задачу в ${status.name}`, status: 'done' }];
    await this.finishRecord(record);
    this.events?.publish('issue', { issueId: next.id, projectId: next.projectId });
  }

  private async handoffToQA(record: OperationRecord, command: Command): Promise<void> {
    let issue = await this.requireIssue(command.issueId);
    assertExpectedUpdatedOn(issue, command.input);
    const statuses = await this.getStatuses();
    const review = statusByKey(statuses, 'review');
    const qaStatus = statusByKey(statuses, 'qa');
    if (!review || !qaStatus) return this.block(record, 'Для передачі потрібні статуси Review і QA.', undefined, 'TRANSITION_NOT_ALLOWED');
    if (issue.statusId !== review.id && issue.statusId !== qaStatus.id) return this.block(record, 'Передати в QA можна лише задачу зі статусом Review.', undefined, 'TRANSITION_NOT_ALLOWED');
    const settings = await this.store.getSettings();
    const qaId = numberField(command.input, 'qaId') ?? settings.projectQa[String(issue.projectId)];
    if (!qaId) return this.block(record, 'Виберіть виконавця QA або задайте його в налаштуваннях проєкту.', undefined, 'QA_REQUIRED');
    await this.validateVersionChange(issue, command.input);
    const me = await this.store.getValue<{ id: number }>('me') ?? { id: 1 };
    if (issue.developerId === undefined && issue.assignedToId !== undefined) {
      await this.store.setIssueRoles(issue.id, issue.assignedToId, issue.qaId);
      issue.developerId = issue.assignedToId;
    }
    if (!stepDone(record, 'join')) {
      if (issue.assignedToId !== me.id) issue = { ...issue, assignedToId: me.id, updatedOn: now() };
      await this.store.saveIssue(issue);
      await this.step(record, 'join', 'Тимчасово призначити себе виконавцем', 'done');
    }
    if (!stepDone(record, 'status')) {
      if (issue.statusId !== qaStatus.id && issue.allowedStatusIds && !issue.allowedStatusIds.includes(qaStatus.id)) {
        return this.block(record, 'Redmine workflow не дозволяє перехід у QA після приєднання.', undefined, 'TRANSITION_NOT_ALLOWED');
      }
      issue = { ...issue, statusId: qaStatus.id, updatedOn: now() };
      await this.store.saveIssue(issue);
      await this.step(record, 'status', 'Перевести задачу в QA', 'done');
    }
    if (!stepDone(record, 'assign')) {
      issue = { ...issue, assignedToId: qaId, qaId, updatedOn: now() };
      await this.store.saveIssue(issue);
      await this.store.setIssueRoles(issue.id, issue.developerId, qaId);
      await this.step(record, 'assign', 'Призначити обраного QA', 'done');
    }
    issue = await this.versionChanged(issue, command.input) ?? issue;
    await this.store.saveIssue(issue);
    record.issue = (await this.store.getIssue(issue.id)) ?? issue;
    record.operation.status = 'done';
    await this.finishRecord(record);
    this.events?.publish('issue', { issueId: issue.id, projectId: issue.projectId });
  }

  private async returnToDeveloper(record: OperationRecord, command: Command): Promise<void> {
    const issue = await this.requireIssue(command.issueId);
    assertExpectedUpdatedOn(issue, command.input);
    const currentStatus = statusById(await this.getStatuses(), issue.statusId)?.key;
    const developerId = numberField(command.input, 'developerId') ?? issue.developerId;
    if (!developerId) return this.block(record, 'Розробника не вдалося визначити. Виберіть його вручну.', undefined, 'DEVELOPER_REQUIRED');
    if (!['qa', 'review'].includes(currentStatus ?? '')) return this.block(record, 'Автоматичне повернення доступне лише з Review або QA.', undefined, 'TRANSITION_NOT_ALLOWED');
    const todo = statusByKey(await this.getStatuses(), 'todo');
    if (!todo) return this.block(record, 'Статус To Do не налаштований.', undefined, 'TRANSITION_NOT_ALLOWED');
    await this.validateVersionChange(issue, command.input);
    let updated: Issue = { ...issue, statusId: todo.id, assignedToId: developerId, developerId, updatedOn: now() };
    updated = await this.versionChanged(updated, command.input) ?? updated;
    await this.store.saveIssue(updated);
    await this.store.setIssueRoles(updated.id, developerId, updated.qaId);
    record.issue = updated;
    record.operation.status = 'done';
    record.operation.steps = [{ name: 'Повернути розробника', status: 'done' }, { name: 'Перевести в To Do', status: 'done' }];
    await this.finishRecord(record);
    this.events?.publish('issue', { issueId: updated.id, projectId: updated.projectId });
  }

  private async comment(record: OperationRecord, command: Command): Promise<void> {
    const issue = await this.requireIssue(command.issueId);
    const notes = stringField(command.input, 'notes')?.trim();
    if (!notes) throw new ApiFault(400, 'COMMENT_REQUIRED', 'Введіть текст коментаря.');
    const me = await this.store.getValue<{ id: number; name: string }>('me') ?? { id: 1, name: 'Користувач' };
    const journal: Journal = { id: this.store.allocateJournalId(), user: me, notes,
      createdOn: now(), changes: [] };
    await this.store.saveJournal(issue.id, journal);
    record.issue = issue;
    record.operation.status = 'done';
    record.operation.steps = [{ name: 'Додати коментар у деморежимі', status: 'done' }];
    await this.finishRecord(record);
    this.events?.publish('issue', { issueId: issue.id, projectId: issue.projectId });
  }

  private async editJournal(record: OperationRecord, command: Command): Promise<void> {
    const issue = await this.requireIssue(command.issueId);
    const journal = await this.requireJournal(issue.id, command.input);
    await this.assertJournalAuthorOrAdmin(journal);
    assertExpectedJournalNotes(journal, command.input);
    const notes = stringField(command.input, 'notes')?.trim();
    if (!notes) throw new ApiFault(400, 'COMMENT_REQUIRED', 'Введіть текст коментаря або скористайтеся видаленням.');
    await this.store.saveJournal(issue.id, { ...journal, notes });
    record.issue = issue;
    record.operation.status = 'done';
    record.operation.steps = [{ name: 'Зберегти зміни коментаря в деморежимі', status: 'done' }];
    await this.finishRecord(record);
    this.events?.publish('issue', { issueId: issue.id, projectId: issue.projectId });
  }

  private async deleteJournal(record: OperationRecord, command: Command): Promise<void> {
    const issue = await this.requireIssue(command.issueId);
    const journal = await this.requireJournal(issue.id, command.input);
    await this.assertJournalAuthorOrAdmin(journal);
    assertExpectedJournalNotes(journal, command.input);
    if (!journal.notes.trim()) throw new ApiFault(404, 'JOURNAL_NOT_FOUND', 'Коментар уже видалено.');
    // Redmine removes a journal only when it contains notes alone. Keep status and field changes intact.
    if (journal.changes.length) {
      await this.store.saveJournal(issue.id, { ...journal, notes: '' });
      this.store.clearJournalLikes(journal.id);
    } else {
      await this.store.deleteJournal(issue.id, journal.id);
    }
    record.issue = issue;
    record.operation.status = 'done';
    record.operation.steps = [{ name: 'Видалити текст коментаря в деморежимі', status: 'done' }];
    await this.finishRecord(record);
    this.events?.publish('issue', { issueId: issue.id, projectId: issue.projectId });
  }

  private async setJournalLike(record: OperationRecord, command: Command): Promise<void> {
    const issue = await this.requireIssue(command.issueId);
    const journal = await this.requireJournal(issue.id, command.input);
    if (!journal.notes.trim()) throw new ApiFault(404, 'JOURNAL_NOT_FOUND', 'Коментар не знайдено.');
    const liked = command.input.liked;
    if (typeof liked !== 'boolean') throw new ApiFault(400, 'LIKE_STATE_REQUIRED', 'Вкажіть, чи вподобано коментар.');
    const me = await this.store.getValue<{ id: number; name: string }>('me') ?? { id: 1, name: 'Користувач' };
    this.store.setJournalLike(journal.id, me.id, liked);
    record.issue = issue;
    record.operation.status = 'done';
    record.operation.steps = [{ name: 'Зберегти вподобання коментаря в деморежимі', status: 'done' }];
    await this.finishRecord(record);
    this.events?.publish('issue', { issueId: issue.id, projectId: issue.projectId });
  }

  private async requireJournal(issueId: number, input: Record<string, unknown>): Promise<Journal> {
    const journalId = numberField(input, 'journalId');
    if (!journalId || journalId <= 0) throw new ApiFault(400, 'JOURNAL_REQUIRED', 'Не вказано коментар.');
    const journal = (await this.store.getJournals(issueId)).find(item => item.id === journalId);
    if (!journal) throw new ApiFault(404, 'JOURNAL_NOT_FOUND', 'Коментар не знайдено.');
    return journal;
  }

  private async assertJournalAuthorOrAdmin(journal: Journal): Promise<void> {
    const me = await this.store.getValue<{ id: number; name: string; isAdmin?: boolean }>('me') ?? { id: 0, name: 'Користувач' };
    if (journal.user.id !== me.id && !me.isAdmin) {
      throw new ApiFault(403, 'JOURNAL_FORBIDDEN', 'Редагувати або видаляти чужий коментар може лише адміністратор.');
    }
  }

  private async createRelease(record: OperationRecord, command: Command): Promise<void> {
    const projectId = command.projectId ?? numberField(command.input, 'projectId');
    const name = stringField(command.input, 'name')?.trim();
    if (!projectId || !(await this.store.getProjects()).some(project => project.id === projectId)) throw new ApiFault(400, 'PROJECT_REQUIRED', 'Виберіть доступний проєкт.');
    if (!name) throw new ApiFault(400, 'RELEASE_NAME_REQUIRED', 'Вкажіть назву релізу.');
    const releases = await this.store.getVersions();
    const version: Version = { id: Math.max(0, ...releases.map(item => item.id)) + 1, projectId, name, status: 'open',
      ...(stringField(command.input, 'dueDate') ? { dueDate: stringField(command.input, 'dueDate') } : {}),
      ...(stringField(command.input, 'description') ? { description: stringField(command.input, 'description') } : {}) };
    const issueIds = Array.isArray(command.input.issueIds) ? command.input.issueIds.filter((id): id is number => typeof id === 'number') : [];
    const chosen = await Promise.all(issueIds.map(id => this.requireIssue(id)));
    if (chosen.some(issue => issue.projectId !== projectId)) throw new ApiFault(400, 'CROSS_PROJECT_RELEASE', 'Один реліз може містити задачі лише одного проєкту.');
    await this.store.saveVersion(version);
    for (const issue of chosen) await this.store.saveIssue({ ...issue, fixedVersionId: version.id, updatedOn: now() });
    record.version = version;
    record.operation.versionId = version.id;
    record.operation.status = 'done';
    record.operation.steps = [{ name: 'Створити реліз', status: 'done' }, { name: `Додати задачі (${chosen.length})`, status: 'done' }];
    await this.finishRecord(record);
    this.events?.publish('release', { versionId: version.id, projectId });
  }

  private async updateRelease(record: OperationRecord, command: Command): Promise<void> {
    const version = await this.requireVersion(command.versionId);
    const input = command.input;
    const updated: Version = { ...version };
    if (typeof input.name === 'string') updated.name = input.name.trim();
    if (typeof input.dueDate === 'string' || input.dueDate === null) updated.dueDate = input.dueDate === null ? undefined : input.dueDate;
    if (typeof input.description === 'string' || input.description === null) updated.description = input.description === null ? undefined : input.description;
    if (input.status === 'open' || input.status === 'locked' || input.status === 'closed') updated.status = input.status;
    await this.store.saveVersion(updated);
    record.version = updated;
    record.operation.status = 'done';
    record.operation.steps = [{ name: 'Оновити реліз у деморежимі', status: 'done' }];
    await this.finishRecord(record);
    this.events?.publish('release', { versionId: updated.id, projectId: updated.projectId });
  }

  private async assignRelease(record: OperationRecord, command: Command): Promise<void> {
    const removing = command.input.fixedVersionId === null;
    const targetVersionId = removing ? undefined : numberField(command.input, 'fixedVersionId') ?? command.versionId;
    const versionId = removing ? command.versionId : targetVersionId;
    const version = versionId ? await this.requireVersion(versionId) : undefined;
    if (!version) throw new ApiFault(400, 'VERSION_REQUIRED', 'Вкажіть реліз для зміни його складу.');
    const issueIds = Array.isArray(command.input.issueIds) ? command.input.issueIds.filter((id): id is number => typeof id === 'number') : [];
    if (issueIds.length === 0) throw new ApiFault(400, 'ISSUES_REQUIRED', 'Виберіть хоча б одну задачу.');
    const selected = await Promise.all(issueIds.map(id => this.requireIssue(id)));
    if (selected.some(issue => issue.projectId !== version.projectId)) throw new ApiFault(400, 'CROSS_PROJECT_RELEASE', 'Задачу можна додати лише до релізу її проєкту.');
    if (removing && selected.some(issue => issue.fixedVersionId !== version.id)) {
      throw new ApiFault(400, 'RELEASE_MEMBERSHIP_CHANGED', 'Вилучати можна лише задачі, які зараз належать цьому релізу.');
    }
    const updated = [] as Issue[];
    for (const issue of selected) {
      const next = { ...issue, fixedVersionId: removing ? undefined : version.id, updatedOn: now() };
      await this.store.saveIssue(next);
      updated.push(next);
    }
    record.issue = updated[0];
    record.version = version;
    record.operation.status = 'done';
    record.operation.steps = [{ name: `Оновити склад релізу (${updated.length} задач)`, status: 'done' }];
    await this.finishRecord(record);
    this.events?.publish('release', { versionId: version?.id, projectId: version?.projectId });
  }

  private async finishRelease(record: OperationRecord, command: Command): Promise<void> {
    const versionId = command.versionId ?? numberField(command.input, 'versionId');
    const version = await this.requireVersion(versionId);
    const allIssues = await this.store.getIssues(version.projectId);
    const current = allIssues.filter(issue => issue.fixedVersionId === version.id);
    const statuses = await this.getStatuses();
    const doneStatus = statuses.find(status => status.key === 'done' && status.isClosed);
    const deployStatus = statusByKey(statuses, 'deploy');
    if (!doneStatus || !deployStatus) return this.block(record, 'Для завершення потрібні закритий статус Done і статус Deploy.', undefined, 'RELEASE_NOT_READY');
    if (!record.context?.issueIds) {
      const readiness = releaseReadiness(current, statuses);
      if (!readiness.ready) {
        const issueIds = readiness.pending.map(issue => issue.id);
        return this.block(record, 'Усі незавершені задачі мають перейти в Deploy перед завершенням релізу.', { issueIds }, 'RELEASE_NOT_READY');
      }
      record.context = { issueIds: current.map(issue => issue.id).sort((a, b) => a - b), doneStatusId: doneStatus.id };
      record.operation.steps = [{ name: 'Перевірити готовність: Done пропущено, решта в Deploy', status: 'done' }];
      await this.store.saveOperationRecord(record);
    }
    const expected = (record.context.issueIds as number[]).slice().sort((a, b) => a - b);
    const actual = current.map(issue => issue.id).sort((a, b) => a - b);
    if (!sameNumbers(expected, actual)) return this.block(record, 'Склад релізу змінився під час виконання. Перевірте актуальний склад і повторіть команду.', undefined, 'STALE');
    const storedDoneId = Number(record.context.doneStatusId ?? doneStatus.id);
    for (const issueId of expected) {
      const issue = await this.requireIssue(issueId);
      const stepKey = `issue:${issueId}`;
      if (stepDone(record, stepKey)) continue;
      if (issue.statusId === storedDoneId) {
        await this.step(record, stepKey, `Задача #${issue.id} вже Done`, 'skipped');
        continue;
      }
      if (issue.statusId !== deployStatus.id) return this.block(record, `Задача #${issue.id} більше не в Deploy.`, { issueId }, 'RELEASE_NOT_READY');
      const updated = { ...issue, statusId: storedDoneId, updatedOn: now() };
      await this.store.saveIssue(updated);
      record.issue = updated;
      await this.step(record, stepKey, `Перевести задачу #${issue.id} у Done`, 'done');
      this.events?.publish('issue', { issueId, projectId: issue.projectId });
    }
    const after = (await this.store.getIssues(version.projectId)).filter(issue => issue.fixedVersionId === version.id);
    if (!sameNumbers(expected, after.map(issue => issue.id).sort((a, b) => a - b)) || after.some(issue => issue.statusId !== storedDoneId)) {
      return this.block(record, 'Склад або статус задач релізу змінився. Версію не закрито.', undefined, 'STALE');
    }
    const latest = await this.requireVersion(version.id);
    const closed: Version = { ...latest, status: 'closed' };
    await this.store.saveVersion(closed);
    record.version = closed;
    await this.step(record, 'version', 'Закрити версію релізу', 'done');
    record.operation.status = 'done';
    await this.finishRecord(record);
    this.events?.publish('release', { versionId: version.id, projectId: version.projectId });
  }

  private async runAutomation(record: OperationRecord, command: Command): Promise<void> {
    const settings = await this.store.getSettings();
    if (!settings.automationEnabled) return this.block(record, 'Автоматизації вимкнені в налаштуваннях.', undefined, 'OPERATION_BLOCKED');
    const processed = await this.processPendingDemoAutomations(command.issueId, record.operation.id);
    record.operation.status = processed.some(operation => operation.status === 'blocked') ? 'blocked' : 'done';
    record.operation.steps = processed.length
      ? processed.map(operation => ({ name: `Автоматизація #${operation.issueId}`, status: operation.status === 'done' ? 'done' : 'blocked' }))
      : [{ name: 'Немає нових переходів CI для обробки', status: 'skipped' }];
    await this.finishRecord(record);
  }

  async processPendingDemoAutomations(issueId?: number, exceptId?: string): Promise<Operation[]> {
    if (this.config.mode === 'redmine') {
      await this.realExecutor?.processPendingAutomations(issueId);
      return [];
    }
    if (this.config.mode !== 'demo') return [];
    const settings = await this.store.getSettings();
    if (!settings.automationEnabled) return [];
    const pending = (await this.store.getOperationRecords()).filter(record => record.operation.type === 'runAutomation'
      && ((record.operation.status === 'pending' && record.operation.id !== exceptId)
        || (record.operation.id === exceptId && record.operation.status === 'running' && record.context?.automationTrigger !== undefined))
      && (issueId === undefined || record.operation.issueId === issueId) && record.context?.automationTrigger);
    const completed: Operation[] = [];
    const statuses = await this.getStatuses();
    const todo = statusByKey(statuses, 'todo');
    for (const record of pending) {
      const issue = await this.store.getIssue(record.operation.issueId ?? 0);
      const trigger = record.context!.automationTrigger as { expectedUpdatedOn: string; reviewStatusId: number; fixedVersionId?: number };
      if (!issue || !todo || issue.statusId !== trigger.reviewStatusId || issue.updatedOn !== trigger.expectedUpdatedOn || !issue.labels.includes(this.config.ciFailedLabel)) {
        record.operation.status = 'blocked';
        record.operation.error = 'Подія CI застаріла: задача більше не відповідає умовам Review і налаштованій мітці помилки.';
        record.operation.errorCode = 'STALE';
        record.operation.steps.push({ name: 'Перевірити актуальний стан', status: 'blocked', error: record.operation.error });
        await this.store.saveOperationRecord(record);
        completed.push(record.operation);
        continue;
      }
      const developerId = issue.developerId ?? Number((record.context!.automationTrigger as { developerId?: number }).developerId);
      if (!developerId) {
        record.operation.status = 'blocked';
        record.operation.error = 'Не вдалося визначити розробника; потрібен ручний вибір.';
        record.operation.errorCode = 'DEVELOPER_REQUIRED';
        record.operation.steps.push({ name: 'Вибрати розробника вручну', status: 'blocked', error: record.operation.error });
        await this.store.saveOperationRecord(record);
        completed.push(record.operation);
        continue;
      }
      const updated: Issue = { ...issue, statusId: todo.id, assignedToId: developerId, developerId, updatedOn: now() };
      // fixedVersionId is intentionally carried through the CI return.
      await this.store.saveIssue(updated);
      await this.store.setIssueRoles(updated.id, developerId, updated.qaId);
      record.issue = updated;
      record.operation.status = 'done';
      record.operation.steps.push({ name: 'Повернути задачу в To Do розробнику', status: 'done' });
      await this.store.saveOperationRecord(record);
      this.events?.publish('issue', { issueId: updated.id, projectId: updated.projectId });
      this.events?.publish('operation', { id: record.operation.id, status: 'done' });
      completed.push(record.operation);
    }
    return completed;
  }

  private async queueCiAutomation(previous: Issue, updated: Issue): Promise<void> {
    if (!(await this.store.getSettings()).automationEnabled) return;
    const reviewStatusId = statusByKey(await this.getStatuses(), 'review')?.id;
    if (!reviewStatusId || previous.statusId !== reviewStatusId) return;
    const id = `demo-ci-${updated.id}-${updated.updatedOn.replace(/[^0-9]/g, '')}`;
    if (await this.store.getOperationRecord(id)) return;
    const record: OperationRecord = {
      operation: { id, type: 'runAutomation', issueId: updated.id, status: 'pending',
        steps: [{ name: 'Виявлено налаштовані CI labels', status: 'done' },
          { name: 'Повернути задачу в To Do розробнику', status: 'pending' }], createdOn: now() },
      context: { automationTrigger: { from: this.config.ciInProgressLabel, to: this.config.ciFailedLabel, expectedUpdatedOn: updated.updatedOn,
        reviewStatusId, fixedVersionId: previous.fixedVersionId, developerId: previous.developerId } },
    };
    await this.store.saveOperationRecord(record);
    this.events?.publish('operation', { id, status: 'pending' });
  }

  private async requireIssue(id?: number): Promise<Issue> {
    if (!id) throw new ApiFault(400, 'ISSUE_REQUIRED', 'Не вказано задачу.');
    const issue = await this.store.getIssue(id);
    if (!issue) throw new ApiFault(404, 'ISSUE_NOT_FOUND', 'Задачу не знайдено.');
    return issue;
  }
  private async requireVersion(id?: number): Promise<Version> {
    if (!id) throw new ApiFault(400, 'VERSION_REQUIRED', 'Не вказано реліз.');
    const version = await this.store.getVersion(id);
    if (!version) throw new ApiFault(404, 'VERSION_NOT_FOUND', 'Реліз не знайдено.');
    return version;
  }
  private async getStatuses() { return await this.store.getValue<import('../../shared/types.js').Status[]>('statuses') ?? []; }
  private async targetStatusId(input: Record<string, unknown>): Promise<number | undefined> {
    if (typeof input.statusId === 'number') return input.statusId;
    const key = stringField(input, 'statusKey') as StatusKey | undefined;
    return key ? statusByKey(await this.getStatuses(), key)?.id : undefined;
  }
  private async validateVersionChange(issue: Issue, input: Record<string, unknown>): Promise<void> {
    if (input.removeVersion === true || input.fixedVersionId === null) return;
    if (typeof input.fixedVersionId !== 'number') return;
    const version = await this.store.getVersion(input.fixedVersionId);
    if (!version) throw new ApiFault(400, 'VERSION_NOT_FOUND', 'Реліз не знайдено.');
    if (version.projectId !== issue.projectId) throw new ApiFault(400, 'CROSS_PROJECT_RELEASE', 'Виберіть реліз цього проєкту.');
  }
  private async versionChanged(issue: Issue, input: Record<string, unknown>): Promise<Issue | undefined> {
    let fixedVersionId = issue.fixedVersionId;
    if (input.removeVersion === true || input.fixedVersionId === null) fixedVersionId = undefined;
    else if (typeof input.fixedVersionId === 'number') {
      await this.validateVersionChange(issue, input);
      fixedVersionId = input.fixedVersionId;
    }
    if (fixedVersionId === issue.fixedVersionId) return undefined;
    return { ...issue, fixedVersionId, updatedOn: now() };
  }
  private async statusIdForKey(key: StatusKey): Promise<number | undefined> { return statusByKey(await this.getStatuses(), key)?.id; }

  private async step(record: OperationRecord, key: string, name: string, status: OperationStep['status'], error?: string): Promise<void> {
    const names = (record.context?.stepNames as Record<string, string> | undefined) ?? {};
    const previousName = names[key];
    if (previousName) record.operation.steps = record.operation.steps.filter(step => step.name !== previousName);
    names[key] = name;
    const completed = new Set((record.context?.completedSteps as string[] | undefined) ?? []);
    if (status === 'done' || status === 'skipped') completed.add(key);
    else completed.delete(key);
    record.context = { ...(record.context ?? {}), stepNames: names, completedSteps: [...completed] };
    record.operation.steps.push({ name, status, ...(error ? { error } : {}) });
    await this.store.saveOperationRecord(record);
  }
  private async block(record: OperationRecord, message: string, details?: unknown, code = 'OPERATION_BLOCKED'): Promise<void> {
    record.operation.status = 'blocked';
    record.operation.error = message;
    record.operation.errorCode = code;
    if (details !== undefined) record.context = { ...(record.context ?? {}), blockedDetails: details };
    record.operation.steps.push({ name: message, status: 'blocked', error: message });
    await this.finishRecord(record);
  }
  private async finishRecord(record: OperationRecord): Promise<void> {
    await this.store.saveOperationRecord(record);
    this.events?.publish('operation', { id: record.operation.id, status: record.operation.status });
  }
  private result(record: OperationRecord): CommandResult { return { operation: record.operation, ...(record.issue ? { issue: record.issue } : {}), ...(record.version ? { version: record.version } : {}) }; }
}

function statusByKey(statuses: import('../../shared/types.js').Status[], key: StatusKey) { return statuses.find(status => status.key === key); }
function statusById(statuses: import('../../shared/types.js').Status[], id: number) { return statuses.find(status => status.id === id); }
function stepDone(record: OperationRecord, key: string): boolean {
  return ((record.context?.completedSteps as string[] | undefined) ?? []).includes(key);
}
function assertExpectedUpdatedOn(issue: Issue, input: Record<string, unknown>): void {
  if (input.expectedUpdatedOn === undefined) return;
  if (typeof input.expectedUpdatedOn !== 'string') throw new ApiFault(400, 'INVALID_UPDATED_ON', 'expectedUpdatedOn має бути рядком.');
  if (input.expectedUpdatedOn !== issue.updatedOn) {
    throw new ApiFault(409, 'STALE', 'Картка змінилася. Оновіть її перед збереженням.', {
      expectedUpdatedOn: input.expectedUpdatedOn, actualUpdatedOn: issue.updatedOn,
    });
  }
}
function assertExpectedJournalNotes(journal: Journal, input: Record<string, unknown>): void {
  if (typeof input.expectedNotes !== 'string') {
    throw new ApiFault(400, 'EXPECTED_NOTES_REQUIRED', 'Оновіть коментар і повторіть дію.');
  }
  if (input.expectedNotes !== journal.notes) {
    throw new ApiFault(409, 'STALE', 'Коментар змінився. Оновіть його перед збереженням.', { journalId: journal.id });
  }
}
function knownTrackers(issues: Issue[]): Map<number, string> {
  const namesById = new Map<number, Map<string, number>>();
  for (const issue of issues) {
    if (!Number.isSafeInteger(issue.trackerId) || issue.trackerId <= 0) continue;
    const name = validTrackerName(issue.trackerName);
    if (!name) continue;
    const names = namesById.get(issue.trackerId) ?? new Map<string, number>();
    names.set(name, (names.get(name) ?? 0) + 1);
    namesById.set(issue.trackerId, names);
  }
  return new Map([...namesById].map(([id, names]) => [id, [...names]
    .sort(([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB))[0]![0]]));
}
function validTrackerName(value?: string): string | undefined {
  const name = value?.trim();
  return name && name.length <= 100 ? name : undefined;
}
function isManualPeopleChoice(record: OperationRecord, field: PeopleField, personId: number, projectId: number): boolean {
  if (record.issue?.projectId !== projectId) return false;
  const targetId = field === 'assignee' ? record.issue.assignedToId
    : field === 'developer' ? record.issue.developerId : record.issue.qaId;
  if (targetId !== personId) return false;
  const original = record.context?.originalCommand as Command | undefined;
  const commandType = original?.type ?? record.operation.type;
  if (commandType === 'runAutomation' || record.operation.type === 'runAutomation') return false;
  if (record.operation.type === 'saveIssueRoles') {
    const choices = record.context?.manualRoleChoices as Record<string, number> | undefined;
    const roleKey = field === 'developer' ? 'developerId' : field === 'qa' ? 'qaId' : undefined;
    return roleKey !== undefined && choices?.[roleKey] === personId;
  }
  if (field === 'assignee' && ['handoffToQA', 'returnToDeveloper'].includes(commandType)) return false;
  const inputKey = field === 'assignee' ? 'assignedToId' : field === 'developer' ? 'developerId' : 'qaId';
  return original?.input?.[inputKey] === personId;
}
function sameNumbers(a: number[], b: number[]): boolean { return a.length === b.length && a.every((value, index) => value === b[index]); }
function safeMessage(error: unknown): string { return error instanceof Error ? error.message : 'Команда не вдалася.'; }
function commandSignature(command: Command): string {
  const { operationId: _operationId, ...payload } = command;
  return createHash('sha256').update(JSON.stringify(sortObject(payload))).digest('hex');
}
function isRetryEnvelope(candidate: Command, original: Command, storedIssueId?: number, storedVersionId?: number): boolean {
  if (Object.keys(candidate.input ?? {}).length > 0 || candidate.type !== original.type) return false;
  for (const key of ['issueId', 'versionId', 'projectId'] as const) {
    if (candidate[key] === undefined || candidate[key] === original[key]) continue;
    const returnedIssue = key === 'issueId' && candidate[key] === storedIssueId && original.type === 'createIssue' && original.issueId === undefined;
    const returnedVersion = key === 'versionId' && candidate[key] === storedVersionId && original.type === 'createRelease' && original.versionId === undefined;
    if (!returnedIssue && !returnedVersion) return false;
  }
  return true;
}
function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, sortObject(item)]));
  return value;
}
