import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Db } from './db/index.js';

// Nothing here touches PLUGINS_DIR, but point it at scratch anyway (see repos.test.ts).
const root = await mkdtemp(join(tmpdir(), 'bitbot-deps-'));
process.env.PLUGINS_DIR = root;
const { migrate, openDb, setDb } = await import('./db/index.js');
const { approve, depsState, describeDeps, install, isApproved, parseLock } = await import('./deps.js');
const { parseMeta } = await import('./plugin-meta.js');

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

/** A registry entry, as npm writes it. */
const reg = (name: string, version: string, extra: object = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`,
  integrity: 'sha512-AAAA',
  ...extra,
});
const LOCK = JSON.stringify({
  name: 'p',
  lockfileVersion: 3,
  packages: {
    '': { name: 'p', dependencies: { sharp: '^0.35.5', tiny: '^1' }, devDependencies: { typescript: '^5' } },
    'node_modules/sharp': reg('sharp', '0.35.5', { hasInstallScript: true }),
    'node_modules/@img/sharp-linux-x64': reg('@img/sharp-linux-x64', '0.35.5', { optional: true }),
    'node_modules/tiny': reg('tiny', '1.0.2'),
    'node_modules/tiny/node_modules/evil': reg('evil', '6.6.6', { hasInstallScript: true }),
    'node_modules/tiny/node_modules/bundled': { version: '1.0.0', inBundle: true },
    'node_modules/typescript': { version: '5.0.0', dev: true, hasInstallScript: true },
    'node_modules/local-thing': { link: true, resolved: '../thing' },
  },
});

test('lockfile: direct dependencies, production package count, and which install scripts run', () => {
  const info = parseLock(LOCK, ['sharp']);
  assert.deepEqual(info.direct, [{ name: 'sharp', version: '0.35.5' }, { name: 'tiny', version: '1.0.2' }]);
  assert.equal(info.total, 5); // dev and linked packages don't count
  assert.deepEqual(info.scripts, ['evil', 'sharp']); // nested ones count; dev ones don't install
  assert.deepEqual(info.allowed, ['sharp']);
  assert.match(info.lockHash, /^[0-9a-f]{64}$/);
  const text = describeDeps('local/p', info);
  assert.match(text, /`sharp@0\.35\.5`, `tiny@1\.0\.2` \(5 packages in total\)/);
  assert.match(text, /will run\*\*: `sharp`/);
  assert.match(text, /won't run.*`evil`/);

  assert.throws(() => parseLock('nope'), /isn't valid JSON/);
  assert.throws(() => parseLock(JSON.stringify({ lockfileVersion: 1, dependencies: {} })), /too old/);
});

test('dependency state: none, no lockfile, waiting for approval, approved (install), installed', async () => {
  const dir = join(root, 'p');
  await mkdir(dir, { recursive: true });
  const pkg = JSON.stringify({ dependencies: { sharp: '^0.35.5' }, bitbot: { id: 'p', api: '0.4', allowScripts: ['sharp'] } });
  const folder = () => {
    const parsed = parseMeta(pkg);
    assert.ok(parsed && 'meta' in parsed);
    return { path: 'local/p', dir, source: 'local' as const, meta: parsed.meta, id: 'p', title: 'p' };
  };

  const noDeps = parseMeta(JSON.stringify({ bitbot: { id: 'q' } }));
  assert.ok(noDeps && 'meta' in noDeps);
  assert.deepEqual(await depsState({ path: 'local/q', dir, source: 'local', meta: noDeps.meta }), { state: 'none' });

  assert.match(((await depsState(folder())) as { problem: string }).problem, /no package-lock.json/);

  await writeFile(join(dir, 'package-lock.json'), LOCK);
  const waiting = await depsState(folder());
  assert.equal(waiting.state, 'approve');
  const { lockHash } = (waiting as { info: { lockHash: string } }).info;

  await approve('local/p', lockHash, 'root (1)');
  assert.ok(await isApproved('local/p', lockHash));
  assert.ok(!(await isApproved('local/other', lockHash)), 'approval is per path');
  assert.equal((await depsState(folder())).state, 'install');

  // Installed: the marker matches the lockfile.
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'node_modules', '.bitbot-installed'), `${lockHash}\n`);
  assert.equal((await depsState(folder())).state, 'ready');

  // A changed lockfile is asked about again, even though the old one was approved and installed.
  await writeFile(join(dir, 'package-lock.json'), LOCK.replace('1.0.2', '1.0.3'));
  assert.equal((await depsState(folder())).state, 'approve');
});

test('lockfile: git dependencies and invalid names are refused; packages from elsewhere are named', () => {
  const withPackage = (key: string, entry: object) => {
    const lock = JSON.parse(LOCK);
    lock.packages[key] = entry;
    return JSON.stringify(lock);
  };
  // npm runs a git dependency's prepare script even with --ignore-scripts.
  for (const resolved of ['git+ssh://git@github.com/a/b.git#abc', 'git+https://example.com/b.git', 'github:a/b', 'git://x/y']) {
    assert.throws(() => parseLock(withPackage('node_modules/tiny/node_modules/sneaky', { version: '1.0.0', resolved })), /git dependencies aren't supported.*: sneaky/, resolved);
  }
  // Bypasses: no `resolved` (npm falls back to package.json's spec, which may be git), a leading space
  // (npm trims), a plain http URL, and an https tarball without an integrity hash.
  for (const entry of [
    { version: '1.0.0' },
    { version: '1.0.0', resolved: ' git+file:///tmp/x.git#abc', integrity: 'sha512-A' },
    { version: '1.0.0', resolved: 'http://example.com/x.tgz', integrity: 'sha512-A' },
    { version: '1.0.0', resolved: 'https://example.com/x.tgz' },
  ]) {
    assert.throws(() => parseLock(withPackage('node_modules/sneaky', entry)), /sneaky/, JSON.stringify(entry));
  }
  assert.throws(() => parseLock(withPackage('node_modules/sneaky', { version: '1', resolved: ' git+file:///x' })), /git dependencies/);
  assert.throws(() => parseLock(withPackage('node_modules/`ping` @everyone', reg('x', '1'))), /invalid package names/);
  const info = parseLock(withPackage('node_modules/odd', { version: '1.0.0', resolved: 'https://example.com/odd-1.0.0.tgz', integrity: 'sha512-A' }));
  assert.deepEqual(info.elsewhere, ['odd (example.com)']);
  assert.match(describeDeps('local/p', info), /Not from the npm registry: `odd \(example\.com\)`/);
});

test('the approved identity is the same however the lockfile was read (git output is trimmed)', () => {
  assert.equal(parseLock(`${LOCK}\n`).lockHash, parseLock(LOCK).lockHash);
  assert.equal(parseLock(`  ${LOCK}\n\n`).lockHash, parseLock(LOCK).lockHash);
});

test('the approved identity covers allowScripts: allowing another script is asked about again', () => {
  assert.notEqual(parseLock(LOCK, []).lockHash, parseLock(LOCK, ['sharp']).lockHash);
  assert.equal(parseLock(LOCK, ['sharp']).lockHash, parseLock(LOCK, ['sharp', 'not-in-the-lockfile']).lockHash);
});

test('install (offline): scripts are off, except for packages in allowScripts', async () => {
  const sh = promisify(execFile);
  const exists = (path: string) => access(path).then(() => true, () => false);
  // A dependency whose install script leaves a file behind, packed as a tarball.
  const work = await mkdtemp(join(tmpdir(), 'bitbot-install-'));
  const dep = join(work, 'dep');
  await mkdir(dep);
  await writeFile(join(dep, 'package.json'), JSON.stringify({ name: 'dep-with-script', version: '1.0.0', scripts: { install: 'node -e "require(\'fs\').writeFileSync(\'ran\', \'\')"' } }));
  await sh('npm', ['pack', '--quiet'], { cwd: dep });
  for (const allow of [false, true]) {
    const dir = join(work, allow ? 'allowed' : 'plain');
    await mkdir(dir);
    const pkg = { name: 'p', dependencies: { 'dep-with-script': `file:${join(dep, 'dep-with-script-1.0.0.tgz')}` }, bitbot: { id: 'p', ...(allow ? { allowScripts: ['dep-with-script'] } : {}) } };
    await writeFile(join(dir, 'package.json'), JSON.stringify(pkg));
    await sh('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir });
    const parsed = parseMeta(JSON.stringify(pkg));
    assert.ok(parsed && 'meta' in parsed);
    const folder = { path: `local/${allow}`, dir, source: 'local' as const, meta: parsed.meta };
    const state = await depsState(folder);
    assert.equal(state.state, 'approve');
    const { info } = state as { info: Parameters<typeof install>[1] };
    assert.deepEqual(info.scripts, ['dep-with-script']);
    await install(folder, info);
    assert.ok(await exists(join(dir, 'node_modules', 'dep-with-script', 'package.json')));
    assert.equal(await exists(join(dir, 'node_modules', 'dep-with-script', 'ran')), allow, allow ? 'allowed script ran' : 'script must not run');
    await approve(folder.path, info.lockHash, 't');
    assert.equal((await depsState(folder)).state, 'ready');
  }
});
