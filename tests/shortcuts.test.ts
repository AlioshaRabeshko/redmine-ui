import { describe, expect, it } from 'vitest';
import { normalizeShortcutKeys, resolveIssueShortcutTarget, shortcutForEvent } from '../src/client/lib/shortcuts.js';
import type { Shortcut } from '../src/shared/types.js';

const shortcut = (keys: string): Shortcut => ({ id: 'test', keys, action: 'test', enabled: true });
const event = (patch: Partial<KeyboardEvent>): KeyboardEvent => ({ key: 'q', code: 'KeyQ', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...patch }) as KeyboardEvent;

describe('configurable keyboard shortcuts', () => {
  it('canonicalizes aliases/order and duplicate modifiers to prevent hidden conflicts', () => {
    expect(normalizeShortcutKeys(' shift + cmd + c ')).toBe('Mod+Shift+C');
    expect(normalizeShortcutKeys('Ctrl+Shift+C')).toBe('Mod+Shift+C');
    expect(normalizeShortcutKeys('Mod+Cmd+K')).toBe('Mod+K');
  });
  it('keeps Q/B working with the Ukrainian layout', () => {
    expect(shortcutForEvent(shortcut('Q'), event({ key: 'й', code: 'KeyQ' }))).toBe(true);
    expect(shortcutForEvent(shortcut('B'), event({ key: 'и', code: 'KeyB' }))).toBe(true);
    expect(shortcutForEvent(shortcut('Q'), event({ key: 'й', code: 'KeyQ', ctrlKey: true }))).toBe(false);
  });
  it('matches portable command modifiers without grabbing unrelated combinations', () => {
    expect(shortcutForEvent(shortcut('Cmd+C'), event({ key: 'c', code: 'KeyC', metaKey: true }))).toBe(true);
    expect(shortcutForEvent(shortcut('Cmd+C'), event({ key: 'c', code: 'KeyC', ctrlKey: true }))).toBe(true);
    expect(shortcutForEvent(shortcut('Cmd+C'), event({ key: 'c', code: 'KeyC', metaKey: true, shiftKey: true }))).toBe(false);
  });
  it('supports a concrete label shortcut using a shifted digit', () => {
    expect(shortcutForEvent(shortcut('Alt+Shift+1'), event({ key: '!', code: 'Digit1', altKey: true, shiftKey: true }))).toBe(true);
  });
  it('uses the focused card after closing an issue and never falls back behind another modal', () => {
    expect(resolveIssueShortcutTarget({ hasModal: false, focusedCardIssueId: 1004 })).toBe(1004);
    expect(resolveIssueShortcutTarget({ hasModal: true, modalIssueId: 1006, focusedCardIssueId: 1004 })).toBe(1006);
    expect(resolveIssueShortcutTarget({ hasModal: true, focusedCardIssueId: 1004 })).toBeUndefined();
  });
  it('matches the explicit save-form shortcut on both command platforms', () => {
    expect(shortcutForEvent(shortcut('Mod+S'), event({ key: 's', code: 'KeyS', metaKey: true }))).toBe(true);
    expect(shortcutForEvent(shortcut('Mod+S'), event({ key: 's', code: 'KeyS', ctrlKey: true }))).toBe(true);
  });
});
