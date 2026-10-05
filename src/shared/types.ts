export type Locale = 'uk' | 'pl' | 'es' | 'en';
export type Mode = 'demo' | 'redmine';
export type StatusKey = 'suspended' | 'todo' | 'progress' | 'review' | 'qa' | 'deploy' | 'done' | 'rejected' | 'backlog' | 'unknown';
export type PersonRole = 'qa' | 'support' | 'developer';
export type PeopleField = 'assignee' | 'developer' | 'qa';
export interface RedmineRole { id: number; name: string }
export type PersonAvatarOverride = { kind: 'photo'; url: string } | { kind: 'emoji'; emoji: string };
export const personAvatarEmojis = ['🙂', '😎', '🦊', '🐈', '🐢', '🐙', '🌱', '🌈', '⭐', '🚀', '🎯', '🍀'] as const;
export function isSingleEmojiAvatar(value: string): boolean {
  if (!value || value.length > 32 || value.trim() !== value) return false;
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
  return segments.length === 1 && /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value);
}
export interface Person { id: number; name: string; avatar?: string; localEmoji?: string; roles?: PersonRole[]; redmineRoles?: RedmineRole[]; isAdmin?: boolean }
export interface ProjectTracker { id: number; name: string }
export interface Project { id: number; name: string; identifier: string; description?: string; trackers?: ProjectTracker[] }
export interface Status { id: number; name: string; key: StatusKey; isClosed: boolean }
export interface Priority { id: number; name: string; rank: number }
export interface Version { id: number; projectId: number; name: string; status: 'open' | 'locked' | 'closed'; dueDate?: string; description?: string }
export interface Attachment { id: number; filename: string; url: string; size: number; contentType?: string; thumbnailUrl?: string }
export interface LabelOption { id: string; name: string; fieldId?: number }
export type ActivityKind = 'comment' | 'status' | 'assignee' | 'labels' | 'field';
export interface ActivityVisibility { comment: boolean; status: boolean; assignee: boolean; labels: boolean; field: boolean }
export const defaultActivityVisibility: ActivityVisibility = { comment: true, status: true, assignee: true, labels: false, field: false };
export interface Journal {
  id: number; user: Person; notes: string; createdOn: string;
  changes: { field: string; oldValue?: string; newValue?: string }[];
  likes?: number; likedByMe?: boolean; canLike?: boolean; canEdit?: boolean; canDelete?: boolean;
}
export interface Issue {
  id: number; projectId: number; subject: string; description: string;
  statusId: number; priorityId: number; trackerId: number; trackerName: string;
  authorId: number; assignedToId?: number; developerId?: number; qaId?: number;
  fixedVersionId?: number; branch: string; labels: string[]; watcherIds: number[];
  createdOn: string; updatedOn: string; dueDate?: string; attachments: Attachment[];
  parentId?: number; allowedStatusIds?: number[];
}
export type View = 'all' | 'mine' | 'watching' | 'backlog';
export interface Filters { search?: string; assigneeId?: number; assignedToMe?: boolean; label?: string; labels?: string[]; statusIds?: number[]; priorityIds?: number[]; versionId?: number; includeClosed?: boolean; hasNotifications?: boolean }
export interface SavedView { id: string; projectId: number; name: string; filters: Filters; view: View }
export interface Shortcut { id: string; keys: string; action: string; value?: string; enabled: boolean }
export interface Subscription { enabled: boolean; events: string[] }
export interface AppSettings {
  locale: Locale; theme: 'light' | 'dark' | 'system'; palette: 'blue' | 'violet' | 'green' | 'amber';
  projectQa: Record<string, number>; subscriptions: Record<string, Subscription>;
  projectBackgrounds: Record<string, string>;
  projectActivity: Record<string, ActivityVisibility>;
  personRoleOverrides: Record<string, Record<string, PersonRole[]>>;
  personAvatarOverrides: Record<string, PersonAvatarOverride>;
  shortcuts: Shortcut[]; savedViews: SavedView[];
  sort: { field: 'priority' | 'updated' | 'created' | 'id' | 'subject'; direction: 'asc' | 'desc' };
  automationEnabled: boolean; pollIntervalSeconds: number;
}
export type SettingsPatch = Partial<Omit<AppSettings, 'projectQa' | 'subscriptions' | 'projectBackgrounds' | 'projectActivity' | 'personRoleOverrides' | 'personAvatarOverrides'>> & {
  projectQa?: Record<string, number | null>;
  subscriptions?: Record<string, Subscription | null>;
  projectBackgrounds?: Record<string, string | null>;
  projectActivity?: Record<string, ActivityVisibility | null>;
  personRoleOverrides?: Record<string, Record<string, PersonRole[] | null> | null>;
  personAvatarOverrides?: Record<string, PersonAvatarOverride | null>;
};
export interface Capabilities {
  canWrite: boolean; journalEditing: boolean; journalDeleting: boolean; journalLikes: boolean;
  branchFieldId?: number; labelsFieldId?: number; warnings: string[];
}
export interface Bootstrap {
  mode: Mode; readOnly: boolean; connected: boolean; redmineUrl: string;
  me: Person; projects: Project[]; statuses: Status[]; priorities: Priority[];
  settings: AppSettings; capabilities: Capabilities;
}
export interface BoardData {
  issues: Issue[]; versions: Version[]; members: Person[]; labels: string[]; total: number; syncedAt?: string;
  trackers?: ProjectTracker[];
  labelOptions?: LabelOption[];
  peopleRecommendations?: Partial<Record<PeopleField, number[]>>;
}
export interface IssueDetail { issue: Issue; journals: Journal[]; watchers: Person[]; people?: Person[] }
export interface SearchResult { id: number; title: string; description: string; projectId?: number; statusName?: string; url?: string; updatedOn?: string }
export interface SearchResponse { results: SearchResult[]; total: number; offset: number; limit: number }
export interface ReleaseDetail { version: Version; issues: Issue[] }
export interface Notification {
  id: string; projectId: number; issueId: number; journalId?: number; actor: Person; kind: string; text: string; createdOn: string; readAt?: string;
  /** Optional cached subject for old issues that are no longer in the local issue cache. */
  issueSubject?: string;
  /** Structured source content lets the API project events through current subscription preferences. */
  notes?: string;
  changes?: Journal['changes'];
  eventKinds?: ActivityKind[];
  changeLookups?: {
    statuses?: Status[]; people?: Person[]; priorities?: Priority[]; versions?: Version[]; labels?: LabelOption[];
  };
  detailsUnavailable?: boolean;
}
export interface OperationStep { name: string; status: 'pending' | 'done' | 'failed' | 'skipped' | 'blocked'; error?: string }
export interface Operation { id: string; type: string; issueId?: number; versionId?: number; status: 'pending' | 'running' | 'done' | 'failed' | 'blocked'; steps: OperationStep[]; createdOn: string; error?: string; errorCode?: string }
export interface Command { type: 'createIssue' | 'updateIssue' | 'moveIssue' | 'handoffToQA' | 'returnToDeveloper' | 'comment' | 'editJournal' | 'deleteJournal' | 'setJournalLike' | 'generateBranch' | 'createRelease' | 'updateRelease' | 'assignRelease' | 'finishRelease' | 'runAutomation'; issueId?: number; projectId?: number; versionId?: number; operationId?: string; input: Record<string, unknown> }
export interface CommandResult { operation: Operation; issue?: Issue; version?: Version }
export interface ApiError { code: string; message: string; details?: unknown }
