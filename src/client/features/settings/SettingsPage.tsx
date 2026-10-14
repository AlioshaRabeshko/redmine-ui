import { useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, Check, Command, History, Image as ImageIcon, Languages, ListFilter, Palette, Plus, Save, Settings2, ShieldCheck, Trash2, Upload, UserRound, Users, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { defaultActivityVisibility, isSingleEmojiAvatar, personAvatarEmojis } from '../../../shared/types';
import type { ActivityKind, AppSettings, AssigneeOption, GroupAvatarOverride, Locale, PeopleField, Person, PersonAvatarOverride, PersonRole, Project, Shortcut, SettingsPatch, Status, SubscriptionEvent } from '../../../shared/types';
import { defaultShortcuts, normalizeShortcutKeys } from '../../lib/shortcuts';
import { enqueueFieldWrite, useWorkspaceFormSave } from '../../lib/serialFieldWrite';
import { Avatar, Button, Field, Notice } from '../../components/ui';
import { GroupAvatar } from '../../components/GroupAvatar';
import { Picker, PeoplePicker } from '../../components/pickers';
import { api } from '../../lib/api';
import { readProjectBackgroundDataUrl, validateProjectBackgroundFile } from '../../lib/projectBackgroundUpload';

type SettingsSaveState = { state: 'pending' | 'saved' | 'error'; error?: string };
type GroupOption = Extract<AssigneeOption, { type: 'group' }>;
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
  if (patch.projectActivity) {
    next.projectActivity = { ...settings.projectActivity };
    for (const [key, value] of Object.entries(patch.projectActivity)) { if (value === null) delete next.projectActivity[key]; else next.projectActivity[key] = value; }
  }
  if (patch.projectBackgrounds) {
    next.projectBackgrounds = { ...(settings.projectBackgrounds || {}) };
    for (const [key, value] of Object.entries(patch.projectBackgrounds)) { if (value === null) delete next.projectBackgrounds[key]; else next.projectBackgrounds[key] = value; }
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
  if (patch.personAvatarOverrides) {
    next.personAvatarOverrides = { ...(settings.personAvatarOverrides || {}) };
    for (const [personId, override] of Object.entries(patch.personAvatarOverrides)) {
      if (override === null) delete next.personAvatarOverrides[personId]; else next.personAvatarOverrides[personId] = override;
    }
  }
  if (patch.groupAvatarOverrides) {
    next.groupAvatarOverrides = { ...(settings.groupAvatarOverrides || {}) };
    for (const [groupId, override] of Object.entries(patch.groupAvatarOverrides)) {
      if (override === null) delete next.groupAvatarOverrides[groupId]; else next.groupAvatarOverrides[groupId] = override;
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
  if (key === `projectBackground:${projectId}`) {
    const projectBackgrounds = { ...(current.projectBackgrounds || {}) };
    const confirmedUrl = confirmed.projectBackgrounds?.[projectId];
    if (confirmedUrl === undefined) delete projectBackgrounds[projectId]; else projectBackgrounds[projectId] = confirmedUrl;
    return { ...current, projectBackgrounds };
  }
  if (key === `projectActivity:${projectId}`) {
    const projectActivity = { ...current.projectActivity };
    if (confirmed.projectActivity[projectId] === undefined) delete projectActivity[projectId]; else projectActivity[projectId] = confirmed.projectActivity[projectId];
    return { ...current, projectActivity };
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
  if (key.startsWith('personAvatar:')) {
    const personId = key.slice('personAvatar:'.length);
    const personAvatarOverrides = { ...(current.personAvatarOverrides || {}) };
    const confirmedOverride = confirmed.personAvatarOverrides?.[personId];
    if (confirmedOverride === undefined) delete personAvatarOverrides[personId]; else personAvatarOverrides[personId] = confirmedOverride;
    return { ...current, personAvatarOverrides };
  }
  if (key.startsWith('groupAvatar:')) {
    const groupId = key.slice('groupAvatar:'.length);
    const groupAvatarOverrides = { ...(current.groupAvatarOverrides || {}) };
    const confirmedOverride = confirmed.groupAvatarOverrides?.[groupId];
    if (confirmedOverride === undefined) delete groupAvatarOverrides[groupId]; else groupAvatarOverrides[groupId] = confirmedOverride;
    return { ...current, groupAvatarOverrides };
  }
  return current;
}

export function SettingsPage({ settings, members, groups = [], project, projects, statuses, labels, peopleRecommendations, readOnly, onPatchSettings, onResetViews, onToast }: {
  settings: AppSettings; members: Person[]; project: Project; projects: Project[]; statuses: Status[]; labels: string[];
  groups?: GroupOption[];
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
  const [backgroundPhase, setBackgroundPhase] = useState<'idle' | 'reading' | 'uploading' | 'saving'>('idle');
  const [backgroundReadProgress, setBackgroundReadProgress] = useState(0);
  const [backgroundError, setBackgroundError] = useState('');
  const [unavailableBackgroundUrl, setUnavailableBackgroundUrl] = useState('');
  const backgroundFileInputRef = useRef<HTMLInputElement>(null);
  const backgroundUrl = draft.projectBackgrounds?.[projectKey];
  const backgroundSaveKey = `projectBackground:${projectKey}`;
  const backgroundBusy = backgroundPhase !== 'idle' || saveStates[backgroundSaveKey]?.state === 'pending';
  const previewUnavailable = !!backgroundUrl && unavailableBackgroundUrl === backgroundUrl;

  useEffect(() => { setUnavailableBackgroundUrl(''); }, [backgroundUrl]);
  const activityVisibility = draft.projectActivity[projectKey] ?? defaultActivityVisibility;
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
  const [personAvatarPhase, setPersonAvatarPhase] = useState<'idle' | 'reading' | 'uploading' | 'saving'>('idle');
  const [personAvatarTarget, setPersonAvatarTarget] = useState<number | undefined>();
  const [personAvatarError, setPersonAvatarError] = useState('');
  const [personAvatarErrorTarget, setPersonAvatarErrorTarget] = useState<number | undefined>();
  const [emojiDraft, setEmojiDraft] = useState('');
  const personAvatarFileInputRef = useRef<HTMLInputElement>(null);
  const [groupAvatarId, setGroupAvatarId] = useState<number | undefined>(() => groups[0]?.id);
  const [groupAvatarPhase, setGroupAvatarPhase] = useState<'idle' | 'reading' | 'uploading' | 'saving'>('idle');
  const [groupAvatarTarget, setGroupAvatarTarget] = useState<number | undefined>();
  const [groupAvatarError, setGroupAvatarError] = useState('');
  const [groupAvatarErrorTarget, setGroupAvatarErrorTarget] = useState<number | undefined>();
  const [groupEmojiDraft, setGroupEmojiDraft] = useState('');
  const groupAvatarFileInputRef = useRef<HTMLInputElement>(null);
  const shortcutFormRef = useWorkspaceFormSave<HTMLFormElement>();

  useEffect(() => {
    if (rolePersonId === undefined && personAvatarPhase === 'idle' && members.length > 0) setRolePersonId(members[0].id);
  }, [rolePersonId, personAvatarPhase, members]);

  useEffect(() => {
    if (groupAvatarId === undefined && groupAvatarPhase === 'idle' && groups.length > 0) setGroupAvatarId(groups[0].id);
  }, [groupAvatarId, groupAvatarPhase, groups]);

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

  useEffect(() => {
    const override = rolePersonId === undefined ? undefined : draft.personAvatarOverrides?.[String(rolePersonId)];
    setEmojiDraft(override?.kind === 'emoji' ? override.emoji : '');
  }, [rolePersonId, draft.personAvatarOverrides]);

  useEffect(() => {
    const override = groupAvatarId === undefined ? undefined : draft.groupAvatarOverrides?.[String(groupAvatarId)];
    setGroupEmojiDraft(override?.kind === 'emoji' ? override.emoji : '');
  }, [groupAvatarId, draft.groupAvatarOverrides]);

  useEffect(() => {
    setPersonAvatarError('');
    setPersonAvatarErrorTarget(undefined);
  }, [rolePersonId]);

  useEffect(() => {
    setGroupAvatarError('');
    setGroupAvatarErrorTarget(undefined);
  }, [groupAvatarId]);

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

  const setActivity = (kind: ActivityKind, checked: boolean) => {
    const current = settingsRef.current.projectActivity[projectKey] ?? defaultActivityVisibility;
    void persistPatch(`projectActivity:${projectKey}`, { projectActivity: { [projectKey]: { ...current, [kind]: checked } } });
  };
  const subscriptionPatch = (next: typeof subscription) => {
    void persistPatch(`subscription:${projectKey}`, { subscriptions: { [projectKey]: next } });
  };
  const setSubscription = (patch: Partial<typeof subscription>) => {
    const current = settingsRef.current.subscriptions[projectKey] || { enabled: false, events: ['comment'] };
    subscriptionPatch({ ...current, ...patch });
  };
  const setEvent = (event: SubscriptionEvent, checked: boolean) => {
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

  const removePersonAvatarBytes = async (personId: number, override?: PersonAvatarOverride) => {
    if (override?.kind !== 'photo') return;
    const version = override.url.match(/[?&]v=([0-9a-f-]{36})/i)?.[1];
    if (version) await api.delete(`/api/people/${personId}/avatar?v=${version}`);
  };

  const savePersonEmoji = async (personId: number, emoji: string) => {
    if (!isSingleEmojiAvatar(emoji)) return false;
    const previous = settingsRef.current.personAvatarOverrides?.[String(personId)];
    setPersonAvatarTarget(personId);
    setPersonAvatarPhase('saving');
    setPersonAvatarError('');
    try {
      const saved = await persistPatch(`personAvatar:${personId}`, { personAvatarOverrides: { [String(personId)]: { kind: 'emoji', emoji } } });
      if (!saved) { setPersonAvatarError(t('personAvatarSaveFailed')); setPersonAvatarErrorTarget(personId); return false; }
      try { await removePersonAvatarBytes(personId, previous); } catch { /* The local preference is saved; an old version can be replaced later. */ }
      return true;
    } finally {
      setPersonAvatarPhase('idle');
      setPersonAvatarTarget(undefined);
    }
  };

  const uploadPersonAvatar = async (personId: number, file: File) => {
    const previous = settingsRef.current.personAvatarOverrides?.[String(personId)];
    if (file.size > 2 * 1024 * 1024) { setPersonAvatarError(t('personAvatarTooLarge')); setPersonAvatarErrorTarget(personId); return; }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type.toLowerCase())) {
      setPersonAvatarError(t('personAvatarUnsupportedType')); setPersonAvatarErrorTarget(personId); return;
    }
    setPersonAvatarError('');
    setPersonAvatarErrorTarget(undefined);
    let phase: 'reading' | 'uploading' | 'saving' = 'reading';
    setPersonAvatarTarget(personId);
    setPersonAvatarPhase(phase);
    try {
      const dataUrl = await readProjectBackgroundDataUrl(file);
      phase = 'uploading';
      setPersonAvatarPhase(phase);
      const response = await api.put<{ url?: string }>(`/api/people/${personId}/avatar`, { dataUrl });
      if (typeof response?.url !== 'string' || !response.url.trim()) throw new Error('Invalid local avatar response');
      phase = 'saving';
      setPersonAvatarPhase(phase);
      const saved = await persistPatch(`personAvatar:${personId}`, { personAvatarOverrides: { [String(personId)]: { kind: 'photo', url: response.url } } });
      if (!saved) { setPersonAvatarError(t('personAvatarSaveFailed')); setPersonAvatarErrorTarget(personId); return; }
      try { await removePersonAvatarBytes(personId, previous); } catch { /* The new photo is active; a stale previous version can be removed later. */ }
    } catch {
      setPersonAvatarError(t(phase === 'reading' ? 'personAvatarReadFailed' : 'personAvatarUploadFailed'));
      setPersonAvatarErrorTarget(personId);
    } finally {
      setPersonAvatarPhase('idle');
      setPersonAvatarTarget(undefined);
    }
  };

  const clearPersonAvatar = async (personId: number) => {
    const previous = settingsRef.current.personAvatarOverrides?.[String(personId)];
    setPersonAvatarError('');
    setPersonAvatarErrorTarget(undefined);
    setPersonAvatarTarget(personId);
    setPersonAvatarPhase('saving');
    try {
      const saved = await persistPatch(`personAvatar:${personId}`, { personAvatarOverrides: { [String(personId)]: null } });
      if (!saved) { setPersonAvatarError(t('personAvatarSaveFailed')); setPersonAvatarErrorTarget(personId); return; }
      try { await removePersonAvatarBytes(personId, previous); } catch { /* The local preference is cleared; an old version can be replaced later. */ }
      setEmojiDraft('');
    } finally {
      setPersonAvatarPhase('idle');
      setPersonAvatarTarget(undefined);
    }
  };

  const removeGroupAvatarBytes = async (groupId: number, override?: GroupAvatarOverride) => {
    if (override?.kind !== 'photo') return;
    const version = override.url.match(/[?&]v=([0-9a-f-]{36})/i)?.[1];
    if (version) await api.delete(`/api/groups/${groupId}/avatar?v=${version}`);
  };

  const saveGroupEmoji = async (groupId: number, emoji: string) => {
    if (!isSingleEmojiAvatar(emoji)) return false;
    const previous = settingsRef.current.groupAvatarOverrides?.[String(groupId)];
    setGroupAvatarTarget(groupId);
    setGroupAvatarPhase('saving');
    setGroupAvatarError('');
    try {
      const saved = await persistPatch(`groupAvatar:${groupId}`, { groupAvatarOverrides: { [String(groupId)]: { kind: 'emoji', emoji } } });
      if (!saved) { setGroupAvatarError(t('groupAvatarSaveFailed')); setGroupAvatarErrorTarget(groupId); return false; }
      try { await removeGroupAvatarBytes(groupId, previous); }
      catch { setGroupAvatarError(t('groupAvatarCleanupFailed')); setGroupAvatarErrorTarget(groupId); }
      return true;
    } finally {
      setGroupAvatarPhase('idle');
      setGroupAvatarTarget(undefined);
    }
  };

  const uploadGroupAvatar = async (groupId: number, file: File) => {
    const previous = settingsRef.current.groupAvatarOverrides?.[String(groupId)];
    if (file.size > 2 * 1024 * 1024) { setGroupAvatarError(t('groupAvatarTooLarge')); setGroupAvatarErrorTarget(groupId); return; }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type.toLowerCase())) {
      setGroupAvatarError(t('groupAvatarUnsupportedType')); setGroupAvatarErrorTarget(groupId); return;
    }
    setGroupAvatarError('');
    setGroupAvatarErrorTarget(undefined);
    let phase: 'reading' | 'uploading' | 'saving' = 'reading';
    let uploadedUrl: string | undefined;
    setGroupAvatarTarget(groupId);
    setGroupAvatarPhase(phase);
    try {
      const dataUrl = await readProjectBackgroundDataUrl(file);
      phase = 'uploading';
      setGroupAvatarPhase(phase);
      const response = await api.put<{ url?: string }>(`/api/groups/${groupId}/avatar`, { dataUrl });
      if (typeof response?.url !== 'string' || !response.url.trim()) throw new Error('Invalid local group avatar response');
      uploadedUrl = response.url;
      phase = 'saving';
      setGroupAvatarPhase(phase);
      const saved = await persistPatch(`groupAvatar:${groupId}`, { groupAvatarOverrides: { [String(groupId)]: { kind: 'photo', url: response.url } } });
      if (!saved) {
        try { await removeGroupAvatarBytes(groupId, { kind: 'photo', url: response.url }); } catch { /* Keep the settings error visible; the orphaned file is still local. */ }
        setGroupAvatarError(t('groupAvatarSaveFailed'));
        setGroupAvatarErrorTarget(groupId);
        return;
      }
      try { await removeGroupAvatarBytes(groupId, previous); }
      catch { setGroupAvatarError(t('groupAvatarCleanupFailed')); setGroupAvatarErrorTarget(groupId); }
    } catch {
      if (uploadedUrl) {
        try { await removeGroupAvatarBytes(groupId, { kind: 'photo', url: uploadedUrl }); } catch { /* Best effort cleanup after an interrupted save. */ }
      }
      setGroupAvatarError(t(phase === 'reading' ? 'groupAvatarReadFailed' : 'groupAvatarUploadFailed'));
      setGroupAvatarErrorTarget(groupId);
    } finally {
      setGroupAvatarPhase('idle');
      setGroupAvatarTarget(undefined);
    }
  };

  const clearGroupAvatar = async (groupId: number) => {
    const previous = settingsRef.current.groupAvatarOverrides?.[String(groupId)];
    setGroupAvatarError('');
    setGroupAvatarErrorTarget(undefined);
    setGroupAvatarTarget(groupId);
    setGroupAvatarPhase('saving');
    try {
      const saved = await persistPatch(`groupAvatar:${groupId}`, { groupAvatarOverrides: { [String(groupId)]: null } });
      if (!saved) { setGroupAvatarError(t('groupAvatarSaveFailed')); setGroupAvatarErrorTarget(groupId); return; }
      try { await removeGroupAvatarBytes(groupId, previous); }
      catch { setGroupAvatarError(t('groupAvatarCleanupFailed')); setGroupAvatarErrorTarget(groupId); }
      setGroupEmojiDraft('');
    } finally {
      setGroupAvatarPhase('idle');
      setGroupAvatarTarget(undefined);
    }
  };

  const uploadProjectBackground = async (file: File) => {
    const validationError = validateProjectBackgroundFile(file);
    if (validationError) { setBackgroundError(t(validationError)); return; }
    setBackgroundError('');
    setUnavailableBackgroundUrl('');
    setBackgroundReadProgress(0);
    let phase: 'reading' | 'uploading' | 'saving' = 'reading';
    setBackgroundPhase(phase);
    try {
      const dataUrl = await readProjectBackgroundDataUrl(file, setBackgroundReadProgress);
      phase = 'uploading';
      setBackgroundPhase(phase);
      const response = await api.put<{ url?: string }>(`/api/projects/${project.id}/background`, { dataUrl });
      if (typeof response?.url !== 'string' || !response.url.trim()) throw new Error('Invalid background upload response');
      phase = 'saving';
      setBackgroundPhase(phase);
      const saved = await persistPatch(backgroundSaveKey, { projectBackgrounds: { [projectKey]: response.url } });
      if (!saved) setBackgroundError(t('projectBackgroundSaveFailed'));
    } catch {
      setBackgroundError(t(phase === 'reading' ? 'projectBackgroundReadFailed' : 'projectBackgroundUploadFailed'));
    } finally {
      setBackgroundPhase('idle');
      setBackgroundReadProgress(0);
    }
  };

  const removeProjectBackground = async () => {
    if (!backgroundUrl || backgroundBusy) return;
    setBackgroundError('');
    setBackgroundPhase('saving');
    try {
      const saved = await persistPatch(backgroundSaveKey, { projectBackgrounds: { [projectKey]: null } });
      if (!saved) setBackgroundError(t('projectBackgroundSaveFailed'));
    } finally {
      setBackgroundPhase('idle');
    }
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
    return t(action === 'view/mine' ? 'assignShortcut' : action === 'projectPicker' ? 'openProjectPicker' : action === 'copyRedmineUrl' ? 'copyUrlShortcut' : action === 'search' ? 'openSearch' : action === 'createIssue' ? 'createShortcut' : action === 'copyBranch' ? 'copyBranchShortcut' : action === 'moveStatus' ? 'moveShortcut' : action === 'commandPalette' ? 'showHelp' : action === 'label' ? 'labelFilter' : action === 'saveForm' ? 'saveFormShortcut' : action === 'toggleSidebar' ? 'toggleSidebarShortcut' : action === 'openInbox' ? 'openInbox' : action === 'openSettings' ? 'openSettingsShortcut' : 'action');
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
  const selectedAvatarOverride = rolePersonId === undefined ? undefined : draft.personAvatarOverrides?.[String(rolePersonId)];
  const personAvatarBusy = personAvatarPhase !== 'idle';
  const personAvatarBusyForSelection = personAvatarBusy && personAvatarTarget === rolePersonId;
  const personAvatarErrorForSelection = personAvatarErrorTarget === rolePersonId ? personAvatarError : '';
  const selectedGroup = groups.find(group => group.id === groupAvatarId);
  const selectedGroupAvatarOverride = groupAvatarId === undefined ? undefined : draft.groupAvatarOverrides?.[String(groupAvatarId)];
  const groupAvatarBusy = groupAvatarPhase !== 'idle';
  const groupAvatarBusyForSelection = groupAvatarBusy && groupAvatarTarget === groupAvatarId;
  const groupAvatarErrorForSelection = groupAvatarErrorTarget === groupAvatarId ? groupAvatarError : '';
  const avatarPreviewPerson = rolePerson && selectedAvatarOverride?.kind === 'photo'
    ? { ...rolePerson, avatar: selectedAvatarOverride.url, localEmoji: undefined }
    : rolePerson && selectedAvatarOverride?.kind === 'emoji'
      ? { ...rolePerson, avatar: undefined, localEmoji: selectedAvatarOverride.emoji }
      : rolePerson;
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
    ['createIssue', 'createShortcut'], ['commandPalette', 'showHelp'], ['copyBranch', 'copyBranchShortcut'], ['moveStatus', 'moveShortcut'], ['label', 'labelFilter'], ['saveForm', 'saveFormShortcut'], ['toggleSidebar', 'toggleSidebarShortcut'], ['openInbox', 'openInbox'], ['openSettings', 'openSettingsShortcut'],
  ].map(([value, key]) => ({ value, label: t(key) }));

  const stateMessage = Object.values(saveStates).some((state) => state.state === 'pending') ? t('savingSettings') : Object.values(saveStates).some((state) => state.state === 'saved') ? t('autosaved') : '';
  return <main className="page settings-page" data-testid="settings-page">
    <div className="page-heading"><div><div className="eyebrow"><Settings2 size={13} />{t('workspace')}</div><h1>{t('settingsTitle')}</h1><p className="page-subtitle">{project.name}</p></div></div>
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

      <section className="settings-card project-background-card">
        <div className="settings-card-title"><ImageIcon size={18} /><div><h2>{t('projectBackground')}</h2><p>{t('projectBackgroundHint')}</p></div></div>
        {backgroundUrl && !previewUnavailable
          ? <img className="project-background-preview" src={backgroundUrl} alt={`${project.name} — ${t('projectBackgroundPreview')}`} onError={() => setUnavailableBackgroundUrl(backgroundUrl)} />
          : <div className="project-background-placeholder" role="img" aria-label={backgroundUrl ? t('projectBackgroundUnavailable') : t('projectBackgroundEmpty')}>{backgroundUrl ? t('projectBackgroundUnavailable') : t('projectBackgroundEmpty')}</div>}
        <input
          ref={backgroundFileInputRef}
          className="sr-only"
          type="file"
          accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
          aria-label={t('uploadProjectBackground')}
          data-testid="project-background-upload"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void uploadProjectBackground(file);
          }}
        />
        <div className="project-background-actions">
          <Button variant="outline" disabled={backgroundBusy} onClick={() => backgroundFileInputRef.current?.click()}><Upload size={14} />{backgroundUrl ? t('replaceProjectBackground') : t('uploadProjectBackground')}</Button>
          {backgroundUrl && <Button variant="danger" disabled={backgroundBusy} onClick={() => void removeProjectBackground()}><Trash2 size={14} />{t('removeProjectBackground')}</Button>}
        </div>
        {backgroundPhase !== 'idle' && <div className="settings-note" role="status" aria-live="polite">
          {t(backgroundPhase === 'reading' ? 'projectBackgroundReading' : backgroundPhase === 'uploading' ? 'projectBackgroundUploading' : 'projectBackgroundSaving')}
          {backgroundPhase === 'reading' && <> · {backgroundReadProgress}%<progress max={100} value={backgroundReadProgress} aria-label={t('projectBackgroundReadProgress')} /></>}
        </div>}
        {backgroundError && <Notice tone="error">{backgroundError}</Notice>}
      </section>

      <section className="settings-card" data-testid="project-activity-settings">
        <div className="settings-card-title"><History size={18} /><div><h2>{t('projectActivity')}</h2><p>{t('projectActivityHint', { project: project.name })}</p></div></div>
        <div className="event-options">{(['comment', 'status', 'assignee', 'labels', 'field'] as ActivityKind[]).map(kind => <label className="check-row" key={kind}><input type="checkbox" checked={activityVisibility[kind]} onChange={event => setActivity(kind, event.target.checked)} /><span>{t({ comment: 'watchComments', status: 'watchStatus', assignee: 'watchAssignee', labels: 'watchLabels', field: 'activityOtherFields' }[kind])}</span></label>)}</div>
        <div className="settings-note"><span>{t('projectActivityLocal')}</span><Button size="sm" onClick={() => void persistPatch(`projectActivity:${projectKey}`, { projectActivity: { [projectKey]: null } })}>{t('projectActivityReset')}</Button></div>
      </section>

      <section className="settings-card">
        <div className="settings-card-title"><BellRing size={18} /><div><h2>{t('subscription')}</h2><p>{t('subscriptionHint')}</p></div></div>
        <label className="switch-row"><span><strong>{t('subscription')}</strong><small>{project.name}</small></span><input type="checkbox" checked={subscription.enabled} onChange={(e) => setSubscription({ enabled: e.target.checked })} /><i /></label>
        <div className="event-options">{([
          ['comment', 'watchComments'], ['status', 'watchStatus'], ['assignee', 'watchAssignee'], ['labels', 'watchLabels'], ['issue_created', 'watchNewIssues'],
        ] as const).map(([event, labelKey]) => <label className="check-row" key={event}><input type="checkbox" disabled={!subscription.enabled} checked={subscription.events.includes(event)} onChange={(e) => setEvent(event, e.target.checked)} /><span>{t(labelKey)}</span></label>)}</div>
      </section>

      <section className="settings-card">
        <div className="settings-card-title"><UserRound size={18} /><div><h2>{t('qaDefault')}</h2><p>{t('qaDefaultHint')}</p></div></div>
        <Field label={`${t('qaDefault')} · ${project.name}`}><PeoplePicker className="settings-picker" members={members} value={draft.projectQa[projectKey]} onChange={updateQa} label={t('qaDefault')} placeholder={t('unknown')} recommendations={peopleRecommendations?.qa} /></Field>
        <div className="settings-note"><ShieldCheck size={15} />{t('subscriptionHint')}</div>
      </section>

      <section className="settings-card settings-role-overrides">
        <div className="settings-card-title"><UserRound size={18} /><div><h2>{t('roleOverrides')}</h2><p>{t('roleOverridesHint')}</p></div></div>
        <Field label={t('editPeopleRoles')}><PeoplePicker className="settings-picker" members={members} value={rolePersonId} onChange={setRolePersonId} label={t('editPeopleRoles')} placeholder={t('choose')} recommendations={peopleRecommendations?.developer} disabled={personAvatarBusy} /></Field>
        {rolePerson && <>
          <div className="inherited-role-copy">{t('useRedmineRoles')}: {inheritedRoles.length ? inheritedRoles.map((role) => t(`role_${role}`)).join(' · ') : t('noRole')}</div>
          <div className="people-role-options">{roles.map((role) => <label className="check-row role-override-option" key={role}><input type="checkbox" checked={currentRoles.includes(role)} onChange={(e) => toggleRole(role, e.target.checked)} /><span>{t(`role_${role}`)}</span></label>)}</div>
          <div className="settings-note"><span>{hasRoleOverride ? t('autosaved') : t('inheritedRoles')}</span>{hasRoleOverride && <Button size="sm" onClick={() => rolePersonId !== undefined && updateRoleOverride(rolePersonId, undefined)}>{t('restoreRedmineRoles')}</Button>}</div>
          <div className="settings-card-divider" />
          <div className="settings-card-title"><ImageIcon size={18} /><div><h2>{t('personAvatarTitle')}</h2><p>{t('personAvatarHint')}</p></div></div>
          <div className="settings-note" data-testid="person-avatar-preview"><Avatar person={avatarPreviewPerson} size="md" /><span>{t('personAvatarFor', { person: rolePerson.name })}</span></div>
          <input
            ref={personAvatarFileInputRef}
            className="sr-only"
            type="file"
            tabIndex={-1}
            accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
            aria-label={t('uploadPersonAvatar')}
            data-testid="person-avatar-upload"
            disabled={personAvatarBusy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file && rolePersonId !== undefined) void uploadPersonAvatar(rolePersonId, file);
            }}
          />
          <div className="project-background-actions">
            <Button variant="outline" disabled={personAvatarBusy} onClick={() => personAvatarFileInputRef.current?.click()}><Upload size={14} />{selectedAvatarOverride?.kind === 'photo' ? t('replacePersonAvatar') : t('uploadPersonAvatar')}</Button>
            {selectedAvatarOverride && <Button variant="danger" disabled={personAvatarBusy} onClick={() => rolePersonId !== undefined && void clearPersonAvatar(rolePersonId)}><Trash2 size={14} />{t('removePersonAvatar')}</Button>}
          </div>
          <Field label={t('personAvatarEmojiInput')} hint={t('personAvatarEmojiHint')}>
            <input className="text-input" data-testid="person-avatar-emoji" value={emojiDraft} maxLength={32} disabled={personAvatarBusy} onChange={(event) => {
              const value = event.target.value;
              setEmojiDraft(value);
              if (rolePersonId !== undefined && isSingleEmojiAvatar(value)) void savePersonEmoji(rolePersonId, value);
            }} />
          </Field>
          {emojiDraft.length > 0 && !isSingleEmojiAvatar(emojiDraft) && <div className="settings-note" role="status">{t('personAvatarEmojiInvalid')}</div>}
          <div className="theme-options" role="group" aria-label={t('personAvatarEmojiPresets')}>
            {personAvatarEmojis.map(emoji => <button type="button" key={emoji} className={`theme-option${selectedAvatarOverride?.kind === 'emoji' && selectedAvatarOverride.emoji === emoji ? ' selected' : ''}`} aria-label={t('usePersonAvatarEmoji', { emoji })} aria-pressed={selectedAvatarOverride?.kind === 'emoji' && selectedAvatarOverride.emoji === emoji} disabled={personAvatarBusy} onClick={() => {
              setEmojiDraft(emoji);
              if (rolePersonId !== undefined) void savePersonEmoji(rolePersonId, emoji);
            }}>{emoji}</button>)}
          </div>
          {personAvatarBusyForSelection && <div className="settings-note" role="status" aria-live="polite">{t(personAvatarPhase === 'reading' ? 'personAvatarReading' : personAvatarPhase === 'uploading' ? 'personAvatarUploading' : 'personAvatarSaving')}</div>}
          {personAvatarErrorForSelection && <Notice tone="error">{personAvatarErrorForSelection}</Notice>}
        </>}
      </section>

      <section className="settings-card group-avatar-settings" data-testid="group-avatar-settings">
        <div className="settings-card-title"><Users size={18} /><div><h2>{t('groupAvatarTitle')}</h2><p>{t('groupAvatarHint')}</p></div></div>
        {groups.length === 0 ? <div className="settings-note">{t('groupAvatarNoGroups')}</div> : <>
          <Field label={t('groupAvatarSelection')}><Picker className="settings-picker" options={groups.map(group => ({ value: String(group.id), label: group.name }))} value={groupAvatarId === undefined ? undefined : String(groupAvatarId)} onChange={value => setGroupAvatarId(value ? Number(value) : undefined)} label={t('groupAvatarSelection')} placeholder={t('choose')} disabled={groupAvatarBusy} /></Field>
          {selectedGroup && <>
            <div className="settings-note" data-testid="group-avatar-preview"><GroupAvatar group={selectedGroup} override={selectedGroupAvatarOverride} size="md" label={t('groupAvatarFor', { group: selectedGroup.name })} /><span>{t('groupAvatarFor', { group: selectedGroup.name })}</span></div>
            <input
              ref={groupAvatarFileInputRef}
              className="sr-only"
              type="file"
              tabIndex={-1}
              accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
              aria-label={t('uploadGroupAvatar')}
              data-testid="group-avatar-upload"
              disabled={groupAvatarBusy}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file && groupAvatarId !== undefined) void uploadGroupAvatar(groupAvatarId, file);
              }}
            />
            <div className="project-background-actions">
              <Button variant="outline" disabled={groupAvatarBusy} onClick={() => groupAvatarFileInputRef.current?.click()}><Upload size={14} />{selectedGroupAvatarOverride?.kind === 'photo' ? t('replaceGroupAvatar') : t('uploadGroupAvatar')}</Button>
              {selectedGroupAvatarOverride && <Button variant="danger" data-testid="group-avatar-remove" disabled={groupAvatarBusy} onClick={() => groupAvatarId !== undefined && void clearGroupAvatar(groupAvatarId)}><Trash2 size={14} />{t('removeGroupAvatar')}</Button>}
            </div>
            <Field label={t('groupAvatarEmojiInput')} hint={t('groupAvatarEmojiHint')}>
              <input className="text-input" data-testid="group-avatar-emoji" value={groupEmojiDraft} maxLength={32} disabled={groupAvatarBusy} onChange={(event) => {
                const value = event.target.value;
                setGroupEmojiDraft(value);
                if (groupAvatarId !== undefined && isSingleEmojiAvatar(value)) void saveGroupEmoji(groupAvatarId, value);
              }} />
            </Field>
            {groupEmojiDraft.length > 0 && !isSingleEmojiAvatar(groupEmojiDraft) && <div className="settings-note" role="status">{t('groupAvatarEmojiInvalid')}</div>}
            <div className="theme-options" role="group" aria-label={t('groupAvatarEmojiPresets')}>
              {personAvatarEmojis.map(emoji => <button type="button" key={emoji} className={`theme-option${selectedGroupAvatarOverride?.kind === 'emoji' && selectedGroupAvatarOverride.emoji === emoji ? ' selected' : ''}`} aria-label={t('useGroupAvatarEmoji', { emoji })} aria-pressed={selectedGroupAvatarOverride?.kind === 'emoji' && selectedGroupAvatarOverride.emoji === emoji} disabled={groupAvatarBusy} onClick={() => {
                setGroupEmojiDraft(emoji);
                if (groupAvatarId !== undefined) void saveGroupEmoji(groupAvatarId, emoji);
              }}>{emoji}</button>)}
            </div>
            {groupAvatarBusyForSelection && <div className="settings-note" role="status" aria-live="polite">{t(groupAvatarPhase === 'reading' ? 'groupAvatarReading' : groupAvatarPhase === 'uploading' ? 'groupAvatarUploading' : 'groupAvatarSaving')}</div>}
            {groupAvatarErrorForSelection && <Notice tone="error">{groupAvatarErrorForSelection}</Notice>}
          </>}
        </>}
      </section>

      <section className="settings-card settings-shortcuts-card">
        <form ref={shortcutFormRef} onSubmit={saveShortcuts} className="settings-shortcuts-form" data-workspace-save>
          <div className="settings-card-title"><Command size={18} /><div><h2>{t('keyboard')}</h2><p>{t('shortcutHint')}</p></div><div className="shortcut-heading-actions"><Button size="sm" onClick={addShortcut}><Plus size={13} />{t('addShortcut')}</Button><Button size="sm" onClick={() => updateShortcutDraft(() => defaultShortcuts)}>{t('resetShortcuts')}</Button></div></div>
          <div className="shortcut-list">
            {shortcuts.map((shortcut) => <div className={`shortcut-row${duplicateShortcut === shortcut.id ? ' has-conflict' : ''}`} key={shortcut.id} data-shortcut-action={shortcut.action}>
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
