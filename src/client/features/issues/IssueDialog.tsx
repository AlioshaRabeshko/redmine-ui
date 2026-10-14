import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { AlertTriangle, ArrowUpRight, CalendarDays, Check, Clock3, Copy, FileText, GitBranch, Heart, History, Link, MessageSquare, MoreHorizontal, Paperclip, Pencil, Quote, Save, Send, Trash2, UserRound, Users, WandSparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { defaultActivityVisibility, type GroupAvatarOverride, type ActivityVisibility, type AssigneeOption, type BoardData, type Issue, type IssueDetail, type Journal, type Notification, type PeopleField, type Person, type Priority, type Project, type Status, type Version } from '../../../shared/types';
import { branchForIssue } from '../../../shared/domain';
import { Avatar, Button, Field, IconButton, Modal, Notice, Spinner } from '../../components/ui';
import { AssigneePicker, Picker, PeoplePicker, type AssigneeSelection, type PickerOption } from '../../components/pickers';
import { ChoiceTiles, type ChoiceTileOption } from '../../components/choiceTiles';
import { AttachmentPreview, RichContent, attachmentContentPath, isPreviewableImage } from '../../components/RichContent';
import { GroupAvatar } from '../../components/GroupAvatar';

const LazyRichEditor = lazy(() => import('../../components/RichEditor').then(module => ({ default: module.RichEditor })));
function RichEditor({ loadingFallback, ...props }: ComponentProps<typeof import('../../components/RichEditor').RichEditor> & { loadingFallback?: ReactNode }) {
  return <Suspense fallback={loadingFallback ?? <Spinner />}><LazyRichEditor {...props} /></Suspense>;
}
import { api, issueUrl } from '../../lib/api';
import { createIssueTextDraftKey, enqueueFieldWrite, issueTextDraftKey, useWorkspaceFormSave } from '../../lib/serialFieldWrite';
import { clearDraftStorage, readDraftStorage, writeDraftStorage } from '../../lib/draftStorage';
import { activityKindForField, localizeJournalChange, visibleJournals } from '../../lib/issueActivity';
import { mergePeopleById } from '../../lib/peoplePresentation';
import { LabelsTiles } from './LabelsTiles';
import { useVisibleUnreadEvents } from './useVisibleUnreadEvents';

type IssueText = { subject: string; description: string; branch: string; dueDate: string };
type JournalEditDraft = { notes: string; expectedNotes: string; operationId?: string };
type OwnCommentReveal = { notes: string; userId: number; submittedAt: number; knownJournalIds: Set<number> };
type AutoField = 'statusId' | 'priorityId' | 'trackerId' | 'assignedToId' | 'developerId' | 'qaId' | 'fixedVersionId' | 'labels';
type AutoValues = Pick<Issue, 'statusId' | 'priorityId' | 'trackerId' | 'assignedToId' | 'developerId' | 'qaId' | 'fixedVersionId' | 'labels'>;
type FieldSaveState = { state: 'pending' | 'saved' | 'error'; error?: string };
export type IssueEditPatch = Omit<Partial<Issue>, 'assignedToId' | 'developerId' | 'qaId' | 'fixedVersionId' | 'dueDate'> & { assignedToId?: number | null; developerId?: number | null; qaId?: number | null; fixedVersionId?: number | null; dueDate?: string | null; expectedUpdatedOn?: string };

const autoFields: AutoField[] = ['statusId', 'priorityId', 'trackerId', 'assignedToId', 'developerId', 'qaId', 'fixedVersionId', 'labels'];
const peopleHistoryField: Partial<Record<AutoField, PeopleField>> = { assignedToId: 'assignee', developerId: 'developer', qaId: 'qa' };

function issueText(issue: Issue): IssueText {
  return { subject: issue.subject, description: issue.description || '', branch: issue.branch || '', dueDate: issue.dueDate || '' };
}

function autoValues(issue: Issue): AutoValues {
  return { statusId: issue.statusId, priorityId: issue.priorityId, trackerId: issue.trackerId, assignedToId: issue.assignedToId, developerId: issue.developerId, qaId: issue.qaId, fixedVersionId: issue.fixedVersionId, labels: issue.labels };
}

function readLegacyDraftObject(key: string): Record<string, unknown> {
  try {
    const stored = readDraftStorage(key);
    if (!stored.present || stored.value === null) return {};
    const parsed: unknown = JSON.parse(stored.value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function readLegacyIssueTextDraft(key: string): Partial<IssueText> {
  const legacy = readLegacyDraftObject(key);
  return {
    ...(typeof legacy.subject === 'string' ? { subject: legacy.subject } : {}),
    ...(typeof legacy.description === 'string' ? { description: legacy.description } : {}),
    ...(typeof legacy.branch === 'string' ? { branch: legacy.branch } : {}),
    ...(typeof legacy.dueDate === 'string' ? { dueDate: legacy.dueDate } : {}),
  };
}

function journalEditDraftKey(scope: string, projectId: number, issueId: number, journalId: number): string {
  return ['redmine-workspace', 'journal-draft', scope, String(projectId), String(issueId), String(journalId)]
    .map((part) => encodeURIComponent(part)).join(':');
}

function readJournalEditDraft(key: string, notes: string): { draft: JournalEditDraft; durable: boolean } {
  const stored = readDraftStorage(key);
  try {
    const draft = JSON.parse(stored.value || 'null') as Partial<JournalEditDraft> | null;
    if (draft && typeof draft.notes === 'string' && typeof draft.expectedNotes === 'string') {
      return { draft: { notes: draft.notes, expectedNotes: draft.expectedNotes, ...(typeof draft.operationId === 'string' ? { operationId: draft.operationId } : {}) }, durable: stored.durable };
    }
  } catch { /* Ignore malformed or unavailable local drafts. */ }
  return { draft: { notes, expectedNotes: notes }, durable: stored.durable };
}

function personFrom(members: Person[], id?: number) { return members.find((person) => person.id === id); }

function ReadOnlyDialogStatus() {
  const { t } = useTranslation();
  return <div className="readonly-dialog-status" role="status"><span className="readonly-dialog-pill" title={t('readOnlyNote')}><AlertTriangle size={14} />{t('readonlyCompact')}</span><span className="readonly-inline-copy">{t('saveBlocked')}</span></div>;
}

function DraftStorageStatus({ meaningful, durable }: { meaningful: boolean; durable: boolean }) {
  const { t } = useTranslation();
  if (!meaningful) return null;
  return durable
    ? <span className="draft-saved-indicator" role="status" data-testid="draft-persistence-status"><Check size={13} />{t('draftSaved')}</span>
    : <span className="readonly-inline" role="status" data-testid="draft-persistence-status"><AlertTriangle size={14} />{t('draftSessionOnly')}</span>;
}

const activityFilterKinds: { key: keyof ActivityVisibility; label: string }[] = [
  { key: 'comment', label: 'comments' },
  { key: 'status', label: 'status' },
  { key: 'assignee', label: 'assignee' },
  { key: 'labels', label: 'labels' },
  { key: 'field', label: 'activityOtherFields' },
];

function suggestedAssignees(members: Person[], selectedId?: number, recommendations: number[] = []) {
  const candidates: Person[] = [];
  const included = new Set<number>();
  const add = (person?: Person) => {
    if (person && !included.has(person.id)) { candidates.push(person); included.add(person.id); }
  };
  add(personFrom(members, selectedId));
  for (const id of recommendations.slice(0, 4)) add(personFrom(members, id));
  const limit = Math.min(5, members.length);
  for (const person of members.filter((entry) => entry.roles?.includes('developer'))) { if (candidates.length >= limit) break; add(person); }
  for (const person of members) { if (candidates.length >= limit) break; add(person); }
  return candidates;
}

export function IssueDialog({ detail, board, statuses, priorities, redmineUrl, groupAvatarOverrides, draftScope, initialJournalId, currentUserId, notificationRequestKey, onNotificationTargetShown, unreadNotifications, onUnreadEventsVisible, activityVisibility = defaultActivityVisibility, canWrite, readOnlyMode, onActivityVisibilityChange, onClose, onSave, onComment, onSaveRoles, onEditJournal, onDeleteJournal, onSetJournalLike, onToast }: {
  groupAvatarOverrides?: Record<string, GroupAvatarOverride>;
  detail: IssueDetail; board: BoardData; statuses: Status[]; priorities: Priority[]; redmineUrl: string; canWrite: boolean; onClose: () => void;
  draftScope: string; initialJournalId?: number; currentUserId?: number; notificationRequestKey?: string; onNotificationTargetShown?: (issueId: number, journalId?: number) => void; activityVisibility?: ActivityVisibility; readOnlyMode: boolean; onActivityVisibilityChange: (visibility: ActivityVisibility) => void;
  unreadNotifications: Notification[]; onUnreadEventsVisible: (issueId: number, ids: string[]) => void | Promise<void>;
  onSave: (issue: Issue, patch: IssueEditPatch, operationId?: string) => Promise<Issue | void>; onComment: (issue: Issue, notes: string) => Promise<void>;
  onSaveRoles: (issue: Issue, rolePatch: { developerId?: number | null; qaId?: number | null }, operationId?: string) => Promise<Issue | void>;
  onEditJournal: (issue: Issue, journalId: number, notes: string, expectedNotes: string, operationId: string) => Promise<void>;
  onDeleteJournal: (issue: Issue, journalId: number, expectedNotes: string, operationId: string) => Promise<void>;
  onSetJournalLike: (issue: Issue, journalId: number, liked: boolean, operationId: string) => Promise<void>;
  onToast: (text: string) => void; initialComment?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const issue = detail.issue;
  const initialText = useRef(issueText(issue)).current;
  const legacyDraftKey = `redmine-workspace:draft:${encodeURIComponent(draftScope)}:${issue.projectId}:${issue.id}`;
  const legacyDraft = useMemo(() => readLegacyIssueTextDraft(legacyDraftKey), [legacyDraftKey]);
  const [legacyIssueTextDurable, setLegacyIssueTextDurable] = useState(() => {
    const stored = readDraftStorage(legacyDraftKey);
    return stored.present && stored.durable;
  });
  const legacyCommentKey = `${legacyDraftKey}:comment`;
  const textKeys = useMemo(() => ({
    subject: issueTextDraftKey(draftScope, issue.projectId, issue.id, 'subject'),
    description: issueTextDraftKey(draftScope, issue.projectId, issue.id, 'description'),
    branch: issueTextDraftKey(draftScope, issue.projectId, issue.id, 'branch'),
    dueDate: issueTextDraftKey(draftScope, issue.projectId, issue.id, 'dueDate'),
  }), [draftScope, issue.projectId, issue.id]);
  const [serverText, setServerText] = useState<IssueText>(() => issueText(issue));
  const serverTextRef = useRef(serverText);
  const baselineTextRef = useRef<IssueText>(initialText);
  const initialDraftState = useMemo(() => {
    const readField = (field: keyof IssueText) => {
      const stored = readDraftStorage(textKeys[field]);
      const legacy = legacyDraft[field];
      const fallback = typeof legacy === 'string' ? legacy : initialText[field];
      // A scoped clear marker means "discard the draft"; show the current server
      // value instead of falling through to an older legacy draft.
      const value = stored.present ? stored.value ?? initialText[field] : fallback;
      const inheritedDirtyValue = !stored.present && value !== initialText[field];
      return { value, durable: inheritedDirtyValue ? false : stored.durable };
    };
    const subject = readField('subject');
    const description = readField('description');
    const branch = readField('branch');
    const dueDate = readField('dueDate');
    return {
      draft: { subject: subject.value, description: description.value, branch: branch.value, dueDate: dueDate.value },
      durability: { subject: subject.durable, description: description.durable, branch: branch.durable, dueDate: dueDate.durable },
    };
  }, [textKeys, initialText, legacyDraft]);
  const initialDraft = initialDraftState.draft;
  const [textDraft, setTextDraft] = useState<IssueText>(initialDraft);
  const textDraftRef = useRef(textDraft);
  const initialDirty = useRef({
    subject: initialDraft.subject !== initialText.subject,
    description: initialDraft.description !== initialText.description,
    branch: initialDraft.branch !== initialText.branch,
    dueDate: initialDraft.dueDate !== initialText.dueDate,
  }).current;
  const [dirtyText, setDirtyText] = useState(initialDirty);
  const dirtyTextRef = useRef(dirtyText);
  const [textDraftDurability, setTextDraftDurability] = useState<Record<keyof IssueText, boolean>>(initialDraftState.durability);
  const [autoDraft, setAutoDraft] = useState<AutoValues>(() => autoValues(issue));
  const [assigneeSelection, setAssigneeSelection] = useState<AssigneeSelection | undefined>(() => issue.assignedToId === undefined ? undefined : { type: issue.assignedToType || 'user', id: issue.assignedToId });
  const assigneeSelectionRef = useRef(assigneeSelection);
  const confirmedAssigneeRef = useRef(assigneeSelection);
  const confirmedAutoRef = useRef<AutoValues>(autoValues(issue));
  const fieldQueuesRef = useRef(new Map<string, Promise<unknown>>());
  const updatedOnRef = useRef(issue.updatedOn);
  const generationRef = useRef<Record<AutoField, number>>({ statusId: 0, priorityId: 0, trackerId: 0, assignedToId: 0, developerId: 0, qaId: 0, fixedVersionId: 0, labels: 0 });
  const pendingCountRef = useRef<Record<AutoField, number>>({ statusId: 0, priorityId: 0, trackerId: 0, assignedToId: 0, developerId: 0, qaId: 0, fixedVersionId: 0, labels: 0 });
  const [fieldSave, setFieldSave] = useState<Partial<Record<AutoField, FieldSaveState>>>({});
  const [textSaving, setTextSaving] = useState(false);
  const [textError, setTextError] = useState('');
  const commentKey = issueTextDraftKey(draftScope, issue.projectId, issue.id, 'comment');
  const initialCommentState = useMemo(() => {
    const scoped = readDraftStorage(commentKey);
    const legacy = readDraftStorage(legacyCommentKey);
    const value = scoped.present ? scoped.value ?? '' : legacy.present ? legacy.value ?? '' : '';
    const inheritedLegacyComment = !scoped.present && legacy.present && Boolean(legacy.value?.trim());
    return { value, durable: inheritedLegacyComment ? false : scoped.durable, legacyValue: legacy.value, legacyDurable: legacy.present && legacy.durable };
  }, [commentKey, legacyCommentKey]);
  const [comment, setComment] = useState(initialCommentState.value);
  const [commentDraftDurable, setCommentDraftDurable] = useState(initialCommentState.durable);
  const [legacyCommentDurable, setLegacyCommentDurable] = useState(initialCommentState.legacyDurable);
  const commentRef = useRef(comment);
  const [commentError, setCommentError] = useState('');
  const [sendingComment, setSendingComment] = useState(false);
  const [mentionPeople, setMentionPeople] = useState<Person[]>([]);
  const [editingJournalId, setEditingJournalId] = useState<number>();
  const [journalEditDraft, setJournalEditDraft] = useState<JournalEditDraft>();
  const journalEditDraftRef = useRef<JournalEditDraft | undefined>(undefined);
  const [journalDraftDurable, setJournalDraftDurable] = useState(true);
  const [journalEditError, setJournalEditError] = useState('');
  const [savingJournalEdit, setSavingJournalEdit] = useState(false);
  const [deleteJournal, setDeleteJournal] = useState<{ journalId: number; expectedNotes: string }>();
  const [deleteJournalError, setDeleteJournalError] = useState('');
  const [deletingJournal, setDeletingJournal] = useState(false);
  const [likingJournalIds, setLikingJournalIds] = useState<Set<number>>(() => new Set());
  const [journalLikeErrors, setJournalLikeErrors] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState(true);
  const [activityJournals, setActivityJournals] = useState<Journal[]>(() => detail.journals);
  const activityJournalsRef = useRef(activityJournals);
  const [bufferedActivity, setBufferedActivity] = useState<Journal[]>([]);
  const bufferedActivityRef = useRef(bufferedActivity);
  const issueDialogScrollRef = useRef<HTMLDivElement>(null);
  const activityListRef = useRef<HTMLDivElement>(null);
  const activeIssueIdRef = useRef(issue.id);
  activeIssueIdRef.current = issue.id;
  const [ownCommentReveal, setOwnCommentReveal] = useState<OwnCommentReveal>();
  const reportedNotificationTargetsRef = useRef(new Set<string>());
  const textFormRef = useWorkspaceFormSave<HTMLFormElement>();
  const commentFormRef = useWorkspaceFormSave<HTMLFormElement>();
  const journalEditFormRef = useRef<HTMLFormElement>(null);
  const [journalEditorFocusRequest, setJournalEditorFocusRequest] = useState(0);
  const journalEditButtonRefs = useRef(new Map<number, HTMLButtonElement>());
  const activityHeadingRef = useRef<HTMLHeadingElement>(null);
  const [commentFocusRequest, setCommentFocusRequest] = useState(0);
  const [commentEditorActive, setCommentEditorActive] = useState(() => Boolean(comment));
  const changeCommentDraft = (next: string) => { commentRef.current = next; setComment(next); setCommentError(''); if (!next.trim()) { clearDraftStorage(legacyCommentKey); setLegacyCommentDurable(false); } };


  useEffect(() => {
    const form = journalEditFormRef.current;
    if (!form) return;
    const onSaveRequest = (event: Event) => {
      if (event.target !== form) return;
      event.preventDefault();
      form.requestSubmit();
    };
    form.addEventListener('workspace:save-form', onSaveRequest);
    return () => form.removeEventListener('workspace:save-form', onSaveRequest);
  }, [editingJournalId]);

  const activeVersions = board.versions.filter((version) => version.projectId === issue.projectId && version.status !== 'closed');
  const selectedClosedVersion = board.versions.find((version) => version.id === autoDraft.fixedVersionId && version.projectId === issue.projectId && version.status === 'closed');
  const issuePeople = mergePeopleById(board.members, detail.people || [], detail.watchers, detail.journals.map((journal) => journal.user));
  const issueWatchers = detail.watchers.map((watcher) => personFrom(issuePeople, watcher.id) || watcher);
  useEffect(() => {
    const controller = new AbortController();
    void api.get<Person[]>(`/api/projects/${issue.projectId}/mention-users`, controller.signal)
      .then((people) => { if (!controller.signal.aborted) setMentionPeople(people.filter((person) => Boolean(person.mentionToken))); })
      .catch(() => { if (!controller.signal.aborted) setMentionPeople([]); });
    return () => controller.abort();
  }, [issue.projectId]);
  const trackers = useMemo(() => board.trackers
    ? [...board.trackers, ...(!board.trackers.some(tracker => tracker.id === issue.trackerId) ? [{ id: issue.trackerId, name: issue.trackerName }] : [])]
    : [...new Map([...board.issues, issue].map(entry => [entry.trackerId, { id: entry.trackerId, name: entry.trackerName }])).values()], [board.trackers, board.issues, issue]);
  const trackerOptions: ChoiceTileOption[] = trackers.map((tracker) => ({ value: String(tracker.id), label: tracker.name }));
  const textFormId = 'issue-text-form-' + issue.id;
  const author = personFrom(issuePeople, issue.authorId);
  const assigneeOptions = detail.assigneeOptions ?? board.assigneeOptions;
  const assignee = assigneeSelection?.type === 'user' ? personFrom(issuePeople, assigneeSelection.id) : undefined;
  const assigneeCurrentOption: AssigneeOption | undefined = assigneeSelection ? (() => {
    const selected = assigneeOptions?.find((option) => option.type === assigneeSelection.type && option.id === assigneeSelection.id);
    if (selected) return selected;
    if (assigneeSelection.type === 'group') return { type: 'group', id: assigneeSelection.id, name: issue.assignedToId === assigneeSelection.id && issue.assignedToType === 'group' ? issue.assignedToName || `#${assigneeSelection.id}` : `#${assigneeSelection.id}` };
    const person = personFrom(issuePeople, assigneeSelection.id);
    const assignedName = issue.assignedToId === assigneeSelection.id && (issue.assignedToType || 'user') === 'user' ? issue.assignedToName : undefined;
    return { type: 'user', id: assigneeSelection.id, name: person?.name || assignedName || `#${assigneeSelection.id}`, ...(person?.avatar ? { avatar: person.avatar } : {}) };
  })() : undefined;
  const developer = personFrom(issuePeople, autoDraft.developerId);
  const qa = personFrom(issuePeople, autoDraft.qaId);
  const assigneeCandidates = useMemo(() => suggestedAssignees(board.members, assigneeSelection?.type === 'user' ? assigneeSelection.id : undefined, board.peopleRecommendations?.assignee), [board.members, board.peopleRecommendations?.assignee, assigneeSelection]);
  const anyTextDirty = Object.values(dirtyText).some(Boolean);
  const textDraftDurable = (Object.keys(dirtyText) as (keyof IssueText)[]).every((key) =>
    !dirtyText[key] || textDraftDurability[key] || (legacyIssueTextDurable && legacyDraft[key] === textDraft[key]));
  const commentDurable = commentDraftDurable || (legacyCommentDurable && comment === initialCommentState.legacyValue);
  const legacyTextMigrationPending = (Object.keys(dirtyText) as (keyof IssueText)[]).some((key) => dirtyText[key] && !textDraftDurability[key]);
  const cardFields: (keyof IssueText)[] = ['subject', 'description', 'dueDate'];
  const hasCardTextDraft = cardFields.some(key => dirtyText[key]);
  const hasCardTextConflict = cardFields.some((key) => dirtyText[key] && serverText[key] !== baselineTextRef.current[key]);
  const hasBranchTextConflict = dirtyText.branch && serverText.branch !== baselineTextRef.current.branch;

  useEffect(() => {
    const next = issueText(issue);
    updatedOnRef.current = issue.updatedOn;
    serverTextRef.current = next;
    setServerText(next);
    // Reconcile from the synchronous refs, which are updated by input handlers.
    // Mutating them inside a React state updater can run later than a newer input
    // event and replace its draft ref with an older render snapshot.
    const updated = { ...textDraftRef.current };
    const updatedDirty = { ...dirtyTextRef.current };
    for (const key of Object.keys(next) as (keyof IssueText)[]) {
      if (!updatedDirty[key]) {
        updated[key] = next[key];
        baselineTextRef.current[key] = next[key];
      }
    }
    textDraftRef.current = updated;
    dirtyTextRef.current = updatedDirty;
    setTextDraft(updated);
    setDirtyText(updatedDirty);
    const nextAuto = autoValues(issue);
    if (pendingCountRef.current.assignedToId === 0) {
      const nextAssignee = issue.assignedToId === undefined ? undefined : { type: issue.assignedToType || 'user', id: issue.assignedToId } as AssigneeSelection;
      assigneeSelectionRef.current = nextAssignee;
      confirmedAssigneeRef.current = nextAssignee;
      setAssigneeSelection(nextAssignee);
    }
    setAutoDraft((current) => {
      const updated = { ...current };
      for (const key of autoFields) {
        if (pendingCountRef.current[key] === 0) {
          (confirmedAutoRef.current as Record<AutoField, unknown>)[key] = nextAuto[key];
          (updated as Record<AutoField, unknown>)[key] = nextAuto[key];
        }
      }
      return updated;
    });
  }, [issue]);

  useEffect(() => {
    const latestById = new Map(detail.journals.map((journal) => [journal.id, journal]));
    const current = activityJournalsRef.current;
    const knownIds = new Set([
      ...current.map((journal) => journal.id),
      ...bufferedActivityRef.current.map((journal) => journal.id),
    ]);
    const currentIds = new Set(current.map((journal) => journal.id));
    const newlyReceived = detail.journals.filter((journal) => !knownIds.has(journal.id));
    const ownJournal = ownCommentReveal && currentUserId === ownCommentReveal.userId
      ? newlyReceived.find((journal) => journal.user.id === ownCommentReveal.userId
        && !ownCommentReveal.knownJournalIds.has(journal.id)
        && journal.notes === ownCommentReveal.notes
        && Date.parse(journal.createdOn) >= ownCommentReveal.submittedAt - 60_000
        && Date.parse(journal.createdOn) <= Date.now() + 60_000)
      : undefined;
    const immediatelyVisibleIds = new Set<number>([
      ...(initialJournalId ? [initialJournalId] : []),
      ...(ownJournal ? [ownJournal.id] : []),
    ]);
    const nextDisplayed = [
      ...current.flatMap((journal) => latestById.has(journal.id) ? [latestById.get(journal.id)!] : []),
      ...newlyReceived.filter((journal) => immediatelyVisibleIds.has(journal.id)),
      ...(initialJournalId !== undefined && latestById.has(initialJournalId) && !currentIds.has(initialJournalId) && !newlyReceived.some((journal) => journal.id === initialJournalId)
        ? [latestById.get(initialJournalId)!]
        : []),
    ];
    activityJournalsRef.current = nextDisplayed;
    setActivityJournals(nextDisplayed);

    const pendingById = new Map<number, Journal>();
    for (const journal of bufferedActivityRef.current) {
      const latest = latestById.get(journal.id);
      if (latest && !immediatelyVisibleIds.has(journal.id)) pendingById.set(latest.id, latest);
    }
    for (const journal of newlyReceived) {
      if (!immediatelyVisibleIds.has(journal.id)) pendingById.set(journal.id, journal);
    }
    const nextBuffered = [...pendingById.values()];
    bufferedActivityRef.current = nextBuffered;
    setBufferedActivity(nextBuffered);
    if (ownJournal) setOwnCommentReveal(undefined);
  }, [detail.journals, initialJournalId, currentUserId, ownCommentReveal]);

  useEffect(() => {
    const durable: Record<keyof IssueText, boolean> = { subject: true, description: true, branch: true, dueDate: true };
    for (const key of Object.keys(textDraft) as (keyof IssueText)[]) {
      if (dirtyText[key]) durable[key] = writeDraftStorage(textKeys[key], textDraft[key]);
      else { clearDraftStorage(textKeys[key]); durable[key] = true; }
    }
    setTextDraftDurability(durable);
  }, [textDraft, dirtyText, textKeys]);
  useEffect(() => {
    setCommentDraftDurable(comment.trim() ? writeDraftStorage(commentKey, comment) : clearDraftStorage(commentKey));
  }, [comment, commentKey]);
  useEffect(() => {
    const preserveUnsavedCommentOnRemoteClear = (event: StorageEvent) => {
      if (event.key !== commentKey || event.newValue !== null) return;
      const current = commentRef.current;
      // Storage events are delivered only to other tabs. If this tab still has
      // non-empty text, that text is its unsent draft even when another tab's
      // follow-up clear happens to remove the same persisted value.
      if (!current.trim()) return;
      setCommentDraftDurable(writeDraftStorage(commentKey, current));
    };
    window.addEventListener('storage', preserveUnsavedCommentOnRemoteClear);
    return () => window.removeEventListener('storage', preserveUnsavedCommentOnRemoteClear);
  }, [commentKey]);
  useEffect(() => {
    if (!legacyTextMigrationPending) {
      clearDraftStorage(legacyDraftKey);
      setLegacyIssueTextDurable(false);
    }
  }, [legacyDraftKey, legacyTextMigrationPending]);
  useEffect(() => {
    if (commentDraftDurable) {
      clearDraftStorage(legacyCommentKey);
      setLegacyCommentDurable(false);
    }
  }, [commentDraftDurable, legacyCommentKey]);
  useEffect(() => {
    if (!notificationRequestKey) return;
    const reportKey = `${issue.id}:${initialJournalId ?? 'issue'}:${notificationRequestKey || 'route'}`;
    if (reportedNotificationTargetsRef.current.has(reportKey)) return;
    const frame = requestAnimationFrame(() => {
      const dialog = document.querySelector<HTMLElement>('.issue-dialog[data-testid="issue-dialog"]');
      if (!dialog) return;
      if (initialJournalId === undefined) {
        reportedNotificationTargetsRef.current.add(reportKey);
        onNotificationTargetShown?.(issue.id);
        return;
      }
      const target = dialog.querySelector<HTMLElement>(`#journal-${initialJournalId}`);
      if (!target?.isConnected || target.closest('.issue-dialog') !== dialog) return;
      target.scrollIntoView({ behavior: 'auto', block: 'center' });
      target.focus({ preventScroll: true });
      const scroller = dialog.querySelector<HTMLElement>('.issue-dialog-scroll');
      const targetRect = target.getBoundingClientRect();
      const scrollerRect = scroller?.getBoundingClientRect();
      const visible = Boolean(scrollerRect && targetRect.bottom > scrollerRect.top && targetRect.top < scrollerRect.bottom);
      if (!visible) return;
      reportedNotificationTargetsRef.current.add(reportKey);
      onNotificationTargetShown?.(issue.id, initialJournalId);
    });
    return () => cancelAnimationFrame(frame);
  }, [issue.id, initialJournalId, notificationRequestKey, activityJournals, onNotificationTargetShown]);

  const setTextValue = (field: keyof IssueText, value: string) => {
    const nextDirty = value !== serverTextRef.current[field];
    dirtyTextRef.current = { ...dirtyTextRef.current, [field]: nextDirty };
    setDirtyText(dirtyTextRef.current);
    textDraftRef.current = { ...textDraftRef.current, [field]: value };
    setTextDraft(textDraftRef.current);
    setTextError('');
  };

  const discardTextDrafts = (fields: (keyof IssueText)[]) => {
    if (textSaving || !fields.length) return;
    const discarded = new Set(fields);
    const nextText = { ...textDraftRef.current };
    const nextDirty = { ...dirtyTextRef.current };
    const nextDurability = { ...textDraftDurability };
    for (const field of fields) {
      nextText[field] = serverTextRef.current[field];
      nextDirty[field] = false;
      nextDurability[field] = true;
      clearDraftStorage(textKeys[field]);
    }
    // If a legacy aggregate draft still carries unrelated dirty text, migrate
    // only those fields before clearing that aggregate. This keeps branch text
    // when the user discards the issue-card draft, and vice versa.
    for (const field of Object.keys(nextText) as (keyof IssueText)[]) {
      if (discarded.has(field) || !nextDirty[field]) continue;
      nextDurability[field] = writeDraftStorage(textKeys[field], nextText[field]);
    }
    clearDraftStorage(legacyDraftKey);
    setLegacyIssueTextDurable(false);
    baselineTextRef.current = { ...baselineTextRef.current, ...Object.fromEntries(fields.map((field) => [field, serverTextRef.current[field]])) };
    textDraftRef.current = nextText;
    dirtyTextRef.current = nextDirty;
    setTextDraft(nextText);
    setDirtyText(nextDirty);
    setTextDraftDurability(nextDurability);
    setTextError('');
  };

  const discardCommentDraft = () => {
    if (sendingComment) return;
    commentRef.current = '';
    setComment('');
    setCommentDraftDurable(clearDraftStorage(commentKey));
    clearDraftStorage(legacyCommentKey);
    setLegacyCommentDurable(false);
    setCommentError('');
  };

  const recordPersonChoice = async (field: PeopleField, personId: number, operationId: string) => {
    try { await api.post('/api/people/selection', { projectId: issue.projectId, personId, field, operationId }); }
    catch { /* Recommendation history never changes the result of the successful issue update. */ }
  };

  const saveAutoField = (field: AutoField, value: AutoValues[AutoField]) => {
    if (!canWrite || Object.is(autoDraft[field], value)) return;
    const generation = ++generationRef.current[field];
    const operationId = crypto.randomUUID();
    pendingCountRef.current[field] += 1;
    setAutoDraft((current) => ({ ...current, [field]: value }));
    setFieldSave((current) => ({ ...current, [field]: { state: 'pending' } }));
    const job = enqueueFieldWrite(fieldQueuesRef.current, `issue:${issue.id}`, async () => {
      if (field === 'developerId' || field === 'qaId') {
        const saved = await onSaveRoles(issue, { [field]: value ?? null }, operationId);
        if (saved?.updatedOn) updatedOnRef.current = saved.updatedOn;
        const savedValue = saved && Object.prototype.hasOwnProperty.call(saved, field) ? saved[field] : value;
        (confirmedAutoRef.current as Record<AutoField, unknown>)[field] = savedValue;
      } else {
        const patch = field === 'assignedToId' ? { assignedToId: value ?? null }
          : field === 'fixedVersionId' ? { fixedVersionId: value ?? null }
            : field === 'labels' ? { labels: value }
              : field === 'statusId' ? { statusId: value }
                : field === 'trackerId' ? { trackerId: value, trackerName: trackers.find((tracker) => tracker.id === value)?.name || issue.trackerName }
                  : { priorityId: value };
        const saved = await onSave(issue, { ...patch, expectedUpdatedOn: updatedOnRef.current } as IssueEditPatch, operationId);
        if (saved?.updatedOn) updatedOnRef.current = saved.updatedOn;
        const savedValue = saved && Object.prototype.hasOwnProperty.call(saved, field) ? saved[field] : value;
        (confirmedAutoRef.current as Record<AutoField, unknown>)[field] = savedValue;
      }
      const personField = peopleHistoryField[field];
      if (personField && typeof value === 'number') await recordPersonChoice(personField, value, operationId);
      return (confirmedAutoRef.current as Record<AutoField, unknown>)[field];
    });
    void job.then((savedValue) => {
      pendingCountRef.current[field] = Math.max(0, pendingCountRef.current[field] - 1);
      if (generationRef.current[field] === generation) {
        setAutoDraft((current) => ({ ...current, [field]: savedValue }));
        setFieldSave((current) => ({ ...current, [field]: { state: 'saved' } }));
      }
    }).catch((error: unknown) => {
      pendingCountRef.current[field] = Math.max(0, pendingCountRef.current[field] - 1);
      if (generationRef.current[field] === generation) {
        const message = error instanceof Error ? error.message : t('error');
        setAutoDraft((current) => ({ ...current, [field]: (confirmedAutoRef.current as Record<AutoField, unknown>)[field] as AutoValues[AutoField] }));
        setFieldSave((current) => ({ ...current, [field]: { state: 'error', error: message } }));
      }
    }).finally(() => {
      if (generationRef.current[field] !== generation && pendingCountRef.current[field] > 0) {
        setFieldSave((current) => current[field]?.state === 'error' ? { ...current, [field]: { state: 'pending' } } : current);
      }
    });
  };

  const saveAssignee = (value?: AssigneeSelection) => {
    const current = assigneeSelectionRef.current;
    if (!canWrite || (current?.type === value?.type && current?.id === value?.id)) return;
    const field: AutoField = 'assignedToId';
    const generation = ++generationRef.current[field];
    const operationId = crypto.randomUUID();
    pendingCountRef.current[field] += 1;
    assigneeSelectionRef.current = value;
    setAssigneeSelection(value);
    setAutoDraft((draft) => ({ ...draft, assignedToId: value?.id }));
    setFieldSave((state) => ({ ...state, [field]: { state: 'pending' } }));
    const patch: IssueEditPatch = {
      ...(value ? { assignedToType: value.type } : {}),
      assignedToId: value?.id ?? null,
      expectedUpdatedOn: updatedOnRef.current,
    };
    const job = enqueueFieldWrite(fieldQueuesRef.current, `issue:${issue.id}`, async () => {
      const saved = await onSave(issue, patch, operationId);
      if (saved?.updatedOn) updatedOnRef.current = saved.updatedOn;
      const savedId = saved && Object.prototype.hasOwnProperty.call(saved, 'assignedToId') ? saved.assignedToId : value?.id;
      const savedType = saved?.assignedToType || value?.type || 'user';
      const savedSelection = savedId === undefined || savedId === null ? undefined : { type: savedType, id: savedId } as AssigneeSelection;
      confirmedAssigneeRef.current = savedSelection;
      (confirmedAutoRef.current as Record<AutoField, unknown>)[field] = savedId ?? undefined;
      if (value?.type === 'user' && typeof value.id === 'number') await recordPersonChoice('assignee', value.id, operationId);
      return savedSelection;
    });
    void job.then((savedSelection) => {
      pendingCountRef.current[field] = Math.max(0, pendingCountRef.current[field] - 1);
      if (generationRef.current[field] === generation) {
        assigneeSelectionRef.current = savedSelection;
        setAssigneeSelection(savedSelection);
        setAutoDraft((draft) => ({ ...draft, assignedToId: savedSelection?.id }));
        setFieldSave((state) => ({ ...state, [field]: { state: 'saved' } }));
      }
    }).catch((error: unknown) => {
      pendingCountRef.current[field] = Math.max(0, pendingCountRef.current[field] - 1);
      if (generationRef.current[field] === generation) {
        const confirmed = confirmedAssigneeRef.current;
        assigneeSelectionRef.current = confirmed;
        setAssigneeSelection(confirmed);
        setAutoDraft((draft) => ({ ...draft, assignedToId: confirmed?.id }));
        setFieldSave((state) => ({ ...state, [field]: { state: 'error', error: error instanceof Error ? error.message : t('error') } }));
      }
    }).finally(() => {
      if (generationRef.current[field] !== generation && pendingCountRef.current[field] > 0) {
        setFieldSave((state) => state[field]?.state === 'error' ? { ...state, [field]: { state: 'pending' } } : state);
      }
    });
  };

  const saveText = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canWrite || !anyTextDirty || textSaving) return;
    const patch: IssueEditPatch = {};
    const submitted: Partial<IssueText> = {};
    const submittedRaw = { ...textDraft };
    if (dirtyText.subject) { submitted.subject = textDraft.subject.trim(); patch.subject = submitted.subject; }
    if (dirtyText.description) { submitted.description = textDraft.description; patch.description = submitted.description; }
    if (dirtyText.branch) { submitted.branch = textDraft.branch.trim(); patch.branch = submitted.branch; }
    if (dirtyText.dueDate) { submitted.dueDate = textDraft.dueDate; patch.dueDate = textDraft.dueDate || null; }
    if (!Object.keys(patch).length || (dirtyText.subject && !String(patch.subject || '').trim())) return;
    setTextSaving(true); setTextError('');
    try {
      const saved = await enqueueFieldWrite(fieldQueuesRef.current, `issue:${issue.id}`, async () => {
        const result = await onSave(issue, { ...patch, expectedUpdatedOn: updatedOnRef.current }, crypto.randomUUID());
        if (result?.updatedOn) updatedOnRef.current = result.updatedOn;
        return result;
      });
      const savedText: Partial<IssueText> = {
        subject: saved?.subject ?? submitted.subject,
        description: saved?.description ?? submitted.description,
        branch: saved?.branch ?? submitted.branch,
        dueDate: saved?.dueDate ?? submitted.dueDate,
      };
      const latestDraft = { ...textDraftRef.current };
      const latestDirty = { ...dirtyTextRef.current };
      for (const key of Object.keys(submitted) as (keyof IssueText)[]) {
        const value = savedText[key] ?? submitted[key]!;
        baselineTextRef.current[key] = value;
        serverTextRef.current = { ...serverTextRef.current, [key]: value };
        if (latestDraft[key] === submittedRaw[key]) {
          latestDraft[key] = value;
          latestDirty[key] = false;
        } else latestDirty[key] = latestDraft[key] !== value;
      }
      setServerText((current) => ({ ...current, ...savedText }));
      textDraftRef.current = latestDraft;
      dirtyTextRef.current = latestDirty;
      setTextDraft(latestDraft);
      setDirtyText(latestDirty);
      for (const key of Object.keys(submitted) as (keyof IssueText)[]) if (!latestDirty[key]) clearDraftStorage(textKeys[key]);
      clearDraftStorage(legacyDraftKey);
      setLegacyIssueTextDurable(false);
      onToast(t('saved'));
    } catch (error) { setTextError(error instanceof Error ? error.message : t('error')); }
    finally { setTextSaving(false); }
  };

  const sendComment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canWrite || !comment.trim() || sendingComment) return;
    setCommentError(''); setSendingComment(true);
    const sentComment = comment;
    if (currentUserId !== undefined) setOwnCommentReveal({
      notes: sentComment.trim(), userId: currentUserId, submittedAt: Date.now(),
      knownJournalIds: new Set([...detail.journals, ...activityJournalsRef.current, ...bufferedActivityRef.current].map((journal) => journal.id)),
    });
    try {
      await onComment(issue, sentComment.trim());
      clearDraftStorage(legacyCommentKey);
      setLegacyCommentDurable(false);
      if (commentRef.current === sentComment) {
        commentRef.current = '';
        setComment('');
        setCommentDraftDurable(clearDraftStorage(commentKey));
      }
      onToast(t('saved'));
    } catch (error) { setOwnCommentReveal(undefined); setCommentError(error instanceof Error ? error.message : t('error')); }
    finally { setSendingComment(false); }
  };

  const storeJournalEditDraft = (journalId: number, next: JournalEditDraft) => {
    journalEditDraftRef.current = next;
    setJournalEditDraft(next);
    const key = journalEditDraftKey(draftScope, issue.projectId, issue.id, journalId);
    const durable = next.notes === next.expectedNotes && !next.operationId
      ? clearDraftStorage(key)
      : writeDraftStorage(key, JSON.stringify(next));
    setJournalDraftDurable(durable);
  };

  const beginJournalEdit = (journal: IssueDetail['journals'][number]) => {
    const key = journalEditDraftKey(draftScope, issue.projectId, issue.id, journal.id);
    const stored = readJournalEditDraft(key, journal.notes);
    journalEditDraftRef.current = stored.draft;
    setJournalEditDraft(stored.draft);
    setJournalDraftDurable(stored.durable);
    setEditingJournalId(journal.id);
    setJournalEditError('');
    setJournalEditorFocusRequest((current) => current + 1);
  };

  const cancelJournalEdit = (journalId: number) => {
    setJournalDraftDurable(clearDraftStorage(journalEditDraftKey(draftScope, issue.projectId, issue.id, journalId)));
    journalEditDraftRef.current = undefined;
    setJournalEditDraft(undefined);
    setJournalEditError('');
    setEditingJournalId(undefined);
    requestAnimationFrame(() => journalEditButtonRefs.current.get(journalId)?.focus());
  };

  const changeJournalEditText = (value: string, journalId: number) => {
    const current = journalEditDraftRef.current;
    if (!current) return;
    storeJournalEditDraft(journalId, { notes: value, expectedNotes: current.expectedNotes });
    setJournalEditError('');
  };

  const saveJournalEdit = async (event: React.FormEvent<HTMLFormElement>, journal: IssueDetail['journals'][number]) => {
    event.preventDefault();
    const draft = journalEditDraftRef.current;
    if (!canWrite || !draft || savingJournalEdit || !draft.notes.trim() || draft.notes === draft.expectedNotes || draft.expectedNotes !== journal.notes) return;
    const operationId = draft.operationId || crypto.randomUUID();
    const savedNotes = draft.notes.trim();
    const submitted = { ...draft, operationId };
    storeJournalEditDraft(journal.id, submitted);
    setJournalEditError('');
    setSavingJournalEdit(true);
    try {
      await onEditJournal(issue, journal.id, savedNotes, submitted.expectedNotes, operationId);
      const latestDraft = journalEditDraftRef.current;
      if (latestDraft?.notes === submitted.notes) {
        cancelJournalEdit(journal.id);
      } else if (latestDraft) {
        storeJournalEditDraft(journal.id, { notes: latestDraft.notes, expectedNotes: savedNotes });
      }
      onToast(t('saved'));
    } catch (error) {
      setJournalEditError(error instanceof Error ? error.message : t('error'));
    } finally { setSavingJournalEdit(false); }
  };

  const resolveJournalConflict = (journal: IssueDetail['journals'][number], keepDraft: boolean) => {
    const draft = journalEditDraftRef.current;
    if (!draft) return;
    storeJournalEditDraft(journal.id, keepDraft
      ? { notes: draft.notes, expectedNotes: journal.notes }
      : { notes: journal.notes, expectedNotes: journal.notes });
    setJournalEditError('');
  };

  const deletionAttemptRef = useRef<{ journalId: number; expectedNotes: string; operationId: string } | undefined>(undefined);
  const openJournalDelete = (journal: IssueDetail['journals'][number]) => {
    setDeleteJournal({ journalId: journal.id, expectedNotes: journal.notes });
    setDeleteJournalError('');
  };
  const confirmJournalDelete = async () => {
    const journalId = deleteJournal?.journalId;
    const expectedNotes = deleteJournal?.expectedNotes;
    const journal = detail.journals.find((item) => item.id === journalId);
    if (!canWrite || journalId === undefined || expectedNotes === undefined || !journal || deletingJournal) return;
    const previous = deletionAttemptRef.current;
    const operationId = previous?.journalId === journalId && previous.expectedNotes === expectedNotes
      ? previous.operationId : crypto.randomUUID();
    deletionAttemptRef.current = { journalId, expectedNotes, operationId };
    setDeletingJournal(true);
    setDeleteJournalError('');
    try {
      await onDeleteJournal(issue, journalId, expectedNotes, operationId);
      clearDraftStorage(journalEditDraftKey(draftScope, issue.projectId, issue.id, journalId));
      if (editingJournalId === journalId) {
        journalEditDraftRef.current = undefined;
        setJournalEditDraft(undefined);
        setEditingJournalId(undefined);
      }
      deletionAttemptRef.current = undefined;
      setDeleteJournal(undefined);
      onToast(t('saved'));
      requestAnimationFrame(() => activityHeadingRef.current?.focus());
    } catch (error) {
      setDeleteJournalError(error instanceof Error ? error.message : t('error'));
    } finally { setDeletingJournal(false); }
  };

  const toggleJournalLike = async (journal: IssueDetail['journals'][number]) => {
    if (!canWrite || journal.canLike !== true || likingJournalIds.has(journal.id)) return;
    const liked = !journal.likedByMe;
    setLikingJournalIds((current) => new Set(current).add(journal.id));
    setJournalLikeErrors((current) => ({ ...current, [journal.id]: '' }));
    try { await onSetJournalLike(issue, journal.id, liked, crypto.randomUUID()); onToast(t('saved')); }
    catch (error) { setJournalLikeErrors((current) => ({ ...current, [journal.id]: error instanceof Error ? error.message : t('error') })); }
    finally { setLikingJournalIds((current) => { const next = new Set(current); next.delete(journal.id); return next; }); }
  };

  const journalPermalink = (journalId: number) => `${issueUrl(redmineUrl, issue.id)}#journal-${journalId}-notes`;
  const copyJournalPermalink = async (journalId: number) => {
    try { await navigator.clipboard.writeText(journalPermalink(journalId)); onToast(t('copied')); }
    catch { onToast(t('error')); }
  };

  const quoteJournal = (journal: IssueDetail['journals'][number]) => {
    if (!journal.notes) return;
    const format = detail.textFormat?.trim().toLocaleLowerCase().replace(/[ -]/g, '_');
    const quoteLines = journal.notes.split('\n').map((line) => format === 'textile' ? `bq. ${line}` : format === 'markdown' || format === 'common_mark' ? `> ${line}` : line).join('\n');
    const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(journal.createdOn));
    const attributionText = `— ${journal.user.name} · ${date}\n${journalPermalink(journal.id)}`;
    const attribution = format === 'textile' ? attributionText.split('\n').map((line) => `bq. ${line}`).join('\n')
      : format === 'markdown' || format === 'common_mark' ? attributionText.split('\n').map((line) => `> ${line}`).join('\n') : attributionText;
    const quoteText = `${quoteLines}\n${attribution}`;
    const separator = !comment ? '' : comment.endsWith('\n\n') ? '' : comment.endsWith('\n') ? '\n' : '\n\n';
    const next = `${comment}${separator}${quoteText}`;
    commentRef.current = next;
    setComment(next);
    setCommentError('');
    setCommentFocusRequest((current) => current + 1);
  };

  const onCopyUrl = async () => { try { await navigator.clipboard.writeText(issueUrl(redmineUrl, issue.id)); onToast(t('copied')); } catch { onToast(t('error')); } };
  const onGenerateBranch = () => setTextValue('branch', branchForIssue(issue.id, textDraft.subject));
  const allowedStatusIds = new Set(issue.allowedStatusIds ?? []);
  const visibleStatusChoices = statuses.filter((entry) => entry.id === issue.statusId || allowedStatusIds.has(entry.id));
  if (!visibleStatusChoices.some((entry) => entry.id === issue.statusId)) {
    visibleStatusChoices.unshift({ id: issue.statusId, name: issue.statusName || `#${issue.statusId}`, key: 'unknown', isClosed: false });
  }
  const statusOptions: PickerOption[] = visibleStatusChoices.map((entry) => ({
    value: String(entry.id), label: entry.name,
    ...(entry.id === issue.statusId && issue.allowedStatusIds !== undefined && !allowedStatusIds.has(entry.id) ? { disabled: true } : {}),
  }));
  const statusChoicesVerified = issue.allowedStatusIds !== undefined;
  const priorityOptions: ChoiceTileOption[] = priorities.map((entry) => ({ value: String(entry.id), label: entry.name, rank: entry.rank }));
  const versionOptions: PickerOption[] = [...activeVersions, ...(selectedClosedVersion ? [selectedClosedVersion] : [])]
    .map((version) => ({ value: String(version.id), label: version.name,
      description: version.status === 'closed' ? t('closed') : version.dueDate || undefined,
      ...(version.status === 'closed' ? { disabled: true } : {}) }));
  const labelOptions = [...new Set([...board.labels, ...(board.labelOptions || []).map((option) => option.name), ...issue.labels])].sort((a, b) => a.localeCompare(b));
  const activityItems = useMemo(() => visibleJournals(activityJournals, activityVisibility, initialJournalId), [activityJournals, activityVisibility, initialJournalId]);
  const bufferedJournalIds = useMemo(() => new Set(bufferedActivity.map((journal) => journal.id)), [bufferedActivity]);
  const excludedUnreadJournalIds = useMemo(() => new Set(initialJournalId === undefined ? [] : [initialJournalId]), [initialJournalId]);
  useVisibleUnreadEvents({
    issueId: issue.id,
    projectId: issue.projectId,
    notifications: unreadNotifications,
    activity: activityItems,
    bufferedJournalIds,
    excludedJournalIds: excludedUnreadJournalIds,
    rootRef: issueDialogScrollRef,
    onVisible: onUnreadEventsVisible,
  });
  const changeLookups = { statuses, people: issuePeople, priorities, versions: board.versions, labels: board.labelOptions || [] };
  const applyBufferedActivity = () => {
    const applyingIssueId = issue.id;
    const scroller = issueDialogScrollRef.current;
    const scrollerBounds = scroller?.getBoundingClientRect();
    const visibleAnchor = scrollerBounds
      ? [...(activityListRef.current?.querySelectorAll<HTMLElement>('.activity-item') ?? [])]
        .find((item) => {
          const bounds = item.getBoundingClientRect();
          return bounds.top < scrollerBounds.bottom && bounds.bottom > scrollerBounds.top;
        })
      : undefined;
    const visibleAnchorTop = visibleAnchor?.getBoundingClientRect().top;
    const previousScrollTop = scroller?.scrollTop;
    const latestById = new Map(detail.journals.map((journal) => [journal.id, journal]));
    const merged = new Map<number, Journal>();
    for (const journal of [...activityJournalsRef.current, ...bufferedActivityRef.current]) {
      const latest = latestById.get(journal.id);
      if (latest) merged.set(latest.id, latest);
    }
    const next = [...merged.values()];
    activityJournalsRef.current = next;
    setActivityJournals(next);
    bufferedActivityRef.current = [];
    setBufferedActivity([]);
    requestAnimationFrame(() => {
      if (activeIssueIdRef.current !== applyingIssueId || !scroller?.isConnected || issueDialogScrollRef.current !== scroller) return;
      if (scroller && visibleAnchor && visibleAnchorTop !== undefined) {
        const shift = visibleAnchor.getBoundingClientRect().top - visibleAnchorTop;
        if (Math.abs(shift) > 0.5) scroller.scrollTop += shift;
      } else if (scroller && previousScrollTop !== undefined) scroller.scrollTop = previousScrollTop;
      activityHeadingRef.current?.focus({ preventScroll: true });
    });
  };
  const progress = (field: AutoField) => {
    const item = fieldSave[field];
    if (!item) return null;
    return <span className={`field-save-state field-save-${item.state}`} aria-live="polite" title={item.error}>
      {item.state === 'pending' ? <><Spinner />{t('loading')}</> : item.state === 'saved' ? <><Check size={12} />{t('saved')}</> : <><AlertTriangle size={12} />{item.error || t('error')}</>}
    </span>;
  };

  return <Modal title={`${issue.trackerName} #${issue.id} ${issue.subject}`} heading={<span className="issue-heading-line"><span className="issue-heading-type">{issue.trackerName}</span>{' '}<span className="issue-heading-id">#{issue.id}</span>{' '}<span className="issue-heading-subject">{issue.subject}</span></span>} headerActions={<details className="issue-header-menu">
    <summary className="icon-button" aria-label={t('issueActions')} title={t('issueActions')}><MoreHorizontal size={17} /></summary>
    <div className="issue-header-menu-panel">
      <button type="button" onClick={onCopyUrl}><Copy size={14} />{t('copyRedmineUrl')}</button>
      <a href={issueUrl(redmineUrl, issue.id)} target="_blank" rel="noreferrer"><ArrowUpRight size={14} />{t('openRedmine')}</a>
    </div>
  </details>} onClose={onClose} size="lg" testId="issue-dialog" className="issue-dialog">
    <div className="issue-dialog-scroll" ref={issueDialogScrollRef}>
      {readOnlyMode && <ReadOnlyDialogStatus />}
      <DraftStorageStatus meaningful={anyTextDirty} durable={textDraftDurable} />
      <div className="issue-layout">
        <div className="issue-main-fields">
          <form id={textFormId} ref={textFormRef} className="issue-text-form" data-workspace-save onSubmit={saveText}>
            <Field label={t('issueTitle')}><input className="text-input input-title" value={textDraft.subject} onChange={(e) => setTextValue('subject', e.target.value)} /></Field>
            <div className="description-head"><span className="field-label">{t('description')}{dirtyText.description && <span className="description-draft-label"> · {t('textChanges')}</span>}</span><div className="segmented"><button type="button" className={!preview ? 'selected' : ''} onClick={() => setPreview(false)} data-testid="issue-description-edit-toggle">{t('edit')}</button><button type="button" className={preview ? 'selected' : ''} onClick={() => setPreview(true)}>{t('preview')}</button></div></div>
            {preview ? <div className="description-preview" data-testid="issue-description-preview" onClick={(event) => { if (!(event.target as HTMLElement).closest('a,button')) setPreview(false); }}>
              {textDraft.description ? <RichContent source={textDraft.description} format={detail.textFormat} issueId={issue.id} attachments={issue.attachments} redmineUrl={redmineUrl} imageUnavailableText={t('imageUnavailable')} openOriginalText={t('openImageOriginal')} retryImageText={t('retry')} /> : <span className="placeholder-text">{t('noDescription')}</span>}
            </div> : <Field as="div" label=""><RichEditor source={textDraft.description} format={detail.textFormat} onChange={(value) => setTextValue('description', value)} label={t('description')} placeholder={t('noDescription')} testId="issue-description-editor" people={mentionPeople} issueId={issue.id} attachments={issue.attachments} redmineUrl={redmineUrl} imageUnavailableText={t('imageUnavailable')} openOriginalText={t('openImageOriginal')} retryImageText={t('retry')} /></Field>}
            <Field label={t('branch')}><div className="input-with-actions"><GitBranch size={16} /><input className="text-input" value={textDraft.branch} onChange={(e) => setTextValue('branch', e.target.value)} /><Button size="sm" variant="outline" onClick={onGenerateBranch}><WandSparkles size={14} />{t('generate')}</Button><IconButton label={t('copyBranchShortcut')} onClick={async () => { try { await navigator.clipboard.writeText(textDraft.branch); onToast(t('copied')); } catch { onToast(t('error')); } }}><Copy size={15} /></IconButton></div></Field>
            {hasCardTextConflict && <Notice tone="warning" className="text-draft-conflict">{t('errorConflict')}</Notice>}
            {hasBranchTextConflict && <Notice tone="warning" className="text-draft-conflict">{t('errorConflict')}</Notice>}
            {textError && <Notice tone="error" className="text-save-error">{textError}</Notice>}
            {anyTextDirty && <div className="text-save-row"><span>{t('textChanges')}</span>{hasCardTextDraft && <Button size="sm" variant="outline" disabled={textSaving} onClick={() => discardTextDrafts(cardFields)} data-testid="discard-card-draft">{t('discardDraft')}: {t('issueTitle')}, {t('description')}, {t('dueDate')}</Button>}{dirtyText.branch && <Button size="sm" variant="outline" disabled={textSaving} onClick={() => discardTextDrafts(['branch'])} data-testid="discard-branch-draft">{t('discardDraft')}: {t('branch')}</Button>}<Button type="submit" variant="primary" disabled={!canWrite || textSaving || !textDraft.subject.trim()}>{textSaving ? <Spinner /> : <Save size={15} />}{t('saveChanges')}</Button></div>}
          </form>
          <div className="activity-toolbar" data-testid="activity-toolbar">
            <div className="activity-toolbar-heading"><History size={15} /><h3 ref={activityHeadingRef} tabIndex={-1}>{t('activity')}</h3><span>{activityItems.length}</span></div>
            <div className="activity-filter-row" role="group" aria-label={t('activityFilters')} data-testid="activity-filter-controls">
              {activityFilterKinds.map(({ key, label }) => <button key={key} type="button" className="activity-filter-button" aria-pressed={activityVisibility[key]} title={t('activityFilterProjectHint')} data-testid={`activity-filter-${key}`} onClick={() => onActivityVisibilityChange({ ...activityVisibility, [key]: !activityVisibility[key] })}>{t(label)}</button>)}
            </div>
          </div>
          {activityItems.some((item) => item.forcedByPermalink) && <div className="activity-target-override" role="status"><strong>{t('activityTargetOverride')}</strong><span>{t('activityTargetOverrideHint')}</span></div>}
          <form ref={commentFormRef} className="comment-composer" data-workspace-save onSubmit={sendComment}>
            <div className="section-title"><MessageSquare size={15} /><h3>{t('comments')}</h3></div>
            {commentEditorActive || Boolean(comment) || commentFocusRequest > 0 ? <RichEditor loadingFallback={<textarea autoFocus className="text-area comment-area" aria-label={t('comments')} data-testid="comment-composer-loading" value={comment} placeholder={t('commentPlaceholder')} onChange={event => changeCommentDraft(event.target.value)} />} source={comment} format={detail.textFormat} onChange={changeCommentDraft} label={t('comments')} placeholder={t('commentPlaceholder')} testId="comment-composer" people={mentionPeople} issueId={issue.id} attachments={issue.attachments} redmineUrl={redmineUrl} imageUnavailableText={t('imageUnavailable')} openOriginalText={t('openImageOriginal')} retryImageText={t('retry')} focusRequest={commentFocusRequest} /> : <textarea className="text-area comment-editor-activate" aria-label={t('comments')} data-testid="comment-composer-activate" value={comment} placeholder={t('commentPlaceholder')} onChange={event => changeCommentDraft(event.target.value)} onFocus={() => { setCommentEditorActive(true); setCommentFocusRequest(current => current + 1); }} />}
            <DraftStorageStatus meaningful={Boolean(comment.trim())} durable={commentDurable} />
            {commentError && <Notice tone="error" className="comment-save-error">{commentError}</Notice>}
            <div className="comment-footer"><span>{!canWrite ? t('readOnlyBadge') : ''}</span><div>{comment.trim() && <Button size="sm" variant="outline" disabled={sendingComment} onClick={discardCommentDraft}>{t('discardDraft')}: {t('comments')}</Button>}<Button type="submit" size="sm" variant="primary" disabled={!canWrite || !comment.trim() || sendingComment}>{sendingComment ? <Spinner /> : <Send size={14} />}{t('addComment')}</Button></div></div>
          </form>
          <div className="activity-new-events-slot" data-testid="activity-new-events-slot">
            {bufferedActivity.length > 0 && <div className="activity-new-events-banner" role="status" data-testid="activity-new-events">
              <Button size="sm" variant="outline" className="activity-new-events-action" onClick={applyBufferedActivity} data-testid="show-new-activity"><History size={14} aria-hidden="true" />{t('showNewActivity', { count: bufferedActivity.length })}</Button>
            </div>}
          </div>
          <div className="activity-list" ref={activityListRef}>
            {activityItems.length === 0 && <div className="activity-empty"><History size={15} />{activityJournals.length === 0 ? t('noActivity') : t('activityFilteredEmpty')}</div>}
            {activityItems.map(({ journal, showComment, changes, forcedByPermalink }) => {
              const journalUser = personFrom(issuePeople, journal.user.id) || journal.user;
              const isEditing = editingJournalId === journal.id;
              const isEditConflict = isEditing && journalEditDraft?.expectedNotes !== journal.notes;
              const hasNote = showComment && Boolean(journal.notes);
              const editAllowed = canWrite && journal.canEdit === true;
              const deleteAllowed = canWrite && journal.canDelete === true;
              const likeSupported = journal.canLike === true;
              return <article className={`activity-item${forcedByPermalink ? ' activity-item-permalink-target' : ''}`} key={journal.id} id={`journal-${journal.id}`} tabIndex={-1} data-testid={`journal-item-${journal.id}`} data-permalink-override={forcedByPermalink || undefined}>
                <Avatar person={journalUser} size="sm" />
                <div className="activity-body">
                  <div className="activity-heading" data-unread-event-heading={journal.id}><strong>{journalUser.name}</strong><time>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(journal.createdOn))}</time></div>
                  {hasNote && (isEditing ? <form ref={journalEditFormRef} className="journal-editor" data-unread-event-content={`${journal.id}:comment`} data-testid={`journal-editor-${journal.id}`} data-workspace-save onSubmit={(event) => { void saveJournalEdit(event, journal); }}>
                    <RichEditor source={journalEditDraft?.notes ?? ''} format={detail.textFormat} onChange={(value) => changeJournalEditText(value, journal.id)} label={t('editComment')} testId={`journal-editor-textarea-${journal.id}`} people={mentionPeople} issueId={issue.id} attachments={issue.attachments} redmineUrl={redmineUrl} imageUnavailableText={t('imageUnavailable')} openOriginalText={t('openImageOriginal')} retryImageText={t('retry')} focusRequest={journalEditorFocusRequest} />
                    <DraftStorageStatus meaningful={Boolean(journalEditDraft && (journalEditDraft.notes !== journalEditDraft.expectedNotes || journalEditDraft.operationId))} durable={journalDraftDurable} />
                    {isEditConflict && <div className="journal-edit-conflict" role="alert" data-testid={`journal-edit-conflict-${journal.id}`}>
                      <p>{t('commentEditConflict')}</p>
                      <details><summary>{t('latestComment')}</summary><pre>{journal.notes || t('commentDeletedElsewhere')}</pre></details>
                      <div className="journal-conflict-actions">
                        <Button size="sm" variant="outline" type="button" data-testid={`journal-keep-draft-${journal.id}`} onClick={() => resolveJournalConflict(journal, true)}>{t('continueWithDraft')}</Button>
                        <Button size="sm" type="button" data-testid={`journal-use-latest-${journal.id}`} onClick={() => resolveJournalConflict(journal, false)}>{t('useLatest')}</Button>
                        <Button size="sm" variant="outline" type="button" data-testid={`journal-discard-draft-${journal.id}`} disabled={savingJournalEdit} onClick={() => cancelJournalEdit(journal.id)}>{t('discardDraft')}</Button>
                      </div>
                    </div>}
                    {journalEditError && <div className="journal-edit-error" role="alert">{journalEditError}</div>}
                    <div className="journal-editor-footer"><span><kbd>⌘/Ctrl+S</kbd> {t('saveCommentEdit')}</span><div>
                      <Button size="sm" type="button" data-testid={`journal-cancel-${journal.id}`} disabled={savingJournalEdit} onClick={() => cancelJournalEdit(journal.id)}>{t('cancelCommentEdit')}</Button>
                      <Button size="sm" variant="primary" type="submit" data-testid={`journal-save-${journal.id}`} disabled={!canWrite || savingJournalEdit || isEditConflict || !journalEditDraft?.notes.trim() || journalEditDraft.notes === journalEditDraft.expectedNotes}>{savingJournalEdit ? <Spinner /> : <Save size={14} />}{t('saveCommentEdit')}</Button>
                    </div></div>
                  </form> : <div data-unread-event-content={`${journal.id}:comment`}><RichContent className="activity-rich-content" source={journal.notes} format={detail.textFormat} issueId={issue.id} attachments={issue.attachments} redmineUrl={redmineUrl} imageUnavailableText={t('imageUnavailable')} openOriginalText={t('openImageOriginal')} retryImageText={t('retry')} /></div>)}
                  {!!changes.length && <ul className="journal-field-changes">{changes.map((change, index) => { const kind = activityKindForField(change.field); const display = localizeJournalChange(change, changeLookups, t); return <li key={`${journal.id}-${index}`} data-activity-kind={kind} data-unread-event-content={`${journal.id}:${kind}`}><strong>{display.field}</strong><span>{display.oldValue}</span><span className="change-arrow">→</span><span>{display.newValue}</span></li>; })}</ul>}
                  {hasNote && <div className="journal-actions" role="group" aria-label={t('commentActions')}>
                    <button type="button" className="journal-action-button" data-testid={`journal-quote-${journal.id}`} aria-label={t('quoteComment')} title={t('quoteComment')} onClick={() => quoteJournal(journal)}><Quote size={13} /><span>{t('quoteComment')}</span></button>
                    <button type="button" className="journal-action-button" data-testid={`journal-permalink-${journal.id}`} aria-label={t('copyCommentLink')} title={t('copyCommentLink')} onClick={() => { void copyJournalPermalink(journal.id); }}><Link size={13} /><span>{t('commentLinkLabel')}</span></button>
                    {journal.canEdit === true && <button ref={(element) => { if (element) journalEditButtonRefs.current.set(journal.id, element); else journalEditButtonRefs.current.delete(journal.id); }} type="button" className="journal-action-button" data-testid={`journal-edit-${journal.id}`} aria-label={t('editComment')} title={editAllowed ? t('editComment') : canWrite ? t('commentEditUnavailable') : t('saveBlocked')} disabled={!editAllowed || savingJournalEdit || (editingJournalId !== undefined && editingJournalId !== journal.id)} onClick={() => beginJournalEdit(journal)}>{isEditing ? <Check size={13} /> : <Pencil size={13} />}<span>{isEditing ? t('editingComment') : t('edit')}</span></button>}
                    {journal.canDelete === true && <button type="button" className="journal-action-button journal-action-danger" data-testid={`journal-delete-${journal.id}`} aria-label={t('deleteComment')} title={deleteAllowed ? t('deleteComment') : canWrite ? t('commentDeleteUnavailable') : t('saveBlocked')} disabled={!deleteAllowed || deletingJournal || savingJournalEdit} onClick={() => openJournalDelete(journal)}><Trash2 size={13} /><span>{t('deleteComment')}</span></button>}
                    {likeSupported && <button type="button" className="journal-action-button" data-testid={`journal-like-${journal.id}`} aria-label={likeSupported ? `${journal.likedByMe ? t('unlikeComment') : t('likeComment')} (${journal.likes ?? 0})` : t('likesUnavailable')} title={likeSupported ? canWrite ? t('likeComment') : t('saveBlocked') : t('likesUnavailable')} aria-pressed={Boolean(journal.likedByMe)} disabled={!likeSupported || !canWrite || likingJournalIds.has(journal.id)} onClick={() => { void toggleJournalLike(journal); }}>
                      <Heart size={13} fill={journal.likedByMe ? 'currentColor' : 'none'} /><span>{likeSupported ? journal.likedByMe ? t('unlikeComment') : t('likeComment') : t('likesUnavailableShort')}</span>{journal.likes !== undefined && <span className="journal-like-count">{journal.likes}</span>}
                    </button>}
                    {journalLikeErrors[journal.id] && <span className="journal-like-error" role="alert">{journalLikeErrors[journal.id]}</span>}
                  </div>}
                </div>
              </article>;
            })}
          </div>
        </div>
        <aside className="issue-side-fields">
          <div className="side-section"><div className="section-title"><Users size={15} /><h3>{t('details')}</h3></div>
            <Field label={t('status')}><Picker className="issue-property-picker" options={statusOptions} label={t('status')} value={String(autoDraft.statusId)} onChange={(value) => saveAutoField('statusId', Number(value))} disabled={!canWrite || !statusChoicesVerified || !issue.allowedStatusIds?.some((id) => id !== issue.statusId)} />{!statusChoicesVerified && <span className="field-helper">{t('cannotMoveIssueStatus')}</span>}{progress('statusId')}</Field>
            <Field label={t('priorityField')} className="issue-choice-field"><ChoiceTiles className="issue-priority-tiles" kind="priority" options={priorityOptions} label={t('priorityField')} value={String(autoDraft.priorityId)} onChange={(value) => saveAutoField('priorityId', Number(value))} disabled={!canWrite} />{progress('priorityId')}</Field>
            {trackerOptions.length > 0 && <Field label={t('tracker')} className="issue-choice-field"><ChoiceTiles className="issue-tracker-tiles" kind="tracker" options={trackerOptions} label={t('tracker')} value={String(autoDraft.trackerId)} onChange={(value) => saveAutoField('trackerId', Number(value))} disabled={!canWrite} />{progress('trackerId')}</Field>}
            <Field label={t('assignee')} className="issue-assignee-field"><div className="assignee-avatar-row" role="group" aria-label={t('assignee')}>
              {assigneeCandidates.map((person) => <button key={person.id} type="button" className={`assignee-avatar-option${assigneeSelection?.type === 'user' && assigneeSelection.id === person.id ? ' is-selected' : ''}`} aria-label={person.name} title={person.name} data-person-id={person.id} aria-pressed={assigneeSelection?.type === 'user' && assigneeSelection.id === person.id} disabled={!canWrite} onClick={() => saveAssignee({ type: 'user', id: person.id })}><Avatar person={person} size="sm" /></button>)}
              <AssigneePicker groupAvatarOverrides={groupAvatarOverrides} compact className="assignee-avatar-picker" options={assigneeOptions} members={board.members} value={assigneeSelection} currentOption={assigneeCurrentOption} onChange={saveAssignee} label={t('assignee')} placeholder={t('noAssignee')} recommendations={board.peopleRecommendations?.assignee} disabled={!canWrite} />
            </div>{progress('assignedToId')}</Field>
            <Field label={t('release')}><Picker className="issue-property-picker" options={versionOptions} value={autoDraft.fixedVersionId === undefined ? undefined : String(autoDraft.fixedVersionId)} onChange={(value) => saveAutoField('fixedVersionId', value ? Number(value) : undefined)} label={t('release')} placeholder={t('noRelease')} clearable disabled={!canWrite} />{progress('fixedVersionId')}</Field>
            <Field label={t('labels')}><LabelsTiles options={labelOptions} values={autoDraft.labels} onChange={(values) => saveAutoField('labels', values)} label={t('labels')} disabled={!canWrite} />{progress('labels')}</Field>
            <Field label={t('dueDate')} className="issue-due-date-field"><div className="input-icon-wrap"><CalendarDays size={15} /><input form={textFormId} type="date" className="text-input" value={textDraft.dueDate} onChange={(e) => setTextValue('dueDate', e.target.value)} data-testid="issue-due-date" /></div></Field>
          </div>
          <div className="side-section role-section"><div className="section-title"><UserRound size={15} /><h3>{t('developer')} / {t('qa')}</h3></div>
            <Field label={t('developer')}><PeoplePicker className="issue-property-picker" members={board.members} value={autoDraft.developerId} onChange={(value) => saveAutoField('developerId', value)} label={t('developer')} placeholder={t('unknown')} recommendations={board.peopleRecommendations?.developer} disabled={!canWrite} />{progress('developerId')}</Field>
            <Field label={t('qa')}><PeoplePicker className="issue-property-picker" members={board.members} value={autoDraft.qaId} onChange={(value) => saveAutoField('qaId', value)} label={t('qa')} placeholder={t('unknown')} recommendations={board.peopleRecommendations?.qa} disabled={!canWrite} />{progress('qaId')}</Field>
            <div className="role-helper">{developer ? <span><Avatar person={developer} size="xs" />{developer.name}</span> : <span>{t('unknown')}</span>}{qa && <span><Avatar person={qa} size="xs" />{qa.name}</span>}</div>
          </div>
          <div className="side-section people-section"><div className="section-title"><Users size={15} /><h3>{t('author')}</h3></div><div className="person-row"><Avatar person={author} size="sm" /><span>{author?.name || t('unknown')}</span></div>
            <div className="section-title mini-section-title"><h3>{t('assignee')}</h3></div>{assigneeSelection?.type === 'group' ? <div className="person-row"><GroupAvatar group={{ type: 'group', id: assigneeSelection.id, name: assigneeCurrentOption?.name || t('unknown') }} override={groupAvatarOverrides?.[String(assigneeSelection.id)]} size="sm" /><span>{assigneeCurrentOption?.name || t('noAssignee')}</span></div> : <div className="person-row"><Avatar person={assignee} size="sm" /><span>{assignee?.name || t('noAssignee')}</span></div>}
            <div className="section-title mini-section-title"><h3>{t('watchers')}</h3><span>{issueWatchers.length}</span></div><div className="watcher-list">{issueWatchers.slice(0, 8).map((person) => <Avatar key={person.id} person={person} size="xs" />)}{issueWatchers.length > 8 && <span className="watcher-extra">+{issueWatchers.length - 8}</span>}</div>
          </div>
          <div className="side-section"><div className="section-title"><Paperclip size={15} /><h3>{t('attachments')}</h3><span>{issue.attachments.length}</span></div>{issue.attachments.length === 0 ? <div className="muted-copy">—</div> : <ul className="attachment-list">{issue.attachments.map((attachment) => { const href = isPreviewableImage(attachment) ? attachmentContentPath(issue.id, attachment.id) : safeAttachmentUrl(attachment.url, redmineUrl); return <li key={attachment.id}>{isPreviewableImage(attachment) && <AttachmentPreview attachment={attachment} issueId={issue.id} unavailableText={t('imageUnavailable')} openOriginalText={t('openImageOriginal')} retryText={t('retry')} />}{href ? <a href={href} target="_blank" rel="noreferrer"><FileText size={14} /><span>{attachment.filename}</span><ArrowUpRight size={12} /></a> : <span className="attachment-unavailable"><FileText size={14} /><span>{attachment.filename}</span></span>}<small>{formatBytes(attachment.size)}</small></li>; })}</ul>}</div>
          <div className="issue-dates"><span><CalendarDays size={13} />{new Intl.DateTimeFormat(i18n.language).format(new Date(issue.createdOn))}</span><span><Clock3 size={13} />{new Intl.DateTimeFormat(i18n.language).format(new Date(issue.updatedOn))}</span></div>
        </aside>
      </div>
    </div>
    {deleteJournal && <Modal title={t('deleteCommentTitle')} onClose={() => { if (!deletingJournal) { setDeleteJournal(undefined); setDeleteJournalError(''); } }} size="sm" testId="journal-delete-confirmation" className="journal-delete-dialog">
      <div className="journal-delete-content">
        <p>{t('deleteCommentMessage')}</p>
        {deleteJournalError && <div className="journal-delete-error" role="alert">{deleteJournalError}</div>}
        <div className="modal-footer"><Button type="button" data-testid="journal-delete-cancel" disabled={deletingJournal} onClick={() => { setDeleteJournal(undefined); setDeleteJournalError(''); }}>{t('cancel')}</Button><Button type="button" variant="danger" data-testid="journal-delete-confirm" disabled={!canWrite || deletingJournal} onClick={() => { void confirmJournalDelete(); }}>{deletingJournal ? <Spinner /> : <Trash2 size={14} />}{t('deleteComment')}</Button></div>
      </div>
    </Modal>}
  </Modal>;
}

export function CreateIssueDialog({ project, board, statuses, priorities, canWrite, readOnlyMode, draftScope, defaults, textFormat, groupAvatarOverrides, onClose, onCreate }: {
  groupAvatarOverrides?: Record<string, GroupAvatarOverride>;
  project: Project; board: BoardData; statuses: Status[]; priorities: Priority[]; canWrite: boolean; readOnlyMode: boolean; draftScope: string; textFormat?: string; onClose: () => void; onCreate: (command: { subject: string; description: string; statusId?: number; priorityId?: number; trackerId?: number; trackerName?: string; assignedToType?: 'user' | 'group'; assignedToId?: number; fixedVersionId?: number }, operationId?: string) => Promise<void>;
  defaults?: { statusId?: number; fixedVersionId?: number | null };
}) {
  const { t } = useTranslation();
  const legacyDraftKey = `redmine-workspace:new-draft:${encodeURIComponent(draftScope)}`;
  const titleKey = createIssueTextDraftKey(draftScope, project.id, 'subject');
  const descriptionKey = createIssueTextDraftKey(draftScope, project.id, 'description');
  const [storedDraft] = useState(() => {
    const legacyStorage = readDraftStorage(legacyDraftKey);
    const legacy = readLegacyDraftObject(legacyDraftKey);
    const subjectDraft = readDraftStorage(titleKey);
    const descriptionDraft = readDraftStorage(descriptionKey);
    const legacySubject = typeof legacy.subject === 'string' ? legacy.subject : '';
    const legacyDescription = typeof legacy.description === 'string' ? legacy.description : '';
    const subjectInherited = !subjectDraft.present && Boolean(legacySubject.trim());
    const descriptionInherited = !descriptionDraft.present && Boolean(legacyDescription.trim());
    return {
      legacy,
      legacyText: { subject: subjectInherited ? legacySubject : undefined, description: descriptionInherited ? legacyDescription : undefined },
      legacyDurable: legacyStorage.present && legacyStorage.durable,
      subject: subjectDraft.present ? subjectDraft.value ?? '' : legacySubject,
      description: descriptionDraft.present ? descriptionDraft.value ?? '' : legacyDescription,
      subjectDurable: subjectInherited ? false : subjectDraft.durable,
      descriptionDurable: descriptionInherited ? false : descriptionDraft.durable,
    };
  });
  const legacyDraft = storedDraft.legacy;
  const [subject, setSubject] = useState(storedDraft.subject);
  const [description, setDescription] = useState(storedDraft.description);
  const [draftDurability, setDraftDurability] = useState({ subject: storedDraft.subjectDurable, description: storedDraft.descriptionDurable });
  const draftDurabilityRef = useRef(draftDurability);
  draftDurabilityRef.current = draftDurability;
  const [legacyBackup, setLegacyBackup] = useState({ durable: storedDraft.legacyDurable, text: storedDraft.legacyText });
  const subjectRef = useRef(subject);
  const descriptionRef = useRef(description);
  subjectRef.current = subject;
  descriptionRef.current = description;
  const [statusId, setStatusId] = useState(Number(defaults?.statusId ?? legacyDraft.statusId ?? statuses.find((status) => status.key === 'todo')?.id ?? statuses[0]?.id ?? 0));
  const [priorityId, setPriorityId] = useState(Number(legacyDraft.priorityId || priorities[0]?.id || 0));
  const trackers = board.trackers ?? [...new Map(board.issues.map(issue => [issue.trackerId, { id: issue.trackerId, name: issue.trackerName }])).values()];
  const [trackerId, setTrackerId] = useState<number | undefined>(typeof legacyDraft.trackerId === 'number' ? legacyDraft.trackerId : trackers[0]?.id);
  const [assignedToId, setAssignedToId] = useState<number | undefined>(typeof legacyDraft.assignedToId === 'number' ? legacyDraft.assignedToId : undefined);
  const [assignedToType, setAssignedToType] = useState<'user' | 'group' | undefined>(typeof legacyDraft.assignedToId === 'number' ? legacyDraft.assignedToType === 'group' ? 'group' : 'user' : undefined);
  const [fixedVersionId, setFixedVersionId] = useState<number | undefined>(defaults?.fixedVersionId !== undefined
    ? defaults.fixedVersionId ?? undefined : typeof legacyDraft.fixedVersionId === 'number' ? legacyDraft.fixedVersionId : undefined);
  const propertiesRef = useRef({ statusId, priorityId, trackerId, assignedToId, assignedToType, fixedVersionId });
  propertiesRef.current = { statusId, priorityId, trackerId, assignedToId, assignedToType, fixedVersionId };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const formRef = useWorkspaceFormSave<HTMLFormElement>();
  const activeVersions = board.versions.filter((version) => version.status !== 'closed');
  const assigneeCandidates = useMemo(() => suggestedAssignees(board.members, assignedToType === 'user' ? assignedToId : undefined, board.peopleRecommendations?.assignee), [board.members, board.peopleRecommendations?.assignee, assignedToId, assignedToType]);
  const createAssigneeSelection = assignedToId === undefined || assignedToType === undefined ? undefined : { type: assignedToType, id: assignedToId } as AssigneeSelection;
  const createCurrentAssigneeOption: AssigneeOption | undefined = createAssigneeSelection ? board.assigneeOptions?.find((option) => option.type === createAssigneeSelection.type && option.id === createAssigneeSelection.id)
    || (createAssigneeSelection.type === 'group' ? { type: 'group', id: createAssigneeSelection.id, name: `#${createAssigneeSelection.id}` }
      : { type: 'user', id: createAssigneeSelection.id, name: personFrom(board.members, createAssigneeSelection.id)?.name || `#${createAssigneeSelection.id}` }) : undefined;
  const issueDraftDurable = (!subject.trim() || draftDurability.subject || (legacyBackup.durable && legacyBackup.text.subject === subject))
    && (!description.trim() || draftDurability.description || (legacyBackup.durable && legacyBackup.text.description === description));
  useEffect(() => {
    const durable = subject.trim() ? writeDraftStorage(titleKey, subject) : clearDraftStorage(titleKey);
    draftDurabilityRef.current = { ...draftDurabilityRef.current, subject: durable };
    setDraftDurability((current) => ({ ...current, subject: durable }));
  }, [subject, titleKey]);
  useEffect(() => {
    const durable = description.trim() ? writeDraftStorage(descriptionKey, description) : clearDraftStorage(descriptionKey);
    draftDurabilityRef.current = { ...draftDurabilityRef.current, description: durable };
    setDraftDurability((current) => ({ ...current, description: durable }));
  }, [description, descriptionKey]);
  useEffect(() => {
    // This runs after the scoped text effects above, so the ref reflects the write
    // result from this render before deciding whether legacy text can be removed.
    const properties = propertiesRef.current;
    const backupText = {
      subject: !draftDurabilityRef.current.subject && subject.trim() ? subject : undefined,
      description: !draftDurabilityRef.current.description && description.trim() ? description : undefined,
    };
    const nextLegacy = { ...properties, ...(backupText.subject ? { subject: backupText.subject } : {}), ...(backupText.description ? { description: backupText.description } : {}) };
    setLegacyBackup({ durable: writeDraftStorage(legacyDraftKey, JSON.stringify(nextLegacy)), text: backupText });
  }, [statusId, priorityId, trackerId, assignedToId, assignedToType, fixedVersionId, subject, description, draftDurability, legacyDraftKey]);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!subject.trim() || !canWrite || busy) return;
    setBusy(true); setError('');
    const operationId = crypto.randomUUID();
    const submittedSubject = subject;
    const submittedDescription = description;
    const submittedProperties = JSON.stringify({ statusId, priorityId, trackerId, assignedToId, assignedToType, fixedVersionId });
    try {
      await onCreate({ subject: subject.trim(), description, statusId: statusId || undefined, priorityId: priorityId || undefined, trackerId, trackerName: trackers.find((tracker) => tracker.id === trackerId)?.name, assignedToType, assignedToId, fixedVersionId }, operationId);
      if (assignedToId !== undefined && assignedToType === 'user') {
        try { await api.post('/api/people/selection', { projectId: project.id, personId: assignedToId, field: 'assignee', operationId }); } catch { /* Successful issue creation remains successful if local recommendation history is unavailable. */ }
      }
      const subjectDurable = subjectRef.current === submittedSubject
        ? clearDraftStorage(titleKey) : writeDraftStorage(titleKey, subjectRef.current);
      const descriptionDurable = descriptionRef.current === submittedDescription
        ? clearDraftStorage(descriptionKey) : writeDraftStorage(descriptionKey, descriptionRef.current);
      draftDurabilityRef.current = { subject: subjectDurable, description: descriptionDurable };
      setDraftDurability(draftDurabilityRef.current);
      const latestProperties = propertiesRef.current;
      if (JSON.stringify(latestProperties) === submittedProperties) {
        clearDraftStorage(legacyDraftKey);
        setLegacyBackup({ durable: false, text: { subject: undefined, description: undefined } });
      } else {
        const backupText = {
          subject: subjectRef.current !== submittedSubject && !draftDurabilityRef.current.subject && subjectRef.current.trim() ? subjectRef.current : undefined,
          description: descriptionRef.current !== submittedDescription && !draftDurabilityRef.current.description && descriptionRef.current.trim() ? descriptionRef.current : undefined,
        };
        setLegacyBackup({ durable: writeDraftStorage(legacyDraftKey, JSON.stringify({ ...latestProperties, ...(backupText.subject ? { subject: backupText.subject } : {}), ...(backupText.description ? { description: backupText.description } : {}) })), text: backupText });
      }
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : t('error')); }
    finally { setBusy(false); }
  };
  const statusOptions = statuses.map((entry) => ({ value: String(entry.id), label: entry.name }));
  const priorityOptions: ChoiceTileOption[] = priorities.map((entry) => ({ value: String(entry.id), label: entry.name, rank: entry.rank }));
  const trackerOptions: ChoiceTileOption[] = trackers.map((tracker) => ({ value: String(tracker.id), label: tracker.name }));
  const versionOptions = activeVersions.map((version) => ({ value: String(version.id), label: version.name, description: version.dueDate || undefined }));
  return <Modal title={t('issueCreateTitle')} eyebrow={project.name} onClose={onClose} testId="issue-dialog" className="create-issue-dialog">
    <form ref={formRef} onSubmit={submit} className="create-issue-form" data-workspace-save>
      <p className="form-intro">{t('issueCreateIntro')}</p>
      {readOnlyMode && <ReadOnlyDialogStatus />}
      {error && <Notice tone="error">{error}</Notice>}
      <DraftStorageStatus meaningful={Boolean(subject.trim() || description.trim())} durable={issueDraftDurable} />
      <Field label={t('issueTitle')}><input className="text-input input-title" autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t('issueTitlePlaceholder')} data-testid="issue-title" required /></Field>
      <Field as="div" label={t('description')}><RichEditor source={description} format={textFormat} onChange={setDescription} label={t('description')} placeholder={t('noDescription')} testId="issue-description-editor" /></Field>
      <div className="create-issue-properties" aria-label={t('details')}>
        <Field label={t('status')} className="create-property-chip"><Picker className="create-property-picker" options={statusOptions} value={String(statusId)} onChange={(value) => setStatusId(Number(value))} label={t('status')} /></Field>
        <Field label={t('priorityField')} className="create-property-chip"><ChoiceTiles className="create-priority-tiles" kind="priority" options={priorityOptions} value={String(priorityId)} onChange={(value) => setPriorityId(Number(value))} label={t('priorityField')} /></Field>
        {trackerOptions.length > 0 && <Field label={t('tracker')} className="create-property-chip"><ChoiceTiles className="create-tracker-tiles" kind="tracker" options={trackerOptions} value={trackerId === undefined ? undefined : String(trackerId)} onChange={(value) => setTrackerId(value ? Number(value) : undefined)} label={t('tracker')} /></Field>}
        <Field label={t('assignee')} className="create-property-chip"><div className="assignee-avatar-row" role="group" aria-label={t('assignee')}>
          {assigneeCandidates.map((person) => <button key={person.id} type="button" className={`assignee-avatar-option${assignedToType === 'user' && assignedToId === person.id ? ' is-selected' : ''}`} aria-label={person.name} title={person.name} data-person-id={person.id} aria-pressed={assignedToType === 'user' && assignedToId === person.id} onClick={() => { setAssignedToId(person.id); setAssignedToType('user'); }}><Avatar person={person} size="sm" /></button>)}
          <AssigneePicker groupAvatarOverrides={groupAvatarOverrides} compact className="assignee-avatar-picker" options={board.assigneeOptions} members={board.members} value={createAssigneeSelection} currentOption={createCurrentAssigneeOption} onChange={(value) => { setAssignedToId(value?.id); setAssignedToType(value?.type); }} label={t('assignee')} placeholder={t('noAssignee')} recommendations={board.peopleRecommendations?.assignee} />
        </div></Field>
        <Field label={t('release')} className="create-property-chip"><Picker className="create-property-picker" options={versionOptions} value={fixedVersionId === undefined ? undefined : String(fixedVersionId)} onChange={(value) => setFixedVersionId(value ? Number(value) : undefined)} label={t('release')} placeholder={t('noRelease')} clearable /></Field>
      </div>
      <div className="branch-preview-note"><GitBranch size={15} /><span>{t('branchPreview')}</span></div>
      <div className="modal-footer"><Button type="button" onClick={onClose}>{t('cancel')}</Button><Button variant="primary" type="submit" disabled={!canWrite || !subject.trim() || busy} data-testid="issue-submit">{busy ? <Spinner /> : <Check size={15} />}{busy ? t('creating') : t('createIssue')}</Button></div>
    </form>
  </Modal>;
}

function safeAttachmentUrl(value: string, redmineUrl: string): string | undefined {
  try {
    const base = new URL(redmineUrl);
    const target = new URL(value, base);
    if ((target.protocol === 'https:' || target.protocol === 'http:') && target.origin === base.origin) return target.toString();
  } catch { /* Untrusted or malformed attachment links are rendered as text. */ }
  return undefined;
}

function formatBytes(bytes: number) { return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
