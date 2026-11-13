import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EmbedBuilder, type Client } from '@fluxerjs/core';
import { botInviteUrl } from './invite.js';
import { adminGroup, adminModule } from './admin.js';
import { rootGroup, rootModule } from './root.js';
import { BUILTIN_ROLES, unknownRoles } from './roles.js';
import { createLogger, isDebug } from './logger.js';
import { botApiFor } from './api.js';
import { pluginsDir } from './config.js';
import { coreSettings } from './core-settings.js';
import { enabledFilter, findPluginFolders } from './repos.js';
import { configFor, defineSettings } from './settings.js';
import { createStore } from './store.js';
import { checkApiVersion } from './version.js';
import { sections, usageLine, whoCanUse } from './help.js';
import { code } from './text.js';
import { checkAccess } from './permissions.js';
import type { Command, Plugin, PluginFactory } from './plugin.js';
import { commands, disabledPlugins, leaves, modules, plugins, requiredRolesOf, resolveCommand } from './registry.js';

const log = createLogger('plugins');

// ---- Core commands --------------------------------------------------------------------------------

const ping: Command = {
  name: 'ping',
  description: 'Replies with Pong!',
  run: (message) => message.reply('Pong!'),
};

const invite: Command = {
  name: 'invite',
  description: 'Link to add the bot to a server (includes the permissions its plugins need).',
  run: async (message) => {
    try {
      await message.author.send(`Add me to a server: ${botInviteUrl(message.client)}`);
    } catch {
      // DMs closed (privacy settings) or blocked: say so instead of failing silently.
      return message.reply("I couldn't DM you. Check your privacy settings, or ask an admin for the link.");
    }
    if (message.guildId) await message.react('📬').catch(() => {}); // "check your DMs"; skip if reactions are blocked
  },
};

const help: Command = {
  name: 'help',
  description: 'List commands, or show a plugin\'s commands or one command\'s details.',
  usage: '[plugin | command]',
  botPermissions: ['EmbedLinks'],
  cooldown: 0, // browsing help (!help, !help access, ...) is normal use
  run: async (message, _args, query) => {
    const prefix = coreSettings.prefix(message.guildId);
    const line = (c: Command) => usageLine(c, prefix);
    // Only show what the caller can actually use here.
    const usable = async (list: Command[]) => {
      const ok: Command[] = [];
      for (const c of list) if ((await checkAccess(message, { ...c, botPermissions: [] })) === null) ok.push(c);
      return ok;
    };
    const all = sections();
    const embed = new EmbedBuilder();
    const helpUrl = coreSettings.helpUrl();
    if (helpUrl) embed.setURL(helpUrl);

    const words = query ? query.split(/\s+/) : [];
    const name = words.length ? (words[0].startsWith(prefix) ? words[0].slice(prefix.length) : words[0]).toLowerCase() : '';
    const resolved = name ? resolveCommand(name, words.slice(1)) : null;
    // A plugin by full id (bitbot-plugins/addemote), short id (addemote) or display name. Short ids are
    // unique: duplicates get disabled at load.
    const section = name
      ? all.find((s) => s.id === name || shortId(s.id) === name || s.title.toLowerCase() === name)
      : undefined;

    // !help <command> [sub...]: details, plus related commands (a group's subcommands, or the rest of its plugin)
    if (resolved) {
      const command = resolved.command;
      const from = all.find((s) => s.commands.some((c) => c.name === command.name || c.name.startsWith(`${command.name} `)));
      const related = (await usable(from?.commands ?? [])).filter(
        (c) => c.name !== command.name && (from?.id !== 'core' || c.name.startsWith(`${command.name} `)),
      );
      embed
        .setTitle(`\`${line(command)}\``)
        .setDescription(command.description)
        .addFields(
          { name: 'From', value: from?.title ?? 'Core', inline: true },
          { name: 'Who can use it', value: whoCanUse(command), inline: true },
        );
      if (related.length) {
        embed.addFields({ name: `Also in ${from!.title}`, value: related.map((c) => `\`${line(c)}\``).join('\n') });
      }
      return message.reply({ embeds: [embed] });
    }

    // !help <plugin>: that plugin's commands
    if (section) {
      const list = await usable(section.commands);
      embed
        .setTitle(section.title)
        .setDescription(
          [section.description, list.map((c) => `\`${line(c)}\` — ${c.description}`).join('\n') || 'Nothing here you can use.']
            .filter(Boolean)
            .join('\n\n'),
        );
      return message.reply({ embeds: [embed] });
    }

    if (query) return message.reply(`No command or plugin called ${code(query)}. Try \`${prefix}help\`.`);

    // !help: core commands in full, one line per plugin
    embed.setTitle('Commands').setFooter({ text: `${prefix}help <plugin | command> for more` });
    if (helpUrl) embed.setDescription(`Full list: ${helpUrl}`);
    for (const s of all) {
      const list = await usable(s.commands);
      if (!list.length) continue;
      const value = s.id !== 'core'
        ? `${s.description ?? ''}\n\`${prefix}help ${shortId(s.id)}\` · ${list.length} command${list.length === 1 ? '' : 's'}`.trim()
        : list.map((c) => `\`${line(c)}\` — ${c.description}`).join('\n');
      embed.addFields({ name: s.title, value });
    }
    return message.reply({ embeds: [embed] });
  },
};

modules.push({ id: 'core', title: 'Core', commands: [help, ping, invite] }, rootModule, adminModule);
for (const command of modules.flatMap((m) => m.commands)) commands.set(command.name, command);

// ---- Plugin loading -------------------------------------------------------------------------------

/** A loaded module's default export, checked to be a plugin factory's result. */
function asPlugin(value: unknown): Plugin {
  const p = value as Plugin;
  if (!p || typeof p.name !== 'string' || typeof p.version !== 'string' || !Array.isArray(p.commands)) {
    throw new Error('index.ts must default-export a function returning { name, version, author, commands }');
  }
  return p;
}

type Candidate = Plugin & { id: string; source?: string; api?: string };

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

/** Names plugins can't use (core settings scopes, modules, and plugin sources). */
const RESERVED_NAMES = new Set(['core', 'admin', 'root', 'local', 'builtin']);

/** The core groups a plugin command is mounted under when it requires that role. */
const MOUNTS: Record<string, Command> = { root: rootGroup, admin: adminGroup };

/** A plugin command's path once registered: "access", or "admin access" when mounted. */
export const pathOf = (c: Command) => (c.requiredRole && MOUNTS[c.requiredRole] ? `${c.requiredRole} ${c.name}` : c.name);

/** Every top-level command path the core owns: "help", "admin", "admin config", ... */
export const corePaths = () =>
  new Set([...commands.entries()].flatMap(([name, c]) => [name, ...(c.subcommands ?? []).filter((s) => !s.origin).map((s) => `${name} ${s.name}`)]));

/** Last part of a plugin id: "bitbot-plugins/addemote" -> "addemote". */
export const shortId = (id: string) => id.split('/').pop()!;

/**
 * Find plugins that can't safely load together. Two plugins claiming the same command (or a core
 * command), or sharing a folder name across repos, are a configuration mistake: every plugin involved
 * is disabled, so the clash gets noticed and fixed rather than half-working. Returns id -> reason.
 */
export function findClashes(candidates: Candidate[], coreNames: Set<string>) {
  const prefix = coreSettings.prefix();
  const reasons = new Map<string, string>();
  const flag = (ids: string[], reason: string) => ids.forEach((id) => reasons.set(id, reasons.get(id) ?? reason));

  const byCommand = new Map<string, string[]>();
  const byShortId = new Map<string, string[]>();
  for (const c of candidates) {
    for (const cmd of new Set(c.commands.map(pathOf))) byCommand.set(cmd, [...(byCommand.get(cmd) ?? []), c.id]);
    byShortId.set(shortId(c.id), [...(byShortId.get(shortId(c.id)) ?? []), c.id]);
  }
  for (const [cmd, ids] of byCommand) {
    if (coreNames.has(cmd)) flag(ids, `\`${prefix}${cmd}\` is a core command`);
    else if (ids.length > 1) flag(ids, `\`${prefix}${cmd}\` is provided by ${ids.join(' and ')}`);
  }
  for (const [name, ids] of byShortId) {
    if (ids.length > 1) flag(ids, `the plugin name "${name}" is used by ${ids.join(' and ')}`);
    // A plugin's short name is its settings scope; these belong to the core.
    if (RESERVED_NAMES.has(name)) flag(ids, `"${name}" is a reserved name`);
  }
  return reasons;
}

/**
 * Load every plugin in PLUGINS_DIR (TypeScript, run by tsx): top-level plugin folders, and plugin
 * folders inside repo clones (see findPluginFolders). A broken plugin is logged and skipped. Clashing
 * plugins are all disabled (see findClashes); with DEBUG=true the first one loaded wins instead.
 */
export async function loadPlugins() {
  const folders = await findPluginFolders().catch((error) => {
    log.warn(`Can't read the plugins folder ${pluginsDir}; starting without plugins`, { error: String(error) });
    return [];
  });
  // Plugins in repos are opt-in: only the ones listed as enabled in plugins.json load.
  const enabled = await enabledFilter();
  const toLoad = folders.filter(enabled);

  // Pass 1: import everything that can be imported.
  const candidates: Candidate[] = [];
  for (const { id, dir, source, api, problem } of toLoad) {
    if (problem) {
      createLogger(id, 'plugin').error(`Not loaded: its package.json is malformed: ${problem}`);
      disabledPlugins.push({ id, reason: `malformed package.json: ${problem}` });
      continue;
    }
    // Checked before import, so an incompatible plugin's code never runs (unless DEBUG=true).
    const check = checkApiVersion(api);
    if (check.status === 'incompatible') {
      if (!isDebug()) {
        createLogger(id, 'plugin').error(`Not loaded: ${check.reason}. Update the plugin, or set DEBUG=true to load it anyway.`);
        disabledPlugins.push({ id, reason: check.reason });
        continue;
      }
      createLogger(id, 'plugin').warn(`Loading anyway (DEBUG mode): ${check.reason}`);
    } else if (check.status === 'undeclared') {
      createLogger(id, 'plugin').warn('Doesn\'t declare a bot API version ("bitbot": { "api": "x.y" } in its package.json)');
    }
    try {
      const factory: PluginFactory = (await import(pathToFileURL(join(dir, 'index.ts')).href)).default;
      if (typeof factory !== 'function') throw new Error('index.ts must default-export a function: (bot) => plugin');
      const plugin = asPlugin(await factory(botApiFor(id, shortId(id))));
      const bad = badCommandNames(plugin.commands);
      if (bad.length) {
        const reason = `command names must be lower case with no spaces: ${bad.join(', ')}`;
        createLogger(id, 'plugin').error(`Not loaded: ${reason}`);
        disabledPlugins.push({ id, name: plugin.name, reason });
        continue;
      }
      candidates.push({ ...plugin, id, source, api });
    } catch (error) {
      createLogger(id, 'plugin').error('Failed to load plugin', error);
      disabledPlugins.push({ id, reason: `failed to load: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  // Pass 2: refuse clashes (unless debugging), then register.
  const clashes = isDebug() ? new Map<string, string>() : findClashes(candidates, corePaths());
  for (const plugin of candidates) {
    const clash = clashes.get(plugin.id);
    if (clash) {
      createLogger(plugin.id, 'plugin').error(`Disabled: ${clash}. Remove one of them, or set DEBUG=true to load the first.`);
      disabledPlugins.push({ id: plugin.id, name: plugin.name, reason: clash });
      continue;
    }
    // Declared before its commands are registered: a bad env value (wrong type, unreadable _FILE) disables
    // the plugin rather than letting it run on a value it didn't expect.
    const problems = plugin.config ? defineSettings(shortId(plugin.id), plugin.config) : [];
    if (problems.length) {
      const reason = `invalid settings: ${problems.join('; ')}`;
      createLogger(plugin.id, 'plugin').error(`Disabled: ${reason}`);
      disabledPlugins.push({ id: plugin.id, name: plugin.name, reason });
      continue;
    }
    const meta = folders.find((f) => f.id === plugin.id);
    for (const command of plugin.commands) {
      command.origin = plugin.id;
      if (command.cooldown === undefined && meta?.cooldown !== undefined) command.cooldown = meta.cooldown;
      // Role-gated commands live under the role's group (!admin access), so they're grouped the same way everywhere.
      const group = command.requiredRole ? MOUNTS[command.requiredRole] : undefined;
      const taken = group ? group.subcommands!.some((s) => s.name === command.name) : commands.has(command.name);
      if (taken) {
        log.warn(`Plugin "${plugin.id}": command "${pathOf(command)}" already exists, skipping it (DEBUG mode).`);
        continue;
      }
      if (group) group.subcommands!.push(command);
      else commands.set(command.name, command);
    }
    // A role the plugin requires but doesn't declare can't be found in permissions.yaml's checks; say so.
    const declared = new Set([...BUILTIN_ROLES, ...(meta?.roles ?? [])]);
    const undeclared = [...new Set(plugin.commands.flatMap(leaves).flatMap(requiredRolesOf))].filter((r) => !declared.has(r));
    if (undeclared.length) {
      createLogger(plugin.id, 'plugin').warn(`Requires bot role(s) its package.json doesn't declare ("bitbot": { "roles": [...] }): ${undeclared.join(', ')}`);
    }
    plugins.push(plugin);
    log.info(`Loaded plugin ${plugin.name} v${plugin.version} from ${plugin.id} (${plugin.commands.length} commands)`);
  }

  // Roles in permissions.yaml that neither the core nor any plugin present (enabled or not) declares:
  // most likely a typo, which would silently grant nothing.
  const unknown = unknownRoles(folders.flatMap((f) => f.roles ?? []));
  if (unknown.length) startupWarnings.push(`permissions.yaml has role(s) nothing declares (typo?): ${unknown.join(', ')}`);
}

/** Problems found while loading, repeated once connected so they reach the log channel. */
export const startupWarnings: string[] = [];

/** Run each plugin's setup hook. Call once, after the first Ready. One plugin failing doesn't stop the others. */
export async function startPlugins(client: Client) {
  for (const p of plugins) {
    if (!p.setup) continue;
    try {
      const scope = shortId(p.id);
      await p.setup({ client, log: createLogger(p.id, 'plugin'), config: configFor(scope), store: createStore(scope) });
    } catch (error) {
      createLogger(p.id, 'plugin').error('Setup failed', error);
    }
  }
}

/** Run each plugin's stop hook (shutdown). Errors are logged and don't block the others. */
export async function stopPlugins() {
  for (const p of plugins) {
    if (!p.stop) continue;
    try {
      await p.stop();
    } catch (error) {
      createLogger(p.id, 'plugin').error('Stop failed', error);
    }
  }
}
