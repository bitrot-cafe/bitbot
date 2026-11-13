import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import type { Db } from './db/index.js';

// config.ts reads PLUGINS_DIR at import, so point it at a scratch folder first, and import everything
// that reaches config.ts dynamically, after this. (A static import would run first and use the real
// plugins/ folder.)
const root = await mkdtemp(join(tmpdir(), 'bitbot-plugins-'));
process.env.PLUGINS_DIR = root;
const { pluginsDir } = await import('./config.js');
assert.equal(pluginsDir, root, 'tests must not touch the real plugins folder');
const { migrate, openDb, setDb } = await import('./db/index.js');
const repos = await import('./repos.js');
const { parseMeta } = await import('./plugin-meta.js');
const { findClashes, findDuplicateIds, pathOf, badCommandNames } = await import('./loader.js');
const { findPluginFolders, findPlugin, parseRepoUrl, validRef, enabledPaths, enablePlugin, disablePlugin, prepareRepos, seedDefaults, repoRows } = repos;

let db: Db;
before(async () => {
  db = openDb('sqlite::memory:');
  await migrate(db);
  setDb(db);
});
after(async () => {
  setDb(null);
  await db.destroy();
});

const exists = (path: string) => access(path).then(() => true, () => false);
const sh = promisify(execFile);
const git = (dir: string, ...args: string[]) =>
  sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd: dir }).then((r) => r.stdout.trim());
const pkg = (id: string, extra: object = {}) => JSON.stringify({ name: id, version: '1.2.3', bitbot: { api: '0.4', id, ...extra } });
/** A plugin folder: package.json (with a "bitbot" block unless `meta` is null) and an index.ts. */
async function plugin(dir: string, id: string, { meta = pkg(id), index = true }: { meta?: string | null; index?: boolean } = {}) {
  await mkdir(dir, { recursive: true });
  if (meta !== null) await writeFile(join(dir, 'package.json'), meta);
  if (index) await writeFile(join(dir, 'index.ts'), 'export default () => ({ commands: [] });\n');
}
/** A git repo holding plugins one and two; returns its first commit. */
async function makeRepo(dir: string) {
  await plugin(join(dir, 'one'), 'one');
  await plugin(join(dir, 'two'), 'two');
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, 'docs', 'README.md'), 'not a plugin');
  await git(dir, 'init', '--quiet');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '--quiet', '-m', 'first');
  return git(dir, 'rev-parse', 'HEAD');
}

test('parseRepoUrl: accepts https and derives the folder name', () => {
  assert.deepEqual(parseRepoUrl('https://github.com/bitrot-cafe/bitbot-plugins'), {
    name: 'bitbot-plugins',
    url: 'https://github.com/bitrot-cafe/bitbot-plugins',
  });
  assert.equal((parseRepoUrl('https://example.com/a/Cool.Plugins.git/') as { name: string }).name, 'cool.plugins');
});

test('parseRepoUrl: rejects unsafe URLs and reserved names', () => {
  for (const bad of [
    'http://github.com/a/b', // not https
    'git@github.com:a/b.git', // ssh / not a URL
    'https://user:pass@github.com/a/b', // credentials
    'https://github.com/a/..', // traversal
    'https://github.com/a/-rf', // option-looking name
    'https://github.com/a/node_modules',
    'https://github.com/a/local', // the other plugin sources
    'https://github.com/a/builtin',
    'https://github.com/',
  ]) {
    assert.ok('error' in parseRepoUrl(bad), bad);
  }
});

test('validRef: branches and tags, but nothing option-like', () => {
  for (const ok of ['main', 'v1.2.3', 'feature/x', 'a1b2c3d']) assert.ok(validRef(ok), ok);
  for (const bad of ['-x', '--upload-pack=evil', 'a..b', '', 'has space']) assert.ok(!validRef(bad), bad);
});

test('package.json metadata: the bitbot block, npm fields, and what makes it a plugin', () => {
  const full = parseMeta(
    JSON.stringify({
      name: 'bitbot-plugin-x',
      version: '2.0.0',
      description: 'Does x',
      author: { name: 'someone' },
      repository: { type: 'git', url: 'https://example.com/x' },
      dependencies: { sharp: '^1' },
      bitbot: {
        api: '0.4',
        id: 'x',
        title: 'Ex',
        roles: ['x-host'],
        cooldown: { seconds: 60, per: 'guild' },
        config: { channel: { type: 'id', description: 'Where', perGuild: true } },
        allowScripts: ['sharp', '@img/sharp-linux-x64'],
      },
    }),
  );
  assert.deepEqual(full, {
    meta: {
      id: 'x',
      title: 'Ex',
      version: '2.0.0',
      author: 'someone',
      description: 'Does x',
      repository: 'https://example.com/x',
      api: '0.4',
      roles: ['x-host'],
      cooldown: { seconds: 60, per: 'guild' },
      config: { channel: { type: 'id', description: 'Where', perGuild: true } },
      allowScripts: ['sharp', '@img/sharp-linux-x64'],
      hasDependencies: true,
    },
  });
  // Defaults: title is the id, version 0.0.0.
  const min = parseMeta(JSON.stringify({ bitbot: { id: 'y' } }));
  assert.ok(min && 'meta' in min && min.meta.title === 'y' && min.meta.version === '0.0.0' && !min.meta.hasDependencies);

  // Not plugins: no file, no "bitbot" object.
  assert.equal(parseMeta(null), null);
  assert.equal(parseMeta(JSON.stringify({ name: 'lib' })), null);
  assert.equal(parseMeta('{ not json'), null);

  // Plugins that can't load, with the reason.
  const problem = (block: unknown) => {
    const r = parseMeta(typeof block === 'string' ? block : JSON.stringify({ bitbot: block }));
    return r && 'problem' in r ? r.problem : null;
  };
  assert.match(problem('{ "bitbot": { "id": "x", }')!, /isn't valid JSON/);
  assert.match(problem({})!, /bitbot.id/);
  assert.match(problem({ id: 'Has Caps' })!, /bitbot.id/);
  assert.match(problem({ id: 'core' })!, /reserved/);
  assert.match(problem({ id: 'x', roles: ['Bad Role'] })!, /bitbot.roles/);
  assert.match(problem({ id: 'x', cooldown: 'often' })!, /bitbot.cooldown/);
  assert.match(problem({ id: 'x', config: { k: { type: 'date', description: '' } } })!, /"type" must be one of/);
  assert.match(problem({ id: 'x', config: { k: { type: 'string' } } })!, /needs a "description"/);
  assert.match(problem({ id: 'x', config: { k: { type: 'string', description: '', secrett: true } } })!, /unknown field "secrett"/);
  assert.match(problem({ id: 'x', config: { k: { type: 'string', description: '', env: true } } })!, /"env" is a variable name/);
  assert.match(problem({ id: 'x', allowScripts: ['--evil'] })!, /allowScripts/);
  assert.match(problem({ id: 'x', title: 'x'.repeat(65) })!, /longer than 64/);
});

test('findPluginFolders: builtin, local, and only the managed repos', async () => {
  await plugin(join(root, 'local', 'mine'), 'mine');
  await plugin(join(root, 'local', 'noindex'), 'noindex', { index: false });
  await plugin(join(root, 'local', 'lib'), 'lib', { meta: JSON.stringify({ name: 'not-a-plugin' }) });
  await plugin(join(root, 'local', '.hidden'), 'hidden');
  await makeRepo(join(root, 'repos', 'stray')); // not in the database: ignored
  const found = await findPluginFolders();
  assert.deepEqual(
    found.map((f) => [f.path, f.source, f.problem ?? null]),
    [
      ['builtin/invite', 'builtin', null],
      ['builtin/ping', 'builtin', null],
      ['local/mine', 'local', null],
      ['local/noindex', 'local', 'no index.ts'],
    ],
  );
  assert.equal((await findPlugin('mine', found)).path, 'local/mine'); // by id or folder name
  await assert.rejects(findPlugin('nope', found), /no plugin `nope`/);
});

test('default plugins are enabled once per database, so disabling one sticks', async () => {
  await seedDefaults();
  assert.deepEqual([...(await enabledPaths())], ['builtin/ping']);
  await disablePlugin('builtin/ping');
  await seedDefaults();
  assert.deepEqual([...(await enabledPaths())], []);
});

test('the allowlist: enable and disable by path; refused when broken, already on, or its id is taken', async () => {
  const found = await findPluginFolders();
  const mine = await findPlugin('local/mine', found);
  await enablePlugin(mine, 't');
  await assert.rejects(enablePlugin(mine, 't'), /already enabled/);
  await assert.rejects(enablePlugin(await findPlugin('noindex', found), 't'), /can't load: no index.ts/);
  // A second copy with the same id (a dev copy of a published plugin) can't be enabled alongside.
  await plugin(join(root, 'local', 'mine-dev'), 'mine');
  await assert.rejects(enablePlugin(await findPlugin('local/mine-dev'), 't'), /same id .*disable it first/);
  await disablePlugin('local/mine');
  await assert.rejects(disablePlugin('local/mine'), /isn't enabled/);
  assert.deepEqual(findDuplicateIds([{ path: 'local/mine', id: 'mine' }, { path: 'local/mine-dev', id: 'mine' }, { path: 'local/x', id: 'x' }]), new Map([
    ['local/mine', 'the id "mine" is used by local/mine and local/mine-dev (enable only one)'],
    ['local/mine-dev', 'the id "mine" is used by local/mine and local/mine-dev (enable only one)'],
  ]));
});

test('startup repair: a repo clone is put back to the recorded commit, with local changes discarded', async () => {
  const dir = join(root, 'repos', 'kept');
  const first = await makeRepo(dir);
  await db.insertInto('plugin_repos').values({ name: 'kept', url: 'https://example.invalid/kept', ref: '', commit: first, updated_at: 'x', updated_by: null }).execute();
  await db.insertInto('plugins_enabled').values({ path: 'kept/one', enabled_at: 'x', enabled_by: null }).execute();
  // A local edit, an untracked file, and a newer commit checked out.
  await writeFile(join(dir, 'one', 'index.ts'), 'edited');
  await writeFile(join(dir, 'one', 'extra.ts'), 'new');
  await prepareRepos();
  assert.equal(await readFile(join(dir, 'one', 'index.ts'), 'utf8'), 'export default () => ({ commands: [] });\n');
  assert.ok(!(await exists(join(dir, 'one', 'extra.ts'))));

  await writeFile(join(dir, 'two', 'index.ts'), 'v2');
  await git(dir, 'commit', '--quiet', '-am', 'second');
  await prepareRepos();
  assert.equal(await git(dir, 'rev-parse', 'HEAD'), first);
});

test('startup repair: a missing clone is rebuilt from its URL at the recorded commit', async () => {
  const source = join(root, '..', `${root.split('/').pop()}-source`);
  const first = await makeRepo(source);
  await plugin(join(source, 'three'), 'three');
  await git(source, 'add', '.');
  await git(source, 'commit', '--quiet', '-m', 'add three');
  // Recorded at the first commit; the source has moved on since.
  await db.insertInto('plugin_repos').values({ name: 'fresh', url: source, ref: '', commit: first, updated_at: 'x', updated_by: null }).execute();
  await prepareRepos();
  const dir = join(root, 'repos', 'fresh');
  assert.equal(await git(dir, 'rev-parse', 'HEAD'), first);
  assert.ok(!(await exists(join(dir, 'three'))));
  assert.ok(!(await exists(join(root, 'repos', '.staging-fresh'))));
});

test('removing a repo forgets it and its plugins\' allowlist entries', async () => {
  await repos.removeRepo('kept');
  assert.ok(!(await exists(join(root, 'repos', 'kept'))));
  assert.ok(!(await repoRows()).some((r) => r.name === 'kept'));
  assert.ok(!(await enabledPaths()).has('kept/one'));
});

test('repair never reaches a checkout that PLUGINS_DIR sits in (the dev checkout)', async () => {
  // The scratch root becomes a git checkout with uncommitted work, like ~/Projects/bitbot around plugins/.
  await writeFile(join(root, '.gitignore'), 'repos/\n');
  await writeFile(join(root, 'work.ts'), 'committed\n');
  await git(root, 'init', '--quiet');
  await git(root, 'add', '.gitignore', 'work.ts');
  await git(root, 'commit', '--quiet', '-m', 'parent');
  await writeFile(join(root, 'work.ts'), 'UNCOMMITTED WORK\n');
  // A managed repo whose folder lost its .git, and can't be re-cloned.
  await mkdir(join(root, 'repos', 'broken'), { recursive: true });
  await db.insertInto('plugin_repos').values({ name: 'broken', url: join(root, 'no-such-repo'), ref: '', commit: '', updated_at: 'x', updated_by: null }).execute();
  await prepareRepos();
  assert.equal(await readFile(join(root, 'work.ts'), 'utf8'), 'UNCOMMITTED WORK\n');
  assert.equal((await repoRows()).find((r) => r.name === 'broken')!.commit, '', "the parent's commit isn't recorded");
  await db.deleteFrom('plugin_repos').where('name', '=', 'broken').execute();
});

test("repair keeps installed dependencies even when the repo doesn't ignore node_modules", async () => {
  const dir = join(root, 'repos', 'noignore');
  await plugin(join(dir, 'p'), 'p', { meta: JSON.stringify({ dependencies: { x: '1' }, bitbot: { api: '0.4', id: 'p' } }) });
  await git(dir, 'init', '--quiet');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '--quiet', '-m', 'first');
  await db.insertInto('plugin_repos').values({ name: 'noignore', url: 'https://example.invalid/x', ref: '', commit: await git(dir, 'rev-parse', 'HEAD'), updated_at: 'x', updated_by: null }).execute();
  await mkdir(join(dir, 'p', 'node_modules', 'x'), { recursive: true });
  await writeFile(join(dir, 'p', 'node_modules', 'x', 'index.js'), '');
  await prepareRepos();
  await prepareRepos();
  assert.ok(await exists(join(dir, 'p', 'node_modules', 'x', 'index.js')));
  await repos.removeRepo('noignore');
});

test('findClashes: every plugin involved in a command clash is disabled', () => {
  const p = (path: string, ...cmds: string[]) => ({ path, commands: cmds.map((name) => ({ name, description: '' })) });
  const clashes = findClashes([p('a/dice', 'roll'), p('b/dice2', 'roll'), p('a/fine', 'fine'), p('a/sneaky', 'help')], new Set(['help']));
  assert.deepEqual([...clashes.keys()].sort(), ['a/dice', 'a/sneaky', 'b/dice2']);
  assert.match(clashes.get('a/dice')!, /roll.*a\/dice and b\/dice2/);
  assert.match(clashes.get('a/sneaky')!, /core command/);
});

test('role-gated plugin commands are mounted under !root / !admin, and clash checks see the full path', () => {
  assert.equal(pathOf({ name: 'access', description: '', requiredRole: 'admin' }), 'admin access');
  assert.equal(pathOf({ name: 'nuke', description: '', requiredRole: 'root' }), 'root nuke');
  assert.equal(pathOf({ name: 'lotto', description: '', requiredRole: 'lotto-host' }), 'lotto'); // custom roles stay top-level
  const p = (path: string, ...cmds: { name: string; requiredRole?: string }[]) => ({ path, commands: cmds.map((c) => ({ ...c, description: '' })) });
  const clashes = findClashes(
    [p('a/sync', { name: 'config', requiredRole: 'admin' }), p('b/fine', { name: 'config' }), p('c/x', { name: 'access', requiredRole: 'admin' })],
    new Set(['help', 'admin', 'admin config']),
  );
  assert.match(clashes.get('a/sync')!, /admin config.*core command/);
  assert.ok(!clashes.has('b/fine')); // top-level "config" doesn't clash with "admin config"
  assert.ok(!clashes.has('c/x'));
});

test('command names that can never be typed are reported, at any depth', () => {
  const c = (name: string, ...subcommands: { name: string; description: string }[]) => ({ name, description: '', subcommands });
  assert.deepEqual(badCommandNames([c('ping'), c('roll-dice'), c('access', c('sync'))]), []);
  assert.deepEqual(badCommandNames([c('Ping'), c('two words'), c('access', c('Sync')), c('')]), ['"Ping"', '"two words"', '"access Sync"', '""']);
});
