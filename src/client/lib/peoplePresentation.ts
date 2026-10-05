import type { Person } from '../../shared/types';

/** Merge API snapshots without letting a sparse issue payload erase project roles or local avatar overrides. */
export function mergePeopleById(...groups: Person[][]): Person[] {
  const people = new Map<number, Person>();
  for (const group of groups) {
    for (const person of group) {
      const previous = people.get(person.id);
      if (!previous) { people.set(person.id, person); continue; }
      const incomingLocalPhoto = person.avatar?.startsWith('/api/people/') === true;
      const previousLocalPhoto = previous.avatar?.startsWith('/api/people/') === true;
      const localEmoji = incomingLocalPhoto ? undefined : person.localEmoji ?? (previousLocalPhoto ? undefined : previous.localEmoji);
      const avatar = incomingLocalPhoto ? person.avatar
        : person.localEmoji ? undefined
          : previousLocalPhoto ? previous.avatar
            : previous.localEmoji ? undefined
              : person.avatar ?? previous.avatar;
      people.set(person.id, {
        ...previous,
        ...person,
        avatar,
        localEmoji,
        roles: person.roles ?? previous.roles,
        redmineRoles: person.redmineRoles ?? previous.redmineRoles,
        isAdmin: person.isAdmin ?? previous.isAdmin,
      });
    }
  }
  return [...people.values()];
}
