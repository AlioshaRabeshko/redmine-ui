import { describe, expect, it } from 'vitest';
import i18n from '../src/client/app/i18n';

describe('supported interface languages', () => {
  const locales = ['uk', 'pl', 'es', 'en'];
  it('provides every base interface key without falling back to another language', () => {
    const english = i18n.getResourceBundle('en', 'translation');
    const keys = Object.keys(english).filter(key => !/_(one|few|many|other|zero|two)$/.test(key));
    for (const locale of locales) {
      const resource = i18n.getResourceBundle(locale, 'translation');
      expect(keys.filter(key => typeof resource[key] !== 'string'), locale).toEqual([]);
    }
  });
  it('provides locale-specific plural forms for issue counts', () => {
    for (const locale of locales) {
      const resource = i18n.getResourceBundle(locale, 'translation');
      for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
        expect(resource[`issueCount_${category}`], `${locale}: ${category}`).toBeTypeOf('string');
      }
    }
  });
});
