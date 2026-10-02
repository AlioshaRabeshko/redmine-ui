import type { Shortcut } from './types.js';

export const navigationShortcuts: Shortcut[] = [
  { id: 'toggle-sidebar', keys: 'Mod+B', action: 'toggleSidebar', enabled: true },
  { id: 'open-inbox', keys: 'Shift+I', action: 'openInbox', enabled: true },
  { id: 'open-settings', keys: 'Shift+P', action: 'openSettings', enabled: true },
];

export function normalizeShortcutKeys(keys: string): string {
  const parts = [...new Set(keys.trim().split('+').map((part) => {
    const value = part.trim();
    const lower = value.toLowerCase();
    if (['mod', 'meta', 'cmd', 'command', 'ctrl', 'control'].includes(lower)) return 'Mod';
    if (lower === 'alt' || lower === 'option') return 'Alt';
    if (lower === 'shift') return 'Shift';
    if (lower.length === 1) return lower.toUpperCase();
    return value;
  }).filter(Boolean))];
  return parts.sort((a, b) => (a === 'Mod' ? -1 : b === 'Mod' ? 1 : a === 'Alt' ? -1 : b === 'Alt' ? 1 : a === 'Shift' ? -1 : b === 'Shift' ? 1 : a.localeCompare(b))).join('+');
}

