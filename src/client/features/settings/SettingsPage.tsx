import { useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, Check, Command, Languages, ListFilter, Palette, Plus, Save, Settings2, ShieldCheck, Trash2, UserRound, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AppSettings, Locale, PeopleField, Person, PersonRole, Project, Shortcut, SettingsPatch, Status } from '../../../shared/types';
import { defaultShortcuts, normalizeShortcutKeys } from '../../lib/shortcuts';
import { enqueueFieldWrite, useWorkspaceFormSave } from '../../lib/serialFieldWrite';
import { Button, Field, Notice } from '../../components/ui';
import { Picker, PeoplePicker } from '../../components/pickers';
import { api } from '../../lib/api';

type SettingsSaveState = { state: 'pending' | 'saved' | 'error'; error?: string };
const roles: PersonRole[] = ['qa', 'support', 'developer'];
const locales: { value: Locale; label: string }[] = [
  { value: 'uk', label: 'Українська' }, { value: 'pl', label: 'Polski' }, { value: 'es', label: 'Español' }, { value: 'en', label: 'English' },
];

function savedShortcuts(settings: AppSettings): Shortcut[] { return settings.shortcuts.length ? settings.shortcuts : defaultShortcuts; }

function mapRedmineRoles(names: string[]): PersonRole[] {
  const found = new Set<PersonRole>();
  for (const rawName of names) {
    const name = rawName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
    if (/(^|\W)qa(\W|$)|quality\s*assurance|\btest(?:er|ing)\b/.test(name)) found.add('qa');
    if (/(^|\W)support(\W|$)|help\s*desk/.test(name)) found.add('support');
    if (/(^|\W)developer(?:s)?(\W|$)|\bdevelopment\b/.test(name)) found.add('developer');
  }
  return roles.filter((role) => found.has(role));
}

function mergePatch(settings: AppSettings, patch: SettingsPatch): AppSettings {
  const next = { ...settings, ...patch } as AppSettings;
  if (patch.projectQa) {
    next.projectQa = { ...settings.projectQa };
    for (const [key, value] of Object.entries(patch.projectQa)) { if (value === null) delete next.projectQa[key]; else next.projectQa[key] = value; }
  }
  if (patch.subscriptions) {
    next.subscriptions = { ...settings.subscriptions };
    for (const [key, value] of Object.entries(patch.subscriptions)) { if (value === null) delete next.subscriptions[key]; else next.subscriptions[key] = value; }
  }
  if (patch.personRoleOverrides) {
    next.personRoleOverrides = { ...(settings.personRoleOverrides || {}) };
    for (const [projectId, overrides] of Object.entries(patch.personRoleOverrides)) {
      if (overrides === null) { delete next.personRoleOverrides[projectId]; continue; }
      const projectOverrides = { ...(next.personRoleOverrides[projectId] || {}) };
      for (const [personId, personRoles] of Object.entries(overrides)) { if (personRoles === null) delete projectOverrides[personId]; else projectOverrides[personId] = personRoles; }
      if (Object.keys(projectOverrides).length) next.personRoleOverrides[projectId] = projectOverrides; else delete next.personRoleOverrides[projectId];
    }
  }
  return next;
}

function restoreSettingsField(current: AppSettings, confirmed: AppSettings, key: string, projectId: string): AppSettings {
  if (key === 'locale') return { ...current, locale: confirmed.locale };
  if (key === 'theme') return { ...current, theme: confirmed.theme };
  if (key === 'palette') return { ...current, palette: confirmed.palette };
  if (key.startsWith('sort:')) return { ...current, sort: confirmed.sort };
  if (key === 'pollIntervalSeconds') return { ...current, pollIntervalSeconds: confirmed.pollIntervalSeconds };
  if (key === 'automationEnabled') return { ...current, automationEnabled: confirmed.automationEnabled };
  if (key === 'shortcuts') return { ...current, shortcuts: confirmed.shortcuts };
  if (key === `projectQa:${projectId}`) {
    const projectQa = { ...current.projectQa };
    if (confirmed.projectQa[projectId] === undefined) delete projectQa[projectId]; else projectQa[projectId] = confirmed.projectQa[projectId];
    return { ...current, projectQa };
  }
  if (key === `subscription:${projectId}`) {
    const subscriptions = { ...current.subscriptions };
    if (confirmed.subscriptions[projectId] === undefined) delete subscriptions[projectId]; else subscriptions[projectId] = confirmed.subscriptions[projectId];
    return { ...current, subscriptions };
  }
  if (key === `personRoleOverrides:${projectId}`) {
    const personRoleOverrides = { ...(current.personRoleOverrides || {}) };
    if (confirmed.personRoleOverrides?.[projectId] === undefined) delete personRoleOverrides[projectId]; else personRoleOverrides[projectId] = confirmed.personRoleOverrides[projectId];
    return { ...current, personRoleOverrides };
  }
  return current;
}

export function SettingsPage({ settings, members, project, projects, statuses, labels, peopleRecommendations, readOnly, onPatchSettings, onResetViews, onToast }: {
  settings: AppSettings; members: Person[]; project: Project; projects: Project[]; statuses: Status[]; labels: string[];
  peopleRecommendations?: Partial<Record<PeopleField, number[]>>; readOnly: boolean;
  onPatchSettings: (patch: SettingsPatch) => Promise<void>; onResetViews: () => void; onToast: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AppSettings>(settings);
  const settingsRef = useRef(settings);
  const confirmedRef = useRef(settings);
  const settingsInitializedRef = useRef(false);
  const settingsQueuesRef = useRef(new Map<string, Promise<unknown>>());
  const settingGenerationsRef = useRef(new Map<string, number>());
  const [saveStates, setSaveStates] = useState<Record<string, SettingsSaveState>>({});
  const [error, setError] = useState('');
  const projectKey = String(project.id);
  const subscription = draft.subscriptions[projectKey] || { enabled: false, events: ['comment'] };
  const [pollValue, setPollValue] = useState(String(settings.pollIntervalSeconds));
  const [shortcutDraft, setShortcutDraft] = useState<Shortcut[]>(() => savedShortcuts(settings));
  const shortcutDraftRef = useRef(shortcutDraft);
  const shortcutBaselineRef = useRef<Shortcut[]>(savedShortcuts(settings));
  const shortcutDirtyRef = useRef(false);
  const shortcutSavePendingRef = useRef(false);
  const [shortcutDirty, setShortcutDirty] = useState(false);
  const [shortcutConflict, setShortcutConflict] = useState(false);
  const [rolePersonId, setRolePersonId] = useState<number | undefined>(() => members[0]?.id);
  const shortcutFormRef = useWorkspaceFormSave<HTMLFormElement>();

  useEffect(() => {
    settingsRef.current = settings;
    if (!settingsInitializedRef.current) {
      confirmedRef.current = settings;
      settingsInitializedRef.current = true;
    }
    setDraft(settings);
    setPollValue(String(settings.pollIntervalSeconds));
    const incomingShortcuts = savedShortcuts(settings);
    if (!shortcutSavePendingRef.current && JSON.stringify(incomingShortcuts) !== JSON.stringify(shortcutBaselineRef.current)) {
      shortcutBaselineRef.current = incomingShortcuts;
      if (shortcutDirtyRef.current) setShortcutConflict(true);
      else { shortcutDraftRef.current = incomingShortcuts; setShortcutDraft(incomingShortcuts); }
    }
  }, [settings]);

  const persistPatch = (key: string, patch: SettingsPatch): Promise<boolean> => {
    const generation = (settingGenerationsRef.current.get(key) || 0) + 1;
    settingGenerationsRef.current.set(key, generation);
    settingsRef.current = mergePatch(settingsRef.current, patch);
    setDraft(settingsRef.current);
    setError('');
    setSaveStates((current) => ({ ...current, [key]: { state: 'pending' } }));
    const job = enqueueFieldWrite(settingsQueuesRef.current, key, async () => {
      await onPatchSettings(patch);
      confirmedRef.current = mergePatch(confirmedRef.current, patch);
      return true;
    });
    return job.then(() => {
      if (settingGenerationsRef.current.get(key) === generation) {
        setSaveStates((current) => ({ ...current, [key]: { state: 'saved' } }));
        if (key !== 'shortcuts') onToast(t('autosaved'));
      }
      return true;
    }).catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : t('error');
      if (settingGenerationsRef.current.get(key) === generation) {
        const restored = restoreSettingsField(settingsRef.current, confirmedRef.current, key, projectKey);
        settingsRef.current = restored;
        setDraft(restored);
        if (key === 'pollIntervalSeconds') setPollValue(String(restored.pollIntervalSeconds));
        setSaveStates((current) => ({ ...current, [key]: { state: 'error', error: message } }));
        setError(message);
      }
      return false;
    });
  };

  const subscriptionPatch = (next: typeof subscription) => {
    void persistPatch(`subscription:${projectKey}`, { subscriptions: { [projectKey]: next } });
  };
  const setSubscription = (patch: Partial<typeof subscription>) => {
    const current = settingsRef.current.subscriptions[projectKey] || { enabled: false, events: ['comment'] };
    subscriptionPatch({ ...current, ...patch });
  };
  const setEvent = (event: string, checked: boolean) => {
    const current = settingsRef.current.subscriptions[projectKey] || { enabled: false, events: ['comment'] };
    setSubscription({ events: checked ? [...new Set([...current.events, event])] : current.events.filter((item) => item !== event) });
  };
  const updateShortcutDraft = (update: (current: Shortcut[]) => Shortcut[]) => setShortcutDraft((current) => {
    const next = update(current);
    shortcutDraftRef.current = next;
    return next;
  });
  const setShortcut = (item: Shortcut, patch: Partial<Shortcut>) => updateShortcutDraft((current) => current.map((entry) => entry.id === item.id ? { ...entry, ...patch } : entry));
  const deleteShortcut = (id: string) => updateShortcutDraft((current) => current.filter((item) => item.id !== id));
  const addShortcut = () => updateShortcutDraft((current) => [...current, { id: crypto.randomUUID(), keys: '', action: 'label', value: '', enabled: true }]);
  const updateQa = (value?: number) => {
    if (settingsRef.current.projectQa[projectKey] === value) return;
    const operationId = value === undefined ? undefined : crypto.randomUUID();
    void persistPatch(`projectQa:${projectKey}`, { projectQa: { [projectKey]: value ?? null } }).then(async (saved) => {
      if (!saved || value === undefined || !operationId) return;
      try { await api.post('/api/people/selection', { projectId: project.id, personId: value, field: 'qa', operationId }); } catch { /* Recommendation history never rolls back a saved local preference. */ }
    });
  };
  const updateRoleOverride = (personId: number, nextRoles: PersonRole[] | undefined) => {
    void persistPatch(`personRoleOverrides:${projectKey}`, { personRoleOverrides: { [projectKey]: { [String(personId)]: nextRoles ?? null } } });
  };

  const shortcuts = shortcutDraft;
  const duplicateShortcut = useMemo(() => {
    const used = new Set<string>();
    for (const shortcut of shortcuts.filter((item) => item.enabled && item.keys.trim())) {
      const normalized = normalizeShortcutKeys(shortcut.keys);
      if (used.has(normalized)) return shortcut.id;
      used.add(normalized);
    }
    return undefined;
  }, [shortcuts]);
  const isShortcutDirty = JSON.stringify(shortcuts) !== JSON.stringify(shortcutBaselineRef.current);
  useEffect(() => { shortcutDirtyRef.current = isShortcutDirty; setShortcutDirty(isShortcutDirty); }, [isShortcutDirty]);

  const labelForShortcut = (item: Shortcut) => {
    const action = item.action === 'view' && item.value === 'mine' ? 'view/mine' : item.action;
    return t(action === 'view/mine' ? 'assignShortcut' : action === 'projectPicker' ? 'openProjectPicker' : action === 'copyRedmineUrl' ? 'copyUrlShortcut' : action === 'search' ? 'openSearch' : action === 'createIssue' ? 'createShortcut' : action === 'copyBranch' ? 'copyBranchShortcut' : action === 'moveStatus' ? 'moveShortcut' : action === 'commandPalette' ? 'showHelp' : action === 'label' ? 'labelFilter' : action === 'saveForm' ? 'saveFormShortcut' : 'action');
  };
  const changeAction = (item: Shortcut, action: string) => setShortcut(item, { action, value: action === 'view' ? 'mine' : '' });
  const saveShortcuts = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (shortcutSavePendingRef.current || duplicateShortcut || !isShortcutDirty) return;
    const submittedShortcuts = shortcuts;
    shortcutSavePendingRef.current = true;
    const saved = await persistPatch('shortcuts', { shortcuts: submittedShortcuts });
    shortcutSavePendingRef.current = false;
    if (!saved) return;
    shortcutBaselineRef.current = submittedShortcuts;
    setShortcutConflict(false);
    const hasLaterEdits = JSON.stringify(shortcutDraftRef.current) !== JSON.stringify(submittedShortcuts);
    shortcutDirtyRef.current = hasLaterEdits;
    setShortcutDirty(hasLaterEdits);
    onToast(t('shortcutsSaved'));
  };

  const commitPollInterval = () => {
    const value = Number(pollValue);
    if (!Number.isInteger(value) || value < 10 || value > 3600 || value % 5 !== 0) {
      setError(t('errorValidation'));
      setPollValue(String(settingsRef.current.pollIntervalSeconds));
      return;
    }
    if (value !== settingsRef.current.pollIntervalSeconds) persistPatch('pollIntervalSeconds', { pollIntervalSeconds: value });
  };
  const setLocale = (value: string) => { if (locales.some((locale) => locale.value === value)) persistPatch('locale', { locale: value as Locale }); };
  const toggleTheme = (theme: AppSettings['theme']) => { if (settingsRef.current.theme !== theme) persistPatch('theme', { theme }); };
  const togglePalette = (palette: AppSettings['palette']) => { if (settingsRef.current.palette !== palette) persistPatch('palette', { palette }); };
  const changeSort = (field: string, value: string) => {
    const sort = { ...settingsRef.current.sort };
    if (field === 'sortField') sort.field = value as AppSettings['sort']['field']; else sort.direction = value as AppSettings['sort']['direction'];
    persistPatch('sort:default', { sort });
  };

  const selectedOverride = rolePersonId === undefined ? undefined : draft.personRoleOverrides?.[projectKey]?.[String(rolePersonId)];
  const rolePerson = members.find((member) => member.id === rolePersonId);
  const inheritedRoles = rolePerson?.redmineRoles?.length ? mapRedmineRoles(rolePerson.redmineRoles.map((role) => role.name)) : rolePerson?.roles ?? [];
  const currentRoles = selectedOverride ?? inheritedRoles;
  const hasRoleOverride = rolePersonId !== undefined && draft.personRoleOverrides?.[projectKey]?.[String(rolePersonId)] !== undefined;
  const toggleRole = (role: PersonRole, checked: boolean) => {
    if (rolePersonId === undefined) return;
    const next = checked ? [...new Set([...currentRoles, role])] : currentRoles.filter((item) => item !== role);
    updateRoleOverride(rolePersonId, next);
  };
  const statusOptions = statuses.map((status) => ({ value: String(status.id), label: status.name }));
  const labelOptions = labels.map((label) => ({ value: label, label }));
  const actionOptions = [
    ['view', 'assignShortcut'], ['projectPicker', 'openProjectPicker'], ['copyRedmineUrl', 'copyUrlShortcut'], ['search', 'openSearch'],
    ['createIssue', 'createShortcut'], ['commandPalette', 'showHelp'], ['copyBranch', 'copyBranchShortcut'], ['moveStatus', 'moveShortcut'], ['label', 'labelFilter'], ['saveForm', 'saveFormShortcut'],
  ].map(([value, key]) => ({ value, label: t(key) }));

  const stateMessage = Object.values(saveStates).some((state) => state.state === 'pending') ? t('savingSettings') : Object.values(saveStates).some((state) => state.state === 'saved') ? t('autosaved') : '';
  return <main className="page settings-page" data-testid="settings-page">
    <div className="page-heading"><div><div className="eyebrow"><Settings2 size={13} />{t('workspace')}</div><h1>{t('settingsTitle')}</h1><p className="page-subtitle">{project.name}</p></div></div>
    {readOnly && <Notice tone="warning">{t('readOnlyNote')}</Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    <div className="settings-grid">
      <section className="settings-card settings-general">
        <div className="settings-card-title"><Languages size={18} /><div><h2>{t('general')}</h2><p>{t('language')} · {t('preferences')}</p></div></div>
        <div className="settings-fields">
          <Field label={t('language')}><Picker className="settings-picker" options={locales.map((locale) => ({ value: locale.value, label: locale.label }))} value={draft.locale} onChange={setLocale} label={t('language')} /></Field>
          <div className="settings-choice-field"><span className="field-label">{t('theme')}</span><div className="theme-options" role="group" aria-label={t('theme')}>
            {(['light', 'dark', 'system'] as const).map((theme) => <button type="button" key={theme} data-testid={`theme-${theme}`} className={`theme-option${draft.theme === theme ? ' selected' : ''}`} aria-pressed={draft.theme === theme} onClick={() => toggleTheme(theme)}>{t(theme === 'light' ? 'themeLight' : theme === 'dark' ? 'themeDark' : 'themeSystem')}</button>)}
          </div></div>
          <div className="settings-choice-field"><span className="field-label">{t('palette')}</span><div className="palette-options" role="group" aria-label={t('palette')}>
            {(['blue', 'violet', 'green', 'amber'] as const).map((palette) => <button type="button" key={palette} data-testid={`palette-${palette}`} className={`palette-option${draft.palette === palette ? ' selected' : ''}`} aria-label={t(`palette${palette[0].toUpperCase()}${palette.slice(1)}`)} aria-pressed={draft.palette === palette} title={t(`palette${palette[0].toUpperCase()}${palette.slice(1)}`)} onClick={() => togglePalette(palette)}><span className={`palette-swatch palette-swatch-${palette}`} aria-hidden="true" /><span>{t(`palette${palette[0].toUpperCase()}${palette.slice(1)}`)}</span></button>)}
          </div></div>
          <Field label={t('defaultSort')} className="sort-settings"><Picker className="settings-picker" options={[['priority', 'priority'], ['updated', 'updated'], ['created', 'created'], ['id', 'issueId'], ['subject', 'subject']].map(([value, key]) => ({ value, label: t(key) }))} value={draft.sort.field} onChange={(value) => changeSort('sortField', value)} label={`${t('defaultSort')} · ${t('sortField')}`} /><Picker className="settings-picker" options={[['desc', 'desc'], ['asc', 'asc']].map(([value, key]) => ({ value, label: t(key) }))} value={draft.sort.direction} onChange={(value) => changeSort('sortDirection', value)} label={`${t('defaultSort')} · ${t('sortDirection')}`} /></Field>
          <Field label={t('polling')}><div className="input-suffix"><input className="text-input" type="number" min={10} max={3600} step={5} value={pollValue} onChange={(e) => setPollValue(e.target.value)} onBlur={commitPollInterval} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitPollInterval(); (e.target as HTMLInputElement).blur(); } }} /><span>{t('seconds')}</span></div></Field>
        </div>
        <div className="settings-card-divider" />
        <div className="settings-card-title"><Workflow size={18} /><div><h2>{t('automation')}</h2><p>{t('polling')} · {draft.pollIntervalSeconds} {t('seconds')}</p></div></div>
        <label className="switch-row"><span><strong>{t('automationEnabled')}</strong><small>{readOnly ? t('readOnlyBadge') : t('automation')}</small></span><input type="checkbox" checked={draft.automationEnabled} onChange={(e) => persistPatch('automationEnabled', { automationEnabled: e.target.checked })} /><i /></label>
      </section>

      <section className="settings-card">
        <div className="settings-card-title"><BellRing size={18} /><div><h2>{t('subscription')}</h2><p>{t('subscriptionHint')}</p></div></div>
        <label className="switch-row"><span><strong>{t('subscription')}</strong><small>{project.name}</small></span><input type="checkbox" checked={subscription.enabled} onChange={(e) => setSubscription({ enabled: e.target.checked })} /><i /></label>
        <div className="event-options">{[['comment', 'watchComments'], ['status', 'watchStatus'], ['assignee', 'watchAssignee'], ['labels', 'watchLabels']].map(([event, labelKey]) => <label className="check-row" key={event}><input type="checkbox" disabled={!subscription.enabled} checked={subscription.events.includes(event)} onChange={(e) => setEvent(event, e.target.checked)} /><span>{t(labelKey)}</span></label>)}</div>
      </section>

      <section className="settings-card">
        <div className="settings-card-title"><UserRound size={18} /><div><h2>{t('qaDefault')}</h2><p>{t('qaDefaultHint')}</p></div></div>
        <Field label={`${t('qaDefault')} · ${project.name}`}><PeoplePicker className="settings-picker" members={members} value={draft.projectQa[projectKey]} onChange={updateQa} label={t('qaDefault')} placeholder={t('unknown')} recommendations={peopleRecommendations?.qa} /></Field>
        <div className="settings-note"><ShieldCheck size={15} />{t('subscriptionHint')}</div>
      </section>

      <section className="settings-card settings-role-overrides">
        <div className="settings-card-title"><UserRound size={18} /><div><h2>{t('roleOverrides')}</h2><p>{t('roleOverridesHint')}</p></div></div>
        <Field label={t('editPeopleRoles')}><PeoplePicker className="settings-picker" members={members} value={rolePersonId} onChange={setRolePersonId} label={t('editPeopleRoles')} placeholder={t('choose')} recommendations={peopleRecommendations?.developer} /></Field>
        {rolePerson && <>
          <div className="inherited-role-copy">{t('useRedmineRoles')}: {inheritedRoles.length ? inheritedRoles.map((role) => t(`role_${role}`)).join(' · ') : t('noRole')}</div>
          <div className="people-role-options">{roles.map((role) => <label className="check-row role-override-option" key={role}><input type="checkbox" checked={currentRoles.includes(role)} onChange={(e) => toggleRole(role, e.target.checked)} /><span>{t(`role_${role}`)}</span></label>)}</div>
          <div className="settings-note"><span>{hasRoleOverride ? t('autosaved') : t('inheritedRoles')}</span>{hasRoleOverride && <Button size="sm" onClick={() => rolePersonId !== undefined && updateRoleOverride(rolePersonId, undefined)}>{t('restoreRedmineRoles')}</Button>}</div>
        </>}
      </section>

      <section className="settings-card settings-shortcuts-card">
        <form ref={shortcutFormRef} onSubmit={saveShortcuts} className="settings-shortcuts-form" data-workspace-save>
          <div className="settings-card-title"><Command size={18} /><div><h2>{t('keyboard')}</h2><p>{t('shortcutHint')}</p></div><div className="shortcut-heading-actions"><Button size="sm" onClick={addShortcut}><Plus size={13} />{t('addShortcut')}</Button><Button size="sm" onClick={() => updateShortcutDraft(() => defaultShortcuts)}>{t('resetShortcuts')}</Button></div></div>
          <div className="shortcut-list">
            {shortcuts.map((shortcut) => <div className={`shortcut-row${duplicateShortcut === shortcut.id ? ' has-conflict' : ''}`} key={shortcut.id}>
              <span className="shortcut-action">{labelForShortcut(shortcut)}</span>
              <input className="shortcut-input" aria-label={`${t('shortcut')} ${labelForShortcut(shortcut)}`} value={shortcut.keys} onChange={(e) => setShortcut(shortcut, { keys: e.target.value })} placeholder="—" />
              <Picker className="shortcut-action-picker" options={actionOptions} label={t('shortcutTarget')} value={shortcut.action} onChange={(action) => changeAction(shortcut, action)} />
              {shortcut.action === 'label' && <Picker className="shortcut-value-picker" label={t('label')} options={labelOptions} value={shortcut.value || undefined} onChange={(value) => setShortcut(shortcut, { value })} placeholder={t('label')} clearable />}
              {shortcut.action === 'moveStatus' && <Picker className="shortcut-value-picker" label={t('status')} options={statusOptions} value={shortcut.value || undefined} onChange={(value) => setShortcut(shortcut, { value })} placeholder={t('status')} clearable />}
              <label className="shortcut-enabled" title={t('shortcut')}><input type="checkbox" aria-label={`${t('enableShortcut')}: ${labelForShortcut(shortcut)}`} checked={shortcut.enabled} onChange={(e) => setShortcut(shortcut, { enabled: e.target.checked })} /><span /></label>
              <button className="shortcut-remove" type="button" onClick={() => deleteShortcut(shortcut.id)} aria-label={`${t('deleteShortcut')}: ${labelForShortcut(shortcut)}`}><Trash2 size={14} /></button>
              {duplicateShortcut === shortcut.id && <span className="shortcut-conflict">{t('shortcutConflict')}</span>}
            </div>)}
          </div>
          {shortcutConflict && <Notice tone="warning" className="shortcut-conflict-notice">{t('errorConflict')}</Notice>}
          <div className="settings-note"><ListFilter size={15} />{t('savedViews')} · {settings.savedViews.length}{settings.savedViews.length > 0 && <Button variant="quiet" size="sm" onClick={onResetViews}>{t('clear')}</Button>}</div>
          <div className="shortcut-save-row"><span>{shortcutDirty ? t('unsavedChanges') : shortcutBaselineRef.current.length ? t('shortcutsSaved') : ''}</span><Button type="submit" variant="primary" disabled={!shortcutDirty || !!duplicateShortcut || saveStates.shortcuts?.state === 'pending'}>{saveStates.shortcuts?.state === 'pending' ? <>{t('savingSettings')}</> : <><Save size={15} />{t('saveShortcuts')}</>}</Button></div>
        </form>
      </section>
      <div className="settings-savebar"><span>{projects.length} {t('projects')}</span><span className="settings-autosave-label" aria-live="polite">{stateMessage ? <><Check size={15} />{stateMessage}</> : ''}</span></div>
    </div>
  </main>;
}
