import type { Issue, Journal, Person, Priority, Project, Status, Version } from '../../shared/types.js';

const now = new Date().toISOString();
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

export const demoMe: Person = { id: 1, name: 'Example Person C' };
export const demoPeople: Person[] = [
  demoMe,
  { id: 2, name: 'Example Person B Мельник' },
  { id: 3, name: 'Example Person A Савчук' },
  { id: 4, name: 'Марія Бондар' },
  { id: 5, name: 'Ігор Шевченко' },
];

export const demoProjects: Project[] = [
  { id: 10, name: 'Core API', identifier: 'core-api', description: 'API та сервісні інтеграції', trackers: [
    { id: 1, name: 'Feature' }, { id: 2, name: 'Bug' }, { id: 3, name: 'Task' },
  ] },
  { id: 20, name: 'Example Project', identifier: 'example-project', description: 'Демонстраційний проєкт', trackers: [
    { id: 1, name: 'Feature' }, { id: 2, name: 'Bug' }, { id: 3, name: 'Task' },
  ] },
];

export const demoStatuses: Status[] = [
  { id: 1, name: 'Suspended', key: 'suspended', isClosed: false },
  { id: 2, name: 'To Do', key: 'todo', isClosed: false },
  { id: 3, name: 'In Progress', key: 'progress', isClosed: false },
  { id: 4, name: 'Review', key: 'review', isClosed: false },
  { id: 5, name: 'QA', key: 'qa', isClosed: false },
  { id: 6, name: 'Deploy', key: 'deploy', isClosed: false },
  { id: 7, name: 'Done', key: 'done', isClosed: true },
  { id: 8, name: 'Rejected', key: 'rejected', isClosed: true },
  { id: 9, name: 'Backlog', key: 'backlog', isClosed: false },
];

export const demoPriorities: Priority[] = [
  { id: 1, name: 'Low', rank: 1 },
  { id: 2, name: 'Normal', rank: 2 },
  { id: 3, name: 'High', rank: 3 },
  { id: 4, name: 'Urgent', rank: 4 },
];

export const demoVersions: Version[] = [
  { id: 100, projectId: 10, name: 'NEXT', status: 'open', description: 'Наступний цикл' },
  { id: 101, projectId: 10, name: '2026.10 Core', status: 'open', dueDate: day(12), description: 'Жовтневий реліз Core API' },
  { id: 99, projectId: 10, name: '2026.09 Core', status: 'closed', dueDate: day(-8) },
  { id: 200, projectId: 20, name: 'NEXT', status: 'open', description: 'Наступний цикл' },
  { id: 201, projectId: 20, name: 'Example Release', status: 'open', dueDate: day(18), description: 'Підготовка версії 4.8' },
  { id: 198, projectId: 20, name: 'Example Release', status: 'closed', dueDate: day(-20) },
];

function issue(
  id: number, projectId: number, subject: string, statusId: number, priorityId: number,
  assignedToId: number | undefined, fixedVersionId: number | undefined, labels: string[],
  developerId?: number, qaId?: number, extras: Partial<Issue> = {},
): Issue {
  const personIds = [demoMe.id, 2, 3, 4, 5];
  return {
    id, projectId, subject, description: `${subject}. Демодані для перевірки швидкої роботи з картками.`,
    statusId, priorityId, trackerId: 1, trackerName: 'Feature', authorId: id % 2 === 0 ? 2 : 4,
    assignedToId, developerId, qaId, fixedVersionId,
    branch: `${id}-${subject.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')}`,
    labels, watcherIds: [demoMe.id, personIds[id % personIds.length]],
    createdOn: new Date(Date.now() - (id % 45 + 2) * 86_400_000).toISOString(),
    updatedOn: new Date(Date.now() - (id % 9) * 3_600_000).toISOString(),
    attachments: [], ...extras,
  };
}

export const demoIssues: Issue[] = [
  issue(1001, 10, 'Retry webhook deliveries with jitter', 4, 4, 2, 100, ['api', 'Build: Running'], 2, 3),
  issue(1002, 10, 'Expose idempotency key in request logs', 5, 3, 3, 101, ['observability', 'Build: Succeeded'], 2, 3),
  issue(1003, 10, 'Migrate payment routes to v3 schema', 6, 4, 2, 101, ['payments', 'Build: Succeeded'], 2, 3),
  issue(1004, 10, 'Document rate limits for partner API', 2, 2, 2, undefined, ['docs'], 2, 3),
  issue(1005, 10, 'Add request correlation IDs', 3, 3, 2, undefined, ['api', 'Build: Running'], 2, 3),
  issue(1006, 10, 'Investigate duplicate settlement event', 1, 4, 4, undefined, ['payments', 'incident'], 5, 3),
  issue(1007, 10, 'Cache customer capability response', 9, 2, undefined, undefined, ['performance'], undefined, 3),
  issue(1008, 10, 'Add timeout metrics for gateway calls', 4, 3, 2, 100, ['observability', 'Build: Failed'], 2, 3),
  issue(1009, 10, 'Verify settlement replay handling', 5, 2, 3, 101, ['payments'], 5, 3),
  issue(1010, 10, 'Replace legacy signing helper', 7, 3, 2, 99, ['security', 'Build: Succeeded'], 2, 3),
  issue(1011, 10, 'Remove deprecated callback option', 8, 1, 5, undefined, ['cleanup'], 5, 3),
  issue(1012, 10, 'Record webhook delivery attempt count', 6, 2, 2, 101, ['api', 'Build: Failed'], 2, 3),
  issue(2001, 20, 'Show settlement status in activity feed', 4, 4, 5, 200, ['payments', 'Build: Running'], 5, 3),
  issue(2002, 20, 'Allow finance users to export CSV', 5, 3, 3, 201, ['reporting'], 4, 3),
  issue(2003, 20, 'Add saved filters to transactions page', 3, 3, 4, undefined, ['ux', 'Build: Running'], 4, 3),
  issue(2004, 20, 'Improve empty state for invoices', 2, 2, 4, undefined, ['ux'], 4, 3),
  issue(2005, 20, 'Add payout schedule preview', 6, 4, 5, 201, ['payouts', 'Build: Succeeded'], 5, 3),
  issue(2006, 20, 'Fix timezone display in audit history', 4, 3, 4, 200, ['bug', 'Build: Failed'], 4, 3),
  issue(2007, 20, 'Review new card verification flow', 9, 2, undefined, undefined, ['cards'], undefined, 3),
  issue(2008, 20, 'Enable archived payout download', 7, 2, 4, 198, ['payouts', 'Build: Succeeded'], 4, 3),
];

export const demoProjectMembers: Record<string, number[]> = { '10': [1, 2, 3, 4, 5], '20': [1, 3, 4, 5] };

export const demoJournals: Journal[] = [
  { id: 9001, user: demoPeople[1]!, notes: 'Додав повторну доставку з jitter; прошу перевірити edge cases.', createdOn: new Date(Date.now() - 70 * 60_000).toISOString(), changes: [{ field: 'status', oldValue: 'In Progress', newValue: 'Review' }] },
  { id: 9002, user: demoPeople[2]!, notes: 'Перевірила сценарій повторного webhook. Є одне уточнення щодо backoff.', createdOn: new Date(Date.now() - 42 * 60_000).toISOString(), changes: [] },
  { id: 9003, user: demoPeople[4]!, notes: 'Готово до deploy після оновлення графіків.', createdOn: new Date(Date.now() - 18 * 60_000).toISOString(), changes: [{ field: 'status', oldValue: 'QA', newValue: 'Deploy' }] },
];

export const demoJournalIssues: Record<string, number> = { '9001': 1001, '9002': 1001, '9003': 2005 };
export const demoNow = now;
