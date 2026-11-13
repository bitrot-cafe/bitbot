/*
 * Table types. Keep them portable (SQLite and Postgres): text and integer columns, JSON stored as text,
 * timestamps as ISO-8601 text (which sorts correctly). Add tables with a new migration, never by editing
 * a shipped one.
 *
 * `guild_id` and `user_id` are '' when a row isn't about a guild / user, and an ID when it is. They're
 * never NULL: NULLs aren't equal in a primary key or ON CONFLICT on either backend.
 */

export const NONE = '';

export type SettingsTable = {
  guild_id: string;
  /** "core", or a plugin's short id. */
  scope: string;
  key: string;
  /** JSON-encoded value. */
  value: string;
  updated_at: string;
  /** Who changed it, e.g. "alice (1234567890123456789)". */
  updated_by: string | null;
};

export type KvTable = {
  /** A plugin's short id. */
  namespace: string;
  guild_id: string;
  /** The user the entry is about, so "everything about this user" can be found and deleted. */
  user_id: string;
  key: string;
  /** JSON-encoded value. */
  value: string;
  updated_at: string;
};

/** Who did what: settings changes, plugin management, and anything plugins record with bot.audit. */
export type AuditLogTable = {
  /** Random; order by `at`. */
  id: string;
  at: string;
  /** The guild it happened in or affects; '' for bot-wide actions. */
  guild_id: string;
  /** Who did it ('' for the bot itself), and their name at the time. */
  actor_id: string;
  actor: string;
  /** "core", "admin", or a plugin's short id. */
  source: string;
  /** e.g. "setting.set", "plugin.enable". */
  action: string;
  /** What it was done to, e.g. "core.status", "bitbot-plugins/whoami", a user ID. */
  target: string;
  /** JSON object with anything else worth keeping. */
  details: string;
};

/** Guilds the bot is or was in. Per-guild data without a current guild here is orphaned. */
export type GuildsTable = {
  guild_id: string;
  name: string;
  joined_at: string;
  /** '' while the bot is in it. */
  left_at: string;
  updated_at: string;
};

/**
 * Things due at a time that must survive restarts. Today: long cooldowns (kind "cooldown"). The scheduler
 * (planned) adds kind "job", with a repeat rule and a claim column, in a later migration.
 */
export type TimersTable = {
  key: string;
  kind: string;
  /** "core", or a plugin's folder id. */
  owner: string;
  guild_id: string;
  due_at: string;
  /** JSON object. */
  payload: string;
};

export type Database = {
  settings: SettingsTable;
  kv: KvTable;
  audit_log: AuditLogTable;
  guilds: GuildsTable;
  timers: TimersTable;
};

/** Tables holding data (copied by db:copy), in dependency order. */
export const DATA_TABLES = ['settings', 'kv', 'audit_log', 'guilds', 'timers'] as const satisfies readonly (keyof Database)[];
