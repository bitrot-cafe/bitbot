import { readdir } from 'node:fs/promises';
import { EmbedBuilder } from '@fluxerjs/core';
import { botInviteUrl } from './invite.js';
import { createLogger, isDebug, setDebug } from './logger.js';
import { helpUrl, prefix } from './config.js';
import { sections, usageLine, whoCanUse } from './help.js';
import { checkAccess, permissionLabel } from './permissions.js';
import { setStatusTemplate } from './status.js';
import type { Command, Plugin } from './plugin.js';
import { commands, coreCommands, plugins } from './registry.js';

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
  run: async (message, [query]) => {
    // Only show what the caller can actually use here.
    const usable = async (list: Command[]) => {
      const ok: Command[] = [];
      for (const c of list) if ((await checkAccess(message, { ...c, botPermissions: [] })) === null) ok.push(c);
      return ok;
    };
    const all = sections();
    const embed = new EmbedBuilder();
    if (helpUrl) embed.setURL(helpUrl);

    const name = query ? (query.startsWith(prefix) ? query.slice(prefix.length) : query).toLowerCase() : '';
    const command = name ? commands.get(name) : undefined;
    const section = name ? all.find((s) => s.id === name || s.title.toLowerCase() === name) : undefined;

    // !help <command>: details, plus the rest of its plugin (covers a plugin and command sharing a name)
    if (command) {
      const from = all.find((s) => s.commands.includes(command));
      const siblings = from?.id ? (await usable(from.commands)).filter((c) => c !== command) : [];
      embed
        .setTitle(`\`${usageLine(command)}\``)
        .setDescription(command.description)
        .addFields(
          { name: 'From', value: from?.title ?? 'Core', inline: true },
          { name: 'Who can use it', value: whoCanUse(command), inline: true },
        );
      if (siblings.length) {
        embed.addFields({ name: `Also in ${from!.title}`, value: siblings.map((c) => `\`${usageLine(c)}\``).join('\n') });
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
      const value = s.id
        ? `${s.description ?? ''}\n\`${prefix}help ${s.id}\` · ${list.length} command${list.length === 1 ? '' : 's'}`.trim()
        : list.map((c) => `\`${usageLine(c)}\` — ${c.description}`).join('\n');
      embed.addFields({ name: s.title, value });
    }
    return message.reply({ embeds: [embed] });
  },
};

const admin: Command = {
  name: 'admin',
  description: 'Bot administration: list loaded plugins, show plugin details, set the bot status, toggle debug mode.',
  usage: 'plugins list | plugins info <number> | status <text|reset> | debug [on|off]',
  botAdminOnly: true,
  botPermissions: ['EmbedLinks'],
  run: async (message, [area, action, arg]) => {
    if (area === 'debug') {
      if (action === 'on' || action === 'off') setDebug(action === 'on');
      return message.reply(
        `Debug mode is **${isDebug() ? 'on' : 'off'}**${isDebug() ? ': debug logs shown, error details included in replies.' : '.'} (resets on restart)`,
      );
    }
    if (area === 'status') {
      if (!action) return message.reply(`Usage: \`${prefix}admin status <text>\` or \`${prefix}admin status reset\`. Placeholders: \`{prefix}\`, \`{guilds}\``);
      // Take the text from the raw message (after "<prefix>admin status ") so its spacing is kept.
      const text = action === 'reset' ? null : message.content.replace(/^\S+\s+status\s+/i, '');
      const shown = setStatusTemplate(message.client, text);
      return message.reply(`Status set to: ${shown}${text === null ? ' (default)' : ''}`);
    }
    if (area !== 'plugins') return message.reply(`Usage: \`${prefix}admin ${admin.usage}\``);

    if (action === 'list') {
      if (plugins.length === 0) return message.reply('No plugins loaded.');
      const lines = plugins.map((p, i) => `${i + 1}. ${p.name} (v${p.version}) - ${p.author}`);
      return message.reply(lines.join('\n'));
    }

    if (action === 'info') {
      const p = plugins[Number(arg) - 1];
      if (!p) return message.reply(`No plugin #${arg}. See \`${prefix}admin plugins list\`.`);
      const perms = [...new Set(p.commands.flatMap((c) => c.botPermissions ?? []))];
      const embed = new EmbedBuilder()
        .setTitle(p.name)
        .setDescription(p.description ?? null)
        .addFields(
          { name: 'Version', value: `v${p.version}`, inline: true },
          { name: 'Author', value: p.author, inline: true },
          { name: 'Folder', value: `\`plugins/${p.id}\``, inline: true },
          { name: 'Repo', value: p.repo ?? '—' },
          { name: 'Commands', value: p.commands.map((c) => `\`${c.name}\` — ${c.description}`).join('\n') },
          { name: 'Bot permissions', value: perms.length ? perms.map(permissionLabel).join(', ') : '—' },
        );
      return message.reply({ embeds: [embed] });
    }

    return message.reply(`Usage: \`${prefix}admin ${admin.usage}\``);
  },
};

coreCommands.push(help, ping, invite, admin);
for (const command of coreCommands) commands.set(command.name, command);

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
