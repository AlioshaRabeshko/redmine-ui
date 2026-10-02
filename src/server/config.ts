import { config as loadDotEnv } from 'dotenv';

loadDotEnv({ override: false, quiet: true });

export type AppModeSetting = 'auto' | 'demo' | 'redmine';
export interface AppConfig {
  mode: 'demo' | 'redmine';
  modeSetting: AppModeSetting;
  token?: string;
  tokenConfigured: boolean;
  redmineUrl: string;
  databasePath: string;
  scope: string;
  host: string;
  port: number;
  pollIntervalSeconds: number;
  configurationError?: string;
}

export interface ConfigInput {
  APP_MODE?: string;
  REDMINE_URL?: string;
  REDMINE_API_TOKEN?: string;
  DATABASE_PATH?: string;
  HOST?: string;
  PORT?: string | number;
  POLL_INTERVAL_SECONDS?: string | number;
}

export function createConfig(input: ConfigInput = process.env): AppConfig {
  const modeSetting = (input.APP_MODE ?? 'auto').toLowerCase();
  if (modeSetting !== 'auto' && modeSetting !== 'demo' && modeSetting !== 'redmine') {
    throw new Error('APP_MODE must be auto, demo, or redmine.');
  }
  const token = input.REDMINE_API_TOKEN?.trim() || undefined;
  const mode = modeSetting === 'auto' ? (token ? 'redmine' : 'demo') : modeSetting;
  const requestedUrl = input.REDMINE_URL ?? 'https://redmine.example.invalid';
  let redmineUrl = 'https://invalid-redmine-url.local';
  let configurationError: string | undefined;
  let instanceKey = 'unconfigured';
  try {
    const parsed = new URL(requestedUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('REDMINE_URL must be an HTTP(S) base URL without credentials, query, or fragment.');
    }
    redmineUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
    instanceKey = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch (error) {
    configurationError = error instanceof Error && error.message.startsWith('REDMINE_URL')
      ? error.message : 'REDMINE_URL must be a valid HTTP(S) base URL.';
  }
  const db = input.DATABASE_PATH ?? './data/workspace.sqlite';
  const port = Number(input.PORT ?? 3000);
  const pollIntervalSeconds = Number(input.POLL_INTERVAL_SECONDS ?? 30);
  return {
    mode,
    modeSetting,
    token,
    tokenConfigured: Boolean(token),
    redmineUrl,
    databasePath: db,
    scope: mode === 'demo' ? 'demo:isolated' : `redmine:${instanceKey}`,
    host: input.HOST ?? '127.0.0.1',
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 3000,
    pollIntervalSeconds: Number.isFinite(pollIntervalSeconds) && pollIntervalSeconds >= 5 ? pollIntervalSeconds : 30,
    configurationError,
  };
}
