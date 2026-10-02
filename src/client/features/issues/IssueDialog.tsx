import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowUpRight, CalendarDays, Check, Clock3, Copy, FileText, GitBranch, History, MessageSquare, Paperclip, Save, Send, UserRound, Users, WandSparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BoardData, Issue, IssueDetail, Person, Priority, Project, Status, Version } from '../../../shared/types';
import { branchForIssue } from '../../../shared/domain';
import { Avatar, Button, Field, IconButton, Modal, Notice, Spinner } from '../../components/ui';
import { issueUrl } from '../../lib/api';

type Draft = { subject: string; description: string; statusId: number; priorityId: number; assignedToId?: number; developerId?: number; qaId?: number; fixedVersionId?: number; branch: string; labelsText: string; dueDate: string };
export type IssueEditPatch = Omit<Partial<Issue>, 'assignedToId' | 'developerId' | 'qaId' | 'fixedVersionId' | 'dueDate'> & { assignedToId?: number | null; developerId?: number | null; qaId?: number | null; fixedVersionId?: number | null; dueDate?: string | null };

function makeDraft(issue: Issue): Draft {
  return { subject: issue.subject, description: issue.description || '', statusId: issue.statusId, priorityId: issue.priorityId, assignedToId: issue.assignedToId, developerId: issue.developerId, qaId: issue.qaId, fixedVersionId: issue.fixedVersionId, branch: issue.branch || '', labelsText: issue.labels.join(', '), dueDate: issue.dueDate || '' };
}
function applyIssuePatch(issue: Issue, patch: IssueEditPatch): Issue {
  const updated = { ...issue, ...patch } as Issue;
  for (const key of ['assignedToId', 'developerId', 'qaId', 'fixedVersionId', 'dueDate'] as const) {
    if (patch[key] === undefined || patch[key] === null) delete updated[key];
  }
  return updated;
}

function avatarPerson(members: Person[], id?: number) { return members.find((person) => person.id === id); }

export function IssueDialog({ detail, board, statuses, priorities, redmineUrl, draftScope, initialJournalId, canWrite, onClose, onSave, onComment, onSaveRoles, onToast }: {
  detail: IssueDetail; board: BoardData; statuses: Status[]; priorities: Priority[]; redmineUrl: string; canWrite: boolean; onClose: () => void;
  draftScope: string; initialJournalId?: number;
  onSave: (issue: Issue, patch: IssueEditPatch) => Promise<Issue | void>; onComment: (issue: Issue, notes: string) => Promise<void>;
  onSaveRoles: (issue: Issue, rolePatch: { developerId?: number | null; qaId?: number | null }) => Promise<Issue | void>; onToast: (text: string) => void; initialComment?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const issue = detail.issue;
  const draftKey = `redmine-workspace:draft:${encodeURIComponent(draftScope)}:${issue.projectId}:${issue.id}`;
  const [draft, setDraft] = useState<Draft>(() => {
    try { return { ...makeDraft(issue), ...JSON.parse(localStorage.getItem(draftKey) || '{}') }; } catch { return makeDraft(issue); }
  });
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingRole, setSavingRole] = useState(false);
  const [comment, setComment] = useState(() => { try { return localStorage.getItem(`${draftKey}:comment`) || ''; } catch { return ''; } });
  const [sendingComment, setSendingComment] = useState(false);
  const [error, setError] = useState('');
  const [roleError, setRoleError] = useState('');
  const baseDraft = useMemo(() => makeDraft(issue), [issue]);
  const changed = useMemo(() => JSON.stringify(draft) !== JSON.stringify(baseDraft), [draft, baseDraft]);
  const roleChanged = draft.developerId !== issue.developerId || draft.qaId !== issue.qaId;
  const editableChanged = useMemo(() => JSON.stringify({ ...draft, developerId: baseDraft.developerId, qaId: baseDraft.qaId }) !== JSON.stringify(baseDraft), [draft, baseDraft]);
  const author = avatarPerson(board.members, issue.authorId);
  const assignee = avatarPerson(board.members, issue.assignedToId);
  const developer = avatarPerson(board.members, issue.developerId);
  const qa = avatarPerson(board.members, issue.qaId);
  const activeVersions = board.versions.filter((version) => version.projectId === issue.projectId && version.status !== 'closed');
  const status = statuses.find((entry) => entry.id === issue.statusId);
  const priority = priorities.find((entry) => entry.id === issue.priorityId);

  useEffect(() => {
    try { if (changed) localStorage.setItem(draftKey, JSON.stringify(draft)); else localStorage.removeItem(draftKey); } catch { /* Local drafts are best effort. */ }
  }, [draft, changed, draftKey]);
  useEffect(() => { try { if (comment.trim()) localStorage.setItem(`${draftKey}:comment`, comment); else localStorage.removeItem(`${draftKey}:comment`); } catch { /* Local drafts are best effort. */ } }, [comment, draftKey]);
  useEffect(() => {
    if (!initialJournalId) return;
    const timer = window.setTimeout(() => {
      const target = document.getElementById(`journal-${initialJournalId}`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target?.focus({ preventScroll: true });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [initialJournalId, detail.journals]);
  const patchDraft = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  const onSaveChanges = async () => {
    if ((!canWrite && !roleChanged) || (!editableChanged && !roleChanged)) return;
    setError(''); setSaving(true);
    const labels = [...new Set(draft.labelsText.split(',').map((v) => v.trim()).filter(Boolean))];
    const patch: IssueEditPatch = { subject: draft.subject.trim(), description: draft.description, statusId: draft.statusId, priorityId: draft.priorityId, assignedToId: draft.assignedToId, fixedVersionId: draft.fixedVersionId, branch: draft.branch.trim(), labels, dueDate: draft.dueDate || undefined, ...(draft.qaId !== issue.qaId ? { qaId: draft.qaId ?? null } : {}) };
    try {
      let savedIssue: Issue | void = undefined;
      const qaSavedByCommand = canWrite && editableChanged && draft.qaId !== issue.qaId;
      if (canWrite && editableChanged) savedIssue = await onSave(issue, patch);
      if (roleChanged) {
        const rolePatch = { ...(draft.developerId !== issue.developerId ? { developerId: draft.developerId ?? null } : {}), ...(!qaSavedByCommand && draft.qaId !== issue.qaId ? { qaId: draft.qaId ?? null } : {}) };
        if (Object.keys(rolePatch).length > 0) savedIssue = await onSaveRoles(issue, rolePatch);
      }
      localStorage.removeItem(draftKey);
      setDraft(makeDraft(savedIssue || applyIssuePatch(issue, patch)));
      onToast(t('saved'));
    }
    catch (e) { setError(e instanceof Error ? e.message : t('error')); }
    finally { setSaving(false); }
  };
  const onSaveRoleChanges = async () => {
    if (!roleChanged) return;
    setRoleError(''); setSavingRole(true);
    try {
      const savedIssue = await onSaveRoles(issue, { ...(draft.developerId !== issue.developerId ? { developerId: draft.developerId ?? null } : {}), ...(draft.qaId !== issue.qaId ? { qaId: draft.qaId ?? null } : {}) });
      setDraft(makeDraft(savedIssue || { ...issue, developerId: draft.developerId, qaId: draft.qaId }));
      onToast(t('saved'));
    } catch (e) { setRoleError(e instanceof Error ? e.message : t('error')); }
    finally { setSavingRole(false); }
  };
  const onSendComment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite || !comment.trim()) return;
    setError(''); setSendingComment(true);
    try { await onComment(issue, comment.trim()); setComment(''); localStorage.removeItem(`${draftKey}:comment`); onToast(t('saved')); }
    catch (e) { setError(e instanceof Error ? e.message : t('error')); }
    finally { setSendingComment(false); }
  };
  const onCopyUrl = async () => { try { await navigator.clipboard.writeText(issueUrl(redmineUrl, issue.id)); onToast(t('copied')); } catch { onToast(t('error')); } };
  const onGenerateBranch = () => patchDraft({ branch: branchForIssue(issue.id, draft.subject) });
  return <Modal title={`#${issue.id} ${issue.subject}`} eyebrow={`${issue.trackerName} · ${status?.name || t('unknown')}`} onClose={onClose} size="lg" testId="issue-dialog" className="issue-dialog">
    <div className="issue-toolbar">
      <div className="issue-toolbar-left">
        <span className={`status-pill status-${status?.key || 'unknown'}`}><span className="status-pill-dot" />{status?.name || t('unknown')}</span>
        {issue.fixedVersionId && <span className="roadmap-pill"><CalendarDays size={13} />{board.versions.find((v) => v.id === issue.fixedVersionId)?.name || t('roadmap')}</span>}
        {priority && <span className="subtle-meta">{t('priorityField')}: {priority.name}</span>}
      </div>
      <div className="issue-toolbar-actions">
        <IconButton label={t('copyRedmineUrl')} onClick={onCopyUrl}><Copy size={16} /></IconButton>
        <a className="icon-button" href={issueUrl(redmineUrl, issue.id)} target="_blank" rel="noreferrer" aria-label={t('openRedmine')} title={t('openRedmine')}><ArrowUpRight size={16} /></a>
      </div>
    </div>
    <div className="issue-dialog-scroll">
      {!canWrite && <Notice tone="warning">{t('saveBlocked')}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {editableChanged && !canWrite && <span className="draft-saved-indicator"><Check size={13} />{t('draftSaved')}</span>}
      <div className="issue-layout">
        <div className="issue-main-fields">
          <Field label={t('issueTitle')}><input className="text-input input-title" value={draft.subject} disabled={!canWrite} onChange={(e) => patchDraft({ subject: e.target.value })} /></Field>
          <div className="description-head"><span className="field-label">{t('description')}</span><div className="segmented"><button type="button" className={!preview ? 'selected' : ''} onClick={() => setPreview(false)}>{t('edit')}</button><button type="button" className={preview ? 'selected' : ''} onClick={() => setPreview(true)}>{t('preview')}</button></div></div>
          {preview ? <div className="description-preview"><div className="raw-preview-label">{t('rawTextPreview')}</div>{draft.description || <span className="placeholder-text">{t('noDescription')}</span>}</div> : <Field label=""><textarea className="text-area description-area" value={draft.description} disabled={!canWrite} onChange={(e) => patchDraft({ description: e.target.value })} placeholder={t('noDescription')} /></Field>}
          <Field label={t('branch')}><div className="input-with-actions"><GitBranch size={16} /><input className="text-input" value={draft.branch} disabled={!canWrite} onChange={(e) => patchDraft({ branch: e.target.value })} /><Button size="sm" variant="outline" disabled={!canWrite} onClick={onGenerateBranch}><WandSparkles size={14} />{t('generate')}</Button><IconButton label={t('copyBranchShortcut')} onClick={async () => { try { await navigator.clipboard.writeText(draft.branch); onToast(t('copied')); } catch { onToast(t('error')); } }}><Copy size={15} /></IconButton></div></Field>
          <Field label={t('labels')}><input className="text-input" value={draft.labelsText} disabled={!canWrite} onChange={(e) => patchDraft({ labelsText: e.target.value })} placeholder="Build: Running, backend" /></Field>
          <div className="section-title"><History size={15} /><h3>{t('activity')}</h3><span>{detail.journals.length}</span></div>
          <div className="activity-list">
            {detail.journals.length === 0 && <div className="activity-empty"><History size={15} />{t('noActivity')}</div>}
            {detail.journals.map((journal) => <article className="activity-item" key={journal.id} id={`journal-${journal.id}`} tabIndex={-1}><Avatar person={journal.user} size="sm" /><div className="activity-body"><div className="activity-heading"><strong>{journal.user.name}</strong><time>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(journal.createdOn))}</time></div>
              {!!journal.notes && <p>{journal.notes}</p>}
              {!!journal.changes.length && <ul>{journal.changes.map((change, index) => <li key={`${journal.id}-${index}`}><strong>{change.field}</strong>{change.oldValue && <span>{change.oldValue}</span>}<span className="change-arrow">→</span>{change.newValue || t('unknown')}</li>)}</ul>}
            </div></article>)}
          </div>
          <form className="comment-composer" onSubmit={onSendComment}>
            <div className="section-title"><MessageSquare size={15} /><h3>{t('comments')}</h3></div>
            <textarea className="text-area comment-area" value={comment} disabled={!canWrite} onChange={(e) => setComment(e.target.value)} placeholder={t('commentPlaceholder')} />
            <div className="comment-footer"><span>{!canWrite ? t('readOnlyBadge') : ''}</span><Button type="submit" size="sm" variant="primary" disabled={!canWrite || !comment.trim() || sendingComment}>{sendingComment ? <Spinner /> : <Send size={14} />}{t('addComment')}</Button></div>
          </form>
        </div>
        <aside className="issue-side-fields">
          <div className="side-section"><div className="section-title"><Users size={15} /><h3>{t('details')}</h3></div>
            <Field label={t('status')}><select className="text-input" disabled={!canWrite} value={draft.statusId} onChange={(e) => patchDraft({ statusId: Number(e.target.value) })}>{statuses.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></Field>
            <Field label={t('priorityField')}><select className="text-input" disabled={!canWrite} value={draft.priorityId} onChange={(e) => patchDraft({ priorityId: Number(e.target.value) })}>{priorities.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></Field>
            <Field label={t('assignee')}><select className="text-input" disabled={!canWrite} value={draft.assignedToId ?? ''} onChange={(e) => patchDraft({ assignedToId: e.target.value ? Number(e.target.value) : undefined })}><option value="">{t('noAssignee')}</option>{board.members.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></Field>
            <Field label={t('release')}><select className="text-input" disabled={!canWrite} value={draft.fixedVersionId ?? ''} onChange={(e) => patchDraft({ fixedVersionId: e.target.value ? Number(e.target.value) : undefined })}><option value="">{t('removeRoadmap')}</option>{activeVersions.map((version) => <option key={version.id} value={version.id}>{version.name}</option>)}</select></Field>
            <Field label={t('dueDate')}><div className="input-icon-wrap"><CalendarDays size={15} /><input type="date" className="text-input" disabled={!canWrite} value={draft.dueDate} onChange={(e) => patchDraft({ dueDate: e.target.value })} /></div></Field>
            {canWrite && <Button variant="primary" className="full-width" disabled={!changed || saving || !draft.subject.trim()} onClick={onSaveChanges}>{saving ? <Spinner /> : <Save size={15} />}{t('saveChanges')}</Button>}
          </div>
          <div className="side-section role-section"><div className="section-title"><UserRound size={15} /><h3>{t('developer')} / {t('qa')}</h3></div>
            <Field label={t('developer')}><select className="text-input" value={draft.developerId ?? ''} onChange={(e) => patchDraft({ developerId: e.target.value ? Number(e.target.value) : undefined })}><option value="">{t('unknown')}</option>{board.members.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></Field>
            <Field label={t('qa')}><select className="text-input" value={draft.qaId ?? ''} onChange={(e) => patchDraft({ qaId: e.target.value ? Number(e.target.value) : undefined })}><option value="">{t('unknown')}</option>{board.members.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></Field>
            <div className="role-helper">{developer ? <span><Avatar person={developer} size="xs" />{developer.name}</span> : <span>{t('unknown')}</span>}{qa && <span><Avatar person={qa} size="xs" />{qa.name}</span>}</div>
            {roleChanged && <Button variant="outline" size="sm" disabled={savingRole} onClick={onSaveRoleChanges}>{savingRole ? <Spinner /> : <Save size={14} />}{t('save')}</Button>}
            {roleError && <Notice tone="error">{roleError}</Notice>}
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
    <div className="issue-dialog-footer"><span>{changed ? t('draftSaved') : `${t('actualStatus')}: ${status?.name || t('unknown')}`}</span><div>{!canWrite && changed && <span className="readonly-inline"><AlertTriangle size={14} />{t('readOnlyBadge')}</span>}<Button onClick={onClose}>{t('close')}</Button>{canWrite && <Button variant="primary" onClick={onSaveChanges} disabled={!changed || saving || !draft.subject.trim()}>{saving ? <Spinner /> : <Save size={15} />}{t('saveChanges')}</Button>}</div></div>
  </Modal>;
}

export function CreateIssueDialog({ project, board, statuses, priorities, canWrite, draftScope, onClose, onCreate }: {
  project: Project; board: BoardData; statuses: Status[]; priorities: Priority[]; canWrite: boolean; draftScope: string; onClose: () => void; onCreate: (command: { subject: string; description: string; statusId?: number; priorityId?: number; trackerId?: number; assignedToId?: number; fixedVersionId?: number }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const draftKey = `redmine-workspace:new-draft:${encodeURIComponent(draftScope)}`;
  const initialDraft = (() => { try { return JSON.parse(localStorage.getItem(draftKey) || '{}') as Record<string, unknown>; } catch { return {}; } })();
  const [subject, setSubject] = useState(String(initialDraft.subject || ''));
  const [description, setDescription] = useState(String(initialDraft.description || ''));
  const [statusId, setStatusId] = useState(Number(initialDraft.statusId || statuses.find((status) => status.key === 'todo')?.id || statuses[0]?.id || 0));
  const [priorityId, setPriorityId] = useState(Number(initialDraft.priorityId || priorities[0]?.id || 0));
  const [trackerId, setTrackerId] = useState<number | undefined>(typeof initialDraft.trackerId === 'number' ? initialDraft.trackerId : undefined);
  const [assignedToId, setAssignedToId] = useState<number | undefined>(typeof initialDraft.assignedToId === 'number' ? initialDraft.assignedToId : undefined);
  const [fixedVersionId, setFixedVersionId] = useState<number | undefined>(typeof initialDraft.fixedVersionId === 'number' ? initialDraft.fixedVersionId : undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const draft = { subject, description, statusId, priorityId, trackerId, assignedToId, fixedVersionId };
    try { if (subject.trim() || description.trim()) localStorage.setItem(draftKey, JSON.stringify(draft)); else localStorage.removeItem(draftKey); } catch { /* Local drafts are best effort. */ }
  }, [subject, description, statusId, priorityId, trackerId, assignedToId, fixedVersionId, draftKey]);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); if (!subject.trim() || !canWrite) return; setBusy(true); setError(''); try { await onCreate({ subject: subject.trim(), description, statusId: statusId || undefined, priorityId: priorityId || undefined, trackerId, assignedToId, fixedVersionId }); localStorage.removeItem(draftKey); onClose(); } catch (e) { setError(e instanceof Error ? e.message : t('error')); } finally { setBusy(false); } };
  const trackers = [...new Map(board.issues.map((issue) => [issue.trackerId, { id: issue.trackerId, name: issue.trackerName }])).values()];
  return <Modal title={t('issueCreateTitle')} eyebrow={project.name} onClose={onClose} testId="issue-dialog" className="create-issue-dialog">
    <form onSubmit={submit} className="create-issue-form">
      <p className="form-intro">{t('issueCreateIntro')}</p>
      {!canWrite && <Notice tone="warning">{t('saveBlocked')}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {!canWrite && (subject || description) && <span className="draft-saved-indicator"><Check size={13} />{t('draftSaved')}</span>}
      <Field label={t('issueTitle')}><input className="text-input input-title" autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t('issueTitlePlaceholder')} data-testid="issue-title" required /></Field>
      <Field label={t('description')}><textarea className="text-area create-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('noDescription')} data-testid="issue-description" /></Field>
      <div className="two-col-fields">
        <Field label={t('status')}><select className="text-input" value={statusId} onChange={(e) => setStatusId(Number(e.target.value))}>{statuses.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></Field>
        <Field label={t('priorityField')}><select className="text-input" value={priorityId} onChange={(e) => setPriorityId(Number(e.target.value))}>{priorities.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></Field>
        {trackers.length > 0 && <Field label={t('tracker')}><select className="text-input" value={trackerId ?? ''} onChange={(e) => setTrackerId(e.target.value ? Number(e.target.value) : undefined)}><option value="">{trackers[0]?.name}</option>{trackers.slice(1).map((tracker) => <option key={tracker.id} value={tracker.id}>{tracker.name}</option>)}</select></Field>}
        <Field label={t('assignee')}><select className="text-input" value={assignedToId ?? ''} onChange={(e) => setAssignedToId(e.target.value ? Number(e.target.value) : undefined)}><option value="">{t('noAssignee')}</option>{board.members.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></Field>
        <Field label={t('release')}><select className="text-input" value={fixedVersionId ?? ''} onChange={(e) => setFixedVersionId(e.target.value ? Number(e.target.value) : undefined)}><option value="">—</option>{board.versions.filter((version) => version.status !== 'closed').map((version) => <option key={version.id} value={version.id}>{version.name}</option>)}</select></Field>
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
