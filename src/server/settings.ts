import { z } from 'zod';
import type { AppSettings } from '../shared/types.js';

const settingsSchema = z.object({
  locale: z.enum(['uk', 'pl', 'es', 'en']),
  theme: z.enum(['light', 'dark', 'system']),
  palette: z.enum(['blue', 'violet', 'green', 'amber']),
  projectQa: z.record(z.string(), z.number().int().positive()),
  subscriptions: z.record(z.string(), z.object({ enabled: z.boolean(), events: z.array(z.string()) })),
  shortcuts: z.array(z.object({ id: z.string(), keys: z.string(), action: z.string(), value: z.string().optional(), enabled: z.boolean() })),
  savedViews: z.array(z.object({ id: z.string(), projectId: z.number().int().positive(), name: z.string(), filters: z.object({
    search: z.string().optional(), assigneeId: z.number().int().optional(), label: z.string().optional(),
    statusIds: z.array(z.number().int()).optional(), priorityIds: z.array(z.number().int()).optional(),
    versionId: z.number().int().optional(), includeClosed: z.boolean().optional(),
  }), view: z.enum(['all', 'mine', 'watching', 'backlog']) })),
  sort: z.object({ field: z.enum(['priority', 'updated', 'created', 'id', 'subject']), direction: z.enum(['asc', 'desc']) }),
  automationEnabled: z.boolean(),
  pollIntervalSeconds: z.number().int().min(5).max(3600),
});

export const defaultSettings: AppSettings = {
  locale: 'uk',
  theme: 'system',
  palette: 'blue',
  projectQa: {},
  subscriptions: {},
  shortcuts: [
    { id: 'mine', keys: 'Q', action: 'view', value: 'mine', enabled: true },
    { id: 'project', keys: 'B', action: 'projectPicker', enabled: true },
    { id: 'copy-redmine-url', keys: 'Cmd+C', action: 'copyRedmineUrl', enabled: true },
    { id: 'search', keys: '/', action: 'search', enabled: true },
    { id: 'create', keys: 'N', action: 'createIssue', enabled: true },
    { id: 'command-palette', keys: 'Mod+K', action: 'commandPalette', enabled: true },
    { id: 'copy-branch', keys: 'Mod+Shift+C', action: 'copyBranch', enabled: true },
    { id: 'move-status', keys: 'S', action: 'moveStatus', enabled: true },
  ],
  savedViews: [],
  sort: { field: 'priority', direction: 'desc' },
  automationEnabled: true,
  pollIntervalSeconds: 30,
};

export function parseSettings(value: unknown): AppSettings {
  return settingsSchema.parse(value);
}
