import { z } from 'zod';
import { navigationShortcuts } from '../shared/shortcuts.js';
import { isSingleEmojiAvatar } from '../shared/types.js';
import type { AppSettings, PersonAvatarOverride, SettingsPatch } from '../shared/types.js';
export type { SettingsPatch } from '../shared/types.js';

const idKey = z.string().regex(/^[1-9]\d*$/);
const personRoleSchema = z.enum(['qa', 'support', 'developer']);
const activityVisibilitySchema = z.object({ comment: z.boolean(), status: z.boolean(), assignee: z.boolean(), labels: z.boolean(), field: z.boolean() }).strict();
const subscriptionSchema = z.object({ enabled: z.boolean(), events: z.array(z.string()) });
const backgroundUrlPattern = /^\/api\/projects\/([1-9]\d*)\/background\?v=([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const personAvatarUrlPattern = /^\/api\/people\/([1-9]\d*)\/avatar\?v=([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
function validateProjectBackgroundMap(backgrounds: Record<string, string | null>, context: z.RefinementCtx): void {
  for (const [projectId, url] of Object.entries(backgrounds)) {
    if (url === null) continue;
    const urlProjectId = url.match(backgroundUrlPattern)?.[1];
    if (urlProjectId !== projectId) context.addIssue({ code: 'custom', path: [projectId], message: 'Background URL must belong to the same project.' });
  }
}
const projectBackgroundsSchema = z.record(idKey, z.string().regex(backgroundUrlPattern)).superRefine(validateProjectBackgroundMap);
const projectBackgroundsPatchSchema = z.record(idKey, z.string().regex(backgroundUrlPattern).nullable()).superRefine(validateProjectBackgroundMap);
const personAvatarOverrideSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('photo'), url: z.string().regex(personAvatarUrlPattern) }).strict(),
  z.object({ kind: z.literal('emoji'), emoji: z.string().max(32).refine(isSingleEmojiAvatar) }).strict(),
]);
function validatePersonAvatarMap(overrides: Record<string, PersonAvatarOverride | null>, context: z.RefinementCtx): void {
  for (const [personId, override] of Object.entries(overrides)) {
    if (override?.kind !== 'photo') continue;
    if (override.url.match(personAvatarUrlPattern)?.[1] !== personId) {
      context.addIssue({ code: 'custom', path: [personId], message: 'Avatar URL must belong to the same person.' });
    }
  }
}
const personAvatarOverridesSchema = z.record(idKey, personAvatarOverrideSchema).superRefine(validatePersonAvatarMap).default({});
const personAvatarOverridesPatchSchema = z.record(idKey, personAvatarOverrideSchema.nullable()).superRefine(validatePersonAvatarMap);
const filtersSchema = z.object({
  search: z.string().optional(), assigneeId: z.number().int().optional(), assignedToMe: z.boolean().optional(),
  label: z.string().optional(), labels: z.array(z.string()).optional(),
  statusIds: z.array(z.number().int()).optional(), priorityIds: z.array(z.number().int()).optional(),
  versionId: z.number().int().optional(), includeClosed: z.boolean().optional(),
});
const savedViewSchema = z.object({ id: z.string(), projectId: z.number().int().positive(), name: z.string(),
  filters: filtersSchema, view: z.enum(['all', 'mine', 'watching', 'backlog']) });
const shortcutSchema = z.object({ id: z.string(), keys: z.string(), action: z.string(), value: z.string().optional(), enabled: z.boolean() });
const sortSchema = z.object({ field: z.enum(['priority', 'updated', 'created', 'id', 'subject']), direction: z.enum(['asc', 'desc']) });

const settingsSchema = z.object({
  locale: z.enum(['uk', 'pl', 'es', 'en']),
  theme: z.enum(['light', 'dark', 'system']),
  palette: z.enum(['blue', 'violet', 'green', 'amber']),
  projectQa: z.record(idKey, z.number().int().positive()),
  subscriptions: z.record(idKey, subscriptionSchema),
  projectActivity: z.record(idKey, activityVisibilitySchema).default({}),
  projectBackgrounds: projectBackgroundsSchema,
  personRoleOverrides: z.record(idKey, z.record(idKey, z.array(personRoleSchema))),
  personAvatarOverrides: personAvatarOverridesSchema,
  shortcuts: z.array(shortcutSchema),
  savedViews: z.array(savedViewSchema),
  sort: sortSchema,
  automationEnabled: z.boolean(),
  pollIntervalSeconds: z.number().int().min(5).max(3600),
});

const settingsPatchSchema = z.object({
  locale: settingsSchema.shape.locale.optional(),
  theme: settingsSchema.shape.theme.optional(),
  palette: settingsSchema.shape.palette.optional(),
  projectQa: z.record(idKey, z.number().int().positive().nullable()).optional(),
  subscriptions: z.record(idKey, subscriptionSchema.nullable()).optional(),
  projectActivity: z.record(idKey, activityVisibilitySchema.nullable()).optional(),
  projectBackgrounds: projectBackgroundsPatchSchema.optional(),
  personRoleOverrides: z.record(idKey, z.record(idKey, z.array(personRoleSchema).nullable()).nullable()).optional(),
  personAvatarOverrides: personAvatarOverridesPatchSchema.optional(),
  shortcuts: settingsSchema.shape.shortcuts.optional(),
  savedViews: settingsSchema.shape.savedViews.optional(),
  sort: settingsSchema.shape.sort.optional(),
  automationEnabled: settingsSchema.shape.automationEnabled.optional(),
  pollIntervalSeconds: settingsSchema.shape.pollIntervalSeconds.optional(),
}).strict();

export const defaultSettings: AppSettings = {
  locale: 'uk',
  theme: 'system',
  palette: 'blue',
  projectQa: {},
  subscriptions: {},
  projectActivity: {},
  projectBackgrounds: {},
  personRoleOverrides: {},
  personAvatarOverrides: {},
  shortcuts: [
    { id: 'mine', keys: 'Q', action: 'view', value: 'mine', enabled: true },
    { id: 'project', keys: 'B', action: 'projectPicker', enabled: true },
    { id: 'copy-redmine-url', keys: 'Cmd+C', action: 'copyRedmineUrl', enabled: true },
    { id: 'search', keys: '/', action: 'search', enabled: true },
    { id: 'create', keys: 'N', action: 'createIssue', enabled: true },
    { id: 'command-palette', keys: 'Mod+K', action: 'commandPalette', enabled: true },
    { id: 'copy-branch', keys: 'Mod+Shift+C', action: 'copyBranch', enabled: true },
    { id: 'move-status', keys: 'S', action: 'moveStatus', enabled: true },
    { id: 'save-form', keys: 'Mod+S', action: 'saveForm', enabled: true },
    ...navigationShortcuts,
  ],
  savedViews: [],
  sort: { field: 'priority', direction: 'desc' },
  automationEnabled: true,
  pollIntervalSeconds: 30,
};

export function parseSettings(value: unknown): AppSettings {
  return settingsSchema.parse(value);
}

export function parseSettingsPatch(value: unknown): SettingsPatch {
  return settingsPatchSchema.parse(value) as SettingsPatch;
}

export function applySettingsPatch(current: AppSettings, patch: SettingsPatch): AppSettings {
  const { projectQa, subscriptions, projectActivity, projectBackgrounds, personRoleOverrides, personAvatarOverrides, ...shallowFields } = patch;
  const next: AppSettings = { ...current, ...shallowFields };

  if (projectQa) {
    next.projectQa = { ...current.projectQa };
    for (const [projectId, personId] of Object.entries(projectQa)) {
      if (personId === null) delete next.projectQa[projectId];
      else next.projectQa[projectId] = personId;
    }
  }
  if (subscriptions) {
    next.subscriptions = { ...current.subscriptions };
    for (const [projectId, subscription] of Object.entries(subscriptions)) {
      if (subscription === null) delete next.subscriptions[projectId];
      else next.subscriptions[projectId] = subscription;
    }
  }
  if (projectActivity) {
    next.projectActivity = { ...current.projectActivity };
    for (const [projectId, visibility] of Object.entries(projectActivity)) {
      if (visibility === null) delete next.projectActivity[projectId];
      else next.projectActivity[projectId] = visibility;
    }
  }
  if (projectBackgrounds) {
    next.projectBackgrounds = { ...current.projectBackgrounds };
    for (const [projectId, url] of Object.entries(projectBackgrounds)) {
      if (url === null) delete next.projectBackgrounds[projectId];
      else next.projectBackgrounds[projectId] = url;
    }
  }
  if (personRoleOverrides) {
    next.personRoleOverrides = structuredClone(current.personRoleOverrides);
    for (const [projectId, overrides] of Object.entries(personRoleOverrides)) {
      if (overrides === null) {
        delete next.personRoleOverrides[projectId];
        continue;
      }
      const projectOverrides = { ...(next.personRoleOverrides[projectId] ?? {}) };
      for (const [personId, roles] of Object.entries(overrides)) {
        if (roles === null) delete projectOverrides[personId];
        else projectOverrides[personId] = [...new Set(roles)];
      }
      if (Object.keys(projectOverrides).length) next.personRoleOverrides[projectId] = projectOverrides;
      else delete next.personRoleOverrides[projectId];
    }
  }
  if (personAvatarOverrides) {
    next.personAvatarOverrides = { ...current.personAvatarOverrides };
    for (const [personId, override] of Object.entries(personAvatarOverrides)) {
      if (override === null) delete next.personAvatarOverrides[personId];
      else next.personAvatarOverrides[personId] = override;
    }
  }
  return settingsSchema.parse(next);
}
