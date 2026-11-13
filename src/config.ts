import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * Bootstrap settings: what the bot needs before its database is open, plus anything that must never be
 * changed from chat. Read once from the environment; configure them in ../.env (see .env.example).
 * Everything else is a setting in the database (src/settings.ts), editable with !admin config.
 */

/**
 * Read an environment variable. NAME_FILE takes precedence and holds a path to a file with the value
 * (trimmed), which is how Docker/compose secrets are passed. Empty means unset.
 */
export function readEnv(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim() || undefined;
    } catch (error) {
      throw new Error(`${name}_FILE points at ${file}, which can't be read: ${(error as Error).message}`);
    }
  }
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** The app folder (where package.json lives), for resolving relative paths. */
export const appRoot = fileURLToPath(new URL('../', import.meta.url));

/** Bot token. Required. Secret: prefer FLUXER_BOT_TOKEN_FILE. */
export const token = readEnv('FLUXER_BOT_TOKEN') ?? '';

/** Self-hosted instance (bare hostname or URL); empty means fluxer.app. */
export const instance = readEnv('FLUXER_INSTANCE') ?? '';


/** Folder of plugins, loaded at runtime. Default: plugins/ in the app folder. */
export const pluginsDir = readEnv('PLUGINS_DIR') ?? fileURLToPath(new URL('../plugins/', import.meta.url));

/**
 * Database: `sqlite:<path>` (relative to the app folder; `sqlite::memory:` for tests) or a
 * `postgres://user:pass@host:5432/db` URL. Holds a password for Postgres, so prefer DATABASE_URL_FILE.
 */
export const databaseUrl = readEnv('DATABASE_URL') ?? 'sqlite:data/bitbot.db';
