import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import SQLite from 'better-sqlite3';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { appRoot } from '../config.js';
import { migrations } from './migrations/index.js';
import type { Database } from './schema.js';

/*
 * The database. One Kysely instance, either SQLite (small installs, dev) or Postgres (large installs),
 * chosen by DATABASE_URL. Migrations are portable, so the same schema runs on both, and db:copy moves
 * data between them.
 */

export type Db = Kysely<Database>;
export type Backend = 'sqlite' | 'postgres';

/** Which backend a URL means, without opening it. */
export function backendOf(url: string): Backend {
  if (url.startsWith('sqlite:')) return 'sqlite';
  if (/^postgres(ql)?:\/\//.test(url)) return 'postgres';
  throw new Error(`DATABASE_URL must start with sqlite: or postgres:// (got "${url.split(':')[0]}:")`);
}

/** Open a database from a URL. Doesn't migrate; see migrate(). */
export function openDb(url: string): Db {
  if (backendOf(url) === 'sqlite') {
    const target = url.slice('sqlite:'.length);
    let file = target;
    if (target !== ':memory:') {
      file = isAbsolute(target) ? target : join(appRoot, target);
      mkdirSync(dirname(file), { recursive: true });
    }
    const sqlite = new SQLite(file);
    sqlite.pragma('journal_mode = WAL'); // readers don't block the writer
    sqlite.pragma('foreign_keys = ON');
    return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  }
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  // An idle connection dropping (Postgres restarted, network blip) is emitted here; unhandled, it would
  // crash the bot. The pool replaces the connection on the next query, so a warning is enough.
  pool.on('error', (error) => onPoolError(error));
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

// Set by index.ts to the core logger; console until then (db:copy, tests). The logger imports settings,
// which import this file, so it can't be imported here.
let onPoolError = (error: Error) => console.warn('Database connection error (the pool will reconnect):', error.message);
export const setPoolErrorHandler = (fn: (error: Error) => void) => void (onPoolError = fn);

/** Apply every pending migration. Throws (with the failing migration's name) if one fails. */
export async function migrate(db: Db): Promise<string[]> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
  const { error, results } = await migrator.migrateToLatest();
  const failed = results?.find((r) => r.status === 'Error');
  if (error || failed) {
    throw new Error(`Migration ${failed?.migrationName ?? '(unknown)'} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

/** A URL safe to log: the password is hidden. */
export const describeUrl = (url: string) => url.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');

// ---- The bot's database (opened once at startup) --------------------------------------------------

let current: Db | null = null;

/** Open and migrate the bot's database. Call once, before anything uses it. */
export async function initDb(url: string) {
  current = openDb(url);
  const applied = await migrate(current);
  return { backend: backendOf(url), applied };
}

/** The bot's database. Throws if initDb() hasn't run. */
export function db(): Db {
  if (!current) throw new Error('Database not initialised (initDb was not called)');
  return current;
}

export async function closeDb() {
  await current?.destroy();
  current = null;
}

/** For tests: use an already-open database as the bot's database. */
export function setDb(instance: Db | null) {
  current = instance;
}
