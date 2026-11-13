import { EmbedBuilder } from '@fluxerjs/core';
import { px, recorder, sourceLabel, who } from './admin-util.js';
import { code } from './text.js';
import { confirm } from './confirm.js';
import { coreSettings } from './core-settings.js';
import { usageLine, writeHelpPage } from './help.js';
import { restart } from './lifecycle.js';
import { createLogger, isDebug, setDebug } from './logger.js';
import { permissionLabel } from './permissions.js';
import type { Command } from './plugin.js';
import { disabledPlugins, leaves, plugins, type Module } from './registry.js';
import {
  abortAdd,
  applyUpdates,
  disablePlugin,
  enablePlugin,
  findAvailable,
  finishAdd,
  listRepos,
  previewUpdates,
  readManifest,
  removeRepo,
  startAdd,
} from './repos.js';
import { describeScope, resolve, setSetting } from './settings.js';
import { refreshStatus } from './status.js';
import { API_VERSION, checkApiVersion } from './version.js';

/*
 * !root: things that change the bot itself (its code, its process, its debug mode). Root only, inherited
 * from the group. Plugin commands that require the root role are mounted here too.
 */

const log = createLogger('root');
const record = recorder('root');

/** One line per plugin with its API compatibility, for the add/update prompts. */
function compatList(found: { id: string; api?: string }[]) {
  if (!found.length) return '  **no plugins**';
  return found
    .map(({ id, api }) => {
      const c = checkApiVersion(api);
      const note =
        c.status === 'ok'
          ? `✅ API ${api}`
          : c.status === 'undeclared'
            ? '⚠️ doesn\'t declare an API version (loads with a warning)'
            : `⛔ ${c.reason}: **will be disabled**`;
      return `  • \`${id}\`: ${note}`;
    })
    .join('\n');
}

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
    if (!p) return message.reply(`No plugin ${code(`#${n ?? '?'}`)}. See \`${px(message)}root plugins list\`.`);
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
        ...(p.config
          ? [
              {
                name: 'Settings',
                value:
                  describeScope(p.id.split('/').pop()!)
                    .map((s) => `${s.missing ? '⚠️ ' : ''}\`${s.key}\` ${s.display === undefined ? '— ' : ''}(${sourceLabel(s)})`)
                    .join('\n') + `\n\`${px(message)}admin config ${p.id.split('/').pop()}\` for details`,
              },
            ]
          : []),
        { name: 'API', value: `${p.api ? `needs ${p.api}` : 'not declared'} · this bot has ${API_VERSION}`, inline: true },
        { name: 'Commands', value: all.map((c) => `\`${usageLine(c, px(message))}\` — ${c.description}`).join('\n') },
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
    if (!list.length) return message.reply(`No plugin repos. Add one with \`${px(message)}root plugins add <https-url> [ref]\`.`);
    return message.reply(
      `✅ enabled · ○ available (\`${px(message)}root plugins enable <plugin>\`)\n` +
      list
        .map(
          (r) =>
            `**${r.name}** \`${r.head ?? 'missing'}\`${r.ref ? ` (${r.ref})` : ''} · ${r.url}\n` +
            (r.plugins.length
              ? r.plugins.map((p) => `  ${r.enabled.includes(p.slice(p.indexOf('/') + 1)) ? '✅' : '○'} \`${p}\``).join('\n')
              : '  no plugins'),
        )
        .join('\n'),
    );
  },
};

const add: Command = {
  name: 'add',
  description: 'Clone a plugin repo (any HTTPS git URL) and list its plugins. Enables nothing: plugins are opt-in.',
  usage: '<https-url> [branch|tag]',
  botPermissions: ['AddReactions'],
  run: async (message, [url, ref], _rest, ctx) => {
    if (!url) return ctx.usage();
    let added;
    try {
      added = await startAdd(url, ref);
    } catch (error) {
      return message.reply(`Couldn't add it: ${(error as Error).message}`);
    }
    const { entry, plugins: found, commit } = added;
    const { ok, prompt } = await confirm(
      message,
      `**${entry.name}** at \`${commit}\` contains:\n${compatList(found)}\n` +
        `Adding it **enables nothing**: you then enable plugins one by one.\nAdd this repo?`,
    );
    if (!ok) {
      await abortAdd(entry.name);
      return prompt.edit({ content: `Cancelled; removed the clone of **${entry.name}**.` });
    }
    await finishAdd(entry);
    log.notice(`Plugin repo ${entry.name} added by ${who(message)}`, { url: entry.url, ref: entry.ref, commit });
    await record(message, 'repo.add', entry.name, { url: entry.url, ref: entry.ref, commit: entry.commit });
    await prompt.edit({
      content: `Added **${entry.name}**. Enable plugins with \`${px(message)}root plugins enable <plugin>\`:\n${compatList(found)}`,
    });
  },
};

const enable: Command = {
  name: 'enable',
  description: 'Opt a plugin in from a managed repo: install its dependencies, then restart to load it.',
  usage: '<plugin | repo/plugin>',
  botPermissions: ['AddReactions'],
  run: async (message, [query], _rest, ctx) => {
    if (!query) return ctx.usage(`See \`${ctx.prefix}root plugins repos\`.`);
    let found;
    try {
      found = await findAvailable(query);
    } catch (error) {
      return message.reply(`Can't enable it: ${(error as Error).message}`);
    }
    const { ok, prompt } = await confirm(
      message,
      `Enable \`${found.folder.id}\`?\n${compatList([found.folder])}\n` +
        `⚠️ Plugins run with the bot's token and settings. Only enable code you trust.\nThe bot restarts to load it.`,
    );
    if (!ok) return prompt.edit({ content: 'Cancelled.' });
    try {
      await prompt.edit({ content: `Installing \`${found.folder.id}\`…` });
      await enablePlugin(found.folder.id);
    } catch (error) {
      return prompt.edit({ content: `Couldn't enable it: ${(error as Error).message}` });
    }
    log.notice(`Plugin ${found.folder.id} enabled by ${who(message)}`);
    await record(message, 'plugin.enable', found.folder.id);
    await prompt.edit({ content: `Enabled \`${found.folder.id}\`. Restarting to load it…` });
    await restart(`plugin ${found.folder.id} enabled`);
  },
};

const disable: Command = {
  name: 'disable',
  description: 'Opt a plugin out (it stays available), then restart without it.',
  usage: '<plugin | repo/plugin>',
  botPermissions: ['AddReactions'],
  run: async (message, [query], _rest, ctx) => {
    if (!query) return ctx.usage();
    let found;
    try {
      found = await findAvailable(query);
    } catch (error) {
      return message.reply(`Can't disable it: ${(error as Error).message}`);
    }
    const { ok, prompt } = await confirm(message, `Disable \`${found.folder.id}\` and restart without it?`);
    if (!ok) return prompt.edit({ content: 'Cancelled.' });
    try {
      await disablePlugin(found.folder.id);
    } catch (error) {
      return prompt.edit({ content: `Couldn't disable it: ${(error as Error).message}` });
    }
    log.notice(`Plugin ${found.folder.id} disabled by ${who(message)}`);
    await record(message, 'plugin.disable', found.folder.id);
    await prompt.edit({ content: `Disabled \`${found.folder.id}\`. Restarting…` });
    await restart(`plugin ${found.folder.id} disabled`);
  },
};

const remove: Command = {
  name: 'remove',
  description: 'Delete a plugin repo and restart without it.',
  usage: '<repo>',
  botPermissions: ['AddReactions'],
  run: async (message, [name], _rest, ctx) => {
    if (!name) return ctx.usage(`See \`${ctx.prefix}root plugins repos\`.`);
    const repo = (await listRepos()).find((r) => r.name === name);
    if (!repo) return message.reply(`No managed repo called ${code(name)}.`);
    const { ok, prompt } = await confirm(
      message,
      `Remove **${name}** and its plugins (${repo.plugins.map((p) => `\`${p}\``).join(', ') || 'none'}), then restart?`,
    );
    if (!ok) return prompt.edit({ content: 'Cancelled.' });
    await removeRepo(name);
    log.notice(`Plugin repo ${name} removed by ${who(message)}`);
    await record(message, 'repo.remove', name);
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
    let preview;
    try {
      preview = await previewUpdates(name);
    } catch (error) {
      return message.reply(`Couldn't check for updates: ${(error as Error).message}`);
    }
    const { pending } = preview;
    // Repos that couldn't be checked are reported, and don't stop the others from updating.
    const unchecked = preview.failed.map((f) => `⚠️ **${f.name}** couldn't be checked: ${f.error}`).join('\n');
    if (!pending.length) {
      if (unchecked) return message.reply(`${unchecked}\nNothing else to update.`);
      return message.reply(name ? `${code(name)} is up to date.` : 'All plugin repos are up to date.');
    }
    const summary = pending
      .map(
        (u) =>
          `**${u.name}** \`${u.from.slice(0, 7)}\` → \`${u.to.slice(0, 7)}\` (${u.count} commit${u.count === 1 ? '' : 's'}` +
          `${u.depsChanged ? ', dependencies changed' : ''})\n` +
          u.commits.map((c) => `  • ${c}`).join('\n') +
          (u.count > u.commits.length ? `\n  • …and ${u.count - u.commits.length} more` : '') +
          `\n  After the update:\n${compatList(u.plugins).replace(/^  /gm, '    ')}`,
      )
      .join('\n');
    const { ok, prompt } = await confirm(message, `${summary}${unchecked ? `\n\n${unchecked}` : ''}\n\nApply and restart?`);
    if (!ok) return prompt.edit({ content: `${summary}${unchecked ? `\n\n${unchecked}` : ''}\n\nCancelled; nothing changed.` });
    await prompt.edit({ content: `${summary}\n\nUpdating…` });
    const { applied, failed } = await applyUpdates(pending);
    const failures = failed.map((f) => `⛔ **${f.name}** not updated (kept the old commit): ${f.error}`).join('\n');
    if (!applied.length) return prompt.edit({ content: `${summary}\n\n${failures}\nNothing changed; not restarting.` });
    for (const u of applied) await record(message, 'repo.update', u.name, { from: u.from, to: u.to });
    log.notice(`Plugin repos updated by ${who(message)}`, {
      updates: applied.map((u) => `${u.name} ${u.from.slice(0, 7)}..${u.to.slice(0, 7)}`),
      ...(failed.length ? { failed: failed.map((f) => f.name) } : {}),
    });
    await prompt.edit({ content: `${summary}\n\n${failures ? `${failures}\n` : ''}Updated. Restarting…` });
    await restart('plugin repos updated');
  },
};


const restartCmd: Command = {
  name: 'restart',
  description: 'Restart the bot (reloads all plugins).',
  run: async (message) => {
    log.notice(`Restart requested by ${who(message)}`);
    await record(message, 'bot.restart', '');
    await message.reply('Restarting…');
    await restart(`requested by ${message.author.username}`);
  },
};


const debug: Command = {
  name: 'debug',
  description: 'Show or toggle debug mode: debug logs, error details in replies, guardrails off. Stored in the database.',
  usage: '[on|off]',
  run: async (message, [mode]) => {
    let note = '';
    if (mode === 'on' || mode === 'off') {
      if (resolve('core', 'debug').source === 'env') {
        // DEBUG is set in the environment, which wins over the database: override for this run only.
        setDebug(mode === 'on');
        note = ` (DEBUG is set in the environment, so this lasts until the next restart)`;
      } else {
        await setSetting('core', 'debug', mode, who(message)); // a database error goes to the error handler
        setDebug(null);
      }
      refreshStatus(message.client); // status shows "DEBUG: commit …" while debug is on
      log.notice(`Debug mode turned ${mode} by ${who(message)}`);
      await record(message, 'setting.set', 'core.debug', { value: mode === 'on', untilRestart: !!note });
    }
    return message.reply(
      `Debug mode is **${isDebug() ? 'on' : 'off'}**${isDebug() ? ': debug logs shown, error details included in replies.' : '.'}${note}`,
    );
  },
};


const helpPage: Command = {
  name: 'helppage',
  description: 'Regenerate the web help page (core help_page_path) from the loaded plugins.',
  run: async (message) => {
    if (!coreSettings.helpPagePath()) {
      return message.reply(`No help page configured. Set it with \`${px(message)}admin config set core help_page_path public/help.html\`.`);
    }
    const written = await writeHelpPage(message.client.user?.username ?? 'Bot');
    if (!written) return message.reply("Couldn't write the help page; check the logs.");
    const url = coreSettings.helpUrl();
    return message.reply(`Help page written to \`${written}\`${url ? `: ${url}` : '.'}`);
  },
};


/** The !root group. Exported so plugins' root commands can be mounted under it. */
export const rootGroup: Command = {
  name: 'root',
  description: 'Bot root: plugins, restarts, debug mode.',
  requiredRole: 'root',
  subcommands: [
    {
      name: 'plugins',
      description: 'Inspect plugins and manage plugin repos.',
      subcommands: [pluginsList, pluginsInfo, repos, add, enable, disable, update, remove],
    },
    restartCmd,
    debug,
    helpPage,
  ],
};

export const rootModule: Module = {
  id: 'root',
  title: 'Root',
  description: 'Changes to the bot itself (bot root only).',
  commands: [rootGroup],
};
