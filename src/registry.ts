import type { Command, Plugin } from './plugin.js';
import type { PluginMeta } from './plugin-meta.js';
import type { PluginSource } from './repos.js';

/** A built-in group of commands (Core, Admin), shown in help like a plugin. */
export type Module = { id: string; title: string; description?: string; commands: Command[] };

/** Built-in modules, in display order. Filled by commands.ts. */
export const modules: Module[] = [];

/**
 * A loaded plugin. `path` is its allowlist path ("builtin/ping", "local/mine", "bitbot-plugins/whoami");
 * `meta` is its package.json; `repo` the managed repo it came from, if any.
 */
export type LoadedPlugin = Plugin & { path: string; source: PluginSource; repo?: string; meta: PluginMeta };

/** Loaded plugins, in load order. */
export const plugins: LoadedPlugin[] = [];

/** Enabled plugins that weren't loaded, and why (shown by !root plugins list). */
export const disabledPlugins: { path: string; title?: string; reason: string }[] = [];

/** The core groups (by role) plugin commands requiring that role are mounted under. Set by commands.ts. */
export const mounts: Record<string, Command> = {};

/** Every top-level command, by name: built-ins plus those from plugins. */
export const commands = new Map<string, Command>();

/*
 * Subcommands. A command can be a group (`subcommands`) instead of, or as well as, having `run`.
 * Children inherit their parent's restrictions, and their name becomes the full path ("admin status").
 */

const union = <T>(a: T[] = [], b: T[] = []) => [...new Set([...a, ...b])];

/** Every bot role a command requires: its own and (once resolved) its parents'. */
export const requiredRolesOf = (c: Command) => c.requiredRoles ?? (c.requiredRole ? [c.requiredRole] : []);

function inherit(parent: Command, child: Command): Command {
  return {
    ...child,
    name: `${parent.name} ${child.name}`,
    requiredRoles: union(requiredRolesOf(parent), requiredRolesOf(child)),
    origin: child.origin ?? parent.origin,
    guildOnly: parent.guildOnly || child.guildOnly,
    cooldown: child.cooldown ?? parent.cooldown,
    userPermissions: union(parent.userPermissions, child.userPermissions),
    botPermissions: union(parent.botPermissions, child.botPermissions),
  };
}

/**
 * Find the deepest (sub)command matching `name` + `args`. Returns it with its inherited restrictions,
 * the remaining args, and how many words the command path used. Null if `name` isn't a command.
 */
export function resolveCommand(name: string, args: string[]) {
  let command = commands.get(name.toLowerCase());
  if (!command) return null;
  let depth = 1;
  while (command.subcommands && args.length) {
    const child: Command | undefined = command.subcommands.find((c) => c.name === args[0].toLowerCase());
    if (!child) break;
    command = inherit(command, child);
    args = args.slice(1);
    depth++;
  }
  return { command, args, depth };
}

/** Every runnable command under `command` (itself if it has `run`), with inherited restrictions. */
export function leaves(command: Command): Command[] {
  const own = command.run ? [command] : [];
  return [...own, ...(command.subcommands ?? []).flatMap((child) => leaves(inherit(command, child)))];
}
