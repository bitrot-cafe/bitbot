import { EmbedBuilder } from '@fluxerjs/core';
import { helpPagePath, helpUrl, prefix } from './config.js';
import { usageLine, writeHelpPage } from './help.js';
import { isDebug, setDebug } from './logger.js';
import { permissionLabel } from './permissions.js';
import type { Command } from './plugin.js';
import { leaves, plugins, type Module } from './registry.js';
import { setStatusTemplate } from './status.js';

/* Bot administration. Everything here is bot-admin only (inherited from the `admin` group). */

const pluginsList: Command = {
  name: 'list',
  description: 'Numbered list of loaded plugins.',
  run: async (message) => {
    if (plugins.length === 0) return message.reply('No plugins loaded.');
    return message.reply(plugins.map((p, i) => `${i + 1}. ${p.name} (v${p.version}) - ${p.author}`).join('\n'));
  },
};

const pluginsInfo: Command = {
  name: 'info',
  description: 'Details for one plugin.',
  usage: '<number>',
  botPermissions: ['EmbedLinks'],
  run: async (message, [n]) => {
    const p = plugins[Number(n) - 1];
    if (!p) return message.reply(`No plugin #${n ?? '?'}. See \`${prefix}admin plugins list\`.`);
    const all = p.commands.flatMap(leaves);
    const perms = [...new Set(all.flatMap((c) => c.botPermissions ?? []))];
    const embed = new EmbedBuilder()
      .setTitle(p.name)
      .setDescription(p.description ?? null)
      .addFields(
        { name: 'Version', value: `v${p.version}`, inline: true },
        { name: 'Author', value: p.author, inline: true },
        { name: 'Folder', value: `\`plugins/${p.id}\``, inline: true },
        { name: 'Repo', value: p.repo ?? '—' },
        { name: 'Commands', value: all.map((c) => `\`${usageLine(c)}\` — ${c.description}`).join('\n') },
        { name: 'Bot permissions', value: perms.length ? perms.map(permissionLabel).join(', ') : '—' },
      );
    return message.reply({ embeds: [embed] });
  },
};

const status: Command = {
  name: 'status',
  description: 'Set the bot status (placeholders {prefix}, {guilds}), or reset it to the default. Not kept across restarts.',
  usage: '<text|reset>',
  run: async (message, args, rest) => {
    if (!rest) return message.reply(`Usage: \`${prefix}admin status <text|reset>\``);
    const text = rest === 'reset' ? null : rest;
    const shown = setStatusTemplate(message.client, text);
    return message.reply(`Status set to: ${shown}${text === null ? ' (default)' : ''}`);
  },
};

const debug: Command = {
  name: 'debug',
  description: 'Show or toggle debug mode: debug logs, and error details in replies. Not kept across restarts.',
  usage: '[on|off]',
  run: async (message, [mode]) => {
    if (mode === 'on' || mode === 'off') setDebug(mode === 'on');
    return message.reply(
      `Debug mode is **${isDebug() ? 'on' : 'off'}**${isDebug() ? ': debug logs shown, error details included in replies.' : '.'}`,
    );
  },
};

const helpPage: Command = {
  name: 'helppage',
  description: 'Regenerate the web help page (HELP_PAGE_PATH) from the loaded plugins.',
  run: async (message) => {
    if (!helpPagePath) return message.reply('No help page configured. Set `HELP_PAGE_PATH` in `.env`.');
    const written = await writeHelpPage(message.client.user?.username ?? 'Bot');
    if (!written) return message.reply("Couldn't write the help page; check the logs.");
    return message.reply(`Help page written to \`${written}\`${helpUrl ? `: ${helpUrl}` : '.'}`);
  },
};

const admin: Command = {
  name: 'admin',
  description: 'Bot administration.',
  botAdminOnly: true,
  subcommands: [
    { name: 'plugins', description: 'Inspect loaded plugins.', subcommands: [pluginsList, pluginsInfo] },
    status,
    debug,
    helpPage,
  ],
};

export const adminModule: Module = {
  id: 'admin',
  title: 'Admin',
  description: 'Bot administration (bot administrators only).',
  commands: [admin],
};
