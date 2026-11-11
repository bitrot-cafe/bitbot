import { EmbedBuilder } from '@fluxerjs/core';
import { confirm } from './confirm.js';
import { helpPagePath, helpUrl, prefix } from './config.js';
import { usageLine, writeHelpPage } from './help.js';
import { restart } from './lifecycle.js';
import { createLogger, isDebug, setDebug } from './logger.js';
import { permissionLabel } from './permissions.js';
import type { Command } from './plugin.js';
import { disabledPlugins, leaves, plugins, type Module } from './registry.js';
import { abortAdd, applyUpdates, finishAdd, listRepos, previewUpdates, readManifest, removeRepo, startAdd } from './repos.js';
import { setStatusTemplate } from './status.js';

/* Bot administration. Everything here is bot-admin only (inherited from the `admin` group). */

const log = createLogger('admin');
const who = (m: { author: { username: string; id: string } }) => `${m.author.username} (${m.author.id})`;

const pluginsList: Command = {
  name: 'list',
  description: 'Numbered list of loaded plugins.',
  run: async (message) => {
    const loaded = plugins.length
      ? plugins.map((p, i) => `${i + 1}. ${p.name} (v${p.version}) - ${p.author} · \`${p.id}\``).join('\n')
      : 'No plugins loaded.';
    const off = disabledPlugins.map((d) => `⛔ \`${d.id}\`${d.name ? ` (${d.name})` : ''}: ${d.reason}`);
    return message.reply([loaded, ...(off.length ? ['', '**Not loaded:**', ...off] : [])].join('\n'));
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
    // The repo the bot installed it from wins; a plugin's own `repo` field covers local folders.
    const managed = p.source ? (await readManifest().catch(() => [])).find((r) => r.name === p.source) : undefined;
    const repo = managed ? `[${managed.name}](${managed.url})${managed.ref ? ` (${managed.ref})` : ''}` : (p.repo ?? '— (local folder)');
    const perms = [...new Set(all.flatMap((c) => c.botPermissions ?? []))];
    const embed = new EmbedBuilder()
      .setTitle(p.name)
      .setDescription(p.description ?? null)
      .addFields(
        { name: 'Version', value: `v${p.version}`, inline: true },
        { name: 'Author', value: p.author, inline: true },
        { name: 'Folder', value: `\`plugins/${p.id}\``, inline: true },
        { name: 'Repo', value: repo },
        { name: 'Commands', value: all.map((c) => `\`${usageLine(c)}\` — ${c.description}`).join('\n') },
        { name: 'Bot permissions', value: perms.length ? perms.map(permissionLabel).join(', ') : '—' },
      );
    return message.reply({ embeds: [embed] });
  },
};

// ---- Plugin repos ---------------------------------------------------------------------------------

const repos: Command = {
  name: 'repos',
  description: 'Plugin repos the bot manages.',
  run: async (message) => {
    const list = await listRepos();
    if (!list.length) return message.reply(`No plugin repos. Add one with \`${prefix}admin plugins add <https-url> [ref]\`.`);
    return message.reply(
      list
        .map(
          (r) =>
            `**${r.name}** \`${r.commit ?? 'missing'}\`${r.ref ? ` (${r.ref})` : ''} · ${r.url}\n` +
            `  ${r.plugins.length ? r.plugins.map((p) => `\`${p}\``).join(', ') : 'no plugins'}`,
        )
        .join('\n'),
    );
  },
};

const add: Command = {
  name: 'add',
  description: 'Clone a plugin repo (any HTTPS git URL), show what\'s in it, and load it after you confirm.',
  usage: '<https-url> [branch|tag]',
  botPermissions: ['AddReactions'],
  run: async (message, [url, ref]) => {
    if (!url) return message.reply(`Usage: \`${prefix}admin plugins add <https-url> [branch|tag]\``);
    let added;
    try {
      added = await startAdd(url, ref);
    } catch (error) {
      return message.reply(`Couldn't add it: ${(error as Error).message}`);
    }
    const { entry, plugins: found, commit } = added;
    const { ok, prompt } = await confirm(
      message,
      `**${entry.name}** at \`${commit}\` contains ${found.length ? found.map((p) => `\`${p}\``).join(', ') : '**no plugins**'}.\n` +
        `⚠️ Plugins run with the bot's token and settings. Only add code you trust.\nInstall and restart to load it?`,
    );
    if (!ok) {
      await abortAdd(entry.name);
      return prompt.edit({ content: `Cancelled; removed the clone of **${entry.name}**.` });
    }
    await prompt.edit({ content: `Installing **${entry.name}**…` });
    await finishAdd(entry);
    log.notice(`Plugin repo ${entry.name} added by ${who(message)}`, { url: entry.url, ref: entry.ref, commit });
    await prompt.edit({ content: `Added **${entry.name}**. Restarting to load it…` });
    await restart(`plugin repo ${entry.name} added`);
  },
};

const remove: Command = {
  name: 'remove',
  description: 'Delete a plugin repo and restart without it.',
  usage: '<repo>',
  botPermissions: ['AddReactions'],
  run: async (message, [name]) => {
    if (!name) return message.reply(`Usage: \`${prefix}admin plugins remove <repo>\` (see \`${prefix}admin plugins repos\`)`);
    const repo = (await listRepos()).find((r) => r.name === name);
    if (!repo) return message.reply(`No managed repo called "${name}".`);
    const { ok, prompt } = await confirm(
      message,
      `Remove **${name}** and its plugins (${repo.plugins.map((p) => `\`${p}\``).join(', ') || 'none'}), then restart?`,
    );
    if (!ok) return prompt.edit({ content: 'Cancelled.' });
    await removeRepo(name);
    log.notice(`Plugin repo ${name} removed by ${who(message)}`);
    await prompt.edit({ content: `Removed **${name}**. Restarting…` });
    await restart(`plugin repo ${name} removed`);
  },
};

const update: Command = {
  name: 'update',
  description: 'Fetch plugin repos (all, or one), show the new commits, and apply them after you confirm.',
  usage: '[repo]',
  botPermissions: ['AddReactions'],
  run: async (message, [name]) => {
    let pending;
    try {
      pending = await previewUpdates(name);
    } catch (error) {
      return message.reply(`Couldn't check for updates: ${(error as Error).message}`);
    }
    if (!pending.length) return message.reply(name ? `**${name}** is up to date.` : 'All plugin repos are up to date.');
    const summary = pending
      .map(
        (u) =>
          `**${u.name}** \`${u.from.slice(0, 7)}\` → \`${u.to.slice(0, 7)}\` (${u.count} commit${u.count === 1 ? '' : 's'}` +
          `${u.depsChanged ? ', dependencies changed' : ''})\n` +
          u.commits.map((c) => `  • ${c}`).join('\n') +
          (u.count > u.commits.length ? `\n  • …and ${u.count - u.commits.length} more` : ''),
      )
      .join('\n');
    const { ok, prompt } = await confirm(message, `${summary}\n\nApply and restart?`);
    if (!ok) return prompt.edit({ content: `${summary}\n\nCancelled; nothing changed.` });
    await prompt.edit({ content: `${summary}\n\nUpdating…` });
    await applyUpdates(pending);
    log.notice(`Plugin repos updated by ${who(message)}`, {
      updates: pending.map((u) => `${u.name} ${u.from.slice(0, 7)}..${u.to.slice(0, 7)}`),
    });
    await prompt.edit({ content: `${summary}\n\nUpdated. Restarting…` });
    await restart('plugin repos updated');
  },
};

const restartCmd: Command = {
  name: 'restart',
  description: 'Restart the bot (reloads all plugins).',
  run: async (message) => {
    log.notice(`Restart requested by ${who(message)}`);
    await message.reply('Restarting…');
    await restart(`requested by ${message.author.username}`);
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
    {
      name: 'plugins',
      description: 'Inspect plugins and manage plugin repos.',
      subcommands: [pluginsList, pluginsInfo, repos, add, update, remove],
    },
    restartCmd,
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
