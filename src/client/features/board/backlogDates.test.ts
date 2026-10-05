import { describe, expect, it } from 'vitest';
import { backlogExactDate, backlogRelativeDate } from './BacklogList';

describe('backlog date labels', () => {
  const locales = ['uk', 'pl', 'es', 'en'];
  const value = '2026-10-05T09:17:00.000Z';

  it.each(locales)('formats exact timestamps with the %s locale for the tooltip', locale => {
    expect(backlogExactDate(value, locale)).toBe(new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)));
  });

  it.each(locales)('formats relative timestamps with the %s locale', locale => {
    const now = Date.parse('2026-10-05T09:18:00.000Z');
    expect(backlogRelativeDate(value, locale, now)).toBe(new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-1, 'minute'));
  });

  it('keeps invalid API timestamps from breaking the row', () => {
    expect(backlogExactDate('not-a-date', 'en')).toBe('—');
    expect(backlogRelativeDate('not-a-date', 'en', Date.now())).toBe('—');
  });
});
