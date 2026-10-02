import { describe, expect, it } from 'vitest';
import { MAX_PROJECT_BACKGROUND_BYTES, validateProjectBackgroundFile } from './projectBackgroundUpload';

describe('project background image validation', () => {
  it('accepts supported image types up to and including 5 MiB', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(validateProjectBackgroundFile({ type, size: MAX_PROJECT_BACKGROUND_BYTES } as File)).toBeUndefined();
    }
  });

  it('rejects files larger than 5 MiB and unsupported formats', () => {
    expect(validateProjectBackgroundFile({ type: 'image/png', size: MAX_PROJECT_BACKGROUND_BYTES + 1 } as File)).toBe('projectBackgroundTooLarge');
    expect(validateProjectBackgroundFile({ type: 'image/gif', size: 100 } as File)).toBe('projectBackgroundUnsupportedType');
  });
});
