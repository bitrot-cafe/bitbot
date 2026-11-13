import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { sql } from 'kysely';
import { describeUrl, migrate, openDb, setDb, type Db } from './index.js';

/*
 * Runs against TEST_DATABASE_URL (default: in-memory SQLite), so CI can run it on Postgres as well.
 *   TEST_DATABASE_URL=postgres://bitbot:bitbot@localhost:5432/bitbot pnpm test
 */
const url = process.env.TEST_DATABASE_URL || 'sqlite::memory:';
const { createStore } = await import('../store.js');
const settings = await import('../settings.js');

let db: Db;
before(async () => {
  db = openDb(url);
  if (url.startsWith('postgres')) {
    await sql`drop table if exists settings, kv, audit_log, guilds, timers, plugin_repos, plugins_enabled, plugin_approvals, kysely_migration, kysely_migration_lock cascade`.execute(db);
  }
  await migrate(db);
  setDb(db);
});
after(async () => {
  setDb(null);
  await db.destroy();
});

test(`migrations apply and are idempotent (${describeUrl(url)})`, async () => {
  assert.deepEqual(await migrate(db), []); // already applied
  await db.insertInto('settings').values({ guild_id: '', scope: 's', key: 'k', value: '1', updated_at: 'x', updated_by: null }).execute();
  await db.deleteFrom('settings').execute();
});

const GUILD = '1562114954234953728';
const OTHER = '1562114954234953729';

test('settings: env > guild > bot-wide > default; secrets never stored', async () => {
  const defs = {
    name: { type: 'string', description: 'x', default: 'dflt' },
    count: { type: 'number', description: 'x', env: 'TEST_COUNT_ENV' },
    flag: { type: 'boolean', description: 'x', required: true },
    token: { type: 'string', description: 'x', secret: true },
    greeting: { type: 'string', description: 'x', default: 'hi', perGuild: true },
  } satisfies Record<string, import('../settings.js').SettingDef>;
  assert.deepEqual(settings.defineSettings('test', defs), []);
  await settings.loadSettings();
  assert.deepEqual(settings.resolve('test', 'name'), { value: 'dflt', source: 'default', envName: 'TEST_NAME' });

  await settings.setSetting('test', 'name', 'stored', 'tester');
  assert.equal(settings.getSetting('test', 'name'), 'stored');
  await settings.loadSettings(); // survives a reload from the database
  assert.equal(settings.resolve('test', 'name').source, 'db');

  // Env is read when a scope is declared, and wins.
  process.env.TEST_NAME = 'from-env';
  settings.defineSettings('test', defs);
  assert.deepEqual(settings.resolve('test', 'name'), { value: 'from-env', source: 'env', envName: 'TEST_NAME' });
  await assert.rejects(settings.setSetting('test', 'name', 'x', 't'), /set by TEST_NAME/);
  delete process.env.TEST_NAME;

  // NAME_FILE (Docker secrets) wins over NAME.
  const dir = await mkdtemp(join(tmpdir(), 'bitbot-env-'));
  await writeFile(join(dir, 'count'), ' 42\n');
  process.env.TEST_COUNT_ENV_FILE = join(dir, 'count');
  process.env.TEST_COUNT_ENV = '1';
  settings.defineSettings('test', defs);
  assert.equal(settings.getSetting('test', 'count'), 42);
  delete process.env.TEST_COUNT_ENV_FILE;
  delete process.env.TEST_COUNT_ENV;

  // A bad env value is reported, and ignored rather than thrown on every read.
  process.env.TEST_FLAG = '*';
  assert.match(settings.defineSettings('test', defs).join(), /TEST_FLAG: `\*` isn't true\/false/);
  assert.equal(settings.resolve('test', 'flag').source, 'missing');
  delete process.env.TEST_FLAG;
  process.env.TEST_COUNT_ENV_FILE = join(dir, 'nope');
  assert.match(settings.defineSettings('test', defs).join(), /TEST_COUNT_ENV_FILE points at/);
  delete process.env.TEST_COUNT_ENV_FILE;
  settings.defineSettings('test', defs);

  assert.deepEqual(settings.missingRequired('test'), ['flag']);
  await settings.setSetting('test', 'flag', 'on', 't');
  assert.equal(settings.getSetting('test', 'flag'), true);
  assert.deepEqual(settings.missingRequired('test'), []);

  await assert.rejects(settings.setSetting('test', 'count', 'many', 't'), /isn't a number/);
  await assert.rejects(settings.setSetting('test', 'token', 'hunter2', 't'), /is a secret/);
  process.env.TEST_TOKEN = 'hunter2';
  settings.defineSettings('test', defs);
  const shown = settings.describeScope('test').find((s) => s.key === 'token')!;
  assert.equal(shown.display, '(set)'); // never the value
  delete process.env.TEST_TOKEN;
  settings.defineSettings('test', defs);
  const rows = await db.selectFrom('settings').selectAll().where('scope', '=', 'test').execute();
  assert.ok(!rows.some((r) => r.key === 'token'), 'secret must not be stored');

  // Per guild: a guild's value, else the bot-wide one, else the default. Bot-wide settings refuse it.
  assert.equal(settings.getSetting('test', 'greeting', GUILD), 'hi');
  await settings.setSetting('test', 'greeting', 'hello', 't');
  await settings.setSetting('test', 'greeting', 'yo', 't', GUILD);
  await settings.loadSettings();
  assert.deepEqual(settings.resolve('test', 'greeting', GUILD), { value: 'yo', source: 'guild', envName: 'TEST_GREETING' });
  assert.equal(settings.getSetting('test', 'greeting', OTHER), 'hello');
  assert.equal(settings.getSetting('test', 'greeting'), 'hello');
  await assert.rejects(settings.setSetting('test', 'name', 'x', 't', GUILD), /bot-wide setting/);
  await settings.unsetSetting('test', 'greeting', GUILD);
  assert.equal(settings.getSetting('test', 'greeting', GUILD), 'hello');

  await settings.unsetSetting('test', 'name');
  assert.equal(settings.resolve('test', 'name').source, 'default');
  // A secret can't be per guild.
  assert.match(settings.defineSettings('bad', { t: { type: 'string', description: 'x', secret: true, perGuild: true } }).join(), /secret can't be perGuild/);
});

test('settings: url type', () => {
  assert.equal(settings.parseValue('url', ' https://example.com/help '), 'https://example.com/help');
  for (const bad of ['example.com', 'javascript:alert(1)', 'ftp://x', '']) assert.throws(() => settings.parseValue('url', bad), /http\(s\) URL/, bad);
});

test('store: namespaced, per guild, JSON values, prefix listing is literal and case-sensitive', async () => {
  const a = createStore('plugin-a');
  const b = createStore('plugin-b');
  await a.set('user:1', { n: 1 });
  await a.set('user:2', [1, 'two']);
  await a.set('User:3', true);
  await a.set('user_%x', 'wild');
  await b.set('user:1', 'other plugin');
  assert.deepEqual(await a.get('user:1'), { n: 1 });
  assert.equal(await b.get('user:1'), 'other plugin');
  assert.equal(await a.get('missing'), undefined);
  assert.deepEqual((await a.list('user:')).map((e) => e.key), ['user:1', 'user:2']); // not User:3, not user_%x
  assert.deepEqual((await a.list('user_%')).map((e) => e.key), ['user_%x']); // % and _ are literal
  await a.set('user:1', { n: 2 }); // upsert
  assert.deepEqual(await a.get('user:1'), { n: 2 });

  // A guild's store is separate from the bot-wide one and from other guilds'.
  const g = a.guild(GUILD);
  await g.set('user:1', 'guild value');
  await a.guild(OTHER).set('user:9', 'other guild');
  assert.equal(await g.get('user:1'), 'guild value');
  assert.deepEqual(await a.get('user:1'), { n: 2 });
  assert.deepEqual((await g.list()).map((e) => e.key), ['user:1']);
  await g.set('user:1', 'updated'); // upsert within the guild
  assert.equal(await g.get('user:1'), 'updated');
  await g.delete('user:1');
  assert.equal(await g.get('user:1'), undefined);
  assert.deepEqual(await a.get('user:1'), { n: 2 });
  assert.throws(() => a.guild('not-an-id'), /isn't a guild ID/);

  await a.delete('user:1');
  assert.equal(await a.get('user:1'), undefined);
  assert.equal(await b.get('user:1'), 'other plugin');
});

test('store: per-user entries, and deleting everything about a user', async () => {
  const { deleteUserData, userDataSummary } = await import('../store.js');
  const U = '1234567890123456789';
  const a = createStore('plugin-a');
  await a.user(U).set('xp', 10);
  await a.guild(GUILD).user(U).set('warnings', 2);
  await createStore('plugin-b').user(U).set('tz', 'UTC');
  await a.set('xp', 'bot-wide, not about the user');
  assert.equal(await a.user(U).get('xp'), 10);
  assert.equal(await a.get('xp'), 'bot-wide, not about the user');
  assert.equal(await a.guild(GUILD).user(U).get('warnings'), 2);
  assert.equal(await a.user(U).guild(GUILD).get('warnings'), 2); // order doesn't matter
  assert.deepEqual(await userDataSummary(U), [
    { plugin: 'plugin-a', entries: 2 },
    { plugin: 'plugin-b', entries: 1 },
  ]);
  assert.equal(await deleteUserData(U), 3);
  assert.deepEqual(await userDataSummary(U), []);
  assert.equal(await a.get('xp'), 'bot-wide, not about the user');
  assert.throws(() => a.user('me'), /isn't a user ID/);
});

test('audit log: written, read newest first, per guild; a failed write never throws', async () => {
  const { audit, recentAudit } = await import('../audit.js');
  await audit('admin', { action: 'setting.set', actor: { id: '1', username: 'yalc' }, target: 'core.status', details: { value: 'hi' } });
  await new Promise((r) => setTimeout(r, 5));
  await audit('modlog', { action: 'ban', actor: { id: '2', username: 'chris' }, guildId: GUILD, target: '3' });
  const all = await recentAudit();
  assert.deepEqual(all.map((r) => r.action), ['ban', 'setting.set']);
  assert.deepEqual(JSON.parse(all[1].details), { value: 'hi' });
  assert.deepEqual((await recentAudit({ guildId: GUILD })).map((r) => r.source), ['modlog']);
  assert.deepEqual((await recentAudit({ guildId: '' })).map((r) => r.source), ['admin']);
  setDb(null); // no database: the write fails, is logged, and doesn't throw
  await audit('admin', { action: 'x' });
  setDb(db);
});

test('settings: pattern and env-less settings (the prefix)', async () => {
  const problems = settings.defineSettings('pat', {
    prefix: { type: 'string', description: 'x', default: '!', env: false, perGuild: true, pattern: '^\\S{1,8}$' },
  });
  assert.deepEqual(problems, []);
  process.env.PAT_PREFIX = '??'; // no env variable for it: ignored
  settings.defineSettings('pat', settings.definitionsOf('pat'));
  assert.equal(settings.getSetting('pat', 'prefix'), '!');
  delete process.env.PAT_PREFIX;
  await assert.rejects(settings.setSetting('pat', 'prefix', 'two words', 't', GUILD), /isn't allowed here/);
  assert.equal(await settings.setSetting('pat', 'prefix', '??', 't', GUILD), '??');
  assert.equal(settings.getSetting('pat', 'prefix', GUILD), '??');
  assert.match(settings.defineSettings('pat2', { p: { type: 'string', description: 'x', pattern: '(' } }).join(), /isn't a valid regular expression/);
  // A secret's bad env value isn't quoted (the problem goes to the console and the log channel).
  process.env.SEC_TOKEN = 'hunter2 oops';
  const secret = settings.defineSettings('sec', { token: { type: 'string', description: 'x', secret: true, pattern: '^\\S+$' } }).join();
  delete process.env.SEC_TOKEN;
  assert.match(secret, /SEC_TOKEN: the value isn't a valid string matching/);
  assert.doesNotMatch(secret, /hunter2/);
});

test('cooldowns over a minute survive a restart (stored in timers)', async () => {
  const { loadCooldowns, resetCooldowns, takeCooldown } = await import('../cooldown.js');
  resetCooldowns();
  const now = Date.now();
  const daily = { seconds: 86_400, per: 'guild' } as const;
  const lotto = takeCooldown({ userId: '1', guildId: GUILD }, { name: 'lotto', origin: 'local/lotto' }, daily, now);
  const short = takeCooldown({ userId: '1', guildId: GUILD }, { name: 'short' }, 30, now);
  const refunded = takeCooldown({ userId: '1', guildId: GUILD }, { name: 'raffle' }, daily, now);
  assert.ok(lotto.ok && short.ok && refunded.ok);
  lotto.commit();
  short.commit(); // not stored: under a minute
  refunded.release(); // never stored
  await new Promise((r) => setTimeout(r, 50)); // the write is fire-and-forget
  const rows = await db.selectFrom('timers').selectAll().execute();
  assert.deepEqual(rows.map((r) => [r.key, r.kind, r.owner, r.guild_id]), [[`cooldown:g:${GUILD}:lotto`, 'cooldown', 'local/lotto', GUILD]]);

  resetCooldowns(); // "restart"
  await loadCooldowns(now + 1000);
  const again = takeCooldown({ userId: '2', guildId: GUILD }, { name: 'lotto' }, daily, now + 1000);
  assert.equal(again.ok, false);
  await loadCooldowns(now + 86_401_000); // expired rows are dropped
  assert.equal((await db.selectFrom('timers').selectAll().execute()).length, 0);
});

test('guilds: synced from the complete list at Ready; an empty list never marks everything as left', async () => {
  const { syncGuilds } = await import('../guilds.js');
  await db.deleteFrom('guilds').execute();
  // First start with existing guilds, no GuildCreate: they're recorded.
  await syncGuilds([{ id: '1', name: 'one' }, { id: '2', name: 'two' }]);
  const first = await db.selectFrom('guilds').selectAll().orderBy('guild_id').execute();
  assert.deepEqual(first.map((r) => [r.guild_id, r.name, r.left_at]), [['1', 'one', ''], ['2', 'two', '']]);

  // Next start: guild 2 removed the bot while it was offline; guild 1 is in an outage (stub, no name).
  assert.deepEqual(await syncGuilds([{ id: '1' }]), ['2']);
  const second = await db.selectFrom('guilds').selectAll().orderBy('guild_id').execute();
  assert.equal(second[0].name, 'one'); // a stub doesn't blank the name
  assert.equal(second[0].joined_at, first[0].joined_at); // still the same stay
  assert.notEqual(second[1].left_at, '');

  // An empty list while guilds are recorded: skipped, nothing marked.
  assert.deepEqual(await syncGuilds([]), []);
  assert.equal((await db.selectFrom('guilds').select('left_at').where('guild_id', '=', '1').executeTakeFirstOrThrow()).left_at, '');
});
