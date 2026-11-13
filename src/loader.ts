import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Client } from '@fluxerjs/core';
import { botApiFor } from './api.js';
import { audit } from './audit.js';
import { coreSettings } from './core-settings.js';
import { approve, autoApproveLocal, depsState, install, type DepsInfo } from './deps.js';
import { createLogger, isDebug } from './logger.js';
import type { Command, Plugin, PluginFactory } from './plugin.js';
import type { PluginMeta } from './plugin-meta.js';
import { commands, disabledPlugins, leaves, mounts, plugins, requiredRolesOf, type LoadedPlugin } from './registry.js';
import { enabledPaths, findPluginFolders, type PluginFolder } from './repos.js';
import { BUILTIN_ROLES, unknownRoles } from './roles.js';
import { configFor, defineSettings } from './settings.js';
import { createStore } from './store.js';
import { checkApiVersion } from './version.js';
import { safeMode } from './config.js';

/*
 * Plugin loading: at startup (loadPlugins) and while the bot runs (loadLate). Imports nothing that imports
 * it back: the !root / !admin groups plugin commands are mounted under come from the registry.
 */

const log = createLogger('plugins');

/** A loaded module's default export, checked to be a plugin factory's result. */
function asPlugin(value: unknown): Plugin {
  const p = value as Plugin;
  if (!p || !Array.isArray(p.commands)) throw new Error('index.ts must default-export a function returning { commands }');
  return p;
}

/**
 * Command names (at any depth) that can never be typed: lookups lower-case what the user wrote, so a name
 * with capitals is dead, and a name with whitespace can't be one word. Returns the offending paths.
 */
export function badCommandNames(list: Command[], parent = ''): string[] {
  return list.flatMap((c) => {
    const path = parent ? `${parent} ${c.name}` : c.name;
    const own = typeof c.name !== 'string' || !c.name || c.name !== c.name.toLowerCase() || /\s/.test(c.name) ? [JSON.stringify(path)] : [];
    return [...own, ...badCommandNames(c.subcommands ?? [], path)];
  });
}

/** Roles whose core group a plugin command is mounted under (the groups themselves: registry `mounts`). */
const MOUNTED_ROLES = new Set(['root', 'admin']);

/** A plugin command's path once registered: "access", or "admin access" when mounted. */
export const pathOf = (c: Command) => (c.requiredRole && MOUNTED_ROLES.has(c.requiredRole) ? `${c.requiredRole} ${c.name}` : c.name);

/** Every top-level command path the core owns: "help", "admin", "admin config", ... */
export const corePaths = () =>
  new Set([...commands.entries()].flatMap(([name, c]) => [name, ...(c.subcommands ?? []).filter((s) => !s.origin).map((s) => `${name} ${s.name}`)]));

type Candidate = { path: string; commands: Command[] };

/**
 * Plugins that claim the same command (or a core command) can't safely load together: a configuration
 * mistake, so every plugin involved is disabled and the clash gets noticed rather than half-working.
 * Returns path -> reason.
 */
export function findClashes(candidates: Candidate[], coreNames: Set<string>) {
  const prefix = coreSettings.prefix();
  const reasons = new Map<string, string>();
  const flag = (paths: string[], reason: string) => paths.forEach((p) => reasons.set(p, reasons.get(p) ?? reason));
  const byCommand = new Map<string, string[]>();
  for (const c of candidates) {
    for (const cmd of new Set(c.commands.map(pathOf))) byCommand.set(cmd, [...(byCommand.get(cmd) ?? []), c.path]);
  }
  for (const [cmd, paths] of byCommand) {
    if (coreNames.has(cmd)) flag(paths, `\`${prefix}${cmd}\` is a core command`);
    else if (paths.length > 1) flag(paths, `\`${prefix}${cmd}\` is provided by ${paths.join(' and ')}`);
  }
  return reasons;
}

/** Enabled plugins that share a bitbot.id (their settings and data would mix): path -> reason. */
export function findDuplicateIds(folders: { path: string; id?: string }[]) {
  const byId = new Map<string, string[]>();
  for (const f of folders) if (f.id) byId.set(f.id, [...(byId.get(f.id) ?? []), f.path]);
  const reasons = new Map<string, string>();
  for (const [id, paths] of byId) {
    if (paths.length > 1) for (const p of paths) reasons.set(p, `the id "${id}" is used by ${paths.join(' and ')} (enable only one)`);
  }
  return reasons;
}

type Prepared = Plugin & { folder: PluginFolder; meta: PluginMeta };
type Outcome = { plugin: Prepared } | { reason: string; waiting?: true };

/** Enabled plugins waiting for root to approve their dependencies (asked once connected, see approvals.ts). */
export const awaitingApproval = new Map<string, { folder: PluginFolder; info: DepsInfo }>();

/**
 * Everything short of registering one plugin: metadata, API check, dependencies (installed if approved),
 * settings, then the import. Its code runs only at the import, after every check passed.
 */
async function prepare(folder: PluginFolder): Promise<Outcome> {
  const { path, meta } = folder;
  if (!meta) return { reason: folder.problem ?? 'unreadable package.json' };
  // Checked before import, so an incompatible plugin's code never runs (unless DEBUG=true).
  const check = checkApiVersion(meta.api);
  if (check.status === 'incompatible') {
    if (!isDebug()) return { reason: `${check.reason}. Update the plugin, or set DEBUG=true to load it anyway` };
    createLogger(path, 'plugin').warn(`Loading anyway (DEBUG mode): ${check.reason}`);
  } else if (check.status === 'undeclared') {
    createLogger(path, 'plugin').warn('Doesn\'t declare a bot API version ("bitbot": { "api": "x.y" } in its package.json)');
  }
  // Dependencies: never installed without root's approval of this exact lockfile (deps.ts).
  let deps = await depsState(folder);
  if (deps.state === 'problem') return { reason: deps.problem };
  if (deps.state === 'approve' && folder.source === 'local' && autoApproveLocal()) {
    await approve(path, deps.info.lockHash, 'AUTO_INSTALL_LOCAL_DEPS');
    await audit('core', { action: 'plugin.approve', target: path, details: { by: 'AUTO_INSTALL_LOCAL_DEPS', packages: deps.info.total, scripts: deps.info.allowed } });
    log.notice(`Dependencies of ${path} approved automatically (AUTO_INSTALL_LOCAL_DEPS)`);
    // At startup the log channel isn't connected yet: repeat it once connected (a late load posts above).
    startupWarnings.push(`Dependencies of ${path} were approved automatically (AUTO_INSTALL_LOCAL_DEPS)`);
    deps = { state: 'install', info: deps.info };
  }
  if (deps.state === 'approve') {
    awaitingApproval.set(path, { folder, info: deps.info });
    return { reason: `waiting for bot root to approve its dependencies (\`root plugins approve ${path}\`)`, waiting: true };
  }
  if (deps.state === 'install') {
    try {
      await install(folder, deps.info);
    } catch (error) {
      return { reason: `couldn't install its dependencies: ${(error as Error).message}` };
    }
  }
  // Declared before the plugin runs, so its factory can read them. A bad env value (wrong type,
  // unreadable _FILE) disables the plugin rather than letting it run on a value it didn't expect.
  const problems = defineSettings(meta.id, meta.config ?? {});
  if (problems.length) return { reason: `invalid settings: ${problems.join('; ')}` };
  try {
    const factory: PluginFactory = (await import(pathToFileURL(join(folder.dir, 'index.ts')).href)).default;
    if (typeof factory !== 'function') throw new Error('index.ts must default-export a function: (bot) => plugin');
    const plugin = asPlugin(await factory(botApiFor(path, meta.id)));
    const bad = badCommandNames(plugin.commands);
    if (bad.length) return { reason: `command names must be lower case with no spaces: ${bad.join(', ')}` };
    return { plugin: { ...plugin, folder, meta } };
  } catch (error) {
    createLogger(path, 'plugin').error('Failed to load plugin', error);
    return { reason: `failed to load: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Add a prepared plugin's commands (mounted under !root / !admin when role-gated) and list it as loaded. */
function register({ folder, meta, ...plugin }: Prepared) {
  const { path } = folder;
  for (const command of plugin.commands) {
    command.origin = path;
    if (command.cooldown === undefined && meta.cooldown !== undefined) command.cooldown = meta.cooldown;
    // Role-gated commands live under the role's group (!admin access), so they're grouped the same way everywhere.
    const mounted = !!command.requiredRole && MOUNTED_ROLES.has(command.requiredRole);
    const group = mounted ? mounts[command.requiredRole!] : undefined;
    // commands.ts sets the mounts; without them the command would land top-level, unlike pathOf says.
    if (mounted && !group) throw new Error(`the !${command.requiredRole} group isn't registered (import commands.ts before loading plugins)`);
    const taken = group ? group.subcommands!.some((s) => s.name === command.name) : commands.has(command.name);
    if (taken) {
      log.warn(`Plugin "${path}": command "${pathOf(command)}" already exists, skipping it (DEBUG mode).`);
      continue;
    }
    if (group) group.subcommands!.push(command);
    else commands.set(command.name, command);
  }
  // A role the plugin requires but doesn't declare can't be found in permissions.yaml's checks; say so.
  const declared = new Set([...BUILTIN_ROLES, ...(meta.roles ?? [])]);
  const undeclared = [...new Set(plugin.commands.flatMap(leaves).flatMap(requiredRolesOf))].filter((r) => !declared.has(r));
  if (undeclared.length) {
    createLogger(path, 'plugin').warn(`Requires bot role(s) its package.json doesn't declare ("bitbot": { "roles": [...] }): ${undeclared.join(', ')}`);
  }
  const loaded = { ...plugin, path, source: folder.source, repo: folder.repo, meta };
  plugins.push(loaded);
  log.info(`Loaded plugin ${meta.title} v${meta.version} from ${path} (${plugin.commands.length} commands)`);
  return loaded;
}

/**
 * Load the enabled plugins (TypeScript, run by tsx). Folders and their package.json are checked before
 * any plugin code runs; a broken plugin is logged and skipped. Clashing plugins are all disabled (see
 * findClashes, findDuplicateIds); with DEBUG=true the first one loaded wins instead.
 */
export async function loadPlugins() {
  if (safeMode) {
    log.warn('SAFE MODE (SAFE_MODE=true): no plugins are loaded. Disable the one causing trouble, then restart without SAFE_MODE.');
    startupWarnings.push('SAFE MODE: no plugins are loaded (SAFE_MODE=true).');
    return;
  }
  const folders = await findPluginFolders().catch((error) => {
    log.warn("Can't read the plugin folders; starting without plugins", { error: String(error) });
    return [];
  });
  const enabled = await enabledPaths().catch((error) => {
    log.error("Can't read the enabled plugins from the database; starting without plugins", error);
    return new Set<string>();
  });
  const off = (path: string, reason: string, title?: string, waiting = false) => {
    if (waiting) createLogger(path, 'plugin').warn(`Not loaded yet: ${reason}`);
    else createLogger(path, 'plugin').error(`Not loaded: ${reason}`);
    disabledPlugins.push({ path, title, reason });
  };
  for (const path of enabled) {
    if (!folders.some((f) => f.path === path)) off(path, 'enabled, but not found (removed from disk?)');
  }
  const toLoad = folders.filter((f) => enabled.has(f.path));
  const duplicates = isDebug() ? new Map<string, string>() : findDuplicateIds(toLoad);
  const seen = new Set<string>();

  // Pass 1: checks, dependencies, settings, import.
  const candidates: Prepared[] = [];
  for (const folder of toLoad) {
    const id = folder.meta?.id;
    const duplicate = duplicates.get(folder.path) ?? (id && seen.has(id) ? `the id "${id}" is already loaded (DEBUG mode: first one wins)` : undefined);
    if (duplicate) {
      off(folder.path, duplicate, folder.title);
      continue;
    }
    if (id) seen.add(id);
    const outcome = await prepare(folder);
    if ('reason' in outcome) off(folder.path, outcome.reason, folder.title, outcome.waiting);
    else candidates.push(outcome.plugin);
  }

  // Pass 2: refuse command clashes (unless debugging), then register.
  const clashes = isDebug() ? new Map<string, string>() : findClashes(candidates.map((c) => ({ path: c.folder.path, commands: c.commands })), corePaths());
  for (const c of candidates) {
    const clash = clashes.get(c.folder.path);
    if (clash) off(c.folder.path, `${clash}. Disable one of them, or set DEBUG=true to load the first`, c.meta.title);
    else register(c);
  }

  // Roles in permissions.yaml that neither the core nor any plugin present (enabled or not) declares:
  // most likely a typo, which would silently grant nothing.
  const unknown = unknownRoles(folders.flatMap((f) => f.meta?.roles ?? []));
  if (unknown.length) startupWarnings.push(`permissions.yaml has role(s) nothing declares (typo?): ${unknown.join(', ')}`);
}

/** Every command path registered now, plugins' included: "help", "admin access", ... */
const registeredPaths = () =>
  new Set([...commands.entries()].flatMap(([name, c]) => [name, ...(c.subcommands ?? []).map((s) => `${name} ${s.name}`)]));

/** Why a late load didn't happen. `refused`: it can't coexist with what's loaded (clash, duplicate id). */
export type LateFailure = { reason: string; refused?: true; waiting?: true };

const inFlight = new Map<string, Promise<LateFailure | null>>();

/**
 * Load one enabled plugin while the bot runs (after its dependencies were approved, or on enable), and run
 * its setup. Loading late is safe; unloading isn't, which is why disabling restarts. Returns why it didn't
 * load, or null. Two calls for the same plugin at once share one load (no two installs in one folder).
 */
export function loadLate(folder: PluginFolder, client: Client): Promise<LateFailure | null> {
  const running = inFlight.get(folder.path);
  if (running) return running;
  const load = doLoadLate(folder, client).finally(() => inFlight.delete(folder.path));
  inFlight.set(folder.path, load);
  return load;
}

async function doLoadLate(folder: PluginFolder, client: Client): Promise<LateFailure | null> {
  if (plugins.some((p) => p.path === folder.path)) return null;
  if (safeMode) return { reason: 'safe mode is on: it loads at the next start without SAFE_MODE' };
  const failed = (f: LateFailure) => {
    // What list and approve show from now on.
    const entry = { path: folder.path, title: folder.title, reason: f.reason };
    const i = disabledPlugins.findIndex((d) => d.path === folder.path);
    if (i >= 0) disabledPlugins[i] = entry;
    else disabledPlugins.push(entry);
    if (!f.waiting) awaitingApproval.delete(folder.path);
    createLogger(folder.path, 'plugin').warn(`Not loaded: ${f.reason}`);
    return f;
  };
  const twin = plugins.find((p) => p.meta.id === folder.id);
  if (twin) return failed({ reason: `the id "${folder.id}" is already loaded from ${twin.path}`, refused: true });
  const outcome = await prepare(folder);
  if ('reason' in outcome) return failed(outcome);
  const clash = isDebug() ? undefined : findClashes([{ path: folder.path, commands: outcome.plugin.commands }], registeredPaths()).get(folder.path);
  if (clash) return failed({ reason: clash.replace('is a core command', 'already exists'), refused: true });
  const loaded = register(outcome.plugin);
  awaitingApproval.delete(folder.path);
  const i = disabledPlugins.findIndex((d) => d.path === folder.path);
  if (i >= 0) disabledPlugins.splice(i, 1);
  await runSetup(loaded, client);
  return null;
}

/** Problems found while loading, repeated once connected so they reach the log channel. */
export const startupWarnings: string[] = [];

/** Run each plugin's setup hook. Call once, after the first Ready. One plugin failing doesn't stop the others. */
export async function startPlugins(client: Client) {
  for (const p of plugins) await runSetup(p, client);
}

/** Plugins whose setup ran (a late load during startPlugins' loop would otherwise run twice). */
const setUp = new WeakSet<LoadedPlugin>();

async function runSetup(p: LoadedPlugin, client: Client) {
  if (setUp.has(p)) return;
  setUp.add(p);
  if (!p.setup) return;
  try {
    await p.setup({ client, log: createLogger(p.path, 'plugin'), config: configFor(p.meta.id), store: createStore(p.meta.id) });
  } catch (error) {
    createLogger(p.path, 'plugin').error('Setup failed', error);
  }
}

/** Run each plugin's stop hook (shutdown). Errors are logged and don't block the others. */
export async function stopPlugins() {
  for (const p of plugins) {
    if (!p.stop) continue;
    try {
      await p.stop();
    } catch (error) {
      createLogger(p.path, 'plugin').error('Stop failed', error);
    }
  }
}
