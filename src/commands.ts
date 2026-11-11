import { readdir } from 'node:fs/promises';
import { EmbedBuilder } from '@fluxerjs/core';
import { botInviteUrl } from './invite.js';
import { adminModule } from './admin.js';
import { createLogger } from './logger.js';
import { helpUrl, prefix } from './config.js';
import { sections, usageLine, whoCanUse } from './help.js';
import { checkAccess } from './permissions.js';
import type { Command, Plugin } from './plugin.js';
import { commands, modules, plugins, resolveCommand } from './registry.js';

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
    const section = name ? all.find((s) => s.id === name || s.title.toLowerCase() === name) : undefined;

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
        ? `${s.description ?? ''}\n\`${prefix}help ${s.id}\` · ${list.length} command${list.length === 1 ? '' : 's'}`.trim()
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

/** Import every plugins/<id>/index and register its commands. Core commands win name clashes. */
export async function loadPlugins() {
  // Works from both src/ (tsx, .ts) and dist/src/ (compiled, .js).
  const dir = new URL('../plugins/', import.meta.url);
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const folders = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();

  for (const id of folders) {
    try {
      const plugin: Plugin = (await import(new URL(`${id}/index.${ext}`, dir).href)).default;
      for (const command of plugin.commands) {
        const existing = commands.get(command.name);
        if (existing) {
          log.warn(`Plugin "${id}": command "${command.name}" already exists, skipping it.`);
          continue;
        }
        commands.set(command.name, command);
      }
      plugins.push({ ...plugin, id });
      log.info(`Loaded plugin ${plugin.name} v${plugin.version} (${plugin.commands.length} commands)`);
    } catch (error) {
      log.error(`Failed to load plugin "${id}"`, error);
    }
  }
}
