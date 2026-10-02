import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowUpRight, CalendarDays, Check, Clock3, Copy, FileText, GitBranch, History, MessageSquare, Paperclip, Save, Send, UserRound, Users, WandSparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BoardData, Issue, IssueDetail, PeopleField, Person, Priority, Project, Status, Version } from '../../../shared/types';
import { branchForIssue } from '../../../shared/domain';
import { Avatar, Button, Field, IconButton, Modal, Notice, Spinner } from '../../components/ui';
import { MultiPicker, Picker, PeoplePicker, type PickerOption } from '../../components/pickers';
import { ChoiceTiles, type ChoiceTileOption } from '../../components/choiceTiles';
import { api, issueUrl } from '../../lib/api';
import { createIssueTextDraftKey, enqueueFieldWrite, issueTextDraftKey, useWorkspaceFormSave } from '../../lib/serialFieldWrite';

type IssueText = { subject: string; description: string; branch: string; dueDate: string };
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

function readDraft(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function personFrom(members: Person[], id?: number) { return members.find((person) => person.id === id); }

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

export function IssueDialog({ detail, board, statuses, priorities, redmineUrl, draftScope, initialJournalId, canWrite, onClose, onSave, onComment, onSaveRoles, onToast }: {
  detail: IssueDetail; board: BoardData; statuses: Status[]; priorities: Priority[]; redmineUrl: string; canWrite: boolean; onClose: () => void;
  draftScope: string; initialJournalId?: number;
  onSave: (issue: Issue, patch: IssueEditPatch, operationId?: string) => Promise<Issue | void>; onComment: (issue: Issue, notes: string) => Promise<void>;
  onSaveRoles: (issue: Issue, rolePatch: { developerId?: number | null; qaId?: number | null }, operationId?: string) => Promise<Issue | void>; onToast: (text: string) => void; initialComment?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const issue = detail.issue;
  const initialText = useRef(issueText(issue)).current;
  const legacyDraftKey = `redmine-workspace:draft:${encodeURIComponent(draftScope)}:${issue.projectId}:${issue.id}`;
  const legacyDraft = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(legacyDraftKey) || '{}') as Partial<IssueText>; } catch { return {}; }
  }, [legacyDraftKey]);
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
  const initialDraft = useMemo(() => ({
    subject: readDraft(textKeys.subject, legacyDraft.subject ?? initialText.subject),
    description: readDraft(textKeys.description, legacyDraft.description ?? initialText.description),
    branch: readDraft(textKeys.branch, legacyDraft.branch ?? initialText.branch),
    dueDate: readDraft(textKeys.dueDate, legacyDraft.dueDate ?? initialText.dueDate),
  }), [textKeys, initialText, legacyDraft]);
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
  const [autoDraft, setAutoDraft] = useState<AutoValues>(() => autoValues(issue));
  const confirmedAutoRef = useRef<AutoValues>(autoValues(issue));
  const fieldQueuesRef = useRef(new Map<string, Promise<unknown>>());
  const updatedOnRef = useRef(issue.updatedOn);
  const generationRef = useRef<Record<AutoField, number>>({ statusId: 0, priorityId: 0, trackerId: 0, assignedToId: 0, developerId: 0, qaId: 0, fixedVersionId: 0, labels: 0 });
  const pendingCountRef = useRef<Record<AutoField, number>>({ statusId: 0, priorityId: 0, trackerId: 0, assignedToId: 0, developerId: 0, qaId: 0, fixedVersionId: 0, labels: 0 });
  const [fieldSave, setFieldSave] = useState<Partial<Record<AutoField, FieldSaveState>>>({});
  const [textSaving, setTextSaving] = useState(false);
  const [textError, setTextError] = useState('');
  const [comment, setComment] = useState(() => readDraft(issueTextDraftKey(draftScope, issue.projectId, issue.id, 'comment'), readDraft(legacyCommentKey, '')));
  const commentRef = useRef(comment);
  const [commentError, setCommentError] = useState('');
  const [sendingComment, setSendingComment] = useState(false);
  const [preview, setPreview] = useState(false);
  const textFormRef = useWorkspaceFormSave<HTMLFormElement>();

  const activeVersions = board.versions.filter((version) => version.projectId === issue.projectId && version.status !== 'closed');
  const trackers = useMemo(() => board.trackers
    ? [...board.trackers, ...(!board.trackers.some(tracker => tracker.id === issue.trackerId) ? [{ id: issue.trackerId, name: issue.trackerName }] : [])]
    : [...new Map([...board.issues, issue].map(entry => [entry.trackerId, { id: entry.trackerId, name: entry.trackerName }])).values()], [board.trackers, board.issues, issue]);
  const trackerOptions: ChoiceTileOption[] = trackers.map((tracker) => ({ value: String(tracker.id), label: tracker.name }));
  const status = statuses.find((entry) => entry.id === issue.statusId);
  const priority = priorities.find((entry) => entry.id === issue.priorityId);
  const author = personFrom(board.members, issue.authorId);
  const assignee = personFrom(board.members, autoDraft.assignedToId);
  const developer = personFrom(board.members, autoDraft.developerId);
  const qa = personFrom(board.members, autoDraft.qaId);
  const assigneeCandidates = useMemo(() => suggestedAssignees(board.members, autoDraft.assignedToId, board.peopleRecommendations?.assignee), [board.members, board.peopleRecommendations?.assignee, autoDraft.assignedToId]);
  const anyTextDirty = Object.values(dirtyText).some(Boolean);
  const hasTextConflict = (Object.keys(dirtyText) as (keyof IssueText)[]).some((key) => dirtyText[key] && serverText[key] !== baselineTextRef.current[key]);

  useEffect(() => {
    const next = issueText(issue);
    updatedOnRef.current = issue.updatedOn;
    serverTextRef.current = next;
    setServerText(next);
    setTextDraft((current) => {
      const updated = { ...current };
      for (const key of Object.keys(next) as (keyof IssueText)[]) {
        if (!dirtyTextRef.current[key]) {
          updated[key] = next[key];
          baselineTextRef.current[key] = next[key];
        }
      }
      textDraftRef.current = updated;
      return updated;
    });
    const nextAuto = autoValues(issue);
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
    try {
      for (const key of Object.keys(textDraft) as (keyof IssueText)[]) {
        if (dirtyText[key]) localStorage.setItem(textKeys[key], textDraft[key]);
        else localStorage.removeItem(textKeys[key]);
      }
    } catch { /* Text drafts remain best effort when browser storage is unavailable. */ }
  }, [textDraft, dirtyText, textKeys]);
  useEffect(() => {
    const key = issueTextDraftKey(draftScope, issue.projectId, issue.id, 'comment');
    try { if (comment.trim()) localStorage.setItem(key, comment); else localStorage.removeItem(key); } catch { /* Keep editing available if local storage is unavailable. */ }
  }, [comment, draftScope, issue.projectId, issue.id]);
  useEffect(() => {
    try { localStorage.removeItem(legacyDraftKey); localStorage.removeItem(legacyCommentKey); } catch { /* New field-scoped drafts have already been written above. */ }
  }, [legacyDraftKey, legacyCommentKey]);
  useEffect(() => {
    if (!initialJournalId) return;
    const timer = window.setTimeout(() => {
      const target = document.getElementById(`journal-${initialJournalId}`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target?.focus({ preventScroll: true });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [initialJournalId, detail.journals]);

  const setTextValue = (field: keyof IssueText, value: string) => {
    const nextDirty = value !== serverTextRef.current[field];
    dirtyTextRef.current = { ...dirtyTextRef.current, [field]: nextDirty };
    setDirtyText(dirtyTextRef.current);
    textDraftRef.current = { ...textDraftRef.current, [field]: value };
    setTextDraft(textDraftRef.current);
    setTextError('');
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
      try { for (const key of Object.keys(submitted) as (keyof IssueText)[]) if (!latestDirty[key]) localStorage.removeItem(textKeys[key]); } catch { /* The save is already confirmed by the server. */ }
      onToast(t('saved'));
    } catch (error) { setTextError(error instanceof Error ? error.message : t('error')); }
    finally { setTextSaving(false); }
  };

  const sendComment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canWrite || !comment.trim() || sendingComment) return;
    setCommentError(''); setSendingComment(true);
    const sentComment = comment;
    try {
      await onComment(issue, sentComment.trim());
      if (commentRef.current === sentComment) { commentRef.current = ''; setComment(''); }
      onToast(t('saved'));
    } catch (error) { setCommentError(error instanceof Error ? error.message : t('error')); }
    finally { setSendingComment(false); }
  };

  const onCopyUrl = async () => { try { await navigator.clipboard.writeText(issueUrl(redmineUrl, issue.id)); onToast(t('copied')); } catch { onToast(t('error')); } };
  const onGenerateBranch = () => setTextValue('branch', branchForIssue(issue.id, textDraft.subject));
  const statusOptions: PickerOption[] = statuses.map((entry) => ({ value: String(entry.id), label: entry.name }));
  const priorityOptions: ChoiceTileOption[] = priorities.map((entry) => ({ value: String(entry.id), label: entry.name, rank: entry.rank }));
  const versionOptions: PickerOption[] = activeVersions.map((version) => ({ value: String(version.id), label: version.name, description: version.dueDate || undefined }));
  const labelOptions: PickerOption[] = [...new Set([...board.labels, ...issue.labels])].sort().map((label) => ({ value: label, label }));
  const progress = (field: AutoField) => {
    const item = fieldSave[field];
    if (!item) return null;
    return <span className={`field-save-state field-save-${item.state}`} aria-live="polite" title={item.error}>
      {item.state === 'pending' ? <><Spinner />{t('loading')}</> : item.state === 'saved' ? <><Check size={12} />{t('saved')}</> : <><AlertTriangle size={12} />{item.error || t('error')}</>}
    </span>;
  };

  return <Modal title={`#${issue.id} ${issue.subject}`} eyebrow={`${issue.trackerName} · ${status?.name || t('unknown')}`} onClose={onClose} size="lg" testId="issue-dialog" className="issue-dialog">
    <div className="issue-toolbar">
      <div className="issue-toolbar-left">
        <span className={`status-pill status-${status?.key || 'unknown'}`}><span className="status-pill-dot" />{status?.name || t('unknown')}</span>
        {autoDraft.fixedVersionId && <span className="roadmap-pill"><CalendarDays size={13} />{board.versions.find((v) => v.id === autoDraft.fixedVersionId)?.name || t('roadmap')}</span>}
        {priority && <span className="subtle-meta">{t('priorityField')}: {priority.name}</span>}
      </div>
      <div className="issue-toolbar-actions">
        <IconButton label={t('copyRedmineUrl')} onClick={onCopyUrl}><Copy size={16} /></IconButton>
        <a className="icon-button" href={issueUrl(redmineUrl, issue.id)} target="_blank" rel="noreferrer" aria-label={t('openRedmine')} title={t('openRedmine')}><ArrowUpRight size={16} /></a>
      </div>
    </div>
    <div className="issue-dialog-scroll">
      {!canWrite && <Notice tone="warning">{t('saveBlocked')}</Notice>}
      {anyTextDirty && <span className="draft-saved-indicator"><Check size={13} />{t('draftSaved')}</span>}
      <div className="issue-layout">
        <div className="issue-main-fields">
          <form ref={textFormRef} className="issue-text-form" data-workspace-save onSubmit={saveText}>
            <Field label={t('issueTitle')}><input className="text-input input-title" value={textDraft.subject} onChange={(e) => setTextValue('subject', e.target.value)} /></Field>
            <div className="description-head"><span className="field-label">{t('description')}</span><div className="segmented"><button type="button" className={!preview ? 'selected' : ''} onClick={() => setPreview(false)}>{t('edit')}</button><button type="button" className={preview ? 'selected' : ''} onClick={() => setPreview(true)}>{t('preview')}</button></div></div>
            {preview ? <div className="description-preview"><div className="raw-preview-label">{t('rawTextPreview')}</div>{textDraft.description || <span className="placeholder-text">{t('noDescription')}</span>}</div> : <Field label=""><textarea className="text-area description-area" aria-label={t('description')} value={textDraft.description} onChange={(e) => setTextValue('description', e.target.value)} placeholder={t('noDescription')} /></Field>}
            <Field label={t('branch')}><div className="input-with-actions"><GitBranch size={16} /><input className="text-input" value={textDraft.branch} onChange={(e) => setTextValue('branch', e.target.value)} /><Button size="sm" variant="outline" onClick={onGenerateBranch}><WandSparkles size={14} />{t('generate')}</Button><IconButton label={t('copyBranchShortcut')} onClick={async () => { try { await navigator.clipboard.writeText(textDraft.branch); onToast(t('copied')); } catch { onToast(t('error')); } }}><Copy size={15} /></IconButton></div></Field>
            <Field label={t('dueDate')}><div className="input-icon-wrap"><CalendarDays size={15} /><input type="date" className="text-input" value={textDraft.dueDate} onChange={(e) => setTextValue('dueDate', e.target.value)} /></div></Field>
            {hasTextConflict && <Notice tone="warning" className="text-draft-conflict">{t('errorConflict')}</Notice>}
            {textError && <Notice tone="error" className="text-save-error">{textError}</Notice>}
            {anyTextDirty && <div className="text-save-row"><span>{t('textChanges')}</span><Button type="submit" variant="primary" disabled={!canWrite || textSaving || !textDraft.subject.trim()}>{textSaving ? <Spinner /> : <Save size={15} />}{t('saveChanges')}</Button></div>}
          </form>
          <div className="section-title"><History size={15} /><h3>{t('activity')}</h3><span>{detail.journals.length}</span></div>
          <div className="activity-list">
            {detail.journals.length === 0 && <div className="activity-empty"><History size={15} />{t('noActivity')}</div>}
            {detail.journals.map((journal) => <article className="activity-item" key={journal.id} id={`journal-${journal.id}`} tabIndex={-1}><Avatar person={journal.user} size="sm" /><div className="activity-body"><div className="activity-heading"><strong>{journal.user.name}</strong><time>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(journal.createdOn))}</time></div>
              {!!journal.notes && <p>{journal.notes}</p>}
              {!!journal.changes.length && <ul>{journal.changes.map((change, index) => <li key={`${journal.id}-${index}`}><strong>{change.field}</strong>{change.oldValue && <span>{change.oldValue}</span>}<span className="change-arrow">→</span>{change.newValue || t('unknown')}</li>)}</ul>}
            </div></article>)}
          </div>
          <form className="comment-composer" onSubmit={sendComment}>
            <div className="section-title"><MessageSquare size={15} /><h3>{t('comments')}</h3></div>
            <textarea className="text-area comment-area" aria-label={t('comments')} value={comment} onChange={(e) => { commentRef.current = e.target.value; setComment(e.target.value); setCommentError(''); }} placeholder={t('commentPlaceholder')} />
            {commentError && <Notice tone="error" className="comment-save-error">{commentError}</Notice>}
            <div className="comment-footer"><span>{!canWrite ? t('readOnlyBadge') : ''}</span><Button type="submit" size="sm" variant="primary" disabled={!canWrite || !comment.trim() || sendingComment}>{sendingComment ? <Spinner /> : <Send size={14} />}{t('addComment')}</Button></div>
          </form>
        </div>
        <aside className="issue-side-fields">
          <div className="side-section"><div className="section-title"><Users size={15} /><h3>{t('details')}</h3></div>
            <Field label={t('status')}><Picker className="issue-property-picker" options={statusOptions} label={t('status')} value={String(autoDraft.statusId)} onChange={(value) => saveAutoField('statusId', Number(value))} disabled={!canWrite} />{progress('statusId')}</Field>
            <Field label={t('priorityField')} className="issue-choice-field"><ChoiceTiles className="issue-priority-tiles" kind="priority" options={priorityOptions} label={t('priorityField')} value={String(autoDraft.priorityId)} onChange={(value) => saveAutoField('priorityId', Number(value))} disabled={!canWrite} />{progress('priorityId')}</Field>
            {trackerOptions.length > 0 && <Field label={t('tracker')} className="issue-choice-field"><ChoiceTiles className="issue-tracker-tiles" kind="tracker" options={trackerOptions} label={t('tracker')} value={String(autoDraft.trackerId)} onChange={(value) => saveAutoField('trackerId', Number(value))} disabled={!canWrite} />{progress('trackerId')}</Field>}
            <Field label={t('assignee')} className="issue-assignee-field"><div className="assignee-avatar-row" role="group" aria-label={t('assignee')}>
              {assigneeCandidates.map((person) => <button key={person.id} type="button" className={`assignee-avatar-option${autoDraft.assignedToId === person.id ? ' is-selected' : ''}`} aria-label={person.name} title={person.name} data-person-id={person.id} aria-pressed={autoDraft.assignedToId === person.id} disabled={!canWrite} onClick={() => saveAutoField('assignedToId', person.id)}><Avatar person={person} size="sm" /></button>)}
              <PeoplePicker compact className="assignee-avatar-picker" members={board.members} value={autoDraft.assignedToId} onChange={(value) => saveAutoField('assignedToId', value)} label={t('assignee')} placeholder={t('noAssignee')} recommendations={board.peopleRecommendations?.assignee} disabled={!canWrite} />
            </div>{progress('assignedToId')}</Field>
            <Field label={t('release')}><Picker className="issue-property-picker" options={versionOptions} value={autoDraft.fixedVersionId === undefined ? undefined : String(autoDraft.fixedVersionId)} onChange={(value) => saveAutoField('fixedVersionId', value ? Number(value) : undefined)} label={t('release')} placeholder={t('noRelease')} clearable disabled={!canWrite} />{progress('fixedVersionId')}</Field>
            <Field label={t('labels')}><MultiPicker className="issue-property-picker" options={labelOptions} values={autoDraft.labels} onChange={(values) => saveAutoField('labels', values)} label={t('labels')} placeholder={t('labels')} disabled={!canWrite} />{progress('labels')}</Field>
          </div>
          <div className="side-section role-section"><div className="section-title"><UserRound size={15} /><h3>{t('developer')} / {t('qa')}</h3></div>
            <Field label={t('developer')}><PeoplePicker className="issue-property-picker" members={board.members} value={autoDraft.developerId} onChange={(value) => saveAutoField('developerId', value)} label={t('developer')} placeholder={t('unknown')} recommendations={board.peopleRecommendations?.developer} disabled={!canWrite} />{progress('developerId')}</Field>
            <Field label={t('qa')}><PeoplePicker className="issue-property-picker" members={board.members} value={autoDraft.qaId} onChange={(value) => saveAutoField('qaId', value)} label={t('qa')} placeholder={t('unknown')} recommendations={board.peopleRecommendations?.qa} disabled={!canWrite} />{progress('qaId')}</Field>
            <div className="role-helper">{developer ? <span><Avatar person={developer} size="xs" />{developer.name}</span> : <span>{t('unknown')}</span>}{qa && <span><Avatar person={qa} size="xs" />{qa.name}</span>}</div>
          </div>
          <div className="side-section people-section"><div className="section-title"><Users size={15} /><h3>{t('author')}</h3></div><div className="person-row"><Avatar person={author} size="sm" /><span>{author?.name || t('unknown')}</span></div>
            <div className="section-title mini-section-title"><h3>{t('assignee')}</h3></div><div className="person-row"><Avatar person={assignee} size="sm" /><span>{assignee?.name || t('noAssignee')}</span></div>
            <div className="section-title mini-section-title"><h3>{t('watchers')}</h3><span>{detail.watchers.length}</span></div><div className="watcher-list">{detail.watchers.slice(0, 8).map((person) => <Avatar key={person.id} person={person} size="xs" />)}{detail.watchers.length > 8 && <span className="watcher-extra">+{detail.watchers.length - 8}</span>}</div>
          </div>
          <div className="side-section"><div className="section-title"><Paperclip size={15} /><h3>{t('attachments')}</h3><span>{issue.attachments.length}</span></div>{issue.attachments.length === 0 ? <div className="muted-copy">—</div> : <ul className="attachment-list">{issue.attachments.map((attachment) => { const href = safeAttachmentUrl(attachment.url, redmineUrl); return <li key={attachment.id}>{href ? <a href={href} target="_blank" rel="noreferrer"><FileText size={14} /><span>{attachment.filename}</span><ArrowUpRight size={12} /></a> : <span className="attachment-unavailable"><FileText size={14} /><span>{attachment.filename}</span></span>}<small>{formatBytes(attachment.size)}</small></li>; })}</ul>}</div>
          <div className="issue-dates"><span><CalendarDays size={13} />{new Intl.DateTimeFormat(i18n.language).format(new Date(issue.createdOn))}</span><span><Clock3 size={13} />{new Intl.DateTimeFormat(i18n.language).format(new Date(issue.updatedOn))}</span></div>
        </aside>
      </div>
    </div>
    <div className="issue-dialog-footer"><span>{anyTextDirty ? t('draftSaved') : `${t('actualStatus')}: ${status?.name || t('unknown')}`}</span><div>{!canWrite && anyTextDirty && <span className="readonly-inline"><AlertTriangle size={14} />{t('readOnlyBadge')}</span>}<Button onClick={onClose}>{t('close')}</Button></div></div>
  </Modal>;
}

export function CreateIssueDialog({ project, board, statuses, priorities, canWrite, draftScope, onClose, onCreate }: {
  project: Project; board: BoardData; statuses: Status[]; priorities: Priority[]; canWrite: boolean; draftScope: string; onClose: () => void; onCreate: (command: { subject: string; description: string; statusId?: number; priorityId?: number; trackerId?: number; trackerName?: string; assignedToId?: number; fixedVersionId?: number }, operationId?: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const legacyDraftKey = `redmine-workspace:new-draft:${encodeURIComponent(draftScope)}`;
  const legacyDraft = (() => { try { return JSON.parse(localStorage.getItem(legacyDraftKey) || '{}') as Record<string, unknown>; } catch { return {}; } })();
  const titleKey = createIssueTextDraftKey(draftScope, project.id, 'subject');
  const descriptionKey = createIssueTextDraftKey(draftScope, project.id, 'description');
  const [subject, setSubject] = useState(() => readDraft(titleKey, String(legacyDraft.subject || '')));
  const [description, setDescription] = useState(() => readDraft(descriptionKey, String(legacyDraft.description || '')));
  const [statusId, setStatusId] = useState(Number(legacyDraft.statusId || statuses.find((status) => status.key === 'todo')?.id || statuses[0]?.id || 0));
  const [priorityId, setPriorityId] = useState(Number(legacyDraft.priorityId || priorities[0]?.id || 0));
  const trackers = board.trackers ?? [...new Map(board.issues.map(issue => [issue.trackerId, { id: issue.trackerId, name: issue.trackerName }])).values()];
  const [trackerId, setTrackerId] = useState<number | undefined>(typeof legacyDraft.trackerId === 'number' ? legacyDraft.trackerId : trackers[0]?.id);
  const [assignedToId, setAssignedToId] = useState<number | undefined>(typeof legacyDraft.assignedToId === 'number' ? legacyDraft.assignedToId : undefined);
  const [fixedVersionId, setFixedVersionId] = useState<number | undefined>(typeof legacyDraft.fixedVersionId === 'number' ? legacyDraft.fixedVersionId : undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const formRef = useWorkspaceFormSave<HTMLFormElement>();
  const activeVersions = board.versions.filter((version) => version.status !== 'closed');
  const assigneeCandidates = useMemo(() => suggestedAssignees(board.members, assignedToId, board.peopleRecommendations?.assignee), [board.members, board.peopleRecommendations?.assignee, assignedToId]);
  useEffect(() => {
    try { if (subject) localStorage.setItem(titleKey, subject); else localStorage.removeItem(titleKey); } catch { /* Local drafts are best effort. */ }
  }, [subject, titleKey]);
  useEffect(() => {
    try { if (description) localStorage.setItem(descriptionKey, description); else localStorage.removeItem(descriptionKey); } catch { /* Local drafts are best effort. */ }
  }, [description, descriptionKey]);
  useEffect(() => {
    try { localStorage.setItem(legacyDraftKey, JSON.stringify({ statusId, priorityId, trackerId, assignedToId, fixedVersionId })); } catch { /* Local property draft is best effort. */ }
  }, [statusId, priorityId, trackerId, assignedToId, fixedVersionId, legacyDraftKey]);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!subject.trim() || !canWrite || busy) return;
    setBusy(true); setError('');
    const operationId = crypto.randomUUID();
    try {
      await onCreate({ subject: subject.trim(), description, statusId: statusId || undefined, priorityId: priorityId || undefined, trackerId, trackerName: trackers.find((tracker) => tracker.id === trackerId)?.name, assignedToId, fixedVersionId }, operationId);
      if (assignedToId !== undefined) {
        try { await api.post('/api/people/selection', { projectId: project.id, personId: assignedToId, field: 'assignee', operationId }); } catch { /* Successful issue creation remains successful if local recommendation history is unavailable. */ }
      }
      try { localStorage.removeItem(legacyDraftKey); localStorage.removeItem(titleKey); localStorage.removeItem(descriptionKey); } catch { /* Issue creation succeeded even if local storage is unavailable. */ }
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
      {!canWrite && <Notice tone="warning">{t('saveBlocked')}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {!canWrite && (subject || description) && <span className="draft-saved-indicator"><Check size={13} />{t('draftSaved')}</span>}
      <Field label={t('issueTitle')}><input className="text-input input-title" autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t('issueTitlePlaceholder')} data-testid="issue-title" required /></Field>
      <Field label={t('description')}><textarea className="text-area create-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('noDescription')} data-testid="issue-description" /></Field>
      <div className="create-issue-properties" aria-label={t('details')}>
        <Field label={t('status')} className="create-property-chip"><Picker className="create-property-picker" options={statusOptions} value={String(statusId)} onChange={(value) => setStatusId(Number(value))} label={t('status')} /></Field>
        <Field label={t('priorityField')} className="create-property-chip"><ChoiceTiles className="create-priority-tiles" kind="priority" options={priorityOptions} value={String(priorityId)} onChange={(value) => setPriorityId(Number(value))} label={t('priorityField')} /></Field>
        {trackerOptions.length > 0 && <Field label={t('tracker')} className="create-property-chip"><ChoiceTiles className="create-tracker-tiles" kind="tracker" options={trackerOptions} value={trackerId === undefined ? undefined : String(trackerId)} onChange={(value) => setTrackerId(value ? Number(value) : undefined)} label={t('tracker')} /></Field>}
        <Field label={t('assignee')} className="create-property-chip"><div className="assignee-avatar-row" role="group" aria-label={t('assignee')}>
          {assigneeCandidates.map((person) => <button key={person.id} type="button" className={`assignee-avatar-option${assignedToId === person.id ? ' is-selected' : ''}`} aria-label={person.name} title={person.name} data-person-id={person.id} aria-pressed={assignedToId === person.id} onClick={() => setAssignedToId(person.id)}><Avatar person={person} size="sm" /></button>)}
          <PeoplePicker compact className="assignee-avatar-picker" members={board.members} value={assignedToId} onChange={setAssignedToId} label={t('assignee')} placeholder={t('noAssignee')} recommendations={board.peopleRecommendations?.assignee} />
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
