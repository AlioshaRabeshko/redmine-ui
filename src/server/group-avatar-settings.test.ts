import { describe, expect, it } from 'vitest';
import { applySettingsPatch, defaultSettings, parseSettings, parseSettingsPatch } from './settings.js';

const groupPhotoUrl = '/api/groups/2/avatar?v=4aa7f23e-145f-4a39-a151-7b46df2bd23d';

describe('group avatar settings', () => {
  it('accepts group-scoped settings while keeping the colliding person override separate', () => {
    const current = structuredClone(defaultSettings);
    current.personAvatarOverrides['2'] = { kind: 'emoji', emoji: '🙂' };
    const patch = parseSettingsPatch({ groupAvatarOverrides: { '2': { kind: 'photo', url: groupPhotoUrl } } });
    const next = applySettingsPatch(current, patch);

    expect(next.groupAvatarOverrides['2']).toEqual({ kind: 'photo', url: groupPhotoUrl });
    expect(next.personAvatarOverrides['2']).toEqual({ kind: 'emoji', emoji: '🙂' });
    expect(parseSettings(next).groupAvatarOverrides['2']).toEqual({ kind: 'photo', url: groupPhotoUrl });
  });

  it('rejects people routes, mismatched group IDs, and invalid emoji in the group map', () => {
    expect(() => parseSettingsPatch({ groupAvatarOverrides: { '2': { kind: 'photo', url: '/api/people/2/avatar?v=4aa7f23e-145f-4a39-a151-7b46df2bd23d' } } })).toThrow();
    expect(() => parseSettingsPatch({ groupAvatarOverrides: { '3': { kind: 'photo', url: groupPhotoUrl } } })).toThrow();
    expect(() => parseSettingsPatch({ groupAvatarOverrides: { '2': { kind: 'emoji', emoji: '🙂x' } } })).toThrow();
    expect(() => parseSettings({ ...structuredClone(defaultSettings), groupAvatarOverrides: { '2': { kind: 'photo', url: '/api/groups/3/avatar?v=4aa7f23e-145f-4a39-a151-7b46df2bd23d' } } })).toThrow();
  });

  it('allows clearing a group override without clearing a person with the same ID', () => {
    const current = {
      ...structuredClone(defaultSettings),
      personAvatarOverrides: { '2': { kind: 'emoji' as const, emoji: '🙂' } },
      groupAvatarOverrides: { '2': { kind: 'emoji' as const, emoji: '👥' } },
    };
    const next = applySettingsPatch(current, parseSettingsPatch({ groupAvatarOverrides: { '2': null } }));
    expect(next.groupAvatarOverrides).toEqual({});
    expect(next.personAvatarOverrides['2']).toEqual({ kind: 'emoji', emoji: '🙂' });
  });
});
