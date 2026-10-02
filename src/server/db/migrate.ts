import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createConfig } from '../config.js';
import { openDatabase, type AppDatabase } from './connection.js';

export async function applyMigrations(db: AppDatabase, migrationsFolder = resolve(process.cwd(), 'drizzle')): Promise<void> {
  await migrate(db, { migrationsFolder });
}

export async function migrateDatabase(databasePath = createConfig().databasePath, migrationsFolder = resolve(process.cwd(), 'drizzle')): Promise<void> {
  const { db, close } = openDatabase(databasePath);
  try { await applyMigrations(db, migrationsFolder); }
  finally { close(); }
}

if (process.argv[1]?.endsWith('/migrate.ts') || process.argv[1]?.endsWith('/migrate.js')) {
  migrateDatabase().catch(error => {
    process.stderr.write(`Database migration failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
