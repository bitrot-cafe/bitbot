import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// config.ts reads PLUGINS_DIR at import, so point it at a scratch folder first.
const root = await mkdtemp(join(tmpdir(), 'bitbot-plugins-'));
process.env.PLUGINS_DIR = root;
const { findPluginFolders, parseRepoUrl, readManifest, validRef, writeManifest } = await import('./repos.js');
const { findClashes } = await import('./commands.js');

test('parseRepoUrl: accepts https and derives the folder name', () => {
  assert.deepEqual(parseRepoUrl('https://github.com/bitrot-cafe/bitbot-plugins'), {
    name: 'bitbot-plugins',
    url: 'https://github.com/bitrot-cafe/bitbot-plugins',
  });
  assert.equal((parseRepoUrl('https://example.com/a/Cool.Plugins.git/') as { name: string }).name, 'cool.plugins');
});

test('parseRepoUrl: rejects unsafe URLs', () => {
  for (const bad of [
    'http://github.com/a/b', // not https
    'git@github.com:a/b.git', // ssh / not a URL
    'https://user:pass@github.com/a/b', // credentials
    'https://github.com/a/..', // traversal
    'https://github.com/a/-rf', // option-looking name
    'https://github.com/a/node_modules',
    'https://github.com/',
  ]) {
    assert.ok('error' in parseRepoUrl(bad), bad);
  }
});

test('validRef: branches, tags and commits, but nothing option-like', () => {
  for (const ok of ['main', 'v1.2.3', 'feature/x', 'a1b2c3d']) assert.ok(validRef(ok), ok);
  for (const bad of ['-x', '--upload-pack=evil', 'a..b', '', 'has space']) assert.ok(!validRef(bad), bad);
});

test('findPluginFolders: top-level plugins, plugins inside repos, skips the rest', async () => {
  const make = async (path: string, file = 'index.ts') => {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, file), '');
  };
  await make('solo');
  await make('repo/one');
  await make('repo/two');
  await make('repo/docs', 'README.md'); // not a plugin
  await make('repo/node_modules/dep'); // skipped
  await make('.hidden'); // skipped
  await make('empty-repo/notes', 'x.md'); // repo with no plugins
  // A folder of plugins is a repo whether or not plugins.json lists it, so its plugins need enabling.
  assert.deepEqual(
    (await findPluginFolders(root)).map((f) => [f.id, f.source]),
    [
      ['repo/one', 'repo'],
      ['repo/two', 'repo'],
      ['solo', undefined],
    ],
  );
  await writeManifest([{ name: 'repo', url: 'https://example.com/a/repo', enabled: [] }]);
  assert.deepEqual(
    (await findPluginFolders(root)).map((f) => [f.id, f.source]),
    [
      ['repo/one', 'repo'],
      ['repo/two', 'repo'],
      ['solo', undefined],
    ],
  );
  await writeManifest([]);
});

test('manifest: missing file is empty; round-trips; rejects garbage', async () => {
  assert.deepEqual(await readManifest(), []);
  const entries = [{ name: 'bitbot-plugins', url: 'https://github.com/bitrot-cafe/bitbot-plugins', ref: 'main', enabled: [] }];
  await writeManifest(entries);
  assert.deepEqual(await readManifest(), entries);
  await writeFile(join(root, 'plugins.json'), '{"not":"a list"}');
  await assert.rejects(readManifest(), /must be a list/);
});

test('findClashes: every plugin involved in a clash is disabled', () => {
  const plugin = (id: string, ...cmds: string[]) => ({
    id,
    name: id,
    version: '1',
    author: 'x',
    commands: cmds.map((name) => ({ name, description: '' })),
  });
  const clashes = findClashes(
    [
      plugin('a/dice', 'roll'),
      plugin('b/dice2', 'roll'), // same command as a/dice
      plugin('a/fine', 'fine'),
      plugin('a/sneaky', 'help'), // core command
      plugin('a/twin', 'x'),
      plugin('b/twin', 'y'), // same plugin name across repos
    ],
    new Set(['help', 'ping']),
  );
  assert.deepEqual([...clashes.keys()].sort(), ['a/dice', 'a/sneaky', 'a/twin', 'b/dice2', 'b/twin']);
  assert.match(clashes.get('a/dice')!, /roll.*a\/dice and b\/dice2/);
  assert.match(clashes.get('a/sneaky')!, /core command/);
  assert.match(clashes.get('b/twin')!, /plugin name "twin"/);
  assert.ok(!clashes.has('a/fine'));
});

test('opt-in: repo plugins load only when enabled; loose folders always', async () => {
  const { disablePlugin, enablePlugin, enabledFilter, finishAdd } = await import('./repos.js');
  // Folders from the scan test: solo/ (loose), repo/one, repo/two, empty-repo/.

  await writeManifest([]);
  await finishAdd({ name: 'repo', url: 'https://example.com/a/repo' });
  assert.deepEqual((await readManifest())[0].enabled, []); // adding enables nothing
  let loads = await enabledFilter();
  assert.deepEqual((await findPluginFolders(root)).filter(loads).map((f) => f.id), ['solo']);

  await enablePlugin('one'); // short name, unambiguous
  loads = await enabledFilter();
  assert.deepEqual((await findPluginFolders(root)).filter(loads).map((f) => f.id), ['repo/one', 'solo']);
  await assert.rejects(enablePlugin('repo/one'), /already enabled/);
  await assert.rejects(enablePlugin('nope'), /no plugin `nope`/);

  await disablePlugin('repo/one');
  assert.deepEqual((await readManifest())[0].enabled, []);
  await assert.rejects(disablePlugin('one'), /isn't enabled/);
});

test('a managed repo with index.ts at its root is one opt-in plugin, not a loose one', async () => {
  const { enabledFilter, enablePlugin } = await import('./repos.js');
  await mkdir(join(root, 'single'), { recursive: true });
  await writeFile(join(root, 'single', 'index.ts'), '');
  await mkdir(join(root, 'single', 'lib'), { recursive: true });
  await writeFile(join(root, 'single', 'lib', 'index.ts'), ''); // not a second plugin
  await writeManifest([{ name: 'single', url: 'https://example.com/a/single', enabled: [] }]);

  const single = (await findPluginFolders(root)).filter((f) => f.id.startsWith('single'));
  assert.deepEqual(single.map((f) => [f.id, f.source]), [['single', 'single']]);
  let loads = await enabledFilter();
  assert.ok(!single.some(loads), 'not loaded until enabled');
  await enablePlugin('single');
  loads = await enabledFilter();
  assert.ok(single.every(loads));

  // Unlisted, the same folder is a loose plugin (placing it is opting in), as before v0.3.
  await writeManifest([]);
  assert.deepEqual((await findPluginFolders(root)).find((f) => f.id === 'single')?.source, undefined);
  // An unlisted folder of plugins (a stray clone) loads nothing.
  loads = await enabledFilter();
  assert.ok(!(await findPluginFolders(root)).some((f) => f.id.startsWith('repo/') && loads(f)));

});

test('package.json metadata: api, roles and cooldown; malformed blocks are reported', async () => {
  const { declaredMeta } = await import('./repos.js');
  assert.deepEqual(declaredMeta(JSON.stringify({ bitbot: { api: '0.3', roles: ['access-sync-operator'], cooldown: { seconds: 60, per: 'guild' } } })), {
    api: '0.3',
    roles: ['access-sync-operator'],
    cooldown: { seconds: 60, per: 'guild' },
  });
  assert.deepEqual(declaredMeta(null), { api: undefined, roles: undefined, cooldown: undefined });
  assert.match(declaredMeta(JSON.stringify({ bitbot: { roles: ['Bad Role'] } })).problem!, /bitbot.roles/);
  assert.match(declaredMeta(JSON.stringify({ bitbot: { cooldown: 'often' } })).problem!, /bitbot.cooldown/);
});

test('role-gated plugin commands are mounted under !root / !admin, and clash checks see the full path', async () => {
  const { pathOf, findClashes } = await import('./commands.js');
  assert.equal(pathOf({ name: 'access', description: '', requiredRole: 'admin' }), 'admin access');
  assert.equal(pathOf({ name: 'nuke', description: '', requiredRole: 'root' }), 'root nuke');
  assert.equal(pathOf({ name: 'lotto', description: '', requiredRole: 'lotto-host' }), 'lotto'); // custom roles stay top-level
  const plugin = (id: string, ...cmds: { name: string; requiredRole?: string }[]) => ({
    id,
    name: id,
    version: '1',
    author: 'x',
    commands: cmds.map((c) => ({ ...c, description: '' })),
  });
  const clashes = findClashes(
    [plugin('a/sync', { name: 'config', requiredRole: 'admin' }), plugin('b/fine', { name: 'config' }), plugin('c/x', { name: 'access', requiredRole: 'admin' })],
    new Set(['help', 'admin', 'admin config']),
  );
  assert.match(clashes.get('a/sync')!, /admin config.*core command/);
  assert.ok(!clashes.has('b/fine')); // top-level "config" doesn't clash with "admin config"
  assert.ok(!clashes.has('c/x'));
});

test('command names that can never be typed are reported, at any depth', async () => {
  const { badCommandNames } = await import('./commands.js');
  const c = (name: string, ...subcommands: { name: string; description: string }[]) => ({ name, description: '', subcommands });
  assert.deepEqual(badCommandNames([c('ping'), c('roll-dice'), c('access', c('sync'))]), []);
  assert.deepEqual(badCommandNames([c('Ping'), c('two words'), c('access', c('Sync')), c('')]), ['"Ping"', '"two words"', '"access Sync"', '""']);
});
