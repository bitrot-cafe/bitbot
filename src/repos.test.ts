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
  const found = await findPluginFolders(root);
  assert.deepEqual(
    found.map((f) => [f.id, f.source]),
    [
      ['repo/one', 'repo'],
      ['repo/two', 'repo'],
      ['solo', undefined],
    ],
  );
});

test('manifest: missing file is empty; round-trips; rejects garbage', async () => {
  assert.deepEqual(await readManifest(), []);
  const entries = [{ name: 'bitbot-plugins', url: 'https://github.com/bitrot-cafe/bitbot-plugins', ref: 'main' }];
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
