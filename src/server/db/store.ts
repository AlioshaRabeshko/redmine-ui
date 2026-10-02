import { and, asc, desc, eq, isNotNull, isNull, notInArray } from 'drizzle-orm';
import type { AppSettings, Issue, Journal, Notification, Operation, PeopleField, Person, Project, Status, Priority, Version } from '../../shared/types.js';
import { demoIssues, demoJournalIssues, demoJournals, demoMe, demoPeople, demoPriorities, demoProjectMembers, demoProjects, demoStatuses, demoVersions } from '../demo/fixtures.js';
import { defaultSettings } from '../settings.js';
import { navigationShortcuts, normalizeShortcutKeys } from '../../shared/shortcuts.js';
import type { AppDatabase } from './connection.js';
import { drafts, issues, issueRoles, journals, keyValues, notifications, operations, peopleSelections, projects, sourceEvents, syncCursors, versions } from './schema.js';

export interface OperationRecord {
  operation: Operation;
  issue?: Issue;
  version?: Version;
  context?: Record<string, unknown>;
}
export interface PersonSelectionRecord {
  operationId: string;
  projectId: number;
  personId: number;
  field: PeopleField;
}
export type ProjectBackgroundContentType = 'image/jpeg' | 'image/png' | 'image/webp';
interface ProjectBackgroundRecord { version: string; contentType: ProjectBackgroundContentType; base64: string }
export interface StoredProjectBackground { version: string; contentType: ProjectBackgroundContentType; data: Buffer }

const encode = (value: unknown) => JSON.stringify(value);
const decode = <T>(value: string): T => JSON.parse(value) as T;
const demoMembershipRoles = {
  '10': { '2': [{ id: 1, name: 'Developer' }], '3': [{ id: 2, name: 'QA' }], '4': [{ id: 3, name: 'Support' }], '5': [{ id: 1, name: 'Developer' }, { id: 2, name: 'QA' }] },
  '20': { '3': [{ id: 2, name: 'QA' }], '4': [{ id: 1, name: 'Developer' }], '5': [{ id: 3, name: 'Support' }] },
};

export class WorkspaceStore {
  constructor(readonly db: AppDatabase, public scope: string) {}

  adoptInitialSettingsIntoUserScope(userScope: string, initialScope: string): void {
    if (this.scope === initialScope) {
      const existing = this.db.$client.prepare('SELECT value FROM key_values WHERE scope = ? AND key = ?').get(initialScope, 'settings') as { value: string } | undefined;
      if (existing) {
        this.db.$client.prepare('INSERT OR IGNORE INTO key_values (scope, key, value) VALUES (?, ?, ?)')
          .run(userScope, 'settings', existing.value);
      }
    }
    this.scope = userScope;
  }

  async initializeDemo(): Promise<void> {
    if (this.scope !== 'demo:isolated') return;
    const existingProjects = await this.getProjects();
    if (existingProjects.length > 0) {
      if (!(await this.getValue('projectMembershipIds'))) await this.setValue('projectMembershipIds', demoProjectMembers);
      if (!(await this.getValue('projectMembershipRoles'))) await this.setValue('projectMembershipRoles', demoMembershipRoles);
      for (const project of existingProjects) {
        const fixture = demoProjects.find(entry => entry.id === project.id);
        if (project.trackers === undefined && fixture?.trackers) await this.saveProject({ ...project, trackers: fixture.trackers });
      }
      return;
    }
    for (const project of demoProjects) await this.saveProject(project);
    for (const version of demoVersions) await this.saveVersion(version);
    for (const issue of demoIssues) await this.saveIssue(issue);
    await this.setValue('me', demoMe);
    await this.setValue('people', demoPeople);
    await this.setValue('statuses', demoStatuses);
    await this.setValue('priorities', demoPriorities);
    await this.setValue('projectMembers', demoProjectMembers);
    await this.setValue('projectMembershipIds', demoProjectMembers);
    await this.setValue('projectMembershipRoles', demoMembershipRoles);
    for (let i = 0; i < demoJournals.length; i++) {
      const journal = demoJournals[i]!;
      await this.saveJournal(demoJournalIssues[String(journal.id)]!, journal);
    }
    const settings = structuredClone(defaultSettings);
    settings.projectQa = { '10': 3, '20': 3 };
    settings.subscriptions = {
      '10': { enabled: true, events: ['comment'] },
      '20': { enabled: true, events: ['comment'] },
    };
    await this.setSettings(settings);
    const notificationExamples: Notification[] = [
      { id: 'demo-comment-9002', projectId: 10, issueId: 1001, journalId: 9002, actor: demoPeople[2]!, kind: 'comment', text: 'Перевірила сценарій повторного webhook. Є уточнення щодо backoff.', createdOn: demoJournals[1]!.createdOn },
      { id: 'demo-status-9003', projectId: 20, issueId: 2005, journalId: 9003, actor: demoPeople[4]!, kind: 'status', text: 'Перевів задачу в Deploy.', createdOn: demoJournals[2]!.createdOn },
    ];
    for (const notification of notificationExamples) await this.saveNotification(notification);
  }

  async getValue<T>(key: string): Promise<T | undefined> {
    const rows = await this.db.select({ value: keyValues.value }).from(keyValues)
      .where(and(eq(keyValues.scope, this.scope), eq(keyValues.key, key))).limit(1);
    return rows[0] ? decode<T>(rows[0].value) : undefined;
  }

  async setValue(key: string, value: unknown): Promise<void> {
    await this.db.insert(keyValues).values({ scope: this.scope, key, value: encode(value) })
      .onConflictDoUpdate({ target: [keyValues.scope, keyValues.key], set: { value: encode(value) } });
  }

  async saveProjectBackground(projectId: number, version: string, contentType: ProjectBackgroundContentType,
    data: Uint8Array, keepVersion?: string): Promise<void> {
    const key = `projectBackground:${projectId}`;
    const existing = await this.getValue<ProjectBackgroundRecord[]>(key) ?? [];
    const previous = keepVersion ? existing.find(item => item.version === keepVersion) : undefined;
    const records: ProjectBackgroundRecord[] = [{ version, contentType, base64: Buffer.from(data).toString('base64') }];
    if (previous && previous.version !== version) records.push(previous);
    await this.setValue(key, records);
  }

  async getProjectBackground(projectId: number, version?: string): Promise<StoredProjectBackground | undefined> {
    const records = await this.getValue<ProjectBackgroundRecord[]>(`projectBackground:${projectId}`) ?? [];
    const selected = version === undefined ? records[0] : records.find(item => item.version === version);
    if (!selected || !['image/jpeg', 'image/png', 'image/webp'].includes(selected.contentType)) return undefined;
    return { version: selected.version, contentType: selected.contentType, data: Buffer.from(selected.base64, 'base64') };
  }

  async getSettings(): Promise<AppSettings> {
    const settings = await this.getValue<AppSettings>('settings');
    if (!settings) {
      const initial = structuredClone(defaultSettings);
      await this.setSettings(initial);
      await this.setValue('settingsSchemaVersion', 2);
      return initial;
    }
    let compatible: AppSettings = {
      ...structuredClone(defaultSettings), ...settings,
      projectQa: settings.projectQa ?? {}, subscriptions: settings.subscriptions ?? {},
      projectBackgrounds: settings.projectBackgrounds ?? {},
      personRoleOverrides: settings.personRoleOverrides ?? {},
      shortcuts: settings.shortcuts ?? structuredClone(defaultSettings.shortcuts), savedViews: settings.savedViews ?? [],
      sort: { ...defaultSettings.sort, ...settings.sort },
      theme: settings.theme ?? defaultSettings.theme, palette: settings.palette ?? defaultSettings.palette,
    };
    const schemaVersion = await this.getValue<number>('settingsSchemaVersion') ?? 0;
    if (schemaVersion < 1) {
      compatible = { ...compatible, shortcuts: ensureSaveFormShortcut(compatible.shortcuts) };
    }
    if (schemaVersion < 2) {
      compatible = { ...compatible, shortcuts: ensureNavigationShortcuts(compatible.shortcuts) };
      await this.setSettings(compatible);
      await this.setValue('settingsSchemaVersion', 2);
    }
    return compatible;
  }

  async setSettings(settings: AppSettings): Promise<void> { await this.setValue('settings', settings); }

  async isProjectMember(projectId: number, personId: number): Promise<boolean> {
    const memberships = await this.getValue<Record<string, number[]>>('projectMembershipIds');
    return memberships?.[String(projectId)]?.includes(personId) ?? false;
  }

  async recordPeopleSelection(selection: PersonSelectionRecord): Promise<'inserted' | 'duplicate' | 'conflict'> {
    const inserted = this.db.$client.prepare(`INSERT OR IGNORE INTO people_selections
      (scope, operation_id, project_id, person_id, field, selected_on) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(this.scope, selection.operationId, selection.projectId, selection.personId, selection.field, new Date().toISOString());
    if (inserted.changes > 0) return 'inserted';
    const existing = this.db.$client.prepare(`SELECT project_id AS projectId, person_id AS personId
      FROM people_selections WHERE scope = ? AND operation_id = ? AND field = ?`)
      .get(this.scope, selection.operationId, selection.field) as { projectId: number; personId: number } | undefined;
    if (existing?.projectId === selection.projectId && existing.personId === selection.personId) return 'duplicate';
    return 'conflict';
  }

  async getPeopleRecommendations(projectId: number, field: PeopleField): Promise<number[]> {
    const rows = this.db.$client.prepare(`SELECT person_id AS personId, COUNT(*) AS choiceCount, MAX(selected_on) AS lastSelectedOn
      FROM people_selections WHERE scope = ? AND project_id = ? AND field = ?
      GROUP BY person_id ORDER BY choiceCount DESC, lastSelectedOn DESC, personId ASC`)
      .all(this.scope, projectId, field) as { personId: number; choiceCount: number; lastSelectedOn: string }[];
    return rows.map(row => row.personId);
  }

  async getProjects(): Promise<Project[]> {
    return (await this.db.select({ payload: projects.payload }).from(projects).where(eq(projects.scope, this.scope)))
      .map(row => decode<Project>(row.payload)).sort((a, b) => a.name.localeCompare(b.name));
  }
  async saveProject(project: Project): Promise<void> {
    await this.db.insert(projects).values({ scope: this.scope, id: project.id, payload: encode(project) })
      .onConflictDoUpdate({ target: [projects.scope, projects.id], set: { payload: encode(project) } });
  }
  async removeProjectsExcept(ids: number[]): Promise<void> {
    await this.db.delete(projects).where(ids.length
      ? and(eq(projects.scope, this.scope), notInArray(projects.id, ids))
      : eq(projects.scope, this.scope));
  }

  async getIssues(projectId?: number): Promise<Issue[]> {
    const rows = await this.db.select({ id: issues.id, payload: issues.payload }).from(issues)
      .where(eq(issues.scope, this.scope));
    const roleRows = await this.db.select().from(issueRoles).where(eq(issueRoles.scope, this.scope));
    const roleMap = new Map(roleRows.map(row => [row.issueId, row]));
    return rows.map(row => {
      const issue = decode<Issue>(row.payload);
      const role = roleMap.get(row.id);
      if (role) {
        issue.developerId = role.developerId ?? undefined;
        issue.qaId = role.qaId ?? undefined;
      }
      return issue;
    }).filter(issue => projectId === undefined || issue.projectId === projectId);
  }
  async getIssue(id: number): Promise<Issue | undefined> { return (await this.getIssues()).find(issue => issue.id === id); }
  async saveIssue(issue: Issue): Promise<void> {
    await this.db.insert(issues).values({ scope: this.scope, id: issue.id, projectId: issue.projectId, statusId: issue.statusId,
      fixedVersionId: issue.fixedVersionId ?? null, updatedOn: issue.updatedOn, payload: encode(issue) })
      .onConflictDoUpdate({ target: [issues.scope, issues.id], set: { projectId: issue.projectId, statusId: issue.statusId,
        fixedVersionId: issue.fixedVersionId ?? null, updatedOn: issue.updatedOn, payload: encode(issue) } });
    const existingRole = (await this.db.select().from(issueRoles).where(and(eq(issueRoles.scope, this.scope), eq(issueRoles.issueId, issue.id))).limit(1))[0];
    if (issue.developerId !== undefined || issue.qaId !== undefined || existingRole) {
      await this.setIssueRoles(issue.id, issue.developerId, issue.qaId);
    }
  }
  async setIssueRoles(issueId: number, developerId: number | null | undefined, qaId: number | null | undefined): Promise<void> {
    const previous = (await this.db.select().from(issueRoles).where(and(eq(issueRoles.scope, this.scope), eq(issueRoles.issueId, issueId))).limit(1))[0];
    const nextDeveloper = developerId === undefined ? previous?.developerId ?? null : developerId;
    const nextQa = qaId === undefined ? previous?.qaId ?? null : qaId;
    await this.db.insert(issueRoles).values({ scope: this.scope, issueId, developerId: nextDeveloper, qaId: nextQa })
      .onConflictDoUpdate({ target: [issueRoles.scope, issueRoles.issueId], set: {
        developerId: nextDeveloper, qaId: nextQa,
      } });
    const issue = await this.getIssue(issueId);
    if (issue) {
      issue.developerId = nextDeveloper ?? undefined;
      issue.qaId = nextQa ?? undefined;
      await this.db.update(issues).set({ payload: encode(issue) }).where(and(eq(issues.scope, this.scope), eq(issues.id, issueId)));
    }
  }

  async getDraft(issueId: number): Promise<unknown | undefined> {
    const row = (await this.db.select({ payload: drafts.payload }).from(drafts)
      .where(and(eq(drafts.scope, this.scope), eq(drafts.issueId, issueId))).limit(1))[0];
    return row ? decode<unknown>(row.payload) : undefined;
  }
  async saveDraft(issueId: number, value: unknown): Promise<void> {
    await this.db.insert(drafts).values({ scope: this.scope, issueId, payload: encode(value), updatedOn: new Date().toISOString() })
      .onConflictDoUpdate({ target: [drafts.scope, drafts.issueId], set: { payload: encode(value), updatedOn: new Date().toISOString() } });
  }
  async removeDraft(issueId: number): Promise<void> {
    await this.db.delete(drafts).where(and(eq(drafts.scope, this.scope), eq(drafts.issueId, issueId)));
  }

  async getVersions(projectId?: number): Promise<Version[]> {
    const rows = await this.db.select({ payload: versions.payload }).from(versions).where(eq(versions.scope, this.scope));
    return rows.map(row => decode<Version>(row.payload)).filter(version => projectId === undefined || version.projectId === projectId);
  }
  async getVersion(id: number): Promise<Version | undefined> { return (await this.getVersions()).find(version => version.id === id); }
  async saveVersion(version: Version): Promise<void> {
    await this.db.insert(versions).values({ scope: this.scope, id: version.id, projectId: version.projectId, status: version.status, payload: encode(version) })
      .onConflictDoUpdate({ target: [versions.scope, versions.id], set: { projectId: version.projectId, status: version.status, payload: encode(version) } });
  }

  async getJournals(issueId: number): Promise<Journal[]> {
    return (await this.db.select({ payload: journals.payload }).from(journals)
      .where(and(eq(journals.scope, this.scope), eq(journals.issueId, issueId))).orderBy(asc(journals.createdOn)))
      .map(row => decode<Journal>(row.payload));
  }
  async saveJournal(issueId: number, journal: Journal): Promise<void> {
    await this.db.insert(journals).values({ scope: this.scope, id: journal.id, issueId, createdOn: journal.createdOn, payload: encode(journal) })
      .onConflictDoUpdate({ target: [journals.scope, journals.id], set: { issueId, createdOn: journal.createdOn, payload: encode(journal) } });
  }

  allocateJournalId(): number {
    return this.db.$client.transaction(() => {
      const stored = this.db.$client.prepare('SELECT value FROM key_values WHERE scope = ? AND key = ?')
        .get(this.scope, 'journalIdSequence') as { value: string } | undefined;
      const maxRow = this.db.$client.prepare('SELECT MAX(id) AS maxId FROM journals WHERE scope = ?')
        .get(this.scope) as { maxId: number | null };
      const sequence = stored ? Number(decode<number>(stored.value)) : 0;
      const next = Math.max(Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0, maxRow.maxId ?? 0) + 1;
      if (!Number.isSafeInteger(next)) throw new Error('Journal ID sequence exceeded the safe integer range.');
      this.db.$client.prepare(`INSERT INTO key_values (scope, key, value) VALUES (?, ?, ?)
        ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`).run(this.scope, 'journalIdSequence', encode(next));
      return next;
    })();
  }

  getJournalLikeState(journalId: number, userId: number): { count: number; likedByMe: boolean } {
    const row = this.db.$client.prepare('SELECT value FROM key_values WHERE scope = ? AND key = ?')
      .get(this.scope, `journalLikes:${journalId}`) as { value: string } | undefined;
    const userIds = row ? decode<number[]>(row.value) : [];
    return { count: userIds.length, likedByMe: userIds.includes(userId) };
  }

  setJournalLike(journalId: number, userId: number, liked: boolean): { count: number; likedByMe: boolean } {
    return this.db.$client.transaction(() => {
      const key = `journalLikes:${journalId}`;
      const row = this.db.$client.prepare('SELECT value FROM key_values WHERE scope = ? AND key = ?')
        .get(this.scope, key) as { value: string } | undefined;
      const userIds: number[] = row ? decode<number[]>(row.value) : [];
      const index = userIds.indexOf(userId);
      if (liked && index < 0) userIds.push(userId);
      else if (!liked && index >= 0) userIds.splice(index, 1);
      if (userIds.length) {
        this.db.$client.prepare(`INSERT INTO key_values (scope, key, value) VALUES (?, ?, ?)
          ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`).run(this.scope, key, encode(userIds));
      } else {
        this.db.$client.prepare('DELETE FROM key_values WHERE scope = ? AND key = ?').run(this.scope, key);
      }
      return { count: userIds.length, likedByMe: userIds.includes(userId) };
    })();
  }

  clearJournalLikes(journalId: number): void {
    this.db.$client.prepare('DELETE FROM key_values WHERE scope = ? AND key = ?')
      .run(this.scope, `journalLikes:${journalId}`);
  }

  async deleteJournal(issueId: number, journalId: number): Promise<void> {
    this.db.$client.transaction(() => {
      // An older demo database may not have a sequence yet. Retain IDs before deleting its newest note.
      const stored = this.db.$client.prepare('SELECT value FROM key_values WHERE scope = ? AND key = ?')
        .get(this.scope, 'journalIdSequence') as { value: string } | undefined;
      const sequence = stored ? Number(decode<number>(stored.value)) : 0;
      const retained = Math.max(Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 0, journalId);
      this.db.$client.prepare(`INSERT INTO key_values (scope, key, value) VALUES (?, ?, ?)
        ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`).run(this.scope, 'journalIdSequence', encode(retained));
      this.db.$client.prepare('DELETE FROM journals WHERE scope = ? AND issue_id = ? AND id = ?')
        .run(this.scope, issueId, journalId);
      this.db.$client.prepare('DELETE FROM key_values WHERE scope = ? AND key = ?')
        .run(this.scope, `journalLikes:${journalId}`);
    })();
  }

  async getNotifications(archived = false): Promise<Notification[]> {
    return (await this.db.select({ payload: notifications.payload, createdOn: notifications.createdOn })
      .from(notifications).where(and(eq(notifications.scope, this.scope), archived ? isNotNull(notifications.readAt) : isNull(notifications.readAt)))
      .orderBy(desc(notifications.createdOn))).map(row => decode<Notification>(row.payload));
  }
  async saveNotification(item: Notification): Promise<void> {
    await this.db.insert(notifications).values({ scope: this.scope, id: item.id, projectId: item.projectId, issueId: item.issueId,
      createdOn: item.createdOn, readAt: item.readAt ?? null, payload: encode(item) })
      .onConflictDoUpdate({ target: [notifications.scope, notifications.id], set: { readAt: item.readAt ?? null, payload: encode(item) } });
  }
  async markNotificationsRead(ids: string[]): Promise<number> {
    const timestamp = new Date().toISOString();
    let count = 0;
    for (const id of ids) {
      const item = (await this.db.select().from(notifications).where(and(eq(notifications.scope, this.scope), eq(notifications.id, id))).limit(1))[0];
      if (!item || item.readAt) continue;
      const payload = decode<Notification>(item.payload);
      payload.readAt = timestamp;
      await this.db.update(notifications).set({ readAt: timestamp, payload: encode(payload) })
        .where(and(eq(notifications.scope, this.scope), eq(notifications.id, id)));
      count++;
    }
    return count;
  }

  async hasSeenSourceEvent(id: string): Promise<boolean> {
    return (await this.db.select({ id: sourceEvents.id }).from(sourceEvents)
      .where(and(eq(sourceEvents.scope, this.scope), eq(sourceEvents.id, id))).limit(1)).length > 0;
  }
  async markSourceEventSeen(id: string): Promise<void> {
    await this.db.insert(sourceEvents).values({ scope: this.scope, id, seenAt: new Date().toISOString() })
      .onConflictDoNothing({ target: [sourceEvents.scope, sourceEvents.id] });
  }
  async commitSourceEvent(id: string, notification?: Notification): Promise<boolean> {
    const now = new Date().toISOString();
    const commit = this.db.$client.transaction(() => {
      const inserted = this.db.$client.prepare('INSERT OR IGNORE INTO source_events(scope, id, seen_at) VALUES (?, ?, ?)')
        .run(this.scope, id, now);
      if (inserted.changes === 0 || !notification) return false;
      this.db.$client.prepare(`INSERT INTO notifications(scope, id, project_id, issue_id, created_on, read_at, payload)
        VALUES (?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(scope, id) DO NOTHING`).run(this.scope, notification.id, notification.projectId,
          notification.issueId, notification.createdOn, encode(notification));
      return true;
    });
    return commit();
  }
  async getCursor(key: string): Promise<string | undefined> {
    const row = (await this.db.select({ value: syncCursors.value }).from(syncCursors)
      .where(and(eq(syncCursors.scope, this.scope), eq(syncCursors.key, key))).limit(1))[0];
    return row?.value;
  }
  async setCursor(key: string, value: string): Promise<void> {
    await this.db.insert(syncCursors).values({ scope: this.scope, key, value, updatedOn: new Date().toISOString() })
      .onConflictDoUpdate({ target: [syncCursors.scope, syncCursors.key], set: { value, updatedOn: new Date().toISOString() } });
  }

  async getOperationRecord(id: string): Promise<OperationRecord | undefined> {
    const row = (await this.db.select({ payload: operations.payload }).from(operations)
      .where(and(eq(operations.scope, this.scope), eq(operations.id, id))).limit(1))[0];
    return row ? decode<OperationRecord>(row.payload) : undefined;
  }
  async saveOperationRecord(record: OperationRecord): Promise<void> {
    const op = record.operation;
    await this.db.insert(operations).values({ scope: this.scope, id: op.id, type: op.type, status: op.status,
      issueId: op.issueId ?? null, versionId: op.versionId ?? null, createdOn: op.createdOn,
      updatedOn: new Date().toISOString(), payload: encode(record) })
      .onConflictDoUpdate({ target: [operations.scope, operations.id], set: { type: op.type, status: op.status,
        issueId: op.issueId ?? null, versionId: op.versionId ?? null, updatedOn: new Date().toISOString(), payload: encode(record) } });
  }
  async getOperations(): Promise<Operation[]> {
    return (await this.db.select({ payload: operations.payload }).from(operations)
      .where(eq(operations.scope, this.scope)).orderBy(desc(operations.createdOn)))
      .map(row => decode<OperationRecord>(row.payload).operation);
  }
  async getOperationRecords(): Promise<OperationRecord[]> {
    return (await this.db.select({ payload: operations.payload }).from(operations)
      .where(eq(operations.scope, this.scope)).orderBy(asc(operations.createdOn)))
      .map(row => decode<OperationRecord>(row.payload));
  }
}

function ensureSaveFormShortcut(shortcuts: AppSettings['shortcuts']): AppSettings['shortcuts'] {
  if (shortcuts.length === 0) return structuredClone(defaultSettings.shortcuts);
  if (shortcuts.some(shortcut => shortcut.action === 'saveForm')) return shortcuts;
  const hasEnabledSaveBinding = shortcuts.some(shortcut => shortcut.enabled && isPortableSaveBinding(shortcut.keys));
  return hasEnabledSaveBinding ? shortcuts : [...shortcuts, structuredClone(defaultSettings.shortcuts.find(item => item.action === 'saveForm')!)];
}

function isPortableSaveBinding(value: string): boolean {
  const canonical = value.trim().toLocaleLowerCase().replace(/\s+/g, '').replace(/^(ctrl|control|meta|command|mod)\+/, 'cmd+');
  return canonical === 'cmd+s';
}

/** Add new actions once without changing custom keys, disabled actions or existing bindings. */
function ensureNavigationShortcuts(shortcuts: AppSettings['shortcuts']): AppSettings['shortcuts'] {
  const result = [...shortcuts];
  for (const shortcut of navigationShortcuts) {
    if (result.some(item => item.action === shortcut.action)) continue;
    const occupied = result.some(item => item.enabled && normalizeShortcutKeys(item.keys) === normalizeShortcutKeys(shortcut.keys));
    let id = shortcut.id;
    for (let suffix = 2; result.some(item => item.id === id); suffix++) id = `${shortcut.id}-${suffix}`;
    result.push({ ...shortcut, id, enabled: !occupied });
  }
  return result;
}
