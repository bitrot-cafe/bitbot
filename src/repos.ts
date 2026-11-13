import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from './build.js';
import { appRoot, pluginsDir } from './config.js';
import { db } from './db/index.js';
import { runCommand } from './exec.js';
import { parseLock, type DepsInfo } from './deps.js';
import { coreSettings } from './core-settings.js';
import { createLogger } from './logger.js';
import { parseMeta, type PluginMeta } from './plugin-meta.js';
import { code } from './text.js';

/*
 * Where plugins come from, and which ones load.
 *
 *   builtin/<plugin>            shipped in the image, versioned with the core (read-only)
 *   PLUGINS_DIR/local/<plugin>  yours: the bot only installs approved dependencies here (node_modules)
 *   PLUGINS_DIR/repos/<repo>/   git clones the bot manages: disposable, rebuilt from the database
 *
 * A plugin's path is its allowlist entry: "builtin/ping", "local/mine", "bitbot-plugins/whoami" (or just
 * "<repo>" when the repo is itself one plugin). Only paths in the allowlist (plugins_enabled) load.
 *
 * Security: bot root can make the bot fetch and run code from any HTTPS repo. git and npm are run with
 * argument arrays (never a shell), with timeouts, and refs/URLs are validated so they can't be read as
 * command-line options.
 */

const log = createLogger('repos');

export const builtinDir = join(appRoot, 'builtin');
export const localDir = join(pluginsDir, 'local');
export const reposDir = join(pluginsDir, 'repos');
/** Repo names that would collide with the other plugin sources. */
const RESERVED_REPOS = new Set(['local', 'builtin', 'node_modules']);

export type PluginSource = 'builtin' | 'local' | 'repo';

/**
 * A plugin folder. `meta` when its package.json is sound; otherwise `problem` (it's listed, never loaded),
 * with whatever id and title could be read.
 */
export type PluginFolder = {
  path: string;
  dir: string;
  source: PluginSource;
  /** The repo it's in (source "repo"). */
  repo?: string;
  meta?: PluginMeta;
  problem?: string;
  id?: string;
  title?: string;
};

export type RepoRow = { name: string; url: string; ref: string; commit: string };

// ---- Folder scan ----------------------------------------------------------------------------------

const skipped = (name: string) => name.startsWith('.') || name === 'node_modules';
const exists = (path: string) => access(path).then(() => true, () => false);

async function subfolders(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && !skipped(e.name)).map((e) => e.name).sort();
}

/** The plugin in `dir`, or null if it isn't one (no package.json with a "bitbot" object). */
async function readFolder(dir: string, path: string, source: PluginSource, repo?: string): Promise<PluginFolder | null> {
  const parsed = parseMeta(await readFile(join(dir, 'package.json'), 'utf8').catch(() => null));
  if (!parsed) return null;
  const base = { path, dir, source, ...(repo ? { repo } : {}) };
  if ('meta' in parsed) {
    if (!(await exists(join(dir, 'index.ts')))) return { ...base, id: parsed.meta.id, title: parsed.meta.title, problem: 'no index.ts' };
    // Built-ins are versioned with the core.
    const meta = source === 'builtin' ? { ...parsed.meta, version: build.version } : parsed.meta;
    return { ...base, meta, id: meta.id, title: meta.title };
  }
  return { ...base, ...parsed };
}

/** The plugins in one repo checked out at `dir`: the repo itself if it's a plugin, else each subfolder that is. */
export async function scanRepo(name: string, dir: string): Promise<PluginFolder[]> {
  const root = await readFolder(dir, name, 'repo', name);
  if (root) return [root];
  const found: PluginFolder[] = [];
  for (const sub of await subfolders(dir)) {
    const p = await readFolder(join(dir, sub), `${name}/${sub}`, 'repo', name);
    if (p) found.push(p);
  }
  return found;
}

async function scanFlat(dir: string, prefix: 'builtin' | 'local'): Promise<PluginFolder[]> {
  const found: PluginFolder[] = [];
  for (const sub of await subfolders(dir)) {
    const p = await readFolder(join(dir, sub), `${prefix}/${sub}`, prefix);
    if (p) found.push(p);
  }
  return found;
}

/** Every plugin the bot can see: builtin, local, and the managed repos (folders in repos/ it doesn't manage are ignored). */
export async function findPluginFolders(): Promise<PluginFolder[]> {
  const repos = await repoRows().catch(() => []);
  const found = [...(await scanFlat(builtinDir, 'builtin')), ...(await scanFlat(localDir, 'local'))];
  for (const r of repos) found.push(...(await scanRepo(r.name, repoDir(r.name))));
  return found;
}

/**
 * Find a plugin by path ("bitbot-plugins/whoami"), id ("whoami") or folder name, if that's unambiguous.
 * Throws a readable reason.
 */
export async function findPlugin(query: string, folders?: PluginFolder[], prefix = coreSettings.prefix()): Promise<PluginFolder> {
  const all = folders ?? (await findPluginFolders());
  const exact = all.find((f) => f.path === query);
  if (exact) return exact;
  const matches = all.filter((f) => f.id === query || f.path.split('/').pop() === query);
  if (matches.length === 0) throw new Error(`no plugin ${code(query)} (see \`${prefix}root plugins list\`)`);
  if (matches.length > 1) throw new Error(`${code(query)} matches ${matches.map((m) => code(m.path)).join(', ')}; use the path`);
  return matches[0];
}

// ---- The allowlist and repo list (database) -------------------------------------------------------

export const repoRows = (): Promise<RepoRow[]> => db().selectFrom('plugin_repos').select(['name', 'url', 'ref', 'commit']).orderBy('name').execute();

export async function enabledPaths(): Promise<Set<string>> {
  return new Set((await db().selectFrom('plugins_enabled').select('path').execute()).map((r) => r.path));
}

const now = () => new Date().toISOString();

async function setRepo(row: RepoRow, by: string | null) {
  await db()
    .insertInto('plugin_repos')
    .values({ ...row, updated_at: now(), updated_by: by })
    .onConflict((oc) => oc.column('name').doUpdateSet({ url: row.url, ref: row.ref, commit: row.commit, updated_at: now(), updated_by: by }))
    .execute();
}

const allow = (path: string, by: string | null) =>
  db().insertInto('plugins_enabled').values({ path, enabled_at: now(), enabled_by: by }).onConflict((oc) => oc.column('path').doNothing()).execute();

/** A repo's plugin paths: the repo itself, or "<repo>/<plugin>". */
const inRepo = (path: string, repo: string) => path === repo || path.startsWith(`${repo}/`);

// ---- Validation ---------------------------------------------------------------------------------

/** A repo folder name: can't climb out of repos/ or look like an option. */
export const validRepoName = (name: string) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) && !name.includes('..');

/** Check a repo URL and derive its folder name. Returns { name } or { error }. */
export function parseRepoUrl(raw: string): { name: string; url: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "that isn't a URL" };
  }
  if (url.protocol !== 'https:') return { error: 'only https:// URLs are allowed' };
  if (url.username || url.password) return { error: "URLs with credentials in them aren't allowed" };
  const last = url.pathname.replace(/\/+$/, '').split('/').pop() ?? '';
  const name = last.replace(/\.git$/, '').toLowerCase();
  if (!validRepoName(name)) {
    return { error: `can't use ${code(last || url.pathname)} as a folder name (letters, digits, . _ -)` };
  }
  if (RESERVED_REPOS.has(name)) return { error: `${code(name)} is a reserved name` };
  return { name, url: url.toString() };
}

/**
 * A branch or tag name (what `git clone --branch` accepts; a commit hash isn't): no leading "-" (would be
 * read as an option) and no "..".
 */
export const validRef = (ref: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) && !ref.includes('..');

// ---- git / npm ----------------------------------------------------------------------------------

const git = (dir: string, ...args: string[]) => runCommand('git', args, dir);
export const repoDir = (name: string) => join(reposDir, name);
/** Where a clone is built before it's swapped into place. A dot-folder, so scans never see it. */
const stagingDir = (name: string) => join(reposDir, `.staging-${name}`);

/** Clone into `dir` at `commit` (or the ref's tip when commit is ''). Returns the commit checked out. */
async function clone(row: Pick<RepoRow, 'url' | 'ref' | 'commit'>, dir: string) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(reposDir, { recursive: true });
  await runCommand('git', ['clone', '--quiet', ...(row.ref ? ['--branch', row.ref] : []), '--', row.url, dir], reposDir, 300_000);
  if (row.commit) await git(dir, 'checkout', '--quiet', '--detach', row.commit);
  await ignoreInstalls(dir);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * Make the clone ignore installed dependencies whatever the repo's own .gitignore says, so repair
 * (status, clean) never counts them as local changes and deletes them.
 */
async function ignoreInstalls(dir: string) {
  const file = join(dir, '.git', 'info', 'exclude');
  const text = await readFile(file, 'utf8').catch(() => '');
  if (text.split('\n').includes('node_modules/')) return;
  await mkdir(join(dir, '.git', 'info'), { recursive: true });
  await writeFile(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}node_modules/\n`);
}

/** Commit-ish to update to: the tracked branch or tag on origin, or origin's default branch. */
async function target(dir: string, ref: string) {
  if (!ref) return git(dir, 'rev-parse', 'origin/HEAD');
  const remote = await git(dir, 'rev-parse', '--verify', '--quiet', `origin/${ref}^{commit}`).catch(() => '');
  return remote || git(dir, 'rev-parse', '--verify', `${ref}^{commit}`); // a tag
}

// ---- Startup ----

/** Built-in plugins enabled on a new bot. */
const DEFAULT_ENABLED = ['builtin/ping'];

/**
 * Enable the default plugins, once per database (a flag in kv records it), so disabling one sticks. Not
 * done by a migration: db:copy needs freshly migrated tables to be empty.
 */
export async function seedDefaults() {
  await db().transaction().execute(async (tx) => {
    const flag = { namespace: 'core', guild_id: '', user_id: '', key: 'defaults_seeded' };
    const done = await tx.selectFrom('kv').select('key').where('namespace', '=', 'core').where('key', '=', flag.key).executeTakeFirst();
    if (done) return;
    await tx.insertInto('kv').values({ ...flag, value: JSON.stringify(now()), updated_at: now() }).execute();
    for (const path of DEFAULT_ENABLED) {
      await tx.insertInto('plugins_enabled').values({ path, enabled_at: now(), enabled_by: null }).onConflict((oc) => oc.column('path').doNothing()).execute();
    }
    log.info(`Enabled the default plugins: ${DEFAULT_ENABLED.join(', ')}`);
  });
}


/** Make one repo's clone match its row: clone it if missing, discard local changes, check out the recorded commit. */
async function repairRepo(row: RepoRow) {
  const dir = repoDir(row.name);
  const head = (await exists(dir)) ? await git(dir, 'rev-parse', 'HEAD').catch(() => null) : null;
  if (head === null) {
    if (await exists(dir)) log.warn(`plugins/repos/${row.name} isn't a git clone; rebuilding it`);
    else log.info(`Cloning plugin repo ${row.name} from ${row.url}`);
    const staging = stagingDir(row.name);
    const commit = await clone(row, staging);
    await rm(dir, { recursive: true, force: true });
    await rename(staging, dir);
    if (!row.commit) await setRepo({ ...row, commit }, null);
    return; // dependencies are installed by the loader (deps.ts), once approved
  }
  await ignoreInstalls(dir); // clones made before this existed (or imported ones)
  // `git status` without ignored files, so installed node_modules stay. Dependencies themselves are the
  // loader's job (deps.ts): it reinstalls whenever the lockfile differs from what was installed.
  if (await git(dir, 'status', '--porcelain')) {
    log.warn(`plugins/repos/${row.name} had local changes; discarded them (plugins must not write into their own folder; put your own plugins in plugins/local)`);
    await git(dir, 'reset', '--quiet', '--hard');
    await git(dir, 'clean', '--quiet', '-fd');
  }
  if (!row.commit) return setRepo({ ...row, commit: head }, null);
  if (head === row.commit) return;
  log.warn(`plugins/repos/${row.name} was on ${head.slice(0, 7)}; checking out the reviewed ${row.commit.slice(0, 7)}`);
  const have = await git(dir, 'cat-file', '-e', `${row.commit}^{commit}`).then(() => true, () => false);
  if (!have) await git(dir, 'fetch', '--quiet', '--tags', 'origin');
  await git(dir, 'checkout', '--quiet', '--detach', row.commit);
}

/**
 * Startup: enable the default plugins (once per database), then make every managed repo's clone match the
 * database. Warns
 * about folders the bot doesn't manage. Never throws: a repo that can't be set up is logged and skipped.
 */
export async function prepareRepos() {
  await seedDefaults().catch((error) => log.error("Couldn't enable the default plugins", error));
  for (const name of await subfolders(pluginsDir)) {
    if (name !== 'local' && name !== 'repos') log.warn(`plugins/${name} isn't loaded: put your own plugins in plugins/local/${name}`);
  }
  for (const e of await readdir(reposDir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory() && e.name.startsWith('.staging-')) await rm(join(reposDir, e.name), { recursive: true, force: true });
  }
  let rows: RepoRow[];
  try {
    rows = await repoRows();
  } catch (error) {
    return log.error("Can't read the plugin repos from the database; skipping repo setup", error);
  }
  const managed = new Set(rows.map((r) => r.name));
  for (const name of await subfolders(reposDir)) {
    if (!managed.has(name)) log.warn(`plugins/repos/${name} isn't a managed repo; ignoring it (add it with \`${coreSettings.prefix()}root plugins add\`, or delete it)`);
  }
  for (const row of rows) {
    try {
      await repairRepo(row);
    } catch (error) {
      log.error(`Couldn't set up plugin repo ${row.name}`, error);
    }
  }
}

// ---- Operations ---------------------------------------------------------------------------------

/** `head`: the short commit checked out now (null if the clone is missing). */
export type RepoStatus = RepoRow & { head: string | null; plugins: PluginFolder[] };

export async function listRepos(): Promise<RepoStatus[]> {
  return Promise.all(
    (await repoRows()).map(async (r) => ({
      ...r,
      head: await git(repoDir(r.name), 'rev-parse', '--short', 'HEAD').catch(() => null),
      plugins: await scanRepo(r.name, repoDir(r.name)),
    })),
  );
}

/**
 * Step 1 of adding: clone into a staging folder and report what's in it. Nothing is recorded yet; call
 * finishAdd or abortAdd. The returned row records the exact commit shown, which is what gets installed.
 */
export async function startAdd(rawUrl: string, ref = '') {
  const parsed = parseRepoUrl(rawUrl);
  if ('error' in parsed) throw new Error(parsed.error);
  if (ref && !validRef(ref)) throw new Error(`${code(ref)} isn't a valid branch or tag name`);
  const { name, url } = parsed;
  if ((await repoRows()).some((r) => r.name === name)) throw new Error(`a repo called ${code(name)} is already managed`);
  const staging = stagingDir(name);
  const commit = await clone({ url, ref, commit: '' }, staging);
  const plugins = (await scanRepo(name, staging)).map((p) => ({ ...p, dir: join(repoDir(name), p.dir.slice(staging.length)) }));
  return { row: { name, url, ref, commit }, plugins, summary: await git(staging, 'log', '-1', '--format=%h %s') };
}

/** Record an added repo and move it into place. Nothing is enabled: plugins are opt-in (enablePlugin). */
export async function finishAdd(row: RepoRow, by: string) {
  await rm(repoDir(row.name), { recursive: true, force: true }); // an unmanaged leftover of the same name
  await rename(stagingDir(row.name), repoDir(row.name));
  await setRepo(row, by);
}

export const abortAdd = (name: string) => rm(stagingDir(name), { recursive: true, force: true });

/**
 * Opt a plugin in: refuse it if it can't load or another enabled plugin has its id, then record it.
 * Dependencies are approved and installed separately (deps.ts).
 */
export async function enablePlugin(p: PluginFolder, by: string) {
  const enabled = await enabledPaths();
  if (enabled.has(p.path)) throw new Error(`${code(p.path)} is already enabled`);
  if (p.problem) throw new Error(`${code(p.path)} can't load: ${p.problem}`);
  const twin = (await findPluginFolders()).find((f) => f.path !== p.path && f.id === p.id && enabled.has(f.path));
  if (twin) throw new Error(`${code(twin.path)} has the same id (${code(p.id!)}) and is enabled; disable it first`);
  await allow(p.path, by);
}

/** Opt a plugin out (by path; it may be missing from disk). Takes effect after a restart. */
export async function disablePlugin(path: string) {
  const result = await db().deleteFrom('plugins_enabled').where('path', '=', path).executeTakeFirst();
  if (!Number(result.numDeletedRows)) throw new Error(`${code(path)} isn't enabled`);
}

/** Delete a repo's clone and forget it, with its plugins' allowlist entries. Their data is kept. */
export async function removeRepo(name: string) {
  if (!(await repoRows()).some((r) => r.name === name)) throw new Error(`no managed repo called ${code(name)}`);
  await rm(repoDir(name), { recursive: true, force: true });
  const paths = [...(await enabledPaths())].filter((p) => inRepo(p, name));
  await db().transaction().execute(async (tx) => {
    await tx.deleteFrom('plugin_repos').where('name', '=', name).execute();
    if (paths.length) await tx.deleteFrom('plugins_enabled').where('path', 'in', paths).execute();
  });
}

export type PendingUpdate = {
  name: string;
  from: string;
  to: string;
  count: number;
  commits: string[];
  depsChanged: boolean;
  /** Plugins as they'll be after the update (read from git, before checking out). */
  plugins: PluginAt[];
};

/**
 * A plugin as it is at some commit. `deps`: what its lockfile installs (absent with no dependencies);
 * `problem` covers a lockfile that can't be used too.
 */
export type PluginAt = { path: string; api?: string; problem?: string; deps?: DepsInfo };

/** The plugins in a repo at `commit` (as scanRepo would find them), read from git without checking out. */
async function pluginsAt(name: string, commit: string) {
  const dir = repoDir(name);
  const at = async (path: string, sub: string): Promise<PluginAt | null> => {
    const file = (name: string) => git(dir, 'show', `${commit}:${sub ? `${sub}/` : ''}${name}`).catch(() => null);
    const parsed = parseMeta(await file('package.json'));
    if (!parsed) return null;
    if (!('meta' in parsed)) return { path, problem: parsed.problem };
    const { api, hasDependencies, allowScripts } = parsed.meta;
    if (!hasDependencies) return { path, api };
    const lock = await file('package-lock.json');
    if (lock === null) return { path, api, problem: 'it has dependencies but no package-lock.json' };
    try {
      return { path, api, deps: parseLock(lock, allowScripts) };
    } catch (error) {
      return { path, api, problem: (error as Error).message };
    }
  };
  const root = await at(name, '');
  if (root) return [root];
  const tops = (await git(dir, 'ls-tree', '-d', '--name-only', commit)).split('\n').filter((n) => n && !skipped(n));
  const found: PluginAt[] = [];
  for (const sub of tops) {
    const p = await at(`${name}/${sub}`, sub);
    if (p) found.push(p);
  }
  return found;
}

/**
 * Fetch and describe what an update would change. Repos already up to date are left out. A repo that
 * can't be fetched or read (unreachable host, deleted branch) is reported in `failed` and doesn't stop
 * the others.
 */
export async function previewUpdates(only?: string): Promise<{ pending: PendingUpdate[]; failed: { name: string; error: string }[] }> {
  const rows = (await repoRows()).filter((r) => !only || r.name === only);
  if (only && rows.length === 0) throw new Error(`no managed repo called ${code(only)}`);
  const pending: PendingUpdate[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const r of rows) {
    try {
      const dir = repoDir(r.name);
      await git(dir, 'fetch', '--quiet', '--tags', 'origin');
      const from = await git(dir, 'rev-parse', 'HEAD');
      const to = await target(dir, r.ref);
      if (from === to) continue;
      const range = `${from}..${to}`;
      pending.push({
        name: r.name,
        from,
        to,
        count: Number(await git(dir, 'rev-list', '--count', range)),
        commits: (await git(dir, 'log', '--format=%h %s', '-n', '10', range)).split('\n').filter(Boolean),
        depsChanged: (await git(dir, 'diff', '--name-only', from, to, '--', '*package.json', '*package-lock.json')) !== '',
        plugins: await pluginsAt(r.name, to),
      });
    } catch (error) {
      failed.push({ name: r.name, error: (error as Error).message });
    }
  }
  return { pending, failed };
}

/**
 * Check out the previewed commits (detached, so the exact reviewed commit runs) and record each one. A
 * repo that can't be checked out is put back on its old commit. Dependencies are installed by the loader
 * after the restart (root.ts approves the changed lockfiles root confirmed). Returns what was applied and
 * what failed.
 */
export async function applyUpdates(pending: PendingUpdate[], by: string) {
  const applied: PendingUpdate[] = [];
  const failed: { name: string; error: string }[] = [];
  const rows = new Map((await repoRows()).map((r) => [r.name, r]));
  for (const u of pending) {
    const dir = repoDir(u.name);
    try {
      await git(dir, 'checkout', '--quiet', '--detach', u.to);
      await setRepo({ ...rows.get(u.name)!, commit: u.to }, by);
      applied.push(u);
    } catch (error) {
      failed.push({ name: u.name, error: (error as Error).message });
      log.error(`Update of ${u.name} failed; going back to ${u.from.slice(0, 7)}`, error);
      try {
        await git(dir, 'checkout', '--quiet', '--detach', u.from);
      } catch (rollbackError) {
        log.error(`Couldn't put ${u.name} back on ${u.from.slice(0, 7)}; it's rebuilt at the next start`, rollbackError);
      }
    }
  }
  return { applied, failed };
}
