import { useMemo, useState } from 'react';
import { BellRing, Check, Command, Languages, ListFilter, Palette, Plus, Save, Settings2, ShieldCheck, Trash2, UserRound, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AppSettings, Locale, Person, Project, Shortcut, Status } from '../../../shared/types';
import { defaultShortcuts, normalizeShortcutKeys } from '../../lib/shortcuts';
import { Button, Field, Notice } from '../../components/ui';

export function SettingsPage({ settings, members, project, projects, statuses, labels, readOnly, onSave, onResetViews, onToast }: {
  settings: AppSettings; members: Person[]; project: Project; projects: Project[]; statuses: Status[]; labels: string[]; readOnly: boolean; onSave: (settings: AppSettings) => Promise<void>; onResetViews: () => void; onToast: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const subscription = draft.subscriptions[String(project.id)] || { enabled: false, events: ['comment'] };
  const shortcuts = draft.shortcuts.length ? draft.shortcuts : defaultShortcuts;
  const duplicateShortcut = useMemo(() => {
    const used = new Set<string>();
    for (const shortcut of shortcuts.filter((item) => item.enabled && item.keys.trim())) {
      const normalized = normalizeShortcutKeys(shortcut.keys);
      if (used.has(normalized)) return shortcut.id;
      used.add(normalized);
    }
    return undefined;
  }, [shortcuts]);
  const setSubscription = (patch: Partial<typeof subscription>) => setDraft((current) => ({ ...current, subscriptions: { ...current.subscriptions, [String(project.id)]: { ...subscription, ...patch } } }));
  const setEvent = (event: string, checked: boolean) => setSubscription({ events: checked ? [...new Set([...subscription.events, event])] : subscription.events.filter((item) => item !== event) });
  const setShortcut = (item: Shortcut, patch: Partial<Shortcut>) => setDraft((current) => ({ ...current, shortcuts: (current.shortcuts.length ? current.shortcuts : defaultShortcuts).map((entry) => entry.id === item.id ? { ...entry, ...patch } : entry) }));
  const deleteShortcut = (id: string) => setDraft((current) => ({ ...current, shortcuts: (current.shortcuts.length ? current.shortcuts : defaultShortcuts).filter((item) => item.id !== id) }));
  const addShortcut = () => setDraft((current) => ({ ...current, shortcuts: [...(current.shortcuts.length ? current.shortcuts : defaultShortcuts), { id: crypto.randomUUID(), keys: '', action: 'label', value: '', enabled: true }] }));
  const updateQa = (value: string) => setDraft((current) => {
    const key = String(project.id);
    const projectQa = { ...current.projectQa };
    if (value) projectQa[key] = Number(value); else delete projectQa[key];
    return { ...current, projectQa };
  });
  const labelForShortcut = (item: Shortcut) => {
    const action = item.action === 'view' && item.value === 'mine' ? 'view/mine' : item.action;
    return t(action === 'view/mine' ? 'assignShortcut' : action === 'projectPicker' ? 'openProjectPicker' : action === 'copyRedmineUrl' ? 'copyUrlShortcut' : action === 'search' ? 'openSearch' : action === 'createIssue' ? 'createShortcut' : action === 'copyBranch' ? 'copyBranchShortcut' : action === 'moveStatus' ? 'moveShortcut' : action === 'commandPalette' ? 'showHelp' : action === 'label' ? 'labelFilter' : 'action');
  };
  const changeAction = (item: Shortcut, action: string) => setShortcut(item, { action, value: action === 'view' ? 'mine' : '' });
  const save = async (event: React.FormEvent) => { event.preventDefault(); setSaving(true); setError(''); setSaved(false); try { await onSave(draft); setSaved(true); onToast(t('settingsSaved')); } catch (e) { setError(e instanceof Error ? e.message : t('error')); } finally { setSaving(false); } };
  const enabledAutomations = draft.automationEnabled;
  return <main className="page settings-page" data-testid="settings-page">
    <div className="page-heading"><div><div className="eyebrow"><Settings2 size={13} />{t('workspace')}</div><h1>{t('settingsTitle')}</h1><p className="page-subtitle">{project.name}</p></div></div>
    {readOnly && <Notice tone="warning">{t('readOnlyNote')}</Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    <form className="settings-grid" onSubmit={save}>
      <section className="settings-card settings-general">
        <div className="settings-card-title"><Languages size={18} /><div><h2>{t('general')}</h2><p>{t('language')} · {t('preferences')}</p></div></div>
        <div className="settings-fields">
          <Field label={t('language')}><select className="text-input" value={draft.locale} onChange={(e) => setDraft({ ...draft, locale: e.target.value as Locale })}><option value="uk">Українська</option><option value="pl">Polski</option><option value="es">Español</option><option value="en">English</option></select></Field>
          <Field label={t('theme')}><select className="text-input" value={draft.theme} data-testid="theme-select" onChange={(e) => setDraft({ ...draft, theme: e.target.value as AppSettings['theme'] })}><option value="light">{t('themeLight')}</option><option value="dark">{t('themeDark')}</option><option value="system">{t('themeSystem')}</option></select></Field>
          <Field label={t('palette')}><select className="text-input palette-select" value={draft.palette} data-testid="palette-select" onChange={(e) => setDraft({ ...draft, palette: e.target.value as AppSettings['palette'] })}><option value="blue">{t('paletteBlue')}</option><option value="violet">{t('paletteViolet')}</option><option value="green">{t('paletteGreen')}</option><option value="amber">{t('paletteAmber')}</option></select></Field>
          <Field label={t('defaultSort')}><div className="sort-settings"><select className="text-input" value={draft.sort.field} onChange={(e) => setDraft({ ...draft, sort: { ...draft.sort, field: e.target.value as AppSettings['sort']['field'] } })}><option value="priority">{t('priority')}</option><option value="updated">{t('updated')}</option><option value="created">{t('created')}</option><option value="id">{t('issueId')}</option><option value="subject">{t('subject')}</option></select><select className="text-input" value={draft.sort.direction} onChange={(e) => setDraft({ ...draft, sort: { ...draft.sort, direction: e.target.value as AppSettings['sort']['direction'] } })}><option value="desc">{t('desc')}</option><option value="asc">{t('asc')}</option></select></div></Field>
          <Field label={t('polling')}><div className="input-suffix"><input className="text-input" type="number" min={10} max={3600} step={5} value={draft.pollIntervalSeconds} onChange={(e) => setDraft({ ...draft, pollIntervalSeconds: Math.max(10, Math.min(3600, Number(e.target.value) || 30)) })} /><span>{t('seconds')}</span></div></Field>
        </div>
        <div className="settings-card-divider" />
        <div className="settings-card-title"><Workflow size={18} /><div><h2>{t('automation')}</h2><p>{t('polling')} · {draft.pollIntervalSeconds} {t('seconds')}</p></div></div>
        <label className="switch-row"><span><strong>{t('automationEnabled')}</strong><small>{readOnly ? t('readOnlyBadge') : t('automation')}</small></span><input type="checkbox" checked={enabledAutomations} onChange={(e) => setDraft({ ...draft, automationEnabled: e.target.checked })} /><i /></label>
      </section>

      <section className="settings-card">
        <div className="settings-card-title"><BellRing size={18} /><div><h2>{t('subscription')}</h2><p>{t('subscriptionHint')}</p></div></div>
        <label className="switch-row"><span><strong>{t('subscription')}</strong><small>{project.name}</small></span><input type="checkbox" checked={subscription.enabled} onChange={(e) => setSubscription({ enabled: e.target.checked })} /><i /></label>
        <div className="event-options">{[['comment', 'watchComments'], ['status', 'watchStatus'], ['assignee', 'watchAssignee'], ['labels', 'watchLabels']].map(([event, labelKey]) => <label className="check-row" key={event}><input type="checkbox" disabled={!subscription.enabled} checked={subscription.events.includes(event)} onChange={(e) => setEvent(event, e.target.checked)} /><span>{t(labelKey)}</span></label>)}</div>
      </section>

      <section className="settings-card">
        <div className="settings-card-title"><UserRound size={18} /><div><h2>{t('qaDefault')}</h2><p>{t('qaDefaultHint')}</p></div></div>
        <Field label={`${t('qaDefault')} · ${project.name}`}><select className="text-input" value={draft.projectQa[String(project.id)] ?? ''} onChange={(e) => updateQa(e.target.value)}><option value="">{t('unknown')}</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></Field>
        <div className="settings-note"><ShieldCheck size={15} />{t('subscriptionHint')}</div>
      </section>

      <section className="settings-card settings-shortcuts-card">
        <div className="settings-card-title"><Command size={18} /><div><h2>{t('keyboard')}</h2><p>{t('shortcutHint')}</p></div><div className="shortcut-heading-actions"><Button size="sm" onClick={addShortcut}><Plus size={13} />{t('addShortcut')}</Button><Button size="sm" onClick={() => setDraft({ ...draft, shortcuts: defaultShortcuts })}>{t('resetShortcuts')}</Button></div></div>
        <div className="shortcut-list">
          {shortcuts.map((shortcut) => <div className={`shortcut-row${duplicateShortcut === shortcut.id ? ' has-conflict' : ''}`} key={shortcut.id}>
            <span className="shortcut-action">{labelForShortcut(shortcut)}</span>
            <input className="shortcut-input" aria-label={`${t('shortcut')} ${labelForShortcut(shortcut)}`} value={shortcut.keys} onChange={(e) => setShortcut(shortcut, { keys: e.target.value })} placeholder="—" />
            <select className="shortcut-action-select" aria-label={t('shortcutTarget')} value={shortcut.action} onChange={(e) => changeAction(shortcut, e.target.value)}><option value="view">{t('assignShortcut')}</option><option value="projectPicker">{t('openProjectPicker')}</option><option value="copyRedmineUrl">{t('copyUrlShortcut')}</option><option value="search">{t('openSearch')}</option><option value="createIssue">{t('createShortcut')}</option><option value="commandPalette">{t('showHelp')}</option><option value="copyBranch">{t('copyBranchShortcut')}</option><option value="moveStatus">{t('moveShortcut')}</option><option value="label">{t('labelFilter')}</option></select>
            {shortcut.action === 'label' && <select className="shortcut-value-select" aria-label={t('label')} value={shortcut.value || ''} onChange={(e) => setShortcut(shortcut, { value: e.target.value })}><option value="">{t('label')}</option>{labels.map((label) => <option key={label}>{label}</option>)}</select>}
            {shortcut.action === 'moveStatus' && <select className="shortcut-value-select" aria-label={t('status')} value={shortcut.value || ''} onChange={(e) => setShortcut(shortcut, { value: e.target.value })}><option value="">{t('status')}</option>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select>}
            <label className="shortcut-enabled" title={t('shortcut')}><input type="checkbox" checked={shortcut.enabled} onChange={(e) => setShortcut(shortcut, { enabled: e.target.checked })} /><span /></label>
            <button className="shortcut-remove" type="button" onClick={() => deleteShortcut(shortcut.id)} aria-label={t('deleteView')}><Trash2 size={14} /></button>
            {duplicateShortcut === shortcut.id && <span className="shortcut-conflict">{t('shortcutConflict')}</span>}
          </div>)}
        </div>
        <div className="settings-note"><ListFilter size={15} />{t('savedViews')} · {settings.savedViews.length}{settings.savedViews.length > 0 && <Button variant="quiet" size="sm" onClick={onResetViews}>{t('clear')}</Button>}</div>
      </section>
      <div className="settings-savebar"><span>{saved ? <><Check size={15} />{t('settingsSaved')}</> : `${projects.length} ${t('projects')}`}</span><Button variant="primary" type="submit" disabled={saving || !!duplicateShortcut}>{saving ? t('loading') : <><Save size={15} />{t('saveSettings')}</>}</Button></div>
    </form>
  </main>;
}
