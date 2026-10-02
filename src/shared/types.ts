export type Locale = 'uk' | 'pl' | 'es' | 'en';
export type Mode = 'demo' | 'redmine';
export type StatusKey = 'suspended' | 'todo' | 'progress' | 'review' | 'qa' | 'deploy' | 'done' | 'rejected' | 'backlog' | 'unknown';
export type PersonRole = 'qa' | 'support' | 'developer';
export type PeopleField = 'assignee' | 'developer' | 'qa';
export interface RedmineRole { id: number; name: string }
export interface Person { id: number; name: string; avatar?: string; roles?: PersonRole[]; redmineRoles?: RedmineRole[] }
export interface ProjectTracker { id: number; name: string }
export interface Project { id: number; name: string; identifier: string; description?: string; trackers?: ProjectTracker[] }
export interface Status { id: number; name: string; key: StatusKey; isClosed: boolean }
export interface Priority { id: number; name: string; rank: number }
export interface Version { id: number; projectId: number; name: string; status: 'open' | 'locked' | 'closed'; dueDate?: string; description?: string }
export interface Attachment { id: number; filename: string; url: string; size: number }
export interface Journal { id: number; user: Person; notes: string; createdOn: string; changes: { field: string; oldValue?: string; newValue?: string }[] }
export interface Issue {
  id: number; projectId: number; subject: string; description: string;
  statusId: number; priorityId: number; trackerId: number; trackerName: string;
  authorId: number; assignedToId?: number; developerId?: number; qaId?: number;
  fixedVersionId?: number; branch: string; labels: string[]; watcherIds: number[];
  createdOn: string; updatedOn: string; dueDate?: string; attachments: Attachment[];
  parentId?: number; allowedStatusIds?: number[];
}
export type View = 'all' | 'mine' | 'watching' | 'backlog';
export interface Filters { search?: string; assigneeId?: number; assignedToMe?: boolean; label?: string; labels?: string[]; statusIds?: number[]; priorityIds?: number[]; versionId?: number; includeClosed?: boolean }
export interface SavedView { id: string; projectId: number; name: string; filters: Filters; view: View }
export interface Shortcut { id: string; keys: string; action: string; value?: string; enabled: boolean }
export interface Subscription { enabled: boolean; events: string[] }
export interface AppSettings {
  locale: Locale; theme: 'light' | 'dark' | 'system'; palette: 'blue' | 'violet' | 'green' | 'amber';
  projectQa: Record<string, number>; subscriptions: Record<string, Subscription>;
  personRoleOverrides: Record<string, Record<string, PersonRole[]>>;
  shortcuts: Shortcut[]; savedViews: SavedView[];
  sort: { field: 'priority' | 'updated' | 'created' | 'id' | 'subject'; direction: 'asc' | 'desc' };
  automationEnabled: boolean; pollIntervalSeconds: number;
}
export type SettingsPatch = Partial<Omit<AppSettings, 'projectQa' | 'subscriptions' | 'personRoleOverrides'>> & {
  projectQa?: Record<string, number | null>;
  subscriptions?: Record<string, Subscription | null>;
  personRoleOverrides?: Record<string, Record<string, PersonRole[] | null> | null>;
};
export interface Capabilities { canWrite: boolean; branchFieldId?: number; labelsFieldId?: number; warnings: string[] }
export interface Bootstrap {
  mode: Mode; readOnly: boolean; connected: boolean; redmineUrl: string;
  me: Person; projects: Project[]; statuses: Status[]; priorities: Priority[];
  settings: AppSettings; capabilities: Capabilities;
}
export interface BoardData {
  issues: Issue[]; versions: Version[]; members: Person[]; labels: string[]; total: number; syncedAt?: string;
  trackers?: ProjectTracker[];
  peopleRecommendations?: Partial<Record<PeopleField, number[]>>;
}
export interface IssueDetail { issue: Issue; journals: Journal[]; watchers: Person[] }
export interface ReleaseDetail { version: Version; issues: Issue[] }
export interface Notification { id: string; projectId: number; issueId: number; journalId?: number; actor: Person; kind: string; text: string; createdOn: string; readAt?: string }
export interface OperationStep { name: string; status: 'pending' | 'done' | 'failed' | 'skipped' | 'blocked'; error?: string }
export interface Operation { id: string; type: string; issueId?: number; versionId?: number; status: 'pending' | 'running' | 'done' | 'failed' | 'blocked'; steps: OperationStep[]; createdOn: string; error?: string; errorCode?: string }
export interface Command { type: 'createIssue' | 'updateIssue' | 'moveIssue' | 'handoffToQA' | 'returnToDeveloper' | 'comment' | 'generateBranch' | 'createRelease' | 'updateRelease' | 'assignRelease' | 'finishRelease' | 'runAutomation'; issueId?: number; projectId?: number; versionId?: number; operationId?: string; input: Record<string, unknown> }
export interface CommandResult { operation: Operation; issue?: Issue; version?: Version }
export interface ApiError { code: string; message: string; details?: unknown }
