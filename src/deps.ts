import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readEnv } from './config.js';
import { db } from './db/index.js';
import { createLogger } from './logger.js';
import { PACKAGE } from './plugin-meta.js';
import { runCommand } from './exec.js';
import type { PluginFolder } from './repos.js';

/*
 * Plugin dependencies. Nothing is installed without root's approval:
 *
 * - A plugin with dependencies must ship a package-lock.json. What root approves is that exact lockfile
 *   plus the install scripts allowed to run (one sha256 of both), recorded per plugin path in
 *   plugin_approvals; a change to either is asked about again.
 * - Git dependencies are refused: npm runs their `prepare` script even with --ignore-scripts.
 * - Installs run with install scripts off (`npm ci --ignore-scripts`). Packages the plugin lists in
 *   "bitbot": { "allowScripts": [...] } then get their scripts run (`npm rebuild <pkg>`); nothing else does.
 * - A marker in node_modules records the lockfile hash last installed, so a start with nothing changed
 *   installs nothing, and a rebuilt clone (no node_modules) reinstalls without asking again.
 *
 * Limit: this narrows what runs at approval. A dependency's own code still runs inside the bot when the
 * plugin loads, with the bot's token and database: approving is trusting it.
 */

const log = createLogger('deps');
const MARKER = '.bitbot-installed';

/** What a plugin's lockfile says it installs. */
export type DepsInfo = {
  /** What's approved: sha256 of the lockfile and the allowed install scripts together. */
  lockHash: string;
  /** Direct dependencies, with the locked versions. */
  direct: { name: string; version: string }[];
  /** Every package installed (production only). */
  total: number;
  /** Packages that have install scripts. */
  scripts: string[];
  /** Of those, the ones the plugin allows to run. */
  allowed: string[];
  /** Packages not downloaded from the npm registry: "name (host)". */
  elsewhere: string[];
};

const REGISTRY = 'https://registry.npmjs.org/';
/** `resolved` values npm fetches with git: only used to word the refusal (see fetchable in parseLock). */
const GIT = /^(git\+|git:|ssh:|github:|gitlab:|bitbucket:|gist:)/i;

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Read a lockfile's text (v2 or v3, npm 7+). `allowScripts` from the plugin's package.json. Throws a
 * readable reason if it can't be used.
 */
export function parseLock(lockText: string, allowScripts: string[] = []): DepsInfo {
  let lock: unknown;
  try {
    lock = JSON.parse(lockText);
  } catch {
    throw new Error("package-lock.json isn't valid JSON");
  }
  if (!isObject(lock) || !isObject(lock.packages) || Number(lock.lockfileVersion) < 2) {
    throw new Error('package-lock.json is too old (needs lockfileVersion 2 or later: run npm install with npm 7+)');
  }
  const packages = lock.packages as Record<string, any>;
  const nameOf = (key: string) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const prod = Object.entries(packages).filter(([key, p]) => key.startsWith('node_modules/') && isObject(p) && !p.dev && !p.link);
  const rootDeps = isObject(packages['']?.dependencies) ? Object.keys(packages[''].dependencies) : [];
  // Names end up in prompts: refuse anything that isn't one.
  const badNames = [...rootDeps, ...prod.map(([key]) => nameOf(key))].filter((n) => !PACKAGE.test(n));
  if (badNames.length) throw new Error(`package-lock.json has invalid package names: ${badNames.slice(0, 5).map((n) => JSON.stringify(n)).join(', ')}`);
  // Only what's known safe: a tarball over https with an integrity hash (what the registry gives), a local
  // tarball (file:), or a package bundled inside its parent's tarball. Anything else (git, a missing
  // `resolved`, which makes npm fall back to package.json's spec) can make npm run scripts on install.
  const fetchable = (p: Record<string, any>) =>
    p.inBundle === true ||
    (typeof p.resolved === 'string' && p.resolved.startsWith('https://') && typeof p.integrity === 'string' && p.integrity !== '') ||
    (typeof p.resolved === 'string' && p.resolved.startsWith('file:'));
  const unsafe = prod.filter(([, p]) => !fetchable(p));
  if (unsafe.length) {
    const names = [...new Set(unsafe.map(([key]) => nameOf(key)))];
    const git = unsafe.some(([, p]) => GIT.test(String(p.resolved ?? '').trim()));
    throw new Error(
      `${git ? "git dependencies aren't supported (npm runs their scripts on install)" : 'every package must come from an https tarball with an integrity hash'}: ${names.slice(0, 10).join(', ')}`,
    );
  }
  const scripts = [...new Set(prod.filter(([, p]) => p.hasInstallScript).map(([key]) => nameOf(key)))].sort();
  const allowed = scripts.filter((s) => allowScripts.includes(s));
  const elsewhere = prod
    .filter(([, p]) => typeof p.resolved === 'string' && !p.resolved.startsWith(REGISTRY))
    .map(([key, p]) => {
      let from = String(p.resolved);
      try {
        from = new URL(from).host || from;
      } catch {}
      return `${nameOf(key)} (${from})`;
    });
  return {
    // Trimmed: the update preview reads the lockfile through git (runCommand trims its output), the loader
    // from disk (with the final newline). Both must give the same identity.
    lockHash: hash(`${lockText.trim()}\u0000allowScripts:${allowed.join(',')}`),
    direct: rootDeps.sort().map((name) => ({ name, version: String(packages[`node_modules/${name}`]?.version ?? '?') })),
    total: prod.length,
    scripts,
    allowed,
    elsewhere: [...new Set(elsewhere)].sort(),
  };
}

/**
 * A plugin's dependency state:
 * - none: nothing to install;
 * - ready: approved and installed;
 * - install: approved, but not installed (or not this lockfile): install without asking;
 * - approve: this lockfile hasn't been approved;
 * - problem: can't be installed at all (no lockfile, unreadable lockfile).
 */
export type DepsState =
  | { state: 'none' }
  | { state: 'ready' | 'install' | 'approve'; info: DepsInfo }
  | { state: 'problem'; problem: string };

export async function depsState(p: PluginFolder): Promise<DepsState> {
  if (!p.meta?.hasDependencies) return { state: 'none' };
  const text = await readFile(join(p.dir, 'package-lock.json'), 'utf8').catch(() => null);
  if (text === null) return { state: 'problem', problem: 'it has dependencies but no package-lock.json (dependencies are installed only from a lockfile)' };
  let info: DepsInfo;
  try {
    info = parseLock(text, p.meta.allowScripts);
  } catch (error) {
    return { state: 'problem', problem: (error as Error).message };
  }
  if (!(await isApproved(p.path, info.lockHash))) return { state: 'approve', info };
  const installed = await readFile(join(p.dir, 'node_modules', MARKER), 'utf8').catch(() => '');
  return { state: installed.trim() === info.lockHash ? 'ready' : 'install', info };
}

export async function isApproved(path: string, lockHash: string) {
  const row = await db().selectFrom('plugin_approvals').select('lock_hash').where('path', '=', path).executeTakeFirst();
  return row?.lock_hash === lockHash;
}

/** Record root's approval of a plugin's lockfile (replacing any earlier one). */
export async function approve(path: string, lockHash: string, by: string) {
  const at = new Date().toISOString();
  await db()
    .insertInto('plugin_approvals')
    .values({ path, lock_hash: lockHash, approved_at: at, approved_by: by })
    .onConflict((oc) => oc.column('path').doUpdateSet({ lock_hash: lockHash, approved_at: at, approved_by: by }))
    .execute();
}

/** Install an approved plugin's dependencies: scripts off, then only the allowed ones' scripts. */
export async function install(p: PluginFolder, info: DepsInfo) {
  await runCommand('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], p.dir, 300_000);
  if (info.allowed.length) await runCommand('npm', ['rebuild', ...info.allowed, '--loglevel=error'], p.dir, 300_000);
  await writeFile(join(p.dir, 'node_modules', MARKER), `${info.lockHash}\n`);
  log.info(`Installed dependencies for ${p.path} (${info.total} packages${info.allowed.length ? `; ran install scripts for ${info.allowed.join(', ')}` : ''})`);
}

/** Local plugins' dependencies are approved automatically (AUTO_INSTALL_LOCAL_DEPS=true): you wrote them. */
export const autoApproveLocal = () => /^(true|on|yes|1)$/i.test(readEnv('AUTO_INSTALL_LOCAL_DEPS') ?? '');

/** What root is asked to approve, for a prompt. */
export function describeDeps(path: string, info: DepsInfo) {
  const direct = info.direct.map((d) => `\`${d.name}@${d.version}\``).join(', ') || '—';
  const notRun = info.scripts.filter((s) => !info.allowed.includes(s));
  return [
    `**Dependencies of \`${path}\`:** ${direct} (${info.total} package${info.total === 1 ? '' : 's'} in total)`,
    info.allowed.length ? `⚠️ Install scripts that **will run**: ${info.allowed.map((s) => `\`${s}\``).join(', ')}` : '',
    notRun.length ? `Install scripts that won't run (not in its allowScripts): ${notRun.map((s) => `\`${s}\``).join(', ')}` : '',
    info.elsewhere.length ? `⚠️ Not from the npm registry: ${info.elsewhere.slice(0, 10).map((s) => `\`${s}\``).join(', ')}${info.elsewhere.length > 10 ? `, and ${info.elsewhere.length - 10} more` : ''}` : '',
    `They run inside the bot, with its token and data. Approve only code you trust.`,
  ]
    .filter(Boolean)
    .join('\n');
}
