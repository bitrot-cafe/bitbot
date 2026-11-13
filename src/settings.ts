import { readEnv } from './config.js';
import { db } from './db/index.js';
import { NONE as GLOBAL } from './db/schema.js';
import { code } from './text.js';

/*
 * Settings: typed values, declared per scope ("core", or a plugin's short id), stored in the database
 * and editable from chat (!admin config).
 *
 * Resolution, highest wins: environment variable (or NAME_FILE) → the guild's value (perGuild settings
 * only) → the bot-wide value → declared default. A value set by env can't be changed from chat; remove it
 * from .env to manage it here instead. Secrets are env/file only: never stored, never settable from
 * chat, never shown.
 *
 * Env is read once, when a scope is declared (it's bootstrap configuration), and every stored row is
 * loaded into memory at startup, so reads are synchronous, cheap and can't throw.
 */

export type SettingType = 'string' | 'number' | 'boolean' | 'id' | 'url';
export type SettingValue = string | number | boolean;

export type SettingDef = {
  type: SettingType;
  description: string;
  default?: SettingValue;
  /** The plugin/core can't work without it. Shown as missing in !admin config and plugin info. */
  required?: boolean;
  /** Tokens, passwords: env or NAME_FILE only. */
  secret?: boolean;
  /**
   * Environment variable that pins the value (wins over the database). Default: SCOPE_KEY in upper case
   * (e.g. access-sync / interval → ACCESS_SYNC_INTERVAL). `false`: no env variable.
   */
  env?: string | false;
  /** For strings: a regular expression the whole value must match, e.g. "^\\S{1,8}$". */
  pattern?: string;
  /** Changes only apply after a restart (shown as a hint). */
  restart?: boolean;
  /** Each guild can have its own value (falling back to the bot-wide one). Never for secrets. */
  perGuild?: boolean;
  /** Only bot root may change it from chat (it affects the bot's host or turns safety checks off). */
  rootOnly?: boolean;
};

export type Source = 'env' | 'guild' | 'db' | 'default' | 'missing';
export type Resolved = { value: SettingValue | undefined; source: Source; envName: string };

type Scope = { defs: Record<string, SettingDef>; env: Map<string, SettingValue> };
const scopesById = new Map<string, Scope>();
/** Stored values: guild ('' = bot-wide) → "scope\0key" → value. */
const stored = new Map<string, Map<string, SettingValue>>();
const id = (scope: string, key: string) => `${scope}\u0000${key}`;

/** The env variable for a setting, or '' if it has none (env: false). */
export const envNameFor = (scope: string, key: string, def: SettingDef) =>
  def.env === false ? '' : (def.env ?? `${scope}_${key}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_'));

/** parseValue plus the setting's own rules (pattern). */
export function parseFor(def: SettingDef, raw: string): SettingValue {
  const value = parseValue(def.type, raw);
  if (def.pattern && typeof value === 'string' && !new RegExp(def.pattern, 'u').test(value)) {
    throw new Error(`${code(raw)} isn't allowed here (must match ${def.pattern})`);
  }
  return value;
}

/** Parse text (from env or chat) into the setting's type. Throws a user-readable message. */
export function parseValue(type: SettingType, raw: string): SettingValue {
  const text = raw.trim();
  switch (type) {
    case 'string':
      return raw;
    case 'number': {
      const n = Number(text);
      if (text === '' || !Number.isFinite(n)) throw new Error(`${code(raw)} isn't a number`);
      return n;
    }
    case 'boolean':
      if (/^(true|on|yes|1)$/i.test(text)) return true;
      if (/^(false|off|no|0)$/i.test(text)) return false;
      throw new Error(`${code(raw)} isn't true/false`);
    case 'id':
      if (!/^\d{1,25}$/.test(text)) throw new Error(`${code(raw)} isn't an ID (digits only)`);
      return text;
    case 'url': {
      let url: URL | undefined;
      try {
        url = new URL(text);
      } catch {}
      if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new Error(`${code(raw)} isn't an http(s) URL`);
      return url.toString();
    }
  }
}

/**
 * Declare (or re-declare) a scope's settings and read their environment variables. Returns the problems
 * found (an env value of the wrong type, an unreadable NAME_FILE, a perGuild secret); a setting with a
 * bad env value is treated as not set by env. The caller decides what a problem means: the core refuses
 * to start, a plugin isn't loaded.
 */
export function defineSettings(scope: string, defs: Record<string, SettingDef>): string[] {
  const env = new Map<string, SettingValue>();
  const problems: string[] = [];
  for (const [key, def] of Object.entries(defs)) {
    if (def.secret && def.perGuild) problems.push(`${key}: a secret can't be perGuild`);
    if (def.pattern) {
      try {
        new RegExp(def.pattern, 'u');
      } catch {
        problems.push(`${key}: pattern ${def.pattern} isn't a valid regular expression`);
      }
    }
    const name = envNameFor(scope, key, def);
    if (!name) continue;
    let raw: string | undefined;
    try {
      raw = readEnv(name);
      if (raw !== undefined) env.set(key, parseFor(def, raw));
    } catch (error) {
      // Parse errors quote the value: never a secret's, since this goes to the console and the log channel.
      const hide = def.secret && raw !== undefined;
      problems.push(`${name}: ${hide ? `the value isn't a valid ${def.type}${def.pattern ? ` matching ${def.pattern}` : ''}` : (error as Error).message}`);
    }
  }
  scopesById.set(scope, { defs, env });
  return problems;
}

export const scopes = () => [...scopesById.keys()];
export const definitionsOf = (scope: string) => scopesById.get(scope)?.defs ?? {};

function defOf(scope: string, key: string): SettingDef {
  const def = scopesById.get(scope)?.defs[key];
  if (!def) throw new Error(`No setting ${code(key)} in ${code(scope)}`);
  return def;
}

const storedIn = (guildId: string) => {
  let map = stored.get(guildId);
  if (!map) stored.set(guildId, (map = new Map()));
  return map;
};

/** Load every stored setting into memory. Call once after the database is open. */
export async function loadSettings() {
  stored.clear();
  for (const row of await db().selectFrom('settings').selectAll().execute()) {
    storedIn(row.guild_id).set(id(row.scope, row.key), JSON.parse(row.value));
  }
}

/** Where a setting's value comes from, and what it is. Pass a guild for perGuild settings. */
export function resolve(scope: string, key: string, guildId = GLOBAL): Resolved {
  const def = defOf(scope, key);
  const envName = envNameFor(scope, key, def);
  const fromEnv = scopesById.get(scope)!.env.get(key);
  if (fromEnv !== undefined) return { value: fromEnv, source: 'env', envName };
  if (!def.secret) {
    const k = id(scope, key);
    if (guildId && def.perGuild && stored.get(guildId)?.has(k)) return { value: stored.get(guildId)!.get(k), source: 'guild', envName };
    if (stored.get(GLOBAL)?.has(k)) return { value: stored.get(GLOBAL)!.get(k), source: 'db', envName };
  }
  if (def.default !== undefined) return { value: def.default, source: 'default', envName };
  return { value: undefined, source: 'missing', envName };
}

/** A setting's current value (undefined if unset and no default). */
export function getSetting<T extends SettingValue = SettingValue>(scope: string, key: string, guildId = GLOBAL): T | undefined {
  return resolve(scope, key, guildId).value as T | undefined;
}

/** Store a setting from chat input (bot-wide, or for one guild). Throws a user-readable reason if that's not allowed. */
export async function setSetting(scope: string, key: string, raw: string, by: string, guildId = GLOBAL) {
  const def = defOf(scope, key);
  if (def.secret) throw new Error(`${key} is a secret: set it with ${envNameFor(scope, key, def) || 'an environment variable'} (or _FILE)`);
  if (guildId && !def.perGuild) throw new Error(`${key} is a bot-wide setting; it can't be set per guild`);
  const r = resolve(scope, key, guildId);
  if (r.source === 'env') throw new Error(`${key} is set by ${r.envName} in the environment; change or remove it there`);
  const value = parseFor(def, raw);
  const row = { guild_id: guildId, scope, key, value: JSON.stringify(value), updated_at: new Date().toISOString(), updated_by: by };
  await db()
    .insertInto('settings')
    .values(row)
    .onConflict((oc) => oc.columns(['guild_id', 'scope', 'key']).doUpdateSet({ value: row.value, updated_at: row.updated_at, updated_by: by }))
    .execute();
  storedIn(guildId).set(id(scope, key), value);
  return value;
}

/** Remove a stored value (back to the bot-wide value, env or default). */
export async function unsetSetting(scope: string, key: string, guildId = GLOBAL) {
  defOf(scope, key);
  await db().deleteFrom('settings').where('guild_id', '=', guildId).where('scope', '=', scope).where('key', '=', key).execute();
  stored.get(guildId)?.delete(id(scope, key));
}

/** Every setting in a scope, for display. Secret values are never included, only whether they're set. */
export function describeScope(scope: string, guildId = GLOBAL) {
  return Object.entries(definitionsOf(scope)).map(([key, def]) => {
    const r = resolve(scope, key, guildId);
    return {
      key,
      def,
      source: r.source,
      envName: r.envName,
      display: r.value === undefined ? undefined : def.secret ? '(set)' : String(r.value),
      missing: !!def.required && r.value === undefined,
    };
  });
}

/** Required settings without a value, per scope. */
export const missingRequired = (scope: string) => describeScope(scope).filter((s) => s.missing).map((s) => s.key);

/** A scope's settings as a plugin sees them (ctx.config / bot.config). Unknown keys read as undefined. */
export function configFor(scope: string) {
  return {
    get: <T extends SettingValue = SettingValue>(key: string, guildId?: string) =>
      (definitionsOf(scope)[key] ? getSetting<T>(scope, key, guildId) : undefined) as T | undefined,
    missing: () => missingRequired(scope),
  };
}
