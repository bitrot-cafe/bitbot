import { execFile } from 'node:child_process';
import { access, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pluginsDir } from './config.js';
import { createLogger } from './logger.js';

/*
 * Plugin repos managed by the bot. Each repo is a git clone at PLUGINS_DIR/<name>, holding one or more
 * plugin folders; PLUGINS_DIR/plugins.json lists them so a fresh install can re-clone everything.
 *
 * Security: any bot administrator can make the bot fetch and run code from any HTTPS repo. git and npm
 * are run with argument arrays (never a shell), with timeouts, and refs/URLs are validated so they
 * can't be read as command-line options.
 */

const log = createLogger('repos');
const exec = promisify(execFile);
const MANIFEST = () => join(pluginsDir, 'plugins.json');

export type RepoEntry = { name: string; url: string; ref?: string };
/** `api`: the bot API version the plugin declares in package.json ("bitbot": { "api": "1.0" }), if any. */
export type PluginFolder = { id: string; dir: string; source?: string; api?: string };

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

const readApi = async (dir: string) => declaredApi(await readFile(join(dir, 'package.json'), 'utf8').catch(() => null));

async function subfolders(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && !skipped(e.name)).map((e) => e.name).sort();
}

/**
 * Every plugin under `root`, two levels deep: a folder with an index.ts is a plugin; one without is a
 * repo whose subfolders with an index.ts are plugins (id "repo/plugin"). Dot-folders and node_modules
 * are skipped, and so are folders with no plugins.
 */
export async function findPluginFolders(root = pluginsDir): Promise<PluginFolder[]> {
  const found: PluginFolder[] = [];
  for (const name of await subfolders(root)) {
    const dir = join(root, name);
    if (await exists(join(dir, 'index.ts'))) {
      found.push({ id: name, dir, api: await readApi(dir) });
      continue;
    }
    for (const sub of await subfolders(dir)) {
      if (await exists(join(dir, sub, 'index.ts'))) {
        found.push({ id: `${name}/${sub}`, dir: join(dir, sub), source: name, api: await readApi(join(dir, sub)) });
      }
    }
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
    return { error: `can't use "${last || url.pathname}" as a folder name (letters, digits, . _ -)` };
  }
  return { name, url: url.toString() };
}

/** A branch, tag or commit: no leading "-" (would be read as an option) and no "..". */
export const validRef = (ref: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) && !ref.includes('..');

// ---- Manifest -----------------------------------------------------------------------------------

export async function readManifest(): Promise<RepoEntry[]> {
  const text = await readFile(MANIFEST(), 'utf8').catch((error) => (error.code === 'ENOENT' ? '[]' : Promise.reject(error)));
  const data = JSON.parse(text);
  const valid =
    Array.isArray(data) &&
    data.every((e) => e && typeof e.name === 'string' && typeof e.url === 'string' && (e.ref === undefined || typeof e.ref === 'string'));
  if (!valid) throw new Error(`${MANIFEST()} must be a list of { name, url, ref? }`);
  return data;
}

/** Write via a temp file + rename, so a crash can't leave a half-written manifest. */
export async function writeManifest(entries: RepoEntry[]) {
  const tmp = `${MANIFEST()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`);
  await rename(tmp, MANIFEST());
}

// ---- git / npm ----------------------------------------------------------------------------------

async function run(cmd: string, args: string[], cwd: string, timeoutMs = 120_000) {
  try {
    const { stdout } = await exec(cmd, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // never wait for a password prompt
    });
    return stdout.trim();
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    throw new Error(`${cmd} ${args[0]} failed: ${(e.stderr || e.message).trim().split('\n').slice(-3).join(' ')}`);
  }
}

const git = (dir: string, ...args: string[]) => run('git', args, dir);
const repoDir = (name: string) => join(pluginsDir, name);

/** Install production dependencies for every plugin in a repo that has a package.json. */
async function installDeps(name: string) {
  for (const p of (await findPluginFolders()).filter((f) => f.source === name)) {
    if (!(await exists(join(p.dir, 'package.json')))) continue;
    await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], p.dir, 300_000);
    log.info(`Installed dependencies for ${p.id}`);
  }
}

async function clone(entry: RepoEntry) {
  const args = ['clone', '--quiet', ...(entry.ref ? ['--branch', entry.ref] : []), '--', entry.url, repoDir(entry.name)];
  await run('git', args, pluginsDir, 300_000);
}

/** Commit-ish to update to: the tracked branch or tag on origin, or origin's default branch. */
async function target(dir: string, ref?: string) {
  if (!ref) return git(dir, 'rev-parse', 'origin/HEAD');
  const remote = await git(dir, 'rev-parse', '--verify', '--quiet', `origin/${ref}^{commit}`).catch(() => '');
  return remote || git(dir, 'rev-parse', '--verify', `${ref}^{commit}`); // a tag or commit
}

// ---- Operations ---------------------------------------------------------------------------------

export type RepoStatus = RepoEntry & { commit: string | null; plugins: string[] };

export async function listRepos(): Promise<RepoStatus[]> {
  const folders = await findPluginFolders();
  return Promise.all(
    (await readManifest()).map(async (e) => ({
      ...e,
      commit: await git(repoDir(e.name), 'rev-parse', '--short', 'HEAD').catch(() => null),
      plugins: folders.filter((f) => f.source === e.name).map((f) => f.id),
    })),
  );
}

/** Startup: clone any repo in plugins.json that isn't on disk. Never updates; never throws. */
export async function ensureRepos() {
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
      await installDeps(entry.name);
    } catch (error) {
      log.error(`Couldn't set up plugin repo ${entry.name}`, error);
      await rm(repoDir(entry.name), { recursive: true, force: true });
    }
  }
}

/** Step 1 of adding: clone and report what's in it. Nothing is recorded yet; call finishAdd or abortAdd. */
export async function startAdd(rawUrl: string, ref?: string) {
  const parsed = parseRepoUrl(rawUrl);
  if ('error' in parsed) throw new Error(parsed.error);
  if (ref && !validRef(ref)) throw new Error(`"${ref}" isn't a valid branch, tag or commit`);
  const entry: RepoEntry = { name: parsed.name, url: parsed.url, ...(ref ? { ref } : {}) };
  if ((await readManifest()).some((e) => e.name === entry.name) || (await exists(repoDir(entry.name)))) {
    throw new Error(`plugins/${entry.name} already exists`);
  }
  await clone(entry);
  const plugins = (await findPluginFolders()).filter((f) => f.source === entry.name);
  const commit = await git(repoDir(entry.name), 'log', '-1', '--format=%h %s');
  return { entry, plugins, commit };
}

export async function finishAdd(entry: RepoEntry) {
  await installDeps(entry.name);
  await writeManifest([...(await readManifest()), entry]);
}

export const abortAdd = (name: string) => rm(repoDir(name), { recursive: true, force: true });

export async function removeRepo(name: string) {
  const entries = await readManifest();
  if (!entries.some((e) => e.name === name)) throw new Error(`no managed repo called "${name}"`);
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

/** The plugin folders in a repo at `commit` (top-level folders with an index.ts), with their declared API. */
async function pluginsAt(name: string, commit: string) {
  const dir = repoDir(name);
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

/** Fetch and describe what an update would change. Repos already up to date are left out. */
export async function previewUpdates(only?: string): Promise<PendingUpdate[]> {
  const entries = (await readManifest()).filter((e) => !only || e.name === only);
  if (only && entries.length === 0) throw new Error(`no managed repo called "${only}"`);
  const pending: PendingUpdate[] = [];
  for (const e of entries) {
    const dir = repoDir(e.name);
    await git(dir, 'fetch', '--quiet', '--tags', 'origin');
    const from = await git(dir, 'rev-parse', 'HEAD');
    const to = await target(dir, e.ref);
    if (from === to) continue;
    const range = `${from}..${to}`;
    pending.push({
      name: e.name,
      from,
      to,
      count: Number(await git(dir, 'rev-list', '--count', range)),
      commits: (await git(dir, 'log', '--format=%h %s', '-n', '10', range)).split('\n').filter(Boolean),
      depsChanged: (await git(dir, 'diff', '--name-only', from, to, '--', '*package.json', '*package-lock.json')) !== '',
      plugins: await pluginsAt(e.name, to),
    });
  }
  return pending;
}

/** Check out the previewed commits (detached, so the exact reviewed commit runs) and reinstall deps if needed. */
export async function applyUpdates(pending: PendingUpdate[]) {
  for (const u of pending) {
    await git(repoDir(u.name), 'checkout', '--quiet', '--detach', u.to);
    if (u.depsChanged) await installDeps(u.name);
  }
}
