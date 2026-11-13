import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sql } from 'kysely';
import { copyDatabase } from './copy.js';
import { migrate, openDb } from './index.js';

/*
 * The SQLite ↔ Postgres path. With TEST_DATABASE_URL set to Postgres this round-trips
 * SQLite → Postgres → SQLite; otherwise SQLite → SQLite.
 */
const pgUrl = process.env.TEST_DATABASE_URL?.startsWith('postgres') ? process.env.TEST_DATABASE_URL : undefined;
const dir = await mkdtemp(join(tmpdir(), 'bitbot-copy-'));
const sqliteA = `sqlite:${join(dir, 'a.db')}`;
const sqliteB = `sqlite:${join(dir, 'b.db')}`;
const middle = pgUrl ?? `sqlite:${join(dir, 'middle.db')}`;

const rowsOf = async (url: string) => {
  const db = openDb(url);
  try {
    return {
      settings: await db.selectFrom('settings').selectAll().orderBy('guild_id').orderBy('scope').orderBy('key').execute(),
      kv: await db.selectFrom('kv').selectAll().orderBy('namespace').orderBy('guild_id').orderBy('user_id').orderBy('key').execute(),
      audit_log: await db.selectFrom('audit_log').selectAll().orderBy('id').execute(),
      guilds: await db.selectFrom('guilds').selectAll().orderBy('guild_id').execute(),
      timers: await db.selectFrom('timers').selectAll().orderBy('key').execute(),
    };
  } finally {
    await db.destroy();
  }
};

test(`round trip: sqlite → ${pgUrl ? 'postgres' : 'sqlite'} → sqlite keeps every row`, async () => {
  if (pgUrl) {
    const pg = openDb(pgUrl);
    await sql`drop table if exists settings, kv, audit_log, guilds, timers, kysely_migration, kysely_migration_lock cascade`.execute(pg);
    await pg.destroy();
  }
  // Seed the source, including unicode and large values.
  const src = openDb(sqliteA);
  await migrate(src);
  const settings = Array.from({ length: 1200 }, (_, i) => ({
    guild_id: i % 4 ? '' : `10000000000000000${i % 7}`,
    scope: i % 2 ? 'core' : 'access-sync',
    key: `k${i}`,
    value: JSON.stringify({ i, text: 'émoji 🎉 "quotes"' }),
    updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    updated_by: i % 3 ? 'yalc (1)' : null,
  }));
  for (let i = 0; i < settings.length; i += 300) await src.insertInto('settings').values(settings.slice(i, i + 300)).execute();
  await src.insertInto('kv').values({ namespace: 'addemote', guild_id: '1562114954234953728', user_id: '1234567890123456789', key: 'x', value: JSON.stringify('y'.repeat(100_000)), updated_at: 'now' }).execute();
  await src
    .insertInto('audit_log')
    .values({ id: 'a1', at: '2026-11-12T00:00:00.000Z', guild_id: '', actor_id: '1', actor: 'yalc', source: 'admin', action: 'setting.set', target: 'core.status', details: '{"value":"hi 🎉"}' })
    .execute();
  await src.insertInto('timers').values({ key: 'cooldown:g:1:lotto', kind: 'cooldown', owner: 'local/lotto', guild_id: '1', due_at: '2026-11-13T00:00:00.000Z', payload: '{}' }).execute();
  await src.insertInto('guilds').values({ guild_id: '1562114954234953728', name: 'Central', joined_at: 'then', left_at: '', updated_at: 'now' }).execute();
  await src.destroy();

  const silent = () => {};
  assert.deepEqual(await copyDatabase(sqliteA, middle, silent), { settings: 1200, kv: 1, audit_log: 1, guilds: 1, timers: 1 });
  assert.deepEqual(await copyDatabase(middle, sqliteB, silent), { settings: 1200, kv: 1, audit_log: 1, guilds: 1, timers: 1 });
  assert.deepEqual(await rowsOf(sqliteB), await rowsOf(sqliteA));

  // Refuses to copy into a database that already has data.
  await assert.rejects(copyDatabase(sqliteA, sqliteB, silent), /isn't empty/);
});
