import { createHash, randomUUID } from 'node:crypto';
import type { Command, CommandResult, Issue, LabelOption, Operation, OperationStep, Person, Status, Version } from '../../shared/types.js';
import { branchForIssue, releaseReadiness } from '../../shared/domain.js';
import type { AppConfig } from '../config.js';
import type { WorkspaceStore, OperationRecord } from '../db/store.js';
import type { RedmineAdapter } from '../redmine/adapter.js';
import { RedmineRequestError } from '../redmine/transport.js';
import { ApiFault } from './service.js';

type WriteMetadata = { branchFieldId?: number; labelFieldIds: number[]; labelOptions: LabelOption[] };
type AdapterWithWriteMetadata = RedmineAdapter & { writeFieldMetadata?: (projectId: number) => Promise<WriteMetadata> };
type Detail = Awaited<ReturnType<RedmineAdapter['issueDetail']>>;
const now = () => new Date().toISOString();

/** Executes commands against Redmine. Every write is preceded by a fresh read and checkpointed locally. */
export class RealCommandExecutor {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly config: AppConfig, private readonly adapter: RedmineAdapter, private readonly store: WorkspaceStore,
    private readonly events?: { publish(event: string, data?: unknown): void }) {}

  async execute(command: Command): Promise<CommandResult> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await this.executeQueued(command); }
    finally { release(); }
  }

  private async executeQueued(command: Command): Promise<CommandResult> {
    const opened = await this.openRecord(command);
    const { record, alreadyDone } = opened;
    command = opened.effectiveCommand;
    if (alreadyDone) return result(record);
    if (command.type === 'runAutomation') return this.processAutomations(command.issueId, record);
    try {
      switch (command.type) {
        case 'createIssue': await this.createIssue(record, command); break;
        case 'updateIssue': await this.updateIssue(record, command); break;
        case 'moveIssue': await this.moveIssue(record, command); break;
        case 'handoffToQA': await this.handoffToQA(record, command); break;
        case 'returnToDeveloper': await this.returnToDeveloper(record, command); break;
        case 'comment': await this.comment(record, command); break;
        case 'createRelease': await this.createRelease(record, command); break;
        case 'updateRelease': await this.updateRelease(record, command); break;
        case 'assignRelease': await this.assignRelease(record, command); break;
        case 'finishRelease': await this.finishRelease(record, command); break;
        case 'generateBranch': await this.generateBranch(record, command); break;
        case 'editJournal': case 'deleteJournal': case 'setJournalLike':
          throw new ApiFault(501, 'UNSUPPORTED_CAPABILITY', 'Ця дія журналу не підтримується перевіреним API Redmine.');
        default: throw new ApiFault(400, 'UNKNOWN_COMMAND', 'Невідома команда.');
      }
      return result(record);
    } catch (error) {
      if (record.operation.status !== 'blocked') {
        const mapped = error instanceof ApiFault ? error : mapRedmineError(error);
        if (mapped instanceof ApiFault && mapped.code === 'OUTCOME_UNKNOWN') {
          const key = typeof record.context?.inFlightStep === 'string' ? record.context.inFlightStep : 'write';
          await this.unknown(record, key, mapped.message);
          return result(record);
        }
        record.context = { ...(record.context ?? {}), inFlightStep: undefined };
        record.operation.status = 'failed';
        record.operation.error = safeMessage(mapped);
        record.operation.errorCode = errorCode(mapped);
        await this.store.saveOperationRecord(record);
      }
      if (error instanceof ApiFault && error.statusCode < 500) throw error;
      return result(record);
    }
  }

  async processPendingAutomations(issueId?: number): Promise<void> {
    const settings = await this.store.getSettings();
    if (!settings.automationEnabled) return;
    const pending = (await this.store.getOperationRecords()).filter(record => record.operation.type === 'runAutomation'
      && record.operation.status === 'pending' && record.context?.realWrite === true
      && record.context?.automationTrigger && (issueId === undefined || record.operation.issueId === issueId));
    for (const pendingRecord of pending) {
      const original = pendingRecord.context?.originalCommand as Command | undefined;
      const command = original ?? { type: 'runAutomation' as const, issueId: pendingRecord.operation.issueId, input: {}, operationId: pendingRecord.operation.id };
      await this.execute(command).catch(() => undefined);
    }
  }

  private async openRecord(command: Command): Promise<{ record: OperationRecord; alreadyDone: boolean; effectiveCommand: Command }> {
    if (command.operationId) {
      const existing = await this.store.getOperationRecord(command.operationId);
      if (existing) {
        if (existing.operation.type !== command.type) throw new ApiFault(409, 'OPERATION_CONFLICT', 'Цей operationId уже використано для іншої команди.');
        if (existing.context?.realWrite !== true) {
          throw new ApiFault(409, 'LEGACY_OPERATION', 'Цю стару операцію не можна повторити як реальний запис. Створіть нову дію після перевірки поточного стану.');
        }
        const original = existing.context.originalCommand as Command | undefined;
        const effective = original && isRetryEnvelope(command, original, existing.operation.issueId, existing.operation.versionId)
          ? { ...original, operationId: command.operationId } : command;
        if (existing.context.commandSignature !== commandSignature(effective)) {
          throw new ApiFault(409, 'OPERATION_CONFLICT', 'Цей operationId уже використано з іншими даними.');
        }
        if (existing.operation.status === 'done') return { record: existing, alreadyDone: true, effectiveCommand: effective };
        if (existing.operation.errorCode === 'OUTCOME_UNKNOWN' || existing.context.outcomeUnknown === true) {
          throw new ApiFault(409, 'OUTCOME_UNKNOWN', 'Результат попереднього запису невідомий. Перевірте Redmine вручну й створіть нову дію лише після звірки.');
        }
        if (existing.operation.status === 'running' && typeof existing.context.inFlightStep === 'string') {
          await this.unknown(existing, existing.context.inFlightStep, 'Процес перезапустився під час запиту до Redmine; результат запису невідомий.');
          throw new ApiFault(409, 'OUTCOME_UNKNOWN', 'Результат попереднього запису невідомий. Перевірте Redmine вручну перед новою дією.');
        }
        existing.operation.status = 'running';
        delete existing.operation.error;
        delete existing.operation.errorCode;
        existing.operation.steps = existing.operation.steps.filter(step => step.status === 'done' || step.status === 'skipped');
        await this.store.saveOperationRecord(existing);
        return { record: existing, alreadyDone: false, effectiveCommand: effective };
      }
    }
    const record: OperationRecord = {
      operation: { id: command.operationId ?? cryptoRandomId(), type: command.type, status: 'running',
        ...(command.issueId ? { issueId: command.issueId } : {}), ...(command.versionId ? { versionId: command.versionId } : {}),
        steps: [], createdOn: now() },
      context: { realWrite: true, commandSignature: commandSignature(command), originalCommand: structuredClone(command) },
    };
    await this.store.saveOperationRecord(record);
    return { record, alreadyDone: false, effectiveCommand: command };
  }

  private async createIssue(record: OperationRecord, command: Command): Promise<void> {
    const input = command.input;
    const projectId = command.projectId ?? numberField(input, 'projectId');
    const project = projectId && (await this.store.getProjects()).find(item => item.id === projectId);
    const subject = stringField(input, 'subject')?.trim();
    if (!projectId || !project) throw new ApiFault(400, 'PROJECT_REQUIRED', 'Виберіть доступний проєкт.');
    if (!subject) throw new ApiFault(400, 'SUBJECT_REQUIRED', 'Вкажіть назву задачі.');
    const statusId = numberField(input, 'statusId') ?? (await this.statusByKey('todo'))?.id;
    const statuses = await this.statuses();
    if (!statusId || !statuses.some(status => status.id === statusId)) throw new ApiFault(400, 'STATUS_REQUIRED', 'Виберіть доступний статус.');
    const priorities = await this.store.getValue<{ id: number }[]>('priorities') ?? [];
    const priorityId = numberField(input, 'priorityId') ?? Math.max(0, ...priorities.map(value => value.id));
    if (priorities.length && !priorities.some(value => value.id === priorityId)) throw new ApiFault(400, 'PRIORITY_REQUIRED', 'Виберіть доступний пріоритет.');
    const trackerId = numberField(input, 'trackerId') ?? project.trackers?.[0]?.id;
    if (!trackerId || project.trackers && !project.trackers.some(value => value.id === trackerId)) throw new ApiFault(400, 'TRACKER_REQUIRED', 'Виберіть тип задачі, доступний у цьому проєкті.');
    const metadata = await this.writeMetadata(projectId);
    if (!metadata.branchFieldId) throw new ApiFault(400, 'BRANCH_FIELD_UNAVAILABLE', 'У проєкті немає доступного для запису поля Branch; задачу не створено.');
    const labels = normalizeLabels(input.labels);
    const fields: Record<string, unknown> = { project_id: projectId, subject, description: stringField(input, 'description') ?? '',
      status_id: statusId, priority_id: priorityId, tracker_id: trackerId };
    const assignee = numberField(input, 'assignedToId');
    if (assignee) { await this.assertProjectMember(projectId, assignee); fields.assigned_to_id = assignee; }
    const versionId = numberField(input, 'fixedVersionId');
    if (versionId) {
      const version = await this.requireVersion(versionId, true);
      if (version.projectId !== projectId) throw new ApiFault(400, 'CROSS_PROJECT_RELEASE', 'Виберіть реліз цього проєкту.');
      fields.fixed_version_id = versionId;
    }
    const dueDate = optionalDate(input.dueDate);
    if (dueDate) fields.due_date = dueDate;
    const custom = this.labelCustomFields(labels, metadata);
    if (labels.length && !custom.length) throw new ApiFault(400, 'LABELS_UNAVAILABLE', 'У проєкті не знайдено підтримуваного поля Labels/Tags з варіантами.');
    if (custom.length) fields.custom_fields = custom;

    if (!this.stepDone(record, 'create')) {
      const priorCreatedId = numberField(record.context ?? {}, 'createdIssueId') ?? record.operation.issueId;
      if (priorCreatedId) {
        let found: Issue;
        try { found = await this.requireFreshIssue(priorCreatedId); }
        catch (error) { await this.unknown(record, 'create', `ID задачі #${priorCreatedId} уже збережено, але результат створення неможливо підтвердити: ${safeMessage(error)}`); return; }
        if (found.projectId !== projectId || found.subject !== subject) {
          await this.unknown(record, 'create', `Задачу #${priorCreatedId} знайдено, але її вміст не відповідає операції; повторне створення заборонено.`); return;
        }
        record.issue = found;
        record.operation.issueId = found.id;
        await this.completeStep(record, 'create', 'Підтвердити створену задачу за збереженим ID');
      } else {
        await this.beginRequest(record, 'create', 'Створити задачу в Redmine');
        let created: Issue;
        try { created = await this.adapter.createIssue(fields, metadata.labelOptions); }
        catch (error) {
          if (isOutcomeUnknown(error, true)) { await this.unknown(record, 'create', safeMessage(error)); return; }
          throw mapRedmineError(error);
        }
        if (!Number.isSafeInteger(created?.id) || created.id <= 0) {
          await this.unknown(record, 'create', 'Redmine прийняв створення, але не повернув ID задачі.'); return;
        }
        // Persist the returned remote ID before any follow-up read or branch update.
        record.operation.issueId = created.id;
        record.issue = created;
        record.context = { ...(record.context ?? {}), createdIssueId: created.id, inFlightStep: undefined };
        await this.store.saveOperationRecord(record);
        await this.completeStep(record, 'create', 'Створити задачу в Redmine');
      }
    }
    const createdId = Number(record.context?.createdIssueId ?? record.operation.issueId);
    if (!createdId) return this.block(record, 'Задачу створено, але Redmine не повернув її ID.', 'CREATED_ID_MISSING');
    let issue = await this.refreshIssue(createdId);
    const branch = branchForIssue(issue.id, issue.subject);
    const freshMetadata = await this.writeMetadata(projectId);
    if (!freshMetadata.branchFieldId) return this.block(record, 'Задачу створено, але поле Branch недоступне для запису.', 'BRANCH_FIELD_UNAVAILABLE', issue);
    if (!await this.writeIssueStep(record, issue, 'branch', 'Записати Branch задачі', { custom_fields: [{ id: freshMetadata.branchFieldId, value: branch }] },
      updated => updated.branch === branch)) return;
    issue = await this.refreshIssue(createdId);
    record.issue = issue;
    if (issue.branch !== branch) return this.block(record, 'Задачу створено, але Branch не підтверджено після запису.', 'REMOTE_STATE_MISMATCH', issue);
    record.operation.status = 'done';
    await this.finish(record);
    this.events?.publish('issue', { issueId: issue.id, projectId });
  }

  private async updateIssue(record: OperationRecord, command: Command): Promise<void> {
    let issue = await this.requireFreshIssue(command.issueId);
    this.assertExpectedUpdatedOn(record, issue, command.input);
    if (record.context?.workflowKind === 'handoffToQA') return this.handoffToQA(record, command);
    if (record.context?.workflowKind === 'returnToDeveloper') return this.returnToDeveloper(record, command);
    const built = await this.buildIssueFields(issue, command.input, true);
    if (!Object.keys(built.fields).length && (built.developerIdChanged || built.qaIdChanged)) {
      await this.store.setIssueRoles(issue.id, built.developerId, built.qaId);
      issue = { ...issue, developerId: built.developerId, qaId: built.qaId };
      record.issue = issue; record.operation.status = 'done';
      await this.finish(record); this.events?.publish('issue', { issueId: issue.id, projectId: issue.projectId }); return;
    }
    if (!Object.keys(built.fields).length) throw new ApiFault(400, 'NO_CHANGES', 'Немає змін для збереження.');
    if (built.statusId !== undefined && built.statusId !== issue.statusId) {
      const target = built.status!;
      if (target.key === 'qa' && (await this.statusById(issue.statusId))?.key === 'review') {
        record.context = { ...(record.context ?? {}), workflowKind: 'handoffToQA' };
        await this.store.saveOperationRecord(record);
        return this.handoffToQA(record, { ...command, type: 'handoffToQA', input: command.input });
      }
      if (target.key === 'todo' && ['qa', 'review'].includes((await this.statusById(issue.statusId))?.key ?? '')) {
        record.context = { ...(record.context ?? {}), workflowKind: 'returnToDeveloper' };
        await this.store.saveOperationRecord(record);
        return this.returnToDeveloper(record, { ...command, type: 'returnToDeveloper', input: command.input });
      }
      this.assertTransition(issue, target.id);
    }
    if (!await this.writeIssueStep(record, issue, 'update', 'Оновити задачу в Redmine', built.fields,
      updated => issueFieldsMatch(updated, built.fields, built.labels, built.branch))) return;
    issue = await this.refreshIssue(issue.id);
    if (built.developerIdChanged || built.qaIdChanged) {
      await this.store.setIssueRoles(issue.id, built.developerId, built.qaId);
      issue.developerId = built.developerId ?? undefined;
      issue.qaId = built.qaId ?? undefined;
    }
    record.issue = issue;
    record.operation.status = 'done';
    await this.finish(record);
    this.events?.publish('issue', { issueId: issue.id, projectId: issue.projectId });
  }

  private async moveIssue(record: OperationRecord, command: Command): Promise<void> {
    const issue = await this.requireFreshIssue(command.issueId);
    this.assertExpectedUpdatedOn(record, issue, command.input);
    if (record.context?.workflowKind === 'handoffToQA') return this.handoffToQA(record, command);
    if (record.context?.workflowKind === 'returnToDeveloper') return this.returnToDeveloper(record, command);
    const target = await this.requestedStatus(command.input, false);
    const membershipRequested = typeof command.input.fixedVersionId === 'number' || command.input.fixedVersionId === null || command.input.removeVersion === true;
    if (!target && !membershipRequested) return this.block(record, 'Не вказано зміну статусу або складу версії.', 'STATUS_REQUIRED', issue);
    const targetStatusId = target?.id ?? issue.statusId;
    const current = await this.statusById(issue.statusId);
    if (target && target.id !== issue.statusId && target.key === 'qa' && current?.key === 'review') {
      record.context = { ...(record.context ?? {}), workflowKind: 'handoffToQA' };
      await this.store.saveOperationRecord(record);
      return this.handoffToQA(record, { ...command, type: 'handoffToQA' });
    }
    if (target && target.id !== issue.statusId && target.key === 'todo' && ['qa', 'review'].includes(current?.key ?? '')) {
      record.context = { ...(record.context ?? {}), workflowKind: 'returnToDeveloper' };
      await this.store.saveOperationRecord(record);
      return this.returnToDeveloper(record, { ...command, type: 'returnToDeveloper' });
    }
    if (target && target.id !== issue.statusId) this.assertTransition(issue, target.id);
    const built = await this.buildIssueFields(issue, command.input, false);
    const fields = { ...built.fields, ...(target && target.id !== issue.statusId ? { status_id: targetStatusId } : {}) };
    if (issueFieldsMatch(issue, fields, built.labels, built.branch)) {
      record.issue = issue; record.operation.status = 'done'; await this.finish(record); return;
    }
    if (!await this.writeIssueStep(record, issue, 'status', target && target.id !== issue.statusId ? `Перевести задачу в ${target.name}` : 'Оновити склад версії', fields,
      updated => updated.statusId === targetStatusId && issueFieldsMatch(updated, fields, built.labels, built.branch))) return;
    record.issue = await this.refreshIssue(issue.id);
    record.operation.status = 'done';
    await this.finish(record);
    this.events?.publish('issue', { issueId: issue.id, projectId: issue.projectId });
  }

  private async handoffToQA(record: OperationRecord, command: Command): Promise<void> {
    let issue = await this.requireFreshIssue(command.issueId);
    this.assertExpectedUpdatedOn(record, issue, command.input);
    if (record.context?.workflowKind !== 'handoffToQA') {
      record.context = { ...(record.context ?? {}), workflowKind: 'handoffToQA' };
      await this.store.saveOperationRecord(record);
    }
    const review = await this.statusByKey('review');
    const qaStatus = await this.statusByKey('qa');
    if (!review || !qaStatus) return this.block(record, 'Для передачі потрібні статуси Review і QA.', 'WORKFLOW_UNAVAILABLE', issue);
    const progressedToQa = issue.statusId === qaStatus.id
      && (this.stepDone(record, 'status') || record.context?.awaitingVerification === 'status');
    if (issue.statusId !== review.id && !progressedToQa) return this.block(record, 'Передати в QA можна лише задачу у Review.', 'TRANSITION_NOT_ALLOWED', issue);
    const settings = await this.store.getSettings();
    const qaId = numberField(command.input, 'qaId') ?? settings.projectQa[String(issue.projectId)];
    if (!qaId) return this.block(record, 'Виберіть QA перед передачею задачі.', 'QA_REQUIRED', issue);
    await this.assertProjectMember(issue.projectId, qaId);
    const me = await this.adapter.currentUser();
    const developerId = numberField(command.input, 'developerId') ?? numberField(record.context ?? {}, 'handoffDeveloperId') ?? issue.developerId
      ?? (issue.assignedToId && issue.assignedToId !== me.id ? issue.assignedToId : undefined);
    record.context = { ...(record.context ?? {}), ...(developerId ? { handoffDeveloperId: developerId } : {}) };
    await this.store.saveOperationRecord(record);
    // Validate non-workflow fields before temporarily changing the assignee.
    const extra = await this.buildIssueFields(issue, command.input, false);
    if (extra.fields.assigned_to_id !== undefined && extra.fields.assigned_to_id !== qaId) {
      throw new ApiFault(400, 'MIXED_WORKFLOW_UPDATE_UNSUPPORTED', 'Передача в QA не може одночасно призначити іншого виконавця.');
    }
    delete extra.fields.assigned_to_id;
    if (!this.stepDone(record, 'assign-self')) {
      issue = await this.requireFreshIssue(issue.id);
      if (issue.assignedToId !== me.id) {
        if (!await this.writeIssueStep(record, issue, 'assign-self', 'Тимчасово призначити себе виконавцем', { assigned_to_id: me.id },
          updated => updated.assignedToId === me.id)) return;
      } else await this.completeStep(record, 'assign-self', 'Виконавець уже призначений поточному користувачу', 'skipped');
    }
    if (!this.stepDone(record, 'status')) {
      issue = await this.requireFreshIssue(issue.id);
      if (issue.statusId !== qaStatus.id) {
        this.assertTransition(issue, qaStatus.id);
        if (!await this.writeIssueStep(record, issue, 'status', 'Перевести задачу в QA', { status_id: qaStatus.id },
          updated => updated.statusId === qaStatus.id)) return;
      } else await this.completeStep(record, 'status', 'Задача вже в QA', 'skipped');
    }
    if (!this.stepDone(record, 'assign-qa')) {
      issue = await this.requireFreshIssue(issue.id);
      if (issue.assignedToId !== qaId) {
        if (!await this.writeIssueStep(record, issue, 'assign-qa', 'Призначити обраного QA', { assigned_to_id: qaId },
          updated => updated.assignedToId === qaId)) return;
      } else await this.completeStep(record, 'assign-qa', 'Обраний QA вже призначений', 'skipped');
    }
    issue = await this.requireFreshIssue(issue.id);
    if (Object.keys(extra.fields).length && !await this.writeIssueStep(record, issue, 'handoff-extra', 'Зберегти додаткові зміни задачі', extra.fields,
      updated => issueFieldsMatch(updated, extra.fields, extra.labels, extra.branch))) return;
    const fresh = await this.refreshIssue(issue.id);
    if (fresh.statusId !== qaStatus.id || fresh.assignedToId !== qaId) return this.block(record, 'Передачу в QA не підтверджено.', 'REMOTE_STATE_MISMATCH', fresh);
    await this.store.setIssueRoles(fresh.id, developerId, qaId);
    fresh.developerId = developerId;
    fresh.qaId = qaId;
    record.issue = fresh;
    record.operation.status = 'done';
    await this.finish(record);
    this.events?.publish('issue', { issueId: fresh.id, projectId: fresh.projectId });
  }

  private async returnToDeveloper(record: OperationRecord, command: Command): Promise<void> {
    const issue = await this.requireFreshIssue(command.issueId);
    this.assertExpectedUpdatedOn(record, issue, command.input);
    if (record.context?.workflowKind !== 'returnToDeveloper') {
      record.context = { ...(record.context ?? {}), workflowKind: 'returnToDeveloper' };
      await this.store.saveOperationRecord(record);
    }
    const current = await this.statusById(issue.statusId);
    const todo = await this.statusByKey('todo');
    if (!todo) return this.block(record, 'Статус To Do не налаштований.', 'WORKFLOW_UNAVAILABLE', issue);
    const developerId = numberField(command.input, 'developerId') ?? issue.developerId;
    if (!developerId) return this.block(record, 'Не вдалося визначити розробника. Виберіть його вручну.', 'DEVELOPER_REQUIRED', issue);
    await this.assertProjectMember(issue.projectId, developerId);
    if (current?.key !== 'todo' && !['qa', 'review'].includes(current?.key ?? '')) {
      return this.block(record, 'Повернення доступне лише з QA або Review.', 'TRANSITION_NOT_ALLOWED', issue);
    }
    if (current?.key !== 'todo') this.assertTransition(issue, todo.id);
    const extra = await this.buildIssueFields(issue, command.input, false);
    if (extra.fields.assigned_to_id !== undefined && extra.fields.assigned_to_id !== developerId) {
      throw new ApiFault(400, 'MIXED_WORKFLOW_UPDATE_UNSUPPORTED', 'Повернення в To Do має призначити збереженого розробника.');
    }
    delete extra.fields.assigned_to_id;
    const fields = { ...extra.fields, status_id: todo.id, assigned_to_id: developerId };
    if (!await this.writeIssueStep(record, issue, 'return', 'Повернути задачу в To Do розробнику',
      fields, updated => updated.statusId === todo.id && updated.assignedToId === developerId
        && issueFieldsMatch(updated, extra.fields, extra.labels, extra.branch))) return;
    const fresh = await this.refreshIssue(issue.id);
    await this.store.setIssueRoles(fresh.id, developerId, fresh.qaId);
    fresh.developerId = developerId;
    record.issue = fresh;
    record.operation.status = 'done';
    await this.finish(record);
    this.events?.publish('issue', { issueId: fresh.id, projectId: fresh.projectId });
  }

  private async comment(record: OperationRecord, command: Command): Promise<void> {
    const issue = await this.requireFreshIssue(command.issueId);
    const notes = stringField(command.input, 'notes')?.trim();
    if (!notes) throw new ApiFault(400, 'COMMENT_REQUIRED', 'Введіть текст коментаря.');
    if (!this.stepDone(record, 'comment')) {
      await this.beginRequest(record, 'comment', 'Додати коментар у Redmine');
      try { await this.adapter.updateIssue(issue.id, { notes }); }
      catch (error) {
        if (isOutcomeUnknown(error, true)) { await this.unknown(record, 'comment', safeMessage(error)); return; }
        throw mapRedmineError(error);
      }
      await this.completeStep(record, 'comment', 'Додати коментар у Redmine');
    }
    record.issue = issue;
    record.operation.status = 'done';
    this.events?.publish('issue', { issueId: issue.id, projectId: issue.projectId });
  }

  private async generateBranch(record: OperationRecord, command: Command): Promise<void> {
    const issue = await this.requireFreshIssue(command.issueId);
    const branch = branchForIssue(issue.id, issue.subject);
    const metadata = await this.writeMetadata(issue.projectId);
    if (!metadata.branchFieldId) return this.block(record, 'Поле Branch недоступне для запису в Redmine.', 'BRANCH_FIELD_UNAVAILABLE', issue);
    if (!await this.writeIssueStep(record, issue, 'branch', 'Записати Branch задачі', { custom_fields: [{ id: metadata.branchFieldId, value: branch }] },
      updated => updated.branch === branch)) return;
    record.issue = await this.refreshIssue(issue.id);
    record.operation.status = 'done';
    await this.finish(record);
    this.events?.publish('issue', { issueId: issue.id, projectId: issue.projectId });
  }

  private async createRelease(record: OperationRecord, command: Command): Promise<void> {
    const projectId = command.projectId ?? numberField(command.input, 'projectId');
    const project = projectId && (await this.store.getProjects()).find(item => item.id === projectId);
    const name = stringField(command.input, 'name')?.trim();
    if (!projectId || !project) throw new ApiFault(400, 'PROJECT_REQUIRED', 'Виберіть доступний проєкт.');
    if (!name) throw new ApiFault(400, 'RELEASE_NAME_REQUIRED', 'Вкажіть назву релізу.');
    const issueIds = uniqueNumbers(command.input.issueIds);
    for (const id of issueIds) {
      const issue = await this.requireFreshIssue(id);
      if (issue.projectId !== projectId) throw new ApiFault(400, 'CROSS_PROJECT_RELEASE', `Задача #${id} належить іншому проєкту; версію не створено.`);
    }
    const fields: Record<string, unknown> = { name,
      ...(stringField(command.input, 'dueDate') ? { due_date: optionalDate(command.input.dueDate) } : {}),
      ...(stringField(command.input, 'description') ? { description: stringField(command.input, 'description') } : {}) };
    let version = record.version;
    if (!this.stepDone(record, 'create-version')) {
      const priorVersionId = numberField(record.context ?? {}, 'createdVersionId') ?? record.operation.versionId;
      if (priorVersionId) {
        try { version = await this.requireVersion(priorVersionId, true); }
        catch (error) { await this.unknown(record, 'create-version', `ID версії #${priorVersionId} уже збережено, але результат створення неможливо підтвердити: ${safeMessage(error)}`); return; }
        if (version.projectId !== projectId || version.name !== name) {
          await this.unknown(record, 'create-version', `Версію #${priorVersionId} знайдено, але вона не відповідає операції; повторне створення заборонено.`); return;
        }
        record.version = version;
        await this.completeStep(record, 'create-version', 'Підтвердити створену версію за збереженим ID');
      } else {
        await this.beginRequest(record, 'create-version', 'Створити версію в Redmine');
        try { version = await this.adapter.createVersion(projectId, fields); }
        catch (error) {
          if (isOutcomeUnknown(error, true)) { await this.unknown(record, 'create-version', safeMessage(error)); return; }
          throw mapRedmineError(error);
        }
        if (!version?.id) { await this.unknown(record, 'create-version', 'Redmine прийняв версію, але не повернув її ID.'); return; }
        record.operation.versionId = version.id;
        record.version = version;
        record.context = { ...(record.context ?? {}), createdVersionId: version.id, inFlightStep: undefined };
        await this.store.saveOperationRecord(record);
        await this.completeStep(record, 'create-version', 'Створити версію в Redmine');
      }
    }
    version ??= await this.requireVersion(Number(record.context?.createdVersionId ?? record.operation.versionId), true);
    for (const id of issueIds) {
      const key = `member:${id}`;
      if (this.stepDone(record, key)) continue;
      const issue = await this.requireFreshIssue(id);
      if (issue.projectId !== projectId) return this.block(record, `Задача #${id} належить іншому проєкту.`, 'CROSS_PROJECT_RELEASE', issue, version);
      if (issue.fixedVersionId !== version.id) {
        if (!await this.writeIssueStep(record, issue, key, `Додати задачу #${id} до версії`, { fixed_version_id: version.id },
          updated => updated.fixedVersionId === version.id)) return;
      } else await this.completeStep(record, key, `Задача #${id} уже належить версії`, 'skipped');
    }
    record.version = await this.requireVersion(version.id, true);
    record.operation.status = 'done';
    await this.finish(record);
    this.events?.publish('release', { versionId: version.id, projectId });
  }

  private async updateRelease(record: OperationRecord, command: Command): Promise<void> {
    let version = await this.requireVersion(command.versionId, true);
    const input = command.input;
    const requestedProjectId = command.projectId ?? numberField(input, 'projectId');
    if (requestedProjectId !== undefined && requestedProjectId !== version.projectId) {
      throw new ApiFault(404, 'VERSION_NOT_FOUND', 'Версія не належить вибраному доступному проєкту.');
    }
    const fields: Record<string, unknown> = {};
    if (typeof input.name === 'string') {
      const name = input.name.trim();
      if (!name) throw new ApiFault(400, 'RELEASE_NAME_REQUIRED', 'Назва версії не може бути порожньою.');
      fields.name = name;
    }
    if (typeof input.dueDate === 'string' || input.dueDate === null) fields.due_date = input.dueDate === null || input.dueDate === '' ? null : optionalDate(input.dueDate);
    if (typeof input.description === 'string' || input.description === null) fields.description = input.description;
    if (input.status === 'closed') throw new ApiFault(409, 'USE_FINISH_RELEASE', 'Закриття версії доступне лише через перевірку команди завершення релізу.');
    if (input.status === 'open' || input.status === 'locked') fields.status = input.status;
    if (!Object.keys(fields).length) throw new ApiFault(400, 'NO_CHANGES', 'Немає змін для збереження.');
    if (!this.stepDone(record, 'update-version')) {
      if (record.context?.awaitingVerification === 'update-version') {
        version = await this.requireVersion(version.id, true);
        if (!versionMatches(version, fields)) return this.block(record, 'Зміни версії не підтверджено після запису.', 'REMOTE_STATE_MISMATCH', undefined, version);
        await this.completeStep(record, 'update-version', 'Оновити версію в Redmine');
      } else {
        await this.beginRequest(record, 'update-version', 'Оновити версію в Redmine');
        try { await this.adapter.updateVersion(version.id, fields); }
        catch (error) {
          if (isOutcomeUnknown(error, false)) { await this.unknown(record, 'update-version', safeMessage(error)); return; }
          throw mapRedmineError(error);
        }
        record.context = { ...(record.context ?? {}), inFlightStep: undefined, awaitingVerification: 'update-version' };
        await this.store.saveOperationRecord(record);
        version = await this.requireVersion(version.id, true);
        if (!versionMatches(version, fields)) return this.block(record, 'Зміни версії не підтверджено після запису.', 'REMOTE_STATE_MISMATCH', undefined, version);
        await this.completeStep(record, 'update-version', 'Оновити версію в Redmine');
      }
    }
    record.version = version;
    record.operation.status = 'done';
    await this.finish(record);
    this.events?.publish('release', { versionId: version.id, projectId: version.projectId });
  }

  private async assignRelease(record: OperationRecord, command: Command): Promise<void> {
    const removing = command.input.fixedVersionId === null;
    const versionId = removing ? command.versionId ?? numberField(command.input, 'versionId')
      : numberField(command.input, 'fixedVersionId') ?? command.versionId ?? numberField(command.input, 'versionId');
    const version = await this.requireVersion(versionId, true);
    const ids = uniqueNumbers(command.input.issueIds);
    if (!ids.length) throw new ApiFault(400, 'ISSUES_REQUIRED', 'Виберіть хоча б одну задачу.');
    for (const id of ids) {
      const key = `member:${id}`;
      if (this.stepDone(record, key)) continue;
      const issue = await this.requireFreshIssue(id);
      if (issue.projectId !== version.projectId) return this.block(record, `Задача #${id} належить іншому проєкту.`, 'CROSS_PROJECT_RELEASE', issue, version);
      if (removing && issue.fixedVersionId !== version.id) return this.block(record, `Задача #${id} більше не належить цій версії.`, 'RELEASE_MEMBERSHIP_CHANGED', issue, version);
      const fields = { fixed_version_id: removing ? null : version.id };
      const desired = removing ? undefined : version.id;
      if (issue.fixedVersionId !== desired) {
        if (!await this.writeIssueStep(record, issue, key,
          removing ? `Вилучити задачу #${id} із версії` : `Додати задачу #${id} до версії`, fields,
          updated => updated.fixedVersionId === desired)) return;
      } else await this.completeStep(record, key, `Склад задачі #${id} уже актуальний`, 'skipped');
    }
    record.version = await this.requireVersion(version.id, true);
    record.issue = await this.refreshIssue(ids[0]!);
    record.operation.status = 'done';
    await this.finish(record);
    this.events?.publish('release', { versionId: version.id, projectId: version.projectId });
  }

  private async finishRelease(record: OperationRecord, command: Command): Promise<void> {
    const version = await this.requireVersion(command.versionId ?? numberField(command.input, 'versionId'), true);
    const statuses = await this.statuses();
    const done = statuses.find(status => status.key === 'done' && status.isClosed);
    const deploy = statuses.find(status => status.key === 'deploy');
    if (!done || !deploy) return this.block(record, 'Для завершення потрібні успішний закритий Done і статус Deploy.', 'RELEASE_NOT_READY', undefined, version);
    let members = await this.freshReleaseMembers(version);
    if (!record.context?.releaseIssueIds) {
      const readiness = releaseReadiness(members, statuses);
      if (!readiness.ready) return this.block(record, 'Усі задачі релізу мають бути в Deploy або успішному Done перед завершенням.',
        'RELEASE_NOT_READY', readiness.pending[0], version, { issueIds: readiness.pending.map(issue => issue.id) });
      record.context = { ...(record.context ?? {}), releaseIssueIds: members.map(issue => issue.id).sort((a, b) => a - b), doneStatusId: done.id };
      await this.store.saveOperationRecord(record);
    }
    const expected = (record.context.releaseIssueIds as number[]).slice().sort((a, b) => a - b);
    const currentIds = members.map(issue => issue.id).sort((a, b) => a - b);
    if (!sameNumbers(expected, currentIds)) return this.block(record, 'Склад версії змінився. Перевірте її склад і створіть нову команду завершення.', 'STALE', undefined, version);
    for (const id of expected) {
      const key = `issue:${id}`;
      let issue = await this.requireFreshIssue(id);
      if (issue.fixedVersionId !== version.id) return this.block(record, `Задача #${id} більше не належить цій версії.`, 'STALE', issue, version);
      if (issue.statusId === done.id) {
        if (!this.stepDone(record, key)) await this.completeStep(record, key, `Задача #${id} вже успішно завершена`, 'skipped');
        continue;
      }
      if (issue.statusId !== deploy.id) return this.block(record, `Задача #${id} більше не в Deploy.`, 'RELEASE_NOT_READY', issue, version);
      if (!this.stepDone(record, key)) {
        this.assertTransition(issue, done.id);
        if (!await this.writeIssueStep(record, issue, key, `Перевести задачу #${id} у Done`, { status_id: done.id },
          updated => updated.statusId === done.id && updated.fixedVersionId === version.id)) return;
      }
      issue = await this.requireFreshIssue(id);
      if (issue.statusId !== done.id || issue.fixedVersionId !== version.id) return this.block(record, `Завершення задачі #${id} не підтверджено.`, 'REMOTE_STATE_MISMATCH', issue, version);
    }
    // Re-read membership and every issue before closing the Version.
    members = await this.freshReleaseMembers(version);
    if (!sameNumbers(expected, members.map(issue => issue.id).sort((a, b) => a - b))) {
      return this.block(record, 'Склад версії змінився перед її закриттям.', 'STALE', undefined, version);
    }
    for (const member of members) {
      const issue = await this.requireFreshIssue(member.id);
      if (issue.fixedVersionId !== version.id || issue.statusId !== done.id) {
        return this.block(record, `Задача #${issue.id} більше не відповідає умовам завершення. Версію не закрито.`, 'STALE', issue, version);
      }
    }
    let latest = await this.requireVersion(version.id, true);
    if (latest.status !== 'closed') {
      if (record.context?.awaitingVerification === 'close-version') {
        return this.block(record, 'Redmine не підтвердив закриття після прийняття запиту. Перевірте версію вручну перед новою дією.', 'REMOTE_STATE_MISMATCH', undefined, latest);
      }
      if (this.stepDone(record, 'close-version')) return this.block(record, 'Версію знову відкрили після закриття.', 'STALE', undefined, latest);
      {
        await this.beginRequest(record, 'close-version', 'Закрити версію Redmine');
        try { await this.adapter.updateVersion(version.id, { status: 'closed' }); }
        catch (error) {
          if (isOutcomeUnknown(error, false)) { await this.unknown(record, 'close-version', safeMessage(error)); return; }
          throw mapRedmineError(error);
        }
        record.context = { ...(record.context ?? {}), inFlightStep: undefined, awaitingVerification: 'close-version' };
        await this.store.saveOperationRecord(record);
      }
      latest = await this.requireVersion(version.id, true);
      if (latest.status !== 'closed') return this.block(record, 'Redmine не підтвердив закриття версії.', 'REMOTE_STATE_MISMATCH', undefined, latest);
      await this.completeStep(record, 'close-version', 'Закрити версію Redmine');
    } else if (!this.stepDone(record, 'close-version')) await this.completeStep(record, 'close-version', 'Версію вже закрито', 'skipped');
    record.version = latest;
    record.operation.status = 'done';
    await this.finish(record);
    this.events?.publish('release', { versionId: version.id, projectId: version.projectId });
  }

  private async processAutomations(issueId: number | undefined, commandRecord: OperationRecord): Promise<CommandResult> {
    const settings = await this.store.getSettings();
    if (!settings.automationEnabled) {
      await this.block(commandRecord, 'Автоматизації вимкнені в налаштуваннях.', 'OPERATION_BLOCKED');
      return result(commandRecord);
    }
    const pending = commandRecord.context?.automationTrigger && commandRecord.context.realWrite === true
      ? [commandRecord]
      : (await this.store.getOperationRecords()).filter(record => record.operation.type === 'runAutomation'
      && record.operation.status === 'pending' && record.context?.realWrite === true && record.context?.automationTrigger
      && (issueId === undefined || record.operation.issueId === issueId));
    const results: Operation[] = [];
    for (const record of pending) {
      const trigger = record.context!.automationTrigger as { expectedUpdatedOn: string; reviewStatusId: number; developerId?: number };
      let issue: Issue | undefined;
      try { issue = record.operation.issueId ? await this.requireFreshIssue(record.operation.issueId) : undefined; }
      catch (error) {
        if (error instanceof ApiFault && error.statusCode === 404 || error instanceof RedmineRequestError && error.statusCode === 404) {
          record.operation.status = 'blocked'; record.operation.errorCode = 'STALE'; record.operation.error = 'Задачу події CI видалено або вона стала недоступною.';
        } else {
          // Keep this new event pending; a transient read failure is not evidence that its trigger went stale.
          record.operation.status = 'pending'; record.operation.errorCode = 'AUTOMATION_READ_FAILED'; record.operation.error = safeMessage(error);
        }
        await this.store.saveOperationRecord(record); results.push(record.operation); continue;
      }
      const review = await this.statusByKey('review');
      const todo = await this.statusByKey('todo');
      const checkpointedReturn = this.stepDone(record, 'return') || record.context?.awaitingVerification === 'return';
      const savedDeveloperId = numberField(record.context ?? {}, 'automationDeveloperId') ?? trigger.developerId;
      if (issue && todo && checkpointedReturn && issue.statusId === todo.id) {
        const developerId = savedDeveloperId ?? issue.developerId;
        if (developerId && issue.assignedToId === developerId) {
          if (!this.stepDone(record, 'return')) await this.completeStep(record, 'return', 'Підтвердити виконане повернення до To Do');
          await this.store.setIssueRoles(issue.id, developerId, issue.qaId);
          issue.developerId = developerId;
          record.issue = issue;
          record.operation.status = 'done';
          await this.finish(record);
          results.push(record.operation);
          continue;
        }
        record.operation.status = 'blocked';
        record.operation.errorCode = 'REMOTE_STATE_MISMATCH';
        record.operation.error = 'Redmine не підтвердив призначення розробника після повернення задачі.';
        await this.store.saveOperationRecord(record); results.push(record.operation); continue;
      }
      if (!issue || !review || !todo || issue.statusId !== review.id || issue.updatedOn !== trigger.expectedUpdatedOn || !issue.labels.includes(this.config.ciFailedLabel)) {
        record.operation.status = 'blocked'; record.operation.errorCode = 'STALE'; record.operation.error = 'Подія CI застаріла; автоматизацію зупинено.';
        await this.store.saveOperationRecord(record); results.push(record.operation); continue;
      }
      const developerId = savedDeveloperId ?? issue.developerId;
      if (!developerId) {
        record.operation.status = 'blocked'; record.operation.errorCode = 'DEVELOPER_REQUIRED'; record.operation.error = 'Не вдалося визначити розробника; потрібен ручний вибір.';
        await this.store.saveOperationRecord(record); results.push(record.operation); continue;
      }
      try {
        record.context = { ...(record.context ?? {}), automationDeveloperId: developerId };
        await this.store.saveOperationRecord(record);
        this.assertTransition(issue, todo.id);
        if (!await this.writeIssueStep(record, issue, 'return', 'Повернути задачу в To Do розробнику',
          { status_id: todo.id, assigned_to_id: developerId }, updated => updated.statusId === todo.id && updated.assignedToId === developerId)) {
          results.push(record.operation);
          continue;
        }
        const updated = await this.refreshIssue(issue.id);
        await this.store.setIssueRoles(issue.id, developerId, updated.qaId);
        updated.developerId = developerId;
        record.issue = updated; record.operation.status = 'done';
        await this.finish(record); results.push(record.operation);
      } catch (error) {
        if (record.operation.errorCode === 'OUTCOME_UNKNOWN' || record.context?.outcomeUnknown === true) {
          results.push(record.operation);
          continue;
        }
        record.operation.status = 'failed'; record.operation.errorCode = errorCode(error); record.operation.error = safeMessage(error);
        await this.store.saveOperationRecord(record); results.push(record.operation);
      }
    }
    if (commandRecord.context?.automationTrigger && commandRecord.context.realWrite === true) return result(commandRecord);
    commandRecord.operation.status = results.some(item => item.status !== 'done') ? 'blocked' : 'done';
    commandRecord.operation.steps = results.length
      ? results.map(item => ({ name: `CI automation #${item.issueId}`, status: item.status === 'done' ? 'done' : 'blocked' }))
      : [{ name: 'Немає нових подій CI для обробки', status: 'skipped' }];
    await this.finish(commandRecord);
    return result(commandRecord);
  }

  private async buildIssueFields(issue: Issue, input: Record<string, unknown>, includeStatus: boolean): Promise<{
    fields: Record<string, unknown>; labels?: string[]; branch?: string; statusId?: number; status?: Status;
    developerId?: number; qaId?: number; developerIdChanged: boolean; qaIdChanged: boolean;
  }> {
    const fields: Record<string, unknown> = {};
    if (typeof input.subject === 'string') {
      const subject = input.subject.trim();
      if (!subject) throw new ApiFault(400, 'SUBJECT_REQUIRED', 'Назва задачі не може бути порожньою.');
      fields.subject = subject;
    }
    if (typeof input.description === 'string') fields.description = input.description;
    if (typeof input.priorityId === 'number') {
      const priorities = await this.store.getValue<{ id: number }[]>('priorities') ?? [];
      if (!priorities.some(value => value.id === input.priorityId)) throw new ApiFault(400, 'PRIORITY_REQUIRED', 'Виберіть доступний пріоритет.');
      fields.priority_id = input.priorityId;
    }
    if (typeof input.trackerId === 'number') {
      const project = (await this.store.getProjects()).find(value => value.id === issue.projectId);
      if (!project?.trackers?.some(value => value.id === input.trackerId)) throw new ApiFault(400, 'TRACKER_REQUIRED', 'Виберіть тип задачі, доступний у цьому проєкті.');
      fields.tracker_id = input.trackerId;
    }
    if (typeof input.assignedToId === 'number' || input.assignedToId === null) {
      if (typeof input.assignedToId === 'number') await this.assertProjectMember(issue.projectId, input.assignedToId);
      fields.assigned_to_id = input.assignedToId;
    }
    if (typeof input.fixedVersionId === 'number' || input.fixedVersionId === null || input.removeVersion === true) {
      const versionId = input.fixedVersionId === null || input.removeVersion === true ? undefined : numberField(input, 'fixedVersionId');
      if (versionId) {
        const version = await this.requireVersion(versionId, true);
        if (version.projectId !== issue.projectId) throw new ApiFault(400, 'CROSS_PROJECT_RELEASE', 'Виберіть реліз цього проєкту.');
      }
      fields.fixed_version_id = versionId ?? null;
    }
    if (typeof input.dueDate === 'string' || input.dueDate === null) fields.due_date = input.dueDate === null || input.dueDate === '' ? null : optionalDate(input.dueDate);
    let labels: string[] | undefined;
    let branch: string | undefined;
    let customFields: { id: number; value: unknown }[] = [];
    if (Array.isArray(input.labels)) {
      labels = normalizeLabels(input.labels);
      const metadata = await this.writeMetadata(issue.projectId);
      if (!metadata.labelFieldIds.length) throw new ApiFault(400, 'LABELS_UNAVAILABLE', 'У проєкті немає доступного для запису поля Labels/Tags.');
      const custom = this.labelCustomFields(labels, metadata);
      customFields.push(...custom);
    }
    if (typeof input.branch === 'string') {
      const metadata = await this.writeMetadata(issue.projectId);
      if (!metadata.branchFieldId) throw new ApiFault(400, 'BRANCH_FIELD_UNAVAILABLE', 'Поле Branch недоступне для запису в цьому проєкті.');
      branch = input.branch.trim();
      customFields = customFields.filter(field => field.id !== metadata.branchFieldId);
      customFields.push({ id: metadata.branchFieldId, value: branch });
    }
    if (customFields.length) fields.custom_fields = customFields;
    const statusId = includeStatus ? await this.requestedStatus(input, false) : undefined;
    if (statusId) fields.status_id = statusId.id;
    const developerIdChanged = typeof input.developerId === 'number' || input.developerId === null;
    const qaIdChanged = typeof input.qaId === 'number' || input.qaId === null;
    const developerId = developerIdChanged ? (input.developerId === null ? undefined : numberField(input, 'developerId')) : issue.developerId;
    const qaId = qaIdChanged ? (input.qaId === null ? undefined : numberField(input, 'qaId')) : issue.qaId;
    if (developerIdChanged && developerId) await this.assertProjectMember(issue.projectId, developerId);
    if (qaIdChanged && qaId) await this.assertProjectMember(issue.projectId, qaId);
    return { fields, labels, branch, statusId: statusId?.id, status: statusId, developerId, qaId, developerIdChanged, qaIdChanged };
  }

  private async writeIssueStep(record: OperationRecord, before: Issue, key: string, name: string, fields: Record<string, unknown>,
    verify: (issue: Issue) => boolean): Promise<boolean> {
    if (this.stepDone(record, key)) {
      const refreshed = await this.refreshIssue(before.id);
      if (!verify(refreshed)) { await this.block(record, `${name}: стан змінився після виконання кроку.`, 'STALE', refreshed); return false; }
      return true;
    }
    if (record.context?.awaitingVerification === key) {
      const refreshed = await this.refreshIssue(before.id);
      if (!verify(refreshed)) { await this.block(record, `${name}: Redmine не підтвердив очікуваний стан.`, 'REMOTE_STATE_MISMATCH', refreshed); return false; }
      await this.completeStep(record, key, name);
      return true;
    }
    await this.beginRequest(record, key, name);
    try { await this.adapter.updateIssue(before.id, fields); }
    catch (error) {
      if (isOutcomeUnknown(error, false)) {
        try {
          const refreshed = await this.refreshIssue(before.id);
          if (verify(refreshed)) {
            record.operation.status = 'running';
            delete record.operation.error; delete record.operation.errorCode;
            record.context = { ...(record.context ?? {}), inFlightStep: undefined, awaitingVerification: undefined, outcomeUnknown: undefined };
            await this.completeStep(record, key, name);
            return true;
          }
        } catch { /* preserve the unknown outcome below */ }
        await this.unknown(record, key, safeMessage(error));
        return false;
      }
      throw mapRedmineError(error);
    }
    record.context = { ...(record.context ?? {}), inFlightStep: undefined, awaitingVerification: key };
    await this.store.saveOperationRecord(record);
    const refreshed = await this.refreshIssue(before.id);
    if (!verify(refreshed)) { await this.block(record, `${name}: Redmine не підтвердив очікуваний стан.`, 'REMOTE_STATE_MISMATCH', refreshed); return false; }
    await this.completeStep(record, key, name);
    return true;
  }

  private async refreshIssue(id: number): Promise<Issue> {
    const catalogs = await this.store.getValue<Record<string, LabelOption[]>>('labelOptions') ?? {};
    const detail = await this.adapter.issueDetail(id, catalogs, false);
    if (!(await this.store.getProjects()).some(project => project.id === detail.issue.projectId)) throw new ApiFault(404, 'ISSUE_NOT_FOUND', 'Задачу не знайдено в доступному проєкті.');
    const old = await this.store.getIssue(id);
    const issue = { ...detail.issue, developerId: old?.developerId, qaId: old?.qaId };
    await this.store.saveIssue(issue);
    for (const journal of detail.journals) await this.store.saveJournal(id, journal);
    const people = new Map<number, Person>((await this.store.getValue<Person[]>('people') ?? []).map(person => [person.id, person]));
    for (const person of detail.people) people.set(person.id, person);
    await this.store.setValue('people', [...people.values()]);
    return issue;
  }

  private async requireFreshIssue(id?: number): Promise<Issue> {
    if (!id) throw new ApiFault(400, 'ISSUE_REQUIRED', 'Не вказано задачу.');
    try { return await this.refreshIssue(id); }
    catch (error) {
      if (error instanceof RedmineRequestError && error.statusCode === 404) throw new ApiFault(404, 'ISSUE_NOT_FOUND', 'Задачу не знайдено в Redmine.');
      throw error;
    }
  }

  private async requireVersion(id?: number, fresh = false): Promise<Version> {
    if (!id) throw new ApiFault(400, 'VERSION_REQUIRED', 'Не вказано версію.');
    if (fresh) {
      try {
        const version = await this.adapter.versionDetail(id);
        if (!(await this.store.getProjects()).some(project => project.id === version.projectId)) {
          throw new ApiFault(404, 'VERSION_NOT_FOUND', 'Версію не знайдено у доступному проєкті.');
        }
        await this.store.saveVersion(version);
        return version;
      } catch (error) {
        if (error instanceof RedmineRequestError && error.statusCode === 404) throw new ApiFault(404, 'VERSION_NOT_FOUND', 'Версію не знайдено в Redmine.');
        throw error;
      }
    }
    const version = await this.store.getVersion(id);
    if (!version) throw new ApiFault(404, 'VERSION_NOT_FOUND', 'Версію не знайдено.');
    return version;
  }

  private async freshReleaseMembers(version: Version): Promise<Issue[]> {
    const catalogs = await this.store.getValue<Record<string, LabelOption[]>>('labelOptions') ?? {};
    const list = await this.adapter.releaseIssues(version.id, version.projectId, catalogs[String(version.projectId)] ?? []);
    const accessible = new Set((await this.store.getProjects()).map(project => project.id));
    if (!accessible.has(version.projectId)) throw new ApiFault(404, 'VERSION_NOT_FOUND', 'Проєкт версії недоступний.');
    const details = await Promise.all(list.map(issue => this.requireFreshIssue(issue.id)));
    return details.filter(issue => issue.fixedVersionId === version.id);
  }

  private async writeMetadata(projectId: number): Promise<WriteMetadata> {
    const adapter = this.adapter as AdapterWithWriteMetadata;
    if (adapter.writeFieldMetadata) {
      const fresh = await adapter.writeFieldMetadata(projectId);
      const catalogs = await this.store.getValue<Record<string, LabelOption[]>>('labelOptions') ?? {};
      catalogs[String(projectId)] = fresh.labelOptions;
      await this.store.setValue('labelOptions', catalogs);
      const capabilities = await this.store.getValue<Record<string, unknown>>('capabilities') ?? {};
      await this.store.setValue('capabilities', { ...capabilities, branchFieldId: fresh.branchFieldId, labelsFieldId: fresh.labelFieldIds[0] });
      return fresh;
    }
    const labels = (await this.store.getValue<Record<string, LabelOption[]>>('labelOptions'))?.[String(projectId)] ?? [];
    const capabilities = await this.store.getValue<{ branchFieldId?: number; labelsFieldId?: number }>('capabilities');
    return { branchFieldId: capabilities?.branchFieldId, labelFieldIds: [...new Set(labels.flatMap(item => item.fieldId ? [item.fieldId] : []))].length
      ? [...new Set(labels.flatMap(item => item.fieldId ? [item.fieldId] : []))]
      : capabilities?.labelsFieldId ? [capabilities.labelsFieldId] : [], labelOptions: labels };
  }

  private labelCustomFields(labels: string[], metadata: WriteMetadata): { id: number; value: string[] }[] {
    if (!metadata.labelFieldIds.length) return [];
    const selected = new Set(labels);
    const fields = metadata.labelFieldIds.map(fieldId => ({ id: fieldId,
      value: metadata.labelOptions.filter(option => option.fieldId === fieldId && selected.has(option.name)).map(option => option.id) }));
    const mapped = new Set(fields.flatMap(field => metadata.labelOptions.filter(option => option.fieldId === field.id && field.value.includes(option.id)).map(option => option.name)));
    if (labels.some(label => !mapped.has(label))) throw new ApiFault(400, 'LABEL_UNAVAILABLE', 'Виберіть Labels/Tags із довідника Redmine цього проєкту.');
    return fields;
  }

  private async assertProjectMember(projectId: number, personId: number): Promise<void> {
    if (!Number.isSafeInteger(personId) || personId <= 0) throw new ApiFault(400, 'PERSON_REQUIRED', 'Виберіть коректного учасника проєкту.');
    if (!(await this.store.getProjects()).some(project => project.id === projectId)) throw new ApiFault(404, 'PROJECT_NOT_FOUND', 'Проєкт не знайдено.');
    const membershipIds = await this.store.getValue<Record<string, number[]>>('projectMembershipIds');
    const projectIds = membershipIds?.[String(projectId)];
    if (projectIds && !projectIds.includes(personId)) throw new ApiFault(400, 'PERSON_NOT_PROJECT_MEMBER', 'Людина не є учасником цього проєкту Redmine.');
  }

  private async statuses(): Promise<Status[]> { return await this.store.getValue<Status[]>('statuses') ?? []; }
  private async statusByKey(key: Status['key']): Promise<Status | undefined> { return (await this.statuses()).find(item => item.key === key); }
  private async statusById(id: number): Promise<Status | undefined> { return (await this.statuses()).find(item => item.id === id); }
  private async requestedStatus(input: Record<string, unknown>, required = true): Promise<Status | undefined> {
    if (typeof input.statusId === 'number') {
      const status = await this.statusById(input.statusId);
      if (!status) throw new ApiFault(400, 'STATUS_REQUIRED', 'Виберіть доступний статус.');
      return status;
    }
    if (typeof input.statusKey === 'string') {
      const status = await this.statusByKey(input.statusKey as Status['key']);
      if (!status) throw new ApiFault(400, 'STATUS_REQUIRED', 'Виберіть доступний статус.');
      return status;
    }
    if (required) return undefined;
    return undefined;
  }

  private assertTransition(issue: Issue, targetStatusId: number): void {
    if (issue.statusId === targetStatusId) return;
    if (!issue.allowedStatusIds) throw new ApiFault(409, 'WORKFLOW_UNVERIFIED', 'Redmine не повернув доступні переходи для цієї задачі; статус не змінено.');
    if (!issue.allowedStatusIds.includes(targetStatusId)) throw new ApiFault(409, 'TRANSITION_NOT_ALLOWED', 'Redmine workflow не дозволяє цей перехід.');
  }

  private assertExpectedUpdatedOn(record: OperationRecord, issue: Issue, input: Record<string, unknown>): void {
    if (((record.context?.completedSteps as string[] | undefined) ?? []).length > 0 || record.context?.awaitingVerification) return;
    if (input.expectedUpdatedOn === undefined) return;
    if (typeof input.expectedUpdatedOn !== 'string') throw new ApiFault(400, 'INVALID_UPDATED_ON', 'expectedUpdatedOn має бути рядком.');
    if (input.expectedUpdatedOn !== issue.updatedOn) throw new ApiFault(409, 'STALE', 'Картка змінилася. Оновіть її перед збереженням.', { expectedUpdatedOn: input.expectedUpdatedOn, actualUpdatedOn: issue.updatedOn });
  }

  private async beginRequest(record: OperationRecord, key: string, name: string): Promise<void> {
    record.context = { ...(record.context ?? {}), inFlightStep: key };
    const steps = record.operation.steps.filter(step => step.status === 'done' || step.status === 'skipped');
    steps.push({ name, status: 'pending' });
    record.operation.steps = steps;
    await this.store.saveOperationRecord(record);
  }
  private async completeStep(record: OperationRecord, key: string, name: string, status: OperationStep['status'] = 'done'): Promise<void> {
    const names = (record.context?.stepNames as Record<string, string> | undefined) ?? {};
    if (names[key]) record.operation.steps = record.operation.steps.filter(step => step.name !== names[key]);
    names[key] = name;
    const completed = new Set((record.context?.completedSteps as string[] | undefined) ?? []);
    if (status === 'done' || status === 'skipped') completed.add(key); else completed.delete(key);
    record.context = { ...(record.context ?? {}), stepNames: names, completedSteps: [...completed], inFlightStep: undefined,
      awaitingVerification: record.context?.awaitingVerification === key ? undefined : record.context?.awaitingVerification };
    record.operation.steps.push({ name, status });
    await this.store.saveOperationRecord(record);
  }
  private stepDone(record: OperationRecord, key: string): boolean {
    return ((record.context?.completedSteps as string[] | undefined) ?? []).includes(key);
  }
  private async unknown(record: OperationRecord, key: string, message: string): Promise<void> {
    record.operation.status = 'blocked';
    record.operation.errorCode = 'OUTCOME_UNKNOWN';
    record.operation.error = message;
    record.context = { ...(record.context ?? {}), outcomeUnknown: true, inFlightStep: undefined, unknownStep: key };
    record.operation.steps.push({ name: message, status: 'blocked', error: message });
    await this.finish(record);
  }
  private async block(record: OperationRecord, message: string, code: string, issue?: Issue, version?: Version, context?: Record<string, unknown>): Promise<void> {
    record.operation.status = 'blocked';
    record.operation.error = message;
    record.operation.errorCode = code;
    if (issue) record.issue = issue;
    if (version) record.version = version;
    record.context = { ...(record.context ?? {}), ...(context ?? {}) };
    record.operation.steps.push({ name: message, status: 'blocked', error: message });
    await this.finish(record);
  }
  private async finish(record: OperationRecord): Promise<void> {
    await this.store.saveOperationRecord(record);
    this.events?.publish('operation', { id: record.operation.id, status: record.operation.status });
  }
}

function result(record: OperationRecord): CommandResult {
  return { operation: { ...record.operation, retryable: realOperationRetryable(record) }, ...(record.issue ? { issue: record.issue } : {}), ...(record.version ? { version: record.version } : {}) };
}
function numberField(input: Record<string, unknown>, key: string): number | undefined {
  return typeof input[key] === 'number' && Number.isSafeInteger(input[key]) ? input[key] as number : undefined;
}
function stringField(input: Record<string, unknown>, key: string): string | undefined { return typeof input[key] === 'string' ? input[key] as string : undefined; }
function normalizeLabels(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))] : [];
}
function optionalDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiFault(400, 'INVALID_DUE_DATE', 'Дата завершення має бути у форматі РРРР-ММ-ДД.');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new ApiFault(400, 'INVALID_DUE_DATE', 'Дата завершення некоректна.');
  return value;
}
function uniqueNumbers(value: unknown): number[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is number => Number.isSafeInteger(item) && item > 0))] : [];
}
function issueFieldsMatch(issue: Issue, fields: Record<string, unknown>, labels?: string[], branch?: string): boolean {
  if (typeof fields.subject === 'string' && issue.subject !== fields.subject) return false;
  if (typeof fields.description === 'string' && issue.description !== fields.description) return false;
  if (typeof fields.status_id === 'number' && issue.statusId !== fields.status_id) return false;
  if (typeof fields.priority_id === 'number' && issue.priorityId !== fields.priority_id) return false;
  if (typeof fields.tracker_id === 'number' && issue.trackerId !== fields.tracker_id) return false;
  if ('assigned_to_id' in fields && issue.assignedToId !== (fields.assigned_to_id === null ? undefined : fields.assigned_to_id)) return false;
  if ('fixed_version_id' in fields && issue.fixedVersionId !== (fields.fixed_version_id === null ? undefined : fields.fixed_version_id)) return false;
  if ('due_date' in fields && issue.dueDate !== (fields.due_date === null ? undefined : fields.due_date)) return false;
  if (branch !== undefined && issue.branch !== branch) return false;
  if (labels && JSON.stringify([...issue.labels].sort()) !== JSON.stringify([...labels].sort())) return false;
  return true;
}
function versionMatches(version: Version, fields: Record<string, unknown>): boolean {
  if (typeof fields.name === 'string' && version.name !== fields.name) return false;
  if ('due_date' in fields && version.dueDate !== (fields.due_date === null ? undefined : fields.due_date)) return false;
  if (typeof fields.description === 'string' && version.description !== fields.description) return false;
  if (typeof fields.status === 'string' && version.status !== fields.status) return false;
  return true;
}
function sameNumbers(left: number[], right: number[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function isOutcomeUnknown(error: unknown, post: boolean): boolean {
  if (error instanceof RedmineRequestError) return error.outcomeUnknown || error.statusCode !== undefined && error.statusCode >= 500
    || post && error.statusCode !== undefined && error.statusCode >= 200 && error.statusCode < 300;
  return true;
}
function mapRedmineError(error: unknown): Error {
  if (error instanceof ApiFault) return error;
  if (error instanceof RedmineRequestError) {
    if (error.outcomeUnknown || error.statusCode !== undefined && error.statusCode >= 500) return new ApiFault(409, 'OUTCOME_UNKNOWN', `${error.message} Перевірте Redmine перед повтором.`);
    if (error.statusCode === 401 || error.statusCode === 403) return new ApiFault(error.statusCode, 'REDMINE_FORBIDDEN', 'Redmine відмовив у доступі до цієї дії.');
    if (error.statusCode === 404) return new ApiFault(404, 'NOT_FOUND', 'Об’єкт не знайдено в Redmine.');
    if (error.statusCode === 422) return new ApiFault(422, 'REDMINE_VALIDATION', error.message);
    return new ApiFault(502, 'REDMINE_REQUEST_FAILED', error.message);
  }
  return error instanceof Error ? error : new Error('Команда не вдалася.');
}
function errorCode(error: unknown): string { return error instanceof ApiFault ? error.code : error instanceof RedmineRequestError ? error.code : 'COMMAND_FAILED'; }
function safeMessage(error: unknown): string { return error instanceof Error ? error.message : 'Команда не вдалася.'; }
function commandSignature(command: Command): string {
  const { operationId: _operationId, ...payload } = command;
  return createHash('sha256').update(JSON.stringify(sortObject(payload))).digest('hex');
}
function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortObject(item)]));
  return value;
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
function realOperationRetryable(record: OperationRecord): boolean {
  return record.context?.realWrite === true
    && ['failed', 'blocked'].includes(record.operation.status)
    && record.operation.errorCode !== 'OUTCOME_UNKNOWN'
    && record.context.outcomeUnknown !== true
    && typeof record.context.inFlightStep !== 'string'
    && !['UNSUPPORTED_CAPABILITY', 'LABEL_UNAVAILABLE', 'LABELS_UNAVAILABLE', 'STALE', 'REMOTE_STATE_MISMATCH', 'USE_FINISH_RELEASE'].includes(record.operation.errorCode ?? '');
}
function cryptoRandomId(): string { return randomUUID(); }
