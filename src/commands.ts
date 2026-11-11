import { readdir } from 'node:fs/promises';
import { EmbedBuilder } from '@fluxerjs/core';
import { prefix } from './config.js';
import { botInviteUrl } from './invite.js';
import { checkAccess } from './permissions.js';
import { permissionLabel } from './permissions.js';
import { setStatusTemplate } from './status.js';
import type { Command, Plugin } from './plugin.js';

/** Loaded plugins, in load order (alphabetical by folder). `id` is the folder name. */
export const plugins: (Plugin & { id: string })[] = [];

/** Every runnable command: core commands plus those from plugins. */
export const commands = new Map<string, Command>();

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
  description: 'List commands, or show details for one.',
  usage: '[command]',
  botPermissions: ['EmbedLinks'],
  run: async (message, [name]) => {
    const groups = [{ title: 'Core', commands: coreCommands }, ...plugins.map((p) => ({ title: p.name, commands: p.commands }))];
    // Only list commands the caller can actually use here.
    const usable = async (c: Command) => (await checkAccess(message, { ...c, botPermissions: [] })) === null;
    const line = (c: Command) => `\`${prefix}${c.name}${c.usage ? ` ${c.usage}` : ''}\``;

    if (name) {
      const command = commands.get((name.startsWith(prefix) ? name.slice(prefix.length) : name).toLowerCase());
      if (!command) return message.reply(`No command \`${name}\`. Try \`${prefix}help\`.`);
      const from = groups.find((g) => g.commands.includes(command))?.title ?? 'Core';
      const embed = new EmbedBuilder()
        .setTitle(line(command))
        .setDescription(command.description)
        .addFields(
          { name: 'From', value: from, inline: true },
          {
            name: 'Who can use it',
            value: command.botAdminOnly
              ? 'Bot administrators'
              : command.userPermissions?.length
                ? command.userPermissions.map(permissionLabel).join(', ')
                : 'Everyone',
            inline: true,
          },
        );
      return message.reply({ embeds: [embed] });
    }

    const embed = new EmbedBuilder()
      .setTitle('Commands')
      .setFooter({ text: `${prefix}help <command> for details` });
    for (const group of groups) {
      const lines: string[] = [];
      for (const c of group.commands) {
        if (commands.get(c.name) === c && (await usable(c))) lines.push(`${line(c)} — ${c.description}`);
      }
      if (lines.length) embed.addFields({ name: group.title, value: lines.join('\n') });
    }
    return message.reply({ embeds: [embed] });
  },
};

const admin: Command = {
  name: 'admin',
  description: 'Bot administration: list loaded plugins, show plugin details, set the bot status.',
  usage: 'plugins list | plugins info <number> | status <text|reset>',
  botAdminOnly: true,
  botPermissions: ['EmbedLinks'],
  run: async (message, [area, action, arg]) => {
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

const coreCommands = [help, ping, invite, admin];
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
          console.warn(`Plugin "${id}": command "${command.name}" already exists, skipping it.`);
          continue;
        }
        commands.set(command.name, command);
      }
      plugins.push({ ...plugin, id });
      console.log(`Loaded plugin ${plugin.name} v${plugin.version} (${plugin.commands.length} commands)`);
    } catch (error) {
      console.error(`Failed to load plugin "${id}":`, error);
    }
  }
}
