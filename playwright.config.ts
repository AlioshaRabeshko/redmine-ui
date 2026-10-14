import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure' },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1600, height: 1000 } } }],
  webServer: {
    command: 'npm run start',
    url: 'http://127.0.0.1:3100/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      APP_MODE: 'demo', REDMINE_API_TOKEN: '', REDMINE_WRITE_ENABLED: 'false', PORT: '3100', HOST: '127.0.0.1',
      // Keep the automation fixture independent of any user-configured labels.
      REDMINE_CI_IN_PROGRESS_LABEL: 'Build: Running', REDMINE_CI_FAILED_LABEL: 'Build: Failed',
      DATABASE_PATH: join(tmpdir(), `redmine-ui-e2e-${process.pid}.sqlite`),
    },
  },
});
