import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'], testTimeout: 15_000 },
});
