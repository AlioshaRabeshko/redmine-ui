import { describe, expect, it } from 'vitest';
import type { Person } from '../src/shared/types.js';
import { defaultSettings } from '../src/server/settings.js';
import { projectPerson } from '../src/server/people.js';

describe('project person projection', () => {
  it('rebuilds roles from the requested project and does not carry another project’s role fields', () => {
    const person: Person = {
      id: 17, name: 'login-style', avatar: 'https://redmine.example/avatar/17',
      roles: ['support'], redmineRoles: [{ id: 3, name: 'Support' }],
    };
    const settings = structuredClone(defaultSettings);
    const inQaProject = projectPerson(person, 10, {
      membershipIds: new Set([17]), membershipRoles: { '17': [{ id: 1, name: 'Quality Assurance' }] },
    }, settings);
    const inDevProject = projectPerson(person, 20, {
      membershipIds: new Set([17]), membershipRoles: { '17': [{ id: 2, name: 'Developer' }] },
    }, settings);

    expect(inQaProject.roles).toEqual(['qa']);
    expect(inQaProject.redmineRoles).toEqual([{ id: 1, name: 'Quality Assurance' }]);
    expect(inDevProject.roles).toEqual(['developer']);
    expect(inDevProject.redmineRoles).toEqual([{ id: 2, name: 'Developer' }]);
  });

  it('applies an explicit project override even when Redmine has no membership record', () => {
    const settings = structuredClone(defaultSettings);
    settings.personRoleOverrides['10'] = { '17': ['support'] };
    const person: Person = { id: 17, name: 'Outside member', roles: ['qa'], redmineRoles: [{ id: 2, name: 'QA' }] };
    const projected = projectPerson(person, 10, { membershipIds: new Set(), membershipRoles: {} }, settings);

    expect(projected.roles).toEqual(['support']);
    expect(projected.redmineRoles).toBeUndefined();
  });

  it('applies one local avatar override across projects while leaving role frames project-specific', () => {
    const settings = structuredClone(defaultSettings);
    settings.personAvatarOverrides['17'] = { kind: 'photo', url: '/api/people/17/avatar?v=4aa7f23e-145f-4a39-a151-7b46df2bd23d' };
    settings.personRoleOverrides['10'] = { '17': ['qa'] };
    const person: Person = { id: 17, name: 'Same person', avatar: 'https://redmine.example/avatar/17' };
    const project10 = projectPerson(person, 10, { membershipIds: new Set(), membershipRoles: {} }, settings);
    const project20 = projectPerson(person, 20, { membershipIds: new Set(), membershipRoles: {} }, settings);

    expect(project10.avatar).toBe(settings.personAvatarOverrides['17']?.kind === 'photo' ? settings.personAvatarOverrides['17'].url : undefined);
    expect(project10.roles).toEqual(['qa']);
    expect(project20.roles).toBeUndefined();
    expect(project20.avatar).toBe(project10.avatar);

    settings.personAvatarOverrides['17'] = { kind: 'emoji', emoji: '👨‍👩‍👧‍👦' };
    const emojiPerson = projectPerson(person, 20, { membershipIds: new Set(), membershipRoles: {} }, settings);
    expect(emojiPerson.avatar).toBeUndefined();
    expect(emojiPerson.localEmoji).toBe('👨‍👩‍👧‍👦');
  });
});
