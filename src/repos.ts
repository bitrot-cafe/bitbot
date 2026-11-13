import { execFile } from 'node:child_process';
import { access, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pluginsDir } from './config.js';
import { parseCooldown } from './cooldown.js';
import { createLogger } from './logger.js';
import type { Cooldown } from './plugin.js';
import { code } from './text.js';

/*
 * Plugin repos managed by the bot. Each repo is a git clone at PLUGINS_DIR/<name>, holding one or more
 * plugin folders; PLUGINS_DIR/plugins.json lists them so a fresh install can re-clone everything.
 *
 * Security: bot root can make the bot fetch and run code from any HTTPS repo. git and npm
 * are run with argument arrays (never a shell), with timeouts, and refs/URLs are validated so they
 * can't be read as command-line options.
 */

const log = createLogger('repos');
const exec = promisify(execFile);
const MANIFEST = () => join(pluginsDir, 'plugins.json');

/**
 * A managed repo. `enabled` lists the plugin folders (within the repo) to load: plugins are opt-in, so
 * adding a repo enables nothing. A repo whose root is itself a plugin (index.ts at the top) has one
 * plugin, named like the repo.
 * `commit` is the commit an administrator reviewed (on add or update); a fresh install checks it out
 * rather than whatever the branch points at now. Missing on older entries: the branch tip is used.
 */
export type RepoEntry = { name: string; url: string; ref?: string; enabled: string[]; commit?: string };
/**
 * A plugin folder and what its package.json declares under "bitbot": `api` (the bot API version it
 * needs), `roles` (bot roles it defines, for permissions.yaml), `cooldown` (default for its commands).
 * `problem`: that block is malformed (the plugin isn't loaded).
 */
export type PluginFolder = { id: string; dir: string; source?: string; api?: string; roles?: string[]; cooldown?: Cooldown; problem?: string };

// ---- Folder scan (shared with the plugin loader) -------------------------------------------------

const skipped = (name: string) => name.startsWith('.') || name === 'node_modules';
const exists = (path: string) => access(path).then(() => true, () => false);

/** The `bitbot.api` field of a package.json's text; undefined if absent or unreadable. */
export function declaredApi(packageJson: string | null): string | undefined {
  if (!packageJson) return undefined;
  try {
    const api = JSON.parse(packageJson)?.bitbot?.api;
    return typeof api === 'string' ? api : undefined;
  } catch {
    return undefined; // malformed package.json: treated as undeclared
  }
}

/** Everything a plugin's package.json declares under "bitbot" (see PluginFolder). Never throws. */
export function declaredMeta(packageJson: string | null): Pick<PluginFolder, 'api' | 'roles' | 'cooldown' | 'problem'> {
  const api = declaredApi(packageJson);
  let block: { roles?: unknown; cooldown?: unknown } | undefined;
  try {
    block = packageJson ? JSON.parse(packageJson)?.bitbot : undefined;
  } catch {
    return { api };
  }
  const problems: string[] = [];
  let roles: string[] | undefined;
  if (block?.roles !== undefined) {
    if (Array.isArray(block.roles) && block.roles.every((r) => typeof r === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(r))) roles = block.roles;
    else problems.push('"bitbot.roles" must be a list of role names (lower case letters, digits, "-")');
  }
  let cooldown: Cooldown | undefined;
  if (block?.cooldown !== undefined) {
    try {
      cooldown = parseCooldown(block.cooldown);
    } catch (error) {
      problems.push(`"bitbot.cooldown": ${(error as Error).message}`);
    }
  }
  return { api, roles, cooldown, ...(problems.length ? { problem: problems.join('; ') } : {}) };
}

const readMeta = async (dir: string) => declaredMeta(await readFile(join(dir, 'package.json'), 'utf8').catch(() => null));

async function subfolders(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && !skipped(e.name)).map((e) => e.name).sort();
}

/**
 * The plugins in one repo checked out at `dir`: the repo itself if it has an index.ts at the top (id
 * "repo"), otherwise each subfolder with an index.ts (id "repo/plugin").
 */
async function scanRepo(name: string, dir: string): Promise<PluginFolder[]> {
  if (await exists(join(dir, 'index.ts'))) return [{ id: name, dir, source: name, ...(await readMeta(dir)) }];
  const found: PluginFolder[] = [];
  for (const sub of await subfolders(dir)) {
    if (await exists(join(dir, sub, 'index.ts'))) {
      found.push({ id: `${name}/${sub}`, dir: join(dir, sub), source: name, ...(await readMeta(join(dir, sub))) });
    }
  }
  return found;
}

/**
 * Every plugin under `root`. A folder listed in plugins.json is a managed repo (see scanRepo). Any other
 * folder with an index.ts is a loose plugin, which always loads (placing it is opting in). Any other
 * folder holding plugins is treated as a repo too, so its plugins only load once enabled in plugins.json:
 * a stray clone never runs code. Dot-folders and node_modules are skipped, and so are folders with no
 * plugins. (v0.4 replaces this with separate local/ and repos/ folders and an allowlist for both.)
 */
export async function findPluginFolders(root = pluginsDir): Promise<PluginFolder[]> {
  const managed = new Set((await readManifest(root).catch(() => [])).map((e) => e.name));
  const found: PluginFolder[] = [];
  for (const name of await subfolders(root)) {
    const dir = join(root, name);
    if (managed.has(name)) {
      found.push(...(await scanRepo(name, dir)));
      continue;
    }
    if (await exists(join(dir, 'index.ts'))) {
      found.push({ id: name, dir, ...(await readMeta(dir)) });
      continue;
    }
    found.push(...(await scanRepo(name, dir)));
  }
  return found;
}

// ---- Validation ---------------------------------------------------------------------------------

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
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) || name === 'node_modules') {
    return { error: `can't use ${code(last || url.pathname)} as a folder name (letters, digits, . _ -)` };
  }
  return { name, url: url.toString() };
}

/**
 * A branch or tag name (what `git clone --branch` accepts; a commit hash isn't): no leading "-" (would be
 * read as an option) and no "..".
 */
export const validRef = (ref: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) && !ref.includes('..');

// ---- Manifest -----------------------------------------------------------------------------------

export async function readManifest(root = pluginsDir): Promise<RepoEntry[]> {
  const file = join(root, 'plugins.json');
  const text = await readFile(file, 'utf8').catch((error) => (error.code === 'ENOENT' ? '[]' : Promise.reject(error)));
  const data = JSON.parse(text);
  const valid =
    Array.isArray(data) &&
    data.every(
      (e) =>
        e &&
        typeof e.name === 'string' &&
        typeof e.url === 'string' &&
        (e.ref === undefined || typeof e.ref === 'string') &&
        (e.commit === undefined || typeof e.commit === 'string') &&
        Array.isArray(e.enabled) &&
        e.enabled.every((x: unknown) => typeof x === 'string'),
    );
  if (!valid) throw new Error(`${file} must be a list of { name, url, ref?, enabled, commit? }`);
  return data;
}

/** Write via a temp file + rename, so a crash can't leave a half-written manifest. */
export async function writeManifest(entries: RepoEntry[]) {
  const tmp = `${MANIFEST()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`);
  await rename(tmp, MANIFEST());
}

// ---- git / npm ----------------------------------------------------------------------------------

/**
 * The environment for git and npm: enough to run, without the bot's own variables (the token,
 * DATABASE_URL, settings pinned in env), so they aren't handed to a dependency's install script directly.
 * This is not isolation: install scripts run as the bot's user, so they can still read the secret files
 * (/run/secrets/*), the SQLite database, and the bot process's environment through /proc. Only enable
 * plugins whose dependencies you trust.
 */
const PASSED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' }; // never wait for a password prompt
  for (const name of PASSED_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

async function run(cmd: string, args: string[], cwd: string, timeoutMs = 120_000) {
  try {
    const { stdout } = await exec(cmd, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: childEnv(),
    });
    return stdout.trim();
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    throw new Error(`${cmd} ${args[0]} failed: ${(e.stderr || e.message).trim().split('\n').slice(-3).join(' ')}`);
  }
}

const git = (dir: string, ...args: string[]) => run('git', args, dir);
const repoDir = (name: string) => join(pluginsDir, name);

/** Plugin folder name within its repo: "bitbot-plugins/addemote" -> "addemote". */
const folderName = (id: string) => id.slice(id.indexOf('/') + 1);

/** Install production dependencies for the given plugins of a repo at `dir` (default: its enabled ones). */
async function installDeps(name: string, only?: string[], dir = repoDir(name)) {
  const wanted = only ?? (await readManifest()).find((e) => e.name === name)?.enabled ?? [];
  for (const p of (await scanRepo(name, dir)).filter((f) => wanted.includes(folderName(f.id)))) {
    if (!(await exists(join(p.dir, 'package.json')))) continue;
    // With a lockfile, `npm ci` installs exactly what the plugin's author locked.
    const ci = await exists(join(p.dir, 'package-lock.json'));
    // Without a lockfile, don't write one: an untracked package-lock.json in the clone would make git
    // refuse a later checkout once the plugin's repo commits its own.
    const args = ci ? ['ci'] : ['install', '--no-package-lock'];
    await run('npm', [...args, '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], p.dir, 300_000);
    log.info(`Installed dependencies for ${p.id}`);
  }
}

/** Clone a repo into `dir` and, if the entry records a reviewed commit, check that out. */
async function clone(entry: RepoEntry, dir = repoDir(entry.name)) {
  const args = ['clone', '--quiet', ...(entry.ref ? ['--branch', entry.ref] : []), '--', entry.url, dir];
  await run('git', args, pluginsDir, 300_000);
  if (entry.commit) await git(dir, 'checkout', '--quiet', '--detach', entry.commit);
}

/** Where `plugins add` clones before the administrator confirms. A dot-folder, so the loader never sees it. */
const stagingDir = (name: string) => join(pluginsDir, `.adding-${name}`);

/** Commit-ish to update to: the tracked branch or tag on origin, or origin's default branch. */
async function target(dir: string, ref?: string) {
  if (!ref) return git(dir, 'rev-parse', 'origin/HEAD');
  const remote = await git(dir, 'rev-parse', '--verify', '--quiet', `origin/${ref}^{commit}`).catch(() => '');
  return remote || git(dir, 'rev-parse', '--verify', `${ref}^{commit}`); // a tag or commit
}

// ---- Operations ---------------------------------------------------------------------------------

/** `head`: the short commit checked out now (null if the clone is missing). */
export type RepoStatus = RepoEntry & { head: string | null; plugins: string[] };

/** Is this plugin folder enabled? Loose folders (not in a repo) always are: placing one is opting in. */
export async function enabledFilter() {
  const manifest = await readManifest().catch(() => []);
  return (f: PluginFolder) => !f.source || !!manifest.find((e) => e.name === f.source)?.enabled.includes(folderName(f.id));
}

export async function listRepos(): Promise<RepoStatus[]> {
  const folders = await findPluginFolders();
  return Promise.all(
    (await readManifest()).map(async (e) => ({
      ...e,
      head: await git(repoDir(e.name), 'rev-parse', '--short', 'HEAD').catch(() => null),
      plugins: folders.filter((f) => f.source === e.name).map((f) => f.id),
    })),
  );
}

/** Startup: clone any repo in plugins.json that isn't on disk. Never updates; never throws. */
export async function ensureRepos() {
  // Leftovers of a `plugins add` interrupted by a restart: never confirmed, so never recorded.
  for (const e of await readdir(pluginsDir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory() && e.name.startsWith('.adding-')) await rm(join(pluginsDir, e.name), { recursive: true, force: true });
  }
  let entries: RepoEntry[];
  try {
    entries = await readManifest();
  } catch (error) {
    return log.error("Can't read plugins.json; skipping repo setup", error);
  }
  for (const entry of entries) {
    if (await exists(repoDir(entry.name))) continue;
    try {
      log.info(`Cloning plugin repo ${entry.name} from ${entry.url}`);
      await clone(entry);
      await installDeps(entry.name, entry.enabled);
    } catch (error) {
      log.error(`Couldn't set up plugin repo ${entry.name}`, error);
      await rm(repoDir(entry.name), { recursive: true, force: true });
    }
  }
}

/**
 * Step 1 of adding: clone into a staging folder and report what's in it. Nothing is recorded yet; call
 * finishAdd or abortAdd. The returned entry records the exact commit shown, which is what gets installed.
 */
export async function startAdd(rawUrl: string, ref?: string) {
  const parsed = parseRepoUrl(rawUrl);
  if ('error' in parsed) throw new Error(parsed.error);
  if (ref && !validRef(ref)) throw new Error(`${code(ref)} isn't a valid branch or tag name`);
  const name = parsed.name;
  if ((await readManifest()).some((e) => e.name === name) || (await exists(repoDir(name)))) {
    throw new Error(`plugins/${name} already exists`);
  }
  const dir = stagingDir(name);
  await rm(dir, { recursive: true, force: true }); // an earlier add of the same repo, abandoned
  await clone({ name, url: parsed.url, ...(ref ? { ref } : {}), enabled: [] }, dir);
  const entry = { name, url: parsed.url, ...(ref ? { ref } : {}), commit: await git(dir, 'rev-parse', 'HEAD') };
  const plugins = await scanRepo(name, dir);
  const commit = await git(dir, 'log', '-1', '--format=%h %s');
  return { entry, plugins: plugins.map((p) => ({ ...p, dir: join(repoDir(name), p.dir.slice(dir.length)) })), commit };
}

/** Record an added repo and move it into place. Nothing is enabled: plugins are opt-in (enablePlugin). */
export async function finishAdd(entry: Omit<RepoEntry, 'enabled'>) {
  if (await exists(stagingDir(entry.name))) await rename(stagingDir(entry.name), repoDir(entry.name));
  await writeManifest([...(await readManifest()), { ...entry, enabled: [] }]);
}

/**
 * Find a plugin in the managed repos by full id ("repo/plugin") or plugin name, if that's unambiguous.
 * Returns its repo entry and folder name.
 */
export async function findAvailable(query: string) {
  const entries = await readManifest();
  const matches = (await findPluginFolders()).filter((f) => f.source && (f.id === query || folderName(f.id) === query));
  if (matches.length === 0) throw new Error(`no plugin ${code(query)} in the managed repos (see !root plugins repos)`);
  if (matches.length > 1) throw new Error(`${code(query)} is in several repos (${matches.map((m) => m.id).join(', ')}); use the full id`);
  const folder = matches[0];
  return { folder, entry: entries.find((e) => e.name === folder.source)!, plugin: folderName(folder.id) };
}

/** Opt a plugin in: install its dependencies and record it. Takes effect after a restart. */
export async function enablePlugin(query: string) {
  const { folder, entry, plugin } = await findAvailable(query);
  if (entry.enabled.includes(plugin)) throw new Error(`${folder.id} is already enabled`);
  await installDeps(entry.name, [plugin]);
  await writeManifest((await readManifest()).map((e) => (e.name === entry.name ? { ...e, enabled: [...e.enabled, plugin] } : e)));
  return folder;
}

/** Opt a plugin out. Takes effect after a restart. */
export async function disablePlugin(query: string) {
  const { folder, entry, plugin } = await findAvailable(query);
  if (!entry.enabled.includes(plugin)) throw new Error(`${folder.id} isn't enabled`);
  await writeManifest((await readManifest()).map((e) => (e.name === entry.name ? { ...e, enabled: e.enabled.filter((p) => p !== plugin) } : e)));
  return folder;
}

export const abortAdd = (name: string) => rm(stagingDir(name), { recursive: true, force: true });

export async function removeRepo(name: string) {
  const entries = await readManifest();
  if (!entries.some((e) => e.name === name)) throw new Error(`no managed repo called ${code(name)}`);
  await rm(repoDir(name), { recursive: true, force: true });
  await writeManifest(entries.filter((e) => e.name !== name));
}

export type PendingUpdate = {
  name: string;
  from: string;
  to: string;
  count: number;
  commits: string[];
  depsChanged: boolean;
  /** Plugins as they'll be after the update (read from git, before checking out). */
  plugins: { id: string; api?: string }[];
};

/** The plugins in a repo at `commit` (as scanRepo would find them), with their declared API. */
async function pluginsAt(name: string, commit: string) {
  const dir = repoDir(name);
  if (await git(dir, 'cat-file', '-e', `${commit}:index.ts`).then(() => true, () => false)) {
    return [{ id: name, api: declaredApi(await git(dir, 'show', `${commit}:package.json`).catch(() => null)) }];
  }
  const tops = (await git(dir, 'ls-tree', '-d', '--name-only', commit)).split('\n').filter((n) => n && !skipped(n));
  const found: { id: string; api?: string }[] = [];
  for (const sub of tops) {
    const hasIndex = await git(dir, 'cat-file', '-e', `${commit}:${sub}/index.ts`).then(() => true, () => false);
    if (!hasIndex) continue;
    const pkg = await git(dir, 'show', `${commit}:${sub}/package.json`).catch(() => null);
    found.push({ id: `${name}/${sub}`, api: declaredApi(pkg) });
  }
  return found;
}

/**
 * Fetch and describe what an update would change. Repos already up to date are left out. A repo that
 * can't be fetched or read (unreachable host, deleted branch) is reported in `failed` and doesn't stop
 * the others.
 */
export async function previewUpdates(only?: string): Promise<{ pending: PendingUpdate[]; failed: { name: string; error: string }[] }> {
  const entries = (await readManifest()).filter((e) => !only || e.name === only);
  if (only && entries.length === 0) throw new Error(`no managed repo called ${code(only)}`);
  const pending: PendingUpdate[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const e of entries) {
    try {
      const update = await previewOne(e);
      if (update) pending.push(update);
    } catch (error) {
      failed.push({ name: e.name, error: (error as Error).message });
    }
  }
  return { pending, failed };
}

async function previewOne(e: RepoEntry): Promise<PendingUpdate | null> {
  {
    const dir = repoDir(e.name);
    await git(dir, 'fetch', '--quiet', '--tags', 'origin');
    const from = await git(dir, 'rev-parse', 'HEAD');
    const to = await target(dir, e.ref);
    if (from === to) return null;
    const range = `${from}..${to}`;
    return {
      name: e.name,
      from,
      to,
      count: Number(await git(dir, 'rev-list', '--count', range)),
      commits: (await git(dir, 'log', '--format=%h %s', '-n', '10', range)).split('\n').filter(Boolean),
      depsChanged: (await git(dir, 'diff', '--name-only', from, to, '--', '*package.json', '*package-lock.json')) !== '',
      plugins: await pluginsAt(e.name, to),
    };
  }
}

/**
 * Check out the previewed commits (detached, so the exact reviewed commit runs), reinstall deps if needed,
 * and record each commit in plugins.json. A repo whose dependencies fail to install is put back on its old
 * commit (and its old dependencies). Returns what was applied and what failed.
 */
export async function applyUpdates(pending: PendingUpdate[]) {
  const applied: PendingUpdate[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const u of pending) {
    const dir = repoDir(u.name);
    try {
      await git(dir, 'checkout', '--quiet', '--detach', u.to);
      if (u.depsChanged) await installDeps(u.name);
      applied.push(u);
    } catch (error) {
      failed.push({ name: u.name, error: (error as Error).message });
      log.error(`Update of ${u.name} failed; going back to ${u.from.slice(0, 7)}`, error);
      try {
        await git(dir, 'checkout', '--quiet', '--detach', u.from);
        if (u.depsChanged) await installDeps(u.name);
      } catch (rollbackError) {
        log.error(`Couldn't put ${u.name} back on ${u.from.slice(0, 7)}; check plugins/${u.name} by hand`, rollbackError);
      }
    }
  }
  if (applied.length) {
    const to = new Map(applied.map((u) => [u.name, u.to]));
    await writeManifest((await readManifest()).map((e) => (to.has(e.name) ? { ...e, commit: to.get(e.name) } : e)));
  }
  return { applied, failed };
}
