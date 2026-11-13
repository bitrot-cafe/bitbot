import { sql } from 'kysely';
import { db } from './db/index.js';
import { NONE } from './db/schema.js';

/*
 * Key/value storage for plugins, namespaced per plugin (its short id). Values are JSON-serialisable.
 * Backed by the `kv` table, so it works the same on SQLite and Postgres.
 *
 * A plugin's store is bot-wide. store.guild(id) narrows it to one guild and store.user(id) to one user;
 * they combine (store.guild(g).user(u)). Use them rather than "guild:<id>:" or "user:<id>:" keys: the
 * guild and user are columns, so a guild's entries are one index range, and everything stored about a
 * user can be found and deleted (deleteUserData) whichever plugin stored it.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type Store = {
  get<T extends Json = Json>(key: string): Promise<T | undefined>;
  set(key: string, value: Json): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every entry whose key starts with `prefix` (all entries if omitted), sorted by key. */
  list<T extends Json = Json>(prefix?: string): Promise<{ key: string; value: T }[]>;
  /** The same store, for one guild. */
  guild(guildId: string): Store;
  /** The same store, for one user (within the current guild, if any). */
  user(userId: string): Store;
};

const isId = (id: string) => /^\d{1,25}$/.test(id);

export function createStore(namespace: string, guildId = NONE, userId = NONE): Store {
  const rows = () =>
    db().selectFrom('kv').where('namespace', '=', namespace).where('guild_id', '=', guildId).where('user_id', '=', userId);
  return {
    async get(key) {
      const row = await rows().select('value').where('key', '=', key).executeTakeFirst();
      return row ? JSON.parse(row.value) : undefined;
    },
    async set(key, value) {
      const row = { namespace, guild_id: guildId, user_id: userId, key, value: JSON.stringify(value), updated_at: new Date().toISOString() };
      await db()
        .insertInto('kv')
        .values(row)
        .onConflict((oc) => oc.columns(['namespace', 'guild_id', 'user_id', 'key']).doUpdateSet({ value: row.value, updated_at: row.updated_at }))
        .execute();
    },
    async delete(key) {
      await db()
        .deleteFrom('kv')
        .where('namespace', '=', namespace)
        .where('guild_id', '=', guildId)
        .where('user_id', '=', userId)
        .where('key', '=', key)
        .execute();
    },
    async list(prefix = '') {
      let query = rows().select(['key', 'value']);
      // substr, not LIKE: LIKE's case sensitivity differs between SQLite and Postgres.
      if (prefix) query = query.where(sql<boolean>`substr(key, 1, ${prefix.length}) = ${prefix}`);
      return (await query.orderBy('key').execute()).map((r) => ({ key: r.key, value: JSON.parse(r.value) }));
    },
    guild(id) {
      if (!isId(id)) throw new Error(`store.guild: "${id}" isn't a guild ID`);
      return createStore(namespace, id, userId);
    },
    user(id) {
      if (!isId(id)) throw new Error(`store.user: "${id}" isn't a user ID`);
      return createStore(namespace, guildId, id);
    },
  };
}

/** How many stored entries are about a user, per plugin. For data requests and before deleting. */
export async function userDataSummary(userId: string) {
  const rows = await db()
    .selectFrom('kv')
    .select(['namespace', (eb) => eb.fn.countAll<number>().as('n')])
    .where('user_id', '=', userId)
    .groupBy('namespace')
    .orderBy('namespace')
    .execute();
  return rows.map((r) => ({ plugin: r.namespace, entries: Number(r.n) }));
}

/** Delete everything plugins stored about a user (every plugin, every guild). Returns how many entries. */
export async function deleteUserData(userId: string) {
  if (!isId(userId)) throw new Error(`"${userId}" isn't a user ID`);
  const result = await db().deleteFrom('kv').where('user_id', '=', userId).executeTakeFirst();
  return Number(result.numDeletedRows);
}
