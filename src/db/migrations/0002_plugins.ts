import type { Kysely } from 'kysely';

// Plugin repos, the allowlist and dependency approvals (they were in plugins/plugins.json before 0.4).
// Portable schema only.
export async function up(db: Kysely<unknown>) {
  await db.schema
    .createTable('plugin_repos')
    .addColumn('name', 'text', (c) => c.primaryKey())
    .addColumn('url', 'text', (c) => c.notNull())
    .addColumn('ref', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('commit', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addColumn('updated_by', 'text')
    .execute();

  await db.schema
    .createTable('plugins_enabled')
    .addColumn('path', 'text', (c) => c.primaryKey())
    .addColumn('enabled_at', 'text', (c) => c.notNull())
    .addColumn('enabled_by', 'text')
    .execute();

  await db.schema
    .createTable('plugin_approvals')
    .addColumn('path', 'text', (c) => c.primaryKey())
    .addColumn('lock_hash', 'text', (c) => c.notNull())
    .addColumn('approved_at', 'text', (c) => c.notNull())
    .addColumn('approved_by', 'text')
    .execute();
}
