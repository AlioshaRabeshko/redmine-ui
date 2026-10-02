import type { Shortcut } from '../../shared/types';
import { navigationShortcuts, normalizeShortcutKeys } from '../../shared/shortcuts';
export { normalizeShortcutKeys } from '../../shared/shortcuts';

export const defaultShortcuts: Shortcut[] = [
  { id: 'mine', keys: 'Q', action: 'view/mine', enabled: true },
  { id: 'project', keys: 'B', action: 'projectPicker', enabled: true },
  { id: 'copy-url', keys: 'Mod+C', action: 'copyRedmineUrl', enabled: true },
  { id: 'search', keys: '/', action: 'search', enabled: true },
  { id: 'create', keys: 'N', action: 'createIssue', enabled: true },
  { id: 'palette', keys: 'Mod+K', action: 'commandPalette', enabled: true },
  { id: 'copy-branch', keys: 'Mod+Shift+C', action: 'copyBranch', enabled: true },
  { id: 'move-status', keys: 'S', action: 'moveStatus', enabled: true },
  { id: 'save-form', keys: 'Mod+S', action: 'saveForm', enabled: true },
  ...navigationShortcuts,
];

export function shortcutForEvent(shortcut: Shortcut, event: KeyboardEvent): boolean {
  if (!shortcut.enabled || !shortcut.keys.trim()) return false;
  const expected = normalizeShortcutKeys(shortcut.keys).split('+');
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const needsMod = expected.includes('Mod');
  const needsAlt = expected.includes('Alt');
  const needsShift = expected.includes('Shift');
  const keyParts = expected.filter((part) => !['Mod', 'Alt', 'Shift'].includes(part));
  const actualMod = event.metaKey || event.ctrlKey;
  const requestedKey = keyParts[0];
  const physicalKey = requestedKey?.length === 1 && /^[A-Z]$/.test(requestedKey)
    ? event.code === `Key${requestedKey}`
    : requestedKey?.length === 1 && /^\d$/.test(requestedKey)
      ? event.code === `Digit${requestedKey}` || event.code === `Numpad${requestedKey}`
      : false;
  return keyParts.length === 1 && (physicalKey || requestedKey.toLowerCase() === key.toLowerCase())
    && needsMod === actualMod && needsAlt === event.altKey && needsShift === event.shiftKey;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const element = target as HTMLElement;
  return element.isContentEditable || !!element.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
}

/** A visible top dialog owns issue shortcuts; otherwise use the currently focused board card. */
export function resolveIssueShortcutTarget(context: { hasModal: boolean; modalIssueId?: number; focusedCardIssueId?: number }): number | undefined {
  if (context.hasModal) return context.modalIssueId;
  return context.focusedCardIssueId;
}
