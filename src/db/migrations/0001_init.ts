import type { Kysely } from 'kysely';

// Portable schema only: the same migration runs on SQLite and Postgres. See ../schema.ts for the columns.
export async function up(db: Kysely<unknown>) {
  await db.schema
    .createTable('settings')
    .addColumn('guild_id', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('scope', 'text', (c) => c.notNull())
    .addColumn('key', 'text', (c) => c.notNull())
    .addColumn('value', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addColumn('updated_by', 'text')
    .addPrimaryKeyConstraint('settings_pk', ['guild_id', 'scope', 'key'])
    .execute();

  await db.schema
    .createTable('kv')
    .addColumn('namespace', 'text', (c) => c.notNull())
    .addColumn('guild_id', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('user_id', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('key', 'text', (c) => c.notNull())
    .addColumn('value', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('kv_pk', ['namespace', 'guild_id', 'user_id', 'key'])
    .execute();
  // "Everything about this user", across plugins and guilds.
  await db.schema.createIndex('kv_user').on('kv').column('user_id').execute();

  await db.schema
    .createTable('audit_log')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('at', 'text', (c) => c.notNull())
    .addColumn('guild_id', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('actor_id', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('actor', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('target', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('details', 'text', (c) => c.notNull().defaultTo('{}'))
    .execute();
  await db.schema.createIndex('audit_log_guild_at').on('audit_log').columns(['guild_id', 'at']).execute();
  await db.schema.createIndex('audit_log_actor_at').on('audit_log').columns(['actor_id', 'at']).execute();

  await db.schema
    .createTable('guilds')
    .addColumn('guild_id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('joined_at', 'text', (c) => c.notNull())
    .addColumn('left_at', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('timers')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('owner', 'text', (c) => c.notNull())
    .addColumn('guild_id', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('due_at', 'text', (c) => c.notNull())
    .addColumn('payload', 'text', (c) => c.notNull().defaultTo('{}'))
    .execute();
  await db.schema.createIndex('timers_kind_due').on('timers').columns(['kind', 'due_at']).execute();
}

export async function down(db: Kysely<unknown>) {
  for (const table of ['timers', 'guilds', 'audit_log', 'kv', 'settings']) await db.schema.dropTable(table).execute();
}
