import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EmbedBuilder, type Client } from '@fluxerjs/core';
import { botInviteUrl } from './invite.js';
import { adminModule } from './admin.js';
import { createLogger } from './logger.js';
import { botApi } from './api.js';
import { debug, helpUrl, pluginsDir, prefix } from './config.js';
import { findPluginFolders } from './repos.js';
import { checkApiVersion } from './version.js';
import { sections, usageLine, whoCanUse } from './help.js';
import { checkAccess } from './permissions.js';
import type { Command, Plugin, PluginFactory } from './plugin.js';
import { commands, disabledPlugins, modules, plugins, resolveCommand } from './registry.js';

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
  run: async (message, _args, query) => {
    // Only show what the caller can actually use here.
    const usable = async (list: Command[]) => {
      const ok: Command[] = [];
      for (const c of list) if ((await checkAccess(message, { ...c, botPermissions: [] })) === null) ok.push(c);
      return ok;
    };
    const all = sections();
    const embed = new EmbedBuilder();
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
        .setTitle(`\`${usageLine(command)}\``)
        .setDescription(command.description)
        .addFields(
          { name: 'From', value: from?.title ?? 'Core', inline: true },
          { name: 'Who can use it', value: whoCanUse(command), inline: true },
        );
      if (related.length) {
        embed.addFields({ name: `Also in ${from!.title}`, value: related.map((c) => `\`${usageLine(c)}\``).join('\n') });
      }
      return message.reply({ embeds: [embed] });
    }

    // !help <plugin>: that plugin's commands
    if (section) {
      const list = await usable(section.commands);
      embed
        .setTitle(section.title)
        .setDescription(
          [section.description, list.map((c) => `\`${usageLine(c)}\` — ${c.description}`).join('\n') || 'Nothing here you can use.']
            .filter(Boolean)
            .join('\n\n'),
        );
      return message.reply({ embeds: [embed] });
    }

    if (query) return message.reply(`No command or plugin called \`${query}\`. Try \`${prefix}help\`.`);

    // !help: core commands in full, one line per plugin
    embed.setTitle('Commands').setFooter({ text: `${prefix}help <plugin | command> for more` });
    if (helpUrl) embed.setDescription(`Full list: ${helpUrl}`);
    for (const s of all) {
      const list = await usable(s.commands);
      if (!list.length) continue;
      const value = s.id !== 'core'
        ? `${s.description ?? ''}\n\`${prefix}help ${shortId(s.id)}\` · ${list.length} command${list.length === 1 ? '' : 's'}`.trim()
        : list.map((c) => `\`${usageLine(c)}\` — ${c.description}`).join('\n');
      embed.addFields({ name: s.title, value });
    }
    return message.reply({ embeds: [embed] });
  },
};

modules.push(
  { id: 'core', title: 'Core', commands: [help, ping, invite] },
  adminModule,
);
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

/** Last part of a plugin id: "bitbot-plugins/addemote" -> "addemote". */
export const shortId = (id: string) => id.split('/').pop()!;

/**
 * Find plugins that can't safely load together. Two plugins claiming the same command (or a core
 * command), or sharing a folder name across repos, are a configuration mistake: every plugin involved
 * is disabled, so the clash gets noticed and fixed rather than half-working. Returns id -> reason.
 */
export function findClashes(candidates: Candidate[], coreNames: Set<string>) {
  const reasons = new Map<string, string>();
  const flag = (ids: string[], reason: string) => ids.forEach((id) => reasons.set(id, reasons.get(id) ?? reason));

  const byCommand = new Map<string, string[]>();
  const byShortId = new Map<string, string[]>();
  for (const c of candidates) {
    for (const cmd of new Set(c.commands.map((x) => x.name))) byCommand.set(cmd, [...(byCommand.get(cmd) ?? []), c.id]);
    byShortId.set(shortId(c.id), [...(byShortId.get(shortId(c.id)) ?? []), c.id]);
  }
  for (const [cmd, ids] of byCommand) {
    if (coreNames.has(cmd)) flag(ids, `\`${prefix}${cmd}\` is a core command`);
    else if (ids.length > 1) flag(ids, `\`${prefix}${cmd}\` is provided by ${ids.join(' and ')}`);
  }
  for (const [name, ids] of byShortId) {
    if (ids.length > 1) flag(ids, `the plugin name "${name}" is used by ${ids.join(' and ')}`);
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

  // Pass 1: import everything that can be imported.
  const candidates: Candidate[] = [];
  for (const { id, dir, source, api } of folders) {
    // Checked before import, so an incompatible plugin's code never runs (unless DEBUG=true).
    const check = checkApiVersion(api);
    if (check.status === 'incompatible') {
      if (!debug) {
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
      candidates.push({ ...asPlugin(await factory(botApi)), id, source, api });
    } catch (error) {
      createLogger(id, 'plugin').error('Failed to load plugin', error);
      disabledPlugins.push({ id, reason: `failed to load: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  // Pass 2: refuse clashes (unless debugging), then register.
  const clashes = debug ? new Map<string, string>() : findClashes(candidates, new Set(commands.keys()));
  for (const plugin of candidates) {
    const clash = clashes.get(plugin.id);
    if (clash) {
      createLogger(plugin.id, 'plugin').error(`Disabled: ${clash}. Remove one of them, or set DEBUG=true to load the first.`);
      disabledPlugins.push({ id: plugin.id, name: plugin.name, reason: clash });
      continue;
    }
    for (const command of plugin.commands) {
      if (commands.has(command.name)) {
        log.warn(`Plugin "${plugin.id}": command "${command.name}" already exists, skipping it (DEBUG mode).`);
        continue;
      }
      commands.set(command.name, command);
    }
    plugins.push(plugin);
    log.info(`Loaded plugin ${plugin.name} v${plugin.version} from ${plugin.id} (${plugin.commands.length} commands)`);
  }
}

/** Run each plugin's setup hook. Call once, after the first Ready. One plugin failing doesn't stop the others. */
export async function startPlugins(client: Client) {
  for (const p of plugins) {
    if (!p.setup) continue;
    try {
      await p.setup({ client, log: createLogger(p.id, 'plugin') });
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
