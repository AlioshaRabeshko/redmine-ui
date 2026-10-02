import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CalendarDays, Check, CircleDot, Clock3, Edit2, Plus, Rocket, Search, Trash2, Users, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BoardData, Issue, Person, Priority, Project, ReleaseDetail, Status, Version } from '../../../shared/types';
import { releaseReadiness } from '../../../shared/domain';
import { api } from '../../lib/api';
import { Avatar, Button, Field, IconButton, Modal, Notice, Spinner } from '../../components/ui';

export function ReleasesPage({ project, board, statuses, priorities, members, versions, selectedVersionId, canWrite, onSelectVersion, onOpenIssue, onCreateRelease, onAssign, onUpdateRelease, onFinish, onToast }: {
  project: Project; board: BoardData; statuses: Status[]; priorities: Priority[]; members: Person[]; versions: Version[]; selectedVersionId?: number; canWrite: boolean;
  onSelectVersion: (versionId?: number) => void; onOpenIssue: (issue: Issue) => void; onCreateRelease: (input: { name: string; dueDate?: string; description?: string; issueIds?: number[] }) => Promise<void>;
  onAssign: (versionId: number, issueIds: number[], fixedVersionId: number | null) => Promise<void>; onUpdateRelease: (version: Version, patch: Partial<Version>) => Promise<void>; onFinish: (version: Version) => Promise<void>; onToast: (text: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [editing, setEditing] = useState(false);
  const [assignment, setAssignment] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selectedVersion = versions.find((version) => version.id === selectedVersionId);
  const releaseQuery = useQuery({ queryKey: ['release', selectedVersionId], queryFn: () => api.get<ReleaseDetail>(`/api/releases/${selectedVersionId}`), enabled: !!selectedVersionId, staleTime: 15_000 });
  const detail = releaseQuery.data;
  const issues = detail?.issues || [];
  const readiness = useMemo(() => releaseReadiness(issues, statuses), [issues, statuses]);
  const activeVersions = versions.filter((version) => version.status !== 'closed').sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  const closedVersions = versions.filter((version) => version.status === 'closed').sort((a, b) => (b.dueDate || '').localeCompare(a.dueDate || ''));
  const currentIds = new Set(issues.map((issue) => issue.id));
  const eligibleIssues = board.issues.filter((issue) => !currentIds.has(issue.id));
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  const priorityById = new Map(priorities.map((priority) => [priority.id, priority]));
  const assignedById = new Map(members.map((member) => [member.id, member]));
  const openCreate = () => { setCreating(true); setError(''); };
  const create = async (input: { name: string; dueDate?: string; description?: string; issueIds?: number[] }) => { setBusy(true); setError(''); try { await onCreateRelease(input); setCreating(false); } catch (e) { setError(e instanceof Error ? e.message : t('error')); throw e; } finally { setBusy(false); } };
  const assign = async () => { if (!selectedVersion || assignment.length === 0) return; setBusy(true); setError(''); try { await onAssign(selectedVersion.id, assignment, selectedVersion.id); setAssignment([]); setAssigning(false); } catch (e) { setError(e instanceof Error ? e.message : t('error')); } finally { setBusy(false); } };
  const saveRelease = async (patch: Partial<Version>) => { if (!selectedVersion) return; setBusy(true); setError(''); try { await onUpdateRelease(selectedVersion, patch); setEditing(false); } catch (e) { setError(e instanceof Error ? e.message : t('error')); } finally { setBusy(false); } };
  const completeRelease = async () => { if (!selectedVersion || !readiness.ready || !canWrite) return; setBusy(true); setError(''); try { await onFinish(selectedVersion); } catch (e) { setError(e instanceof Error ? e.message : t('error')); } finally { setBusy(false); } };
  const removeIssue = async (issueId: number) => { if (!selectedVersion) return; setBusy(true); setError(''); try { await onAssign(selectedVersion.id, [issueId], null); } catch (e) { setError(e instanceof Error ? e.message : t('error')); } finally { setBusy(false); } };
  return <main className="page releases-page" data-testid="releases-page">
    <div className="page-heading">
      <div><div className="eyebrow"><Rocket size={13} />{project.identifier}</div><h1>{t('releaseTitle')}</h1><p className="page-subtitle">{project.name} <span className="inline-separator">·</span> {versions.length} {t('releases')}</p></div>
      <div className="heading-actions"><Button variant="primary" onClick={openCreate} disabled={!canWrite}><Plus size={15} />{t('createRelease')}</Button></div>
    </div>
    {error && <Notice tone="error">{error}</Notice>}
    <div className="release-workspace">
      <aside className={`release-index${selectedVersion ? ' release-index-collapsed' : ''}`}>
        <div className="release-index-head"><span><CalendarDays size={15} />{t('activeReleases')}</span><span className="lane-count">{activeVersions.length}</span></div>
        {activeVersions.length === 0 && <div className="release-index-empty">{t('noReleaseIssues')}</div>}
        {activeVersions.map((version) => <button type="button" className={`release-index-item${selectedVersionId === version.id ? ' selected' : ''}`} key={version.id} onClick={() => onSelectVersion(version.id)}>
          <span className="release-index-icon"><CalendarDays size={16} /></span><span className="release-index-text"><strong>{version.name}</strong><small>{version.dueDate ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(`${version.dueDate}T00:00:00`)) : t('activeReleases')}</small></span><ArrowRight size={14} />
        </button>)}
        {closedVersions.length > 0 && <><div className="release-index-head history-head"><span><Clock3 size={15} />{t('releaseHistory')}</span><span className="lane-count">{closedVersions.length}</span></div>{closedVersions.map((version) => <button type="button" className={`release-index-item release-closed${selectedVersionId === version.id ? ' selected' : ''}`} key={version.id} onClick={() => onSelectVersion(version.id)}><span className="release-index-icon"><Check size={16} /></span><span className="release-index-text"><strong>{version.name}</strong><small>{version.dueDate || t('archived')}</small></span><ArrowRight size={14} /></button>)}</>}
      </aside>
      {!selectedVersion && <div className="release-welcome"><div className="release-welcome-illustration"><Rocket size={28} /></div><h2>{t('releaseTitle')}</h2><p>{t('createReleaseIntro')}</p><Button variant="outline" onClick={openCreate} disabled={!canWrite}><Plus size={15} />{t('createRelease')}</Button></div>}
      {selectedVersion && <section className="release-detail-pane">
        <div className="release-detail-heading"><Button variant="quiet" size="sm" className="release-back" onClick={() => onSelectVersion()}><ArrowLeft size={15} />{t('back')}</Button><div className="release-detail-title"><div className="eyebrow">{selectedVersion.status === 'closed' ? t('releaseHistory') : t('activeReleases')}</div><h2>{selectedVersion.name}</h2><div className="release-date-line"><CalendarDays size={14} />{selectedVersion.dueDate ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'long' }).format(new Date(`${selectedVersion.dueDate}T00:00:00`)) : t('unknown')}<span className={`release-state release-state-${selectedVersion.status}`}>{selectedVersion.status}</span></div></div><div className="release-detail-actions">{selectedVersion.status !== 'closed' && <><Button onClick={() => setEditing(true)} disabled={!canWrite}><Edit2 size={15} />{t('edit')}</Button><Button variant="outline" onClick={() => { setAssignment([]); setAssigning(true); }} disabled={!canWrite}><Plus size={15} />{t('addIssues')}</Button></>}</div></div>
        {releaseQuery.isLoading && <div className="center-loading"><Spinner label={t('loading')} /></div>}
        {releaseQuery.isError && <Notice tone="error">{t('releaseNotFound')} <Button size="sm" onClick={() => releaseQuery.refetch()}>{t('retry')}</Button></Notice>}
        {detail && <>
          <div className="release-summary-grid"><div className="release-stat"><strong>{issues.length}</strong><span>{t('issuesInRelease')}</span></div><div className={`release-stat${readiness.ready ? ' stat-ready' : ' stat-pending'}`}><strong>{readiness.completed.length}</strong><span>{t('doneSkipped', { count: readiness.completed.length })}</span></div><div className={`release-stat${readiness.ready ? ' stat-ready' : ' stat-pending'}`}><strong>{readiness.pending.length}</strong><span>{readiness.ready ? t('ready') : t('finishBlocked')}</span></div></div>
          {selectedVersion.description && <p className="release-description">{selectedVersion.description}</p>}
          {selectedVersion.status !== 'closed' && <Notice tone={readiness.ready ? 'success' : 'warning'}>{readiness.ready ? t('allReady') : t('finishBlocked')}</Notice>}
          <div className="release-issues-head"><div><h3>{t('issuesInRelease')}</h3><span>{issues.length}</span></div>{selectedVersion.status !== 'closed' && <Button variant="primary" size="sm" onClick={completeRelease} disabled={!canWrite || !readiness.ready || busy}>{busy ? <Spinner /> : <Check size={14} />}{t('finishRelease')}</Button>}</div>
          {issues.length === 0 ? <div className="release-issues-empty"><div className="empty-illustration"><CircleDot size={22} /></div><p>{t('noReleaseIssues')}</p>{selectedVersion.status !== 'closed' && <Button size="sm" variant="outline" onClick={() => setAssigning(true)} disabled={!canWrite}><Plus size={14} />{t('addIssues')}</Button>}</div> : <div className="release-issue-list">{issues.map((issue) => { const status = statusById.get(issue.statusId); const priority = priorityById.get(issue.priorityId); const assignee = assignedById.get(issue.assignedToId || 0); const completed = status?.key === 'done' && status.isClosed; return <article className="release-issue-row" key={issue.id}>
            <button type="button" className="release-issue-open" onClick={() => onOpenIssue(issue)}><span className={`release-issue-priority priority-${priority?.rank ?? 0}`}>{priority?.name || '—'}</span><strong>{issue.subject}</strong><span className="issue-ref">#{issue.id}</span></button>
            <span className={`status-pill status-${status?.key || 'unknown'}`}><span className="status-pill-dot" />{status?.name || t('unknown')}</span><span className="release-issue-assignee"><Avatar person={assignee} size="xs" />{assignee?.name || t('noAssignee')}</span>{completed && <span className="completed-chip"><Check size={12} />{t('saved')}</span>}
            {selectedVersion.status !== 'closed' && <IconButton label={t('removeRoadmap')} disabled={!canWrite || busy} onClick={() => removeIssue(issue.id)}><X size={15} /></IconButton>}
          </article>; })}</div>}
        </>}
      </section>}
    </div>
    {creating && <CreateReleaseDialog project={project} board={board} versions={versions} canWrite={canWrite} busy={busy} onClose={() => setCreating(false)} onCreate={create} />}
    {assigning && selectedVersion && <AssignIssuesDialog project={project} issues={eligibleIssues} statuses={statuses} selected={assignment} canWrite={canWrite} busy={busy} onChange={setAssignment} onClose={() => setAssigning(false)} onSave={assign} />}
    {editing && selectedVersion && <EditReleaseDialog version={selectedVersion} canWrite={canWrite} busy={busy} onClose={() => setEditing(false)} onSave={saveRelease} />}
  </main>;
}

function CreateReleaseDialog({ project, board, versions, canWrite, busy, onClose, onCreate }: { project: Project; board: BoardData; versions: Version[]; canWrite: boolean; busy: boolean; onClose: () => void; onCreate: (input: { name: string; dueDate?: string; description?: string; issueIds?: number[] }) => Promise<void> }) {
  const { t } = useTranslation();
  const [name, setName] = useState(''); const [dueDate, setDueDate] = useState(''); const [description, setDescription] = useState(''); const [selected, setSelected] = useState<number[]>([]); const [query, setQuery] = useState('');
  const available = board.issues.filter((issue) => `${issue.id} ${issue.subject}`.toLowerCase().includes(query.toLowerCase()));
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (name.trim()) void onCreate({ name: name.trim(), dueDate: dueDate || undefined, description: description.trim() || undefined, issueIds: selected }); };
  return <Modal title={t('createRelease')} eyebrow={project.name} onClose={onClose} size="md" className="release-modal">
    <form className="release-form" onSubmit={submit}><p className="form-intro">{t('createReleaseIntro')}</p>
      <Field label={t('releaseName')}><input className="text-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} required /></Field>
      <Field label={t('dueDate')}><input className="text-input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
      <Field label={t('description')}><textarea className="text-area" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <div className="assignment-picker"><div className="assignment-picker-head"><strong>{t('selectIssues')}</strong><span>{selected.length}</span></div><div className="search-field compact"><Search size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('searchPlaceholder')} /></div><div className="assignment-options">{available.length === 0 ? <span>{t('emptySearch')}</span> : available.map((issue) => { const checked = selected.includes(issue.id); return <label key={issue.id} className="assignment-option"><input type="checkbox" checked={checked} onChange={() => setSelected((current) => checked ? current.filter((id) => id !== issue.id) : [...current, issue.id])} /><span><strong>{issue.subject}</strong><small>#{issue.id} · {issue.trackerName}</small></span><span className="assignment-current-version">{versions.find((v) => v.id === issue.fixedVersionId)?.name || t('actualStatus')}</span></label>; })}</div></div>
      {!canWrite && <Notice tone="warning">{t('saveBlocked')}</Notice>}
      <div className="modal-footer"><Button type="button" onClick={onClose}>{t('cancel')}</Button><Button type="submit" variant="primary" disabled={!canWrite || !name.trim() || busy}>{busy ? <Spinner /> : <Plus size={15} />}{t('createRelease')}</Button></div>
    </form>
  </Modal>;
}

function AssignIssuesDialog({ project, issues, statuses, selected, canWrite, busy, onChange, onClose, onSave }: { project: Project; issues: Issue[]; statuses: Status[]; selected: number[]; canWrite: boolean; busy: boolean; onChange: (ids: number[]) => void; onClose: () => void; onSave: () => void }) {
  const { t } = useTranslation(); const [query, setQuery] = useState('');
  const filtered = issues.filter((issue) => `${issue.id} ${issue.subject}`.toLowerCase().includes(query.toLowerCase())); const statusMap = new Map(statuses.map((status) => [status.id, status]));
  return <Modal title={t('addIssues')} eyebrow={project.name} onClose={onClose} className="release-modal"><div className="release-form"><p className="form-intro">{t('selectIssues')}</p><div className="search-field compact"><Search size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('searchPlaceholder')} /></div><div className="assignment-options assignment-options-tall">{filtered.length === 0 ? <span>{t('emptySearch')}</span> : filtered.map((issue) => { const checked = selected.includes(issue.id); return <label key={issue.id} className="assignment-option"><input type="checkbox" checked={checked} onChange={() => onChange(checked ? selected.filter((id) => id !== issue.id) : [...selected, issue.id])} /><span><strong>{issue.subject}</strong><small>#{issue.id} · {issue.trackerName}</small></span><span className="assignment-current-version">{statusMap.get(issue.statusId)?.name || t('unknown')}</span></label>; })}</div><div className="modal-footer"><Button onClick={onClose}>{t('cancel')}</Button><Button variant="primary" onClick={onSave} disabled={!canWrite || selected.length === 0 || busy}>{busy ? <Spinner /> : <Plus size={15} />}{t('addIssues')} · {selected.length}</Button></div></div></Modal>;
}

function EditReleaseDialog({ version, canWrite, busy, onClose, onSave }: { version: Version; canWrite: boolean; busy: boolean; onClose: () => void; onSave: (patch: Partial<Version>) => void }) {
  const { t } = useTranslation(); const [name, setName] = useState(version.name); const [dueDate, setDueDate] = useState(version.dueDate || ''); const [description, setDescription] = useState(version.description || '');
  const submit = (event: React.FormEvent) => { event.preventDefault(); onSave({ name: name.trim(), dueDate: dueDate || undefined, description }); };
  return <Modal title={t('edit')} eyebrow={t('release')} onClose={onClose} className="release-modal"><form className="release-form" onSubmit={submit}><Field label={t('releaseName')}><input className="text-input" value={name} onChange={(e) => setName(e.target.value)} required /></Field><Field label={t('dueDate')}><input className="text-input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field><Field label={t('description')}><textarea className="text-area" value={description} onChange={(e) => setDescription(e.target.value)} /></Field><div className="modal-footer"><Button type="button" onClick={onClose}>{t('cancel')}</Button><Button type="submit" variant="primary" disabled={!canWrite || !name.trim() || busy}>{busy ? <Spinner /> : <Check size={15} />}{t('save')}</Button></div></form></Modal>;
}
