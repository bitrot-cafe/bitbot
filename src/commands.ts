import { EmbedBuilder } from '@fluxerjs/core';
import { adminGroup, adminModule } from './admin.js';
import { rootGroup, rootModule } from './root.js';
import { coreSettings } from './core-settings.js';
import { sections, usageLine, whoCanUse } from './help.js';
import { code } from './text.js';
import { checkAccess } from './permissions.js';
import type { Command } from './plugin.js';
import { commands, modules, mounts, resolveCommand } from './registry.js';

/*
 * The core's own commands, and the modules shown in help. Plugin loading is in loader.ts, which doesn't
 * import this file (or root.ts / admin.ts), so root.ts can use the loader without an import cycle.
 */

// ---- Core commands --------------------------------------------------------------------------------

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
    // A plugin by path (bitbot-plugins/addemote), id (addemote) or title. Ids are unique: duplicates
    // are disabled at load.
    const section = name ? all.find((s) => s.id === name || s.key === name || s.title.toLowerCase() === name) : undefined;

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
        ? `${s.description ?? ''}\n\`${prefix}help ${s.key}\` · ${list.length} command${list.length === 1 ? '' : 's'}`.trim()
        : list.map((c) => `\`${line(c)}\` — ${c.description}`).join('\n');
      embed.addFields({ name: s.title, value });
    }
    return message.reply({ embeds: [embed] });
  },
};

modules.push({ id: 'core', title: 'Core', commands: [help] }, rootModule, adminModule);
for (const command of modules.flatMap((m) => m.commands)) commands.set(command.name, command);
// Plugin commands that require root or admin are mounted under these groups (loader.ts).
mounts.root = rootGroup;
mounts.admin = adminGroup;
