import { describe, expect, it } from 'vitest';
import type { Person } from '../../shared/types';
import { mergePeopleById } from './peoplePresentation';

describe('issue people presentation', () => {
  it('keeps project roles when a later issue payload has only a basic person record', () => {
    const members: Person[] = [{ id: 114, name: 'A. Example', roles: ['qa'], redmineRoles: [{ id: 3, name: 'QA' }] }];
    const detail: Person[] = [{ id: 114, name: 'Alex Example' }];

    expect(mergePeopleById([...members], detail)).toMatchObject([{ id: 114, name: 'Alex Example', roles: ['qa'], redmineRoles: [{ id: 3, name: 'QA' }] }]);
  });

  it('keeps explicit empty role overrides and gives local avatars priority over remote snapshots', () => {
    const merged = mergePeopleById(
      [{ id: 7, name: 'Person', roles: ['developer'], avatar: '/api/people/7/avatar?v=local-1' }],
      [{ id: 7, name: 'Person', roles: [], avatar: 'https://redmine.test/avatar/7' }],
    );
    expect(merged[0]).toMatchObject({ roles: [], avatar: '/api/people/7/avatar?v=local-1' });
  });

  it('lets a local emoji avatar suppress a stale remote photo', () => {
    const merged = mergePeopleById(
      [{ id: 8, name: 'Person', avatar: 'https://redmine.test/avatar/8' }],
      [{ id: 8, name: 'Person', localEmoji: '🦊' }],
    );
    expect(merged[0]).toMatchObject({ localEmoji: '🦊' });
    expect(merged[0]?.avatar).toBeUndefined();
  });

  it('lets a newly projected local photo replace a stale emoji snapshot', () => {
    const merged = mergePeopleById(
      [{ id: 9, name: 'Person', localEmoji: '🦊' }],
      [{ id: 9, name: 'Person', avatar: '/api/people/9/avatar?v=local-2' }],
    );
    expect(merged[0]).toMatchObject({ avatar: '/api/people/9/avatar?v=local-2' });
    expect(merged[0]?.localEmoji).toBeUndefined();
  });
});
