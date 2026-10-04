import { describe, expect, it } from 'vitest';
import { faviconDataUrl, updateFavicon } from './favicon';

describe('unread favicon', () => {
  it('removes the badge at zero and restores it when a new event arrives', () => {
    const svg = (count: number) => decodeURIComponent(faviconDataUrl(count).split(',')[1]);
    expect(svg(2)).toContain('>2</text>');
    expect(svg(1)).toContain('>1</text>');
    expect(svg(0)).not.toContain('<text');
    expect(svg(1)).toContain('>1</text>');
    expect(svg(100)).toContain('>9+</text>');
    expect(svg(-1)).not.toContain('<text');
    expect(svg(Infinity)).not.toContain('<text');
  });

  it('replaces all stale icon candidates rather than leaving another badge selected', () => {
    const removed: unknown[] = [];
    const appended: unknown[] = [];
    const icon = { dataset: {}, setAttribute() {} };
    const document = {
      createElement: () => icon,
      querySelectorAll: () => [1, 2].map(value => ({ remove: () => removed.push(value) })),
      head: { append: (value: unknown) => appended.push(value) },
    } as unknown as Document;
    updateFavicon(document, 0);
    expect(removed).toEqual([1, 2]);
    expect(appended).toEqual([icon]);
    expect(icon.dataset).toEqual({ unread: '0' });
  });
});
