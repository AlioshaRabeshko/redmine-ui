import type { AppSettings, Person, PersonRole, RedmineRole } from '../shared/types.js';

export interface ProjectPeopleRoles {
  membershipIds: ReadonlySet<number>;
  membershipRoles: Record<string, RedmineRole[]>;
}

function personRolesFromRedmine(redmineRoles: RedmineRole[]): PersonRole[] {
  const roles = new Set<PersonRole>();
  for (const role of redmineRoles) {
    const name = role.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
    if (/(^|\W)qa(\W|$)|quality\s*assurance|\btest(?:er|ing)\b/.test(name)) roles.add('qa');
    if (/(^|\W)support(\W|$)|help\s*desk/.test(name)) roles.add('support');
    if (/(^|\W)developer(?:s)?(\W|$)|\bdevelopment\b/.test(name)) roles.add('developer');
  }
  const orderedRoles: PersonRole[] = ['qa', 'support', 'developer'];
  return orderedRoles.filter(role => roles.has(role));
}

export function projectPerson(person: Person, projectId: number, roles: ProjectPeopleRoles, settings: AppSettings): Person {
  const { roles: _oldRoles, redmineRoles: _oldRedmineRoles, localEmoji: _oldEmoji, ...base } = person;
  const personId = String(person.id);
  const projectKey = String(projectId);
  const avatarOverride = settings.personAvatarOverrides[personId];
  if (avatarOverride?.kind === 'photo') base.avatar = avatarOverride.url;
  else if (avatarOverride?.kind === 'emoji') delete base.avatar;

  const redmineRoles = roles.membershipIds.has(person.id)
    ? roles.membershipRoles[personId] ?? []
    : [];
  const override = settings.personRoleOverrides[projectKey]?.[personId];
  const effectiveRoles = override ?? personRolesFromRedmine(redmineRoles);
  return {
    ...base,
    ...(avatarOverride?.kind === 'emoji' ? { localEmoji: avatarOverride.emoji } : {}),
    ...(redmineRoles.length ? { redmineRoles } : {}),
    ...(override !== undefined ? { roles: override } : effectiveRoles.length ? { roles: effectiveRoles } : {}),
  };
}

export function applyPersonAvatarOverride(person: Person, settings: AppSettings): Person {
  const { localEmoji: _oldEmoji, ...base } = person;
  const override = settings.personAvatarOverrides[String(person.id)];
  if (override?.kind === 'photo') return { ...base, avatar: override.url };
  if (override?.kind === 'emoji') {
    const { avatar: _avatar, ...withoutRemotePhoto } = base;
    return { ...withoutRemotePhoto, localEmoji: override.emoji };
  }
  return base;
}
