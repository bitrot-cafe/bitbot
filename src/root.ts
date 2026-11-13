import { EmbedBuilder } from '@fluxerjs/core';
import { px, recorder, sourceLabel, who } from './admin-util.js';
import { code } from './text.js';
import { approveAndLoad, refusedNote } from './approvals.js';
import { loadLate } from './loader.js';
import { confirm } from './confirm.js';
import { chunk, paginate } from './paginate.js';
import { approve, depsState, describeDeps, isApproved } from './deps.js';
import { safeMode } from './config.js';
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
  enabledPaths,
  findPlugin,
  findPluginFolders,
  finishAdd,
  listRepos,
  previewUpdates,
  removeRepo,
  repoRows,
  startAdd,
  type PluginFolder,
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
function compatList(found: { path: string; api?: string; problem?: string }[]) {
  if (!found.length) return '  **no plugins**';
  return found
    .map(({ path, api, problem }) => {
      if (problem) return `  • \`${path}\`: ⛔ ${problem}: **can't be enabled**`;
      const c = checkApiVersion(api);
      const note =
        c.status === 'ok'
          ? `✅ API ${api}`
          : c.status === 'undeclared'
            ? '⚠️ doesn\'t declare an API version (loads with a warning)'
            : `⛔ ${c.reason}: **won't load**`;
      return `  • \`${path}\`: ${note}`;
    })
    .join('\n');
}

/** "✅ Plugin: 0.4 | Bot: 0.4"; a version that doesn't match the bot's is bold (⚠️ loads, ❌ won't). */
function apiLine(api?: string) {
  const status = checkApiVersion(api).status;
  const icon = status === 'incompatible' ? '❌' : api === API_VERSION ? '✅' : '⚠️';
  return `${icon} Plugin: ${api === API_VERSION ? api : `**${api ?? 'not declared'}**`} | Bot: ${API_VERSION}`;
}

/** `text` cut to `max` characters (embed fields and descriptions have limits). */
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const compatOf = (f: PluginFolder) => ({ path: f.path, api: f.meta?.api, problem: f.problem });

/** `list` sections, in display order, with the words that pick one. */
const SECTIONS = [
  { key: 'loaded', title: 'Loaded', words: ['loaded'] },
  // Enabled, but not loaded: refused (clash, incompatible, broken), waiting for approval, or missing.
  { key: 'failed', title: 'Failed', words: ['failed'] },
  { key: 'available', title: 'Available', words: ['available'] },
] as const;
type SectionKey = (typeof SECTIONS)[number]['key'];
const LIST_PAGE_SIZE = 10;

const pluginsList: Command = {
  name: 'list',
  description: 'Every plugin the bot can see, by state: loaded, failed (enabled but not loaded, and why), available.',
  usage: '[loaded | failed | available] [page]',
  botPermissions: ['EmbedLinks'],
  run: async (message, args, _rest, ctx) => {
    let only: SectionKey | undefined;
    let start = 0;
    for (const arg of args.map((a) => a.toLowerCase())) {
      const section = SECTIONS.find((s) => (s.words as readonly string[]).includes(arg));
      if (section) only = section.key;
      else if (/^\d+$/.test(arg) && Number(arg) > 0) start = Number(arg) - 1;
      else return ctx.usage();
    }
    const [folders, enabled] = await Promise.all([findPluginFolders(), enabledPaths()]);
    const loaded = new Map(plugins.map((p) => [p.path, p]));
    const reasons = new Map(disabledPlugins.map((d) => [d.path, d.reason]));
    // Reasons can be long; `info` has the full text.
    const short = (text: string) => (text.length > 120 ? `${text.slice(0, 119)}…` : text);
    const entries: { section: SectionKey; text: string }[] = [];
    for (const f of [...folders].sort((x, y) => x.path.localeCompare(y.path))) {
      const name = `\`${f.path}\`${f.title && f.title !== f.path.split('/').pop() ? ` (${f.title})` : ''}`;
      const running = loaded.get(f.path);
      // The version that's running; the folder may have changed (or broken) since.
      if (running) entries.push({ section: 'loaded', text: `🟢 ${name} v${running.meta.version}${f.problem ? ` · ⚠️ on disk now: ${short(f.problem)}` : ''}` });
      else if (enabled.has(f.path)) entries.push({ section: 'failed', text: `🔴 ${name}: ${short(reasons.get(f.path) ?? (safeMode ? 'not loaded: safe mode' : 'enabled; restart to load it'))}` });
      else entries.push({ section: 'available', text: `🔵 ${name}${f.problem ? `: ${short(f.problem)}` : ''}` });
    }
    for (const path of [...enabled].filter((path) => !folders.some((f) => f.path === path)).sort()) {
      entries.push({ section: 'failed', text: `🔴 \`${path}\`: enabled, but not found` });
    }
    const order = (e: { section: SectionKey }) => SECTIONS.findIndex((s) => s.key === e.section);
    const shown = entries.filter((e) => !only || e.section === only).sort((x, y) => order(x) - order(y));
    const counts = Object.fromEntries(SECTIONS.map((s) => [s.key, entries.filter((e) => e.section === s.key).length])) as Record<SectionKey, number>;
    const pages = chunk(shown, LIST_PAGE_SIZE);
    const legend = '🟢 loaded · 🔴 failed · 🔵 available';

    const render = (page: number, reactions: boolean) => {
      let text = safeMode ? '**Safe mode** (SAFE_MODE=true): nothing loads until the bot restarts without it.\n\n' : '';
      // A section's heading on every page it appears on.
      for (const s of SECTIONS) {
        const lines = pages[page].filter((e) => e.section === s.key).map((e) => e.text);
        if (lines.length) text += `**${s.title}** (${counts[s.key]})\n${lines.join('\n')}\n\n`;
      }
      if (!shown.length) text += only ? `Nothing ${SECTIONS.find((s) => s.key === only)!.title.toLowerCase()}.` : 'No plugins found.';
      const paging =
        pages.length < 2 ? '' : reactions ? `\n⬅️ previous · ➡️ next (page ${page + 1}/${pages.length})` : `\npage ${page + 1}/${pages.length} · ${px(message)}root plugins list ${only ?? ''} <page>`.replace('  ', ' ');
      return new EmbedBuilder()
        .setTitle(`Plugins: ${counts.loaded} loaded${counts.failed ? `, ${counts.failed} failed` : ''}`)
        .setDescription(text.trim())
        .setFooter({ text: `${legend} · ${px(message)}root plugins info <plugin>${paging}` });
    };
    return paginate(message, pages.length, render, { start });
  },
};

const pluginsInfo: Command = {
  name: 'info',
  description: 'Details for one plugin (by path, id or folder name).',
  usage: '<plugin>',
  botPermissions: ['EmbedLinks'],
  run: async (message, [query], _rest, ctx) => {
    if (!query) return ctx.usage();
    let folder: PluginFolder;
    try {
      folder = await findPlugin(query, undefined, px(message));
    } catch (error) {
      return message.reply((error as Error).message);
    }
    const loaded = plugins.find((p) => p.path === folder.path);
    const meta = folder.meta;
    const repo = folder.repo ? (await repoRows()).find((r) => r.name === folder.repo) : undefined;
    const from = repo
      ? `[${repo.name}](${repo.url})${repo.ref ? ` (${repo.ref})` : ''} at \`${repo.commit.slice(0, 7)}\``
      : folder.source === 'builtin' ? 'built in' : 'local folder';
    const state = loaded
      ? 'loaded'
      : (await enabledPaths()).has(folder.path)
        ? `failed: ${disabledPlugins.find((d) => d.path === folder.path)?.reason ?? 'restart to load it'}`
        : 'not enabled';
    const embed = new EmbedBuilder()
      .setTitle(folder.title ?? folder.path)
      .setDescription(cut(meta?.description ?? folder.problem ?? '', 1000) || null)
      .addFields(
        { name: 'Path', value: `\`${folder.path}\``, inline: true },
        { name: 'Id', value: folder.id ? `\`${folder.id}\`` : '—', inline: true },
        { name: 'State', value: state, inline: true },
        ...(meta
          ? [
              { name: 'Version', value: `v${meta.version}`, inline: true },
              { name: 'Author', value: meta.author ?? '—', inline: true },
              { name: 'API', value: apiLine(meta.api), inline: true },
            ]
          : []),
        { name: 'From', value: meta?.repository && !repo ? `${from} · ${meta.repository}` : from },
      );
    if (meta?.config && Object.keys(meta.config).length) {
      // Settings are declared when a plugin loads, so only a loaded one has values (and an `admin config`
      // scope). For any other, list what it declares: another plugin may hold the same id.
      const value = loaded
        ? describeScope(meta.id)
            .map((s) => `${s.missing ? '⚠️ ' : ''}\`${s.key}\` ${s.display === undefined ? '— ' : ''}(${sourceLabel(s)})`)
            .join('\n') + `\n\`${px(message)}admin config ${meta.id}\` for details`
        : `${Object.keys(meta.config).map((k) => `\`${k}\``).join(', ')}\n(set once it's loaded)`;
      embed.addFields({ name: 'Settings', value });
    }
    if (meta?.hasDependencies) {
      const deps = await depsState(folder);
      const value =
        deps.state === 'problem'
          ? `⛔ ${deps.problem}`
          : deps.state === 'none'
            ? '—'
            : `${deps.info.direct.map((d) => `\`${d.name}@${d.version}\``).join(', ')} (${deps.info.total} packages) · ` +
              { ready: '✅ approved, installed', install: '✅ approved, installed at the next load', approve: '⏳ not approved' }[deps.state] +
              (deps.info.allowed.length ? ` · install scripts run for ${deps.info.allowed.join(', ')}` : '');
      embed.addFields({ name: 'Dependencies', value });
    }
    if (loaded) {
      const all = loaded.commands.flatMap(leaves);
      const perms = [...new Set(all.flatMap((c) => c.botPermissions ?? []))];
      embed.addFields(
        { name: 'Commands', value: all.map((c) => `\`${usageLine(c, px(message))}\` — ${c.description}`).join('\n') || '—' },
        { name: 'Bot permissions', value: perms.length ? perms.map(permissionLabel).join(', ') : '—' },
      );
    }
    return message.reply({ embeds: [embed] });
  },
};

// ---- Plugin repos ---------------------------------------------------------------------------------

const repos: Command = {
  name: 'repos',
  description: 'Plugin repos the bot manages.',
  botPermissions: ['EmbedLinks'],
  run: async (message) => {
    const [list, enabled] = await Promise.all([listRepos(), enabledPaths()]);
    if (!list.length) return message.reply(`No plugin repos. Add one with \`${px(message)}root plugins add <https-url> [ref]\`.`);
    const embed = new EmbedBuilder()
      .setTitle(`Plugin repos: ${list.length}`)
      .setFooter({ text: `🟢 enabled · 🔵 available · ${px(message)}root plugins enable <plugin>` });
    // One field per repo (an embed has at most 25; a field value holds 1024 characters).
    for (const r of list.slice(0, 25)) {
      const plugins = r.plugins.length ? r.plugins.map((p) => `${enabled.has(p.path) ? '🟢' : '🔵'} \`${p.path}\``).join('\n') : 'no plugins';
      const value = `${r.url}\n${plugins}`;
      embed.addFields({
        name: `${r.name} · ${r.head ?? 'missing'}${r.ref ? ` (${r.ref})` : ''}`,
        value: value.length > 1024 ? `${value.slice(0, 1023)}…` : value,
      });
    }
    return message.reply({ embeds: [embed] });
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
    const { row, plugins: found, summary } = added;
    const { ok, prompt } = await confirm(
      message,
      `**${row.name}** at \`${summary}\` contains:\n${compatList(found.map(compatOf))}\n` +
        `Adding it **enables nothing**: you then enable plugins one by one.\nAdd this repo?`,
    );
    if (!ok) {
      await abortAdd(row.name);
      return prompt.edit({ content: `Cancelled; removed the clone of **${row.name}**.` });
    }
    await finishAdd(row, who(message));
    log.notice(`Plugin repo ${row.name} added by ${who(message)}`, { url: row.url, ref: row.ref, commit: row.commit });
    await record(message, 'repo.add', row.name, { url: row.url, ref: row.ref, commit: row.commit });
    await prompt.edit({
      content: `Added **${row.name}**. Enable plugins with \`${px(message)}root plugins enable <plugin>\`:\n${compatList(found.map(compatOf))}`,
    });
  },
};

const enable: Command = {
  name: 'enable',
  description: 'Opt a plugin in (builtin, local or from a repo), approving its dependencies, and load it now.',
  usage: '<plugin>',
  botPermissions: ['AddReactions'],
  run: async (message, [query], _rest, ctx) => {
    if (!query) return ctx.usage(`See \`${ctx.prefix}root plugins list\`.`);
    let folder: PluginFolder;
    try {
      folder = await findPlugin(query, undefined, px(message));
    } catch (error) {
      return message.reply(`Can't enable it: ${(error as Error).message}`);
    }
    if ((await enabledPaths()).has(folder.path)) return message.reply(`\`${folder.path}\` is already enabled.`);
    const deps = await depsState(folder);
    if (deps.state === 'problem') return message.reply(`Can't enable \`${folder.path}\`: ${deps.problem}.`);
    const toApprove = deps.state === 'approve' ? deps.info : null;
    const { ok, prompt } = await confirm(
      message,
      `Enable \`${folder.path}\`?\n${compatList([compatOf(folder)])}\n` +
        (toApprove ? `${describeDeps(folder.path, toApprove)}\n✅ also approves these dependencies.` : `⚠️ Plugins run with the bot's token and data. Only enable code you trust.`),
    );
    if (!ok) return prompt.edit({ content: 'Cancelled.' });
    try {
      await enablePlugin(folder, who(message));
    } catch (error) {
      return prompt.edit({ content: `Couldn't enable it: ${(error as Error).message}` });
    }
    log.notice(`Plugin ${folder.path} enabled by ${who(message)}`);
    await record(message, 'plugin.enable', folder.path);
    await prompt.edit({ content: `Enabled \`${folder.path}\`. ${deps.state === 'none' ? 'Loading' : 'Installing its dependencies and loading'} it…` });
    // Loaded now: loading late is safe (only unloading needs a restart).
    const failed = toApprove
      ? await approveAndLoad(folder, toApprove, message.author, message.client)
      : await loadLate(folder, message.client);
    if (failed?.refused) {
      // It can't coexist with what's loaded. Left enabled, the next restart would disable both sides of
      // the clash; undo the enable instead.
      await disablePlugin(folder.path).catch(() => {});
      log.notice(`Plugin ${folder.path} not enabled after all: ${failed.reason}`);
      await record(message, 'plugin.disable', folder.path, { reason: failed.reason });
      return prompt.edit({ content: `Not enabled: \`${folder.path}\` ${failed.reason.startsWith('the id') ? 'conflicts: ' : 'clashes: '}${failed.reason}.` });
    }
    await prompt.edit({
      content: failed
        ? `Enabled \`${folder.path}\`, but it didn't load: ${failed.reason}`
        : `Enabled and loaded \`${folder.path}\`. \`${px(message)}help ${folder.id}\` shows its commands.`,
    });
  },
};

const approveCmd: Command = {
  name: 'approve',
  description: "Approve an enabled plugin's dependencies (when it's waiting for that), install them, and load it.",
  usage: '<plugin>',
  botPermissions: ['AddReactions'],
  run: async (message, [query], _rest, ctx) => {
    if (!query) return ctx.usage();
    let folder: PluginFolder;
    try {
      folder = await findPlugin(query, undefined, px(message));
    } catch (error) {
      return message.reply((error as Error).message);
    }
    if (!(await enabledPaths()).has(folder.path)) return message.reply(`\`${folder.path}\` isn't enabled; use \`${px(message)}root plugins enable\`.`);
    const deps = await depsState(folder);
    if (deps.state === 'problem') return message.reply(`\`${folder.path}\` can't be installed: ${deps.problem}.`);
    if (deps.state !== 'approve') return message.reply(`\`${folder.path}\` has nothing waiting for approval.`);
    const { ok, prompt } = await confirm(message, `${describeDeps(folder.path, deps.info)}\nApprove, install, and load \`${folder.path}\`?`);
    if (!ok) return prompt.edit({ content: 'Cancelled; nothing changed.' });
    await prompt.edit({ content: `Installing \`${folder.path}\`…` });
    const failed = await approveAndLoad(folder, deps.info, message.author, message.client);
    await prompt.edit({ content: failed ? `Approved, but \`${folder.path}\` didn't load: ${failed.reason}${refusedNote(failed)}` : `Approved and loaded \`${folder.path}\`.` });
  },
};

const disable: Command = {
  name: 'disable',
  description: 'Opt a plugin out (it stays available, its data is kept), then restart without it.',
  usage: '<plugin>',
  botPermissions: ['AddReactions'],
  run: async (message, [query], _rest, ctx) => {
    if (!query) return ctx.usage();
    // By path even when it's gone from disk (an enabled plugin whose folder was deleted).
    const enabled = await enabledPaths();
    let path = enabled.has(query) ? query : undefined;
    if (!path) {
      try {
        path = (await findPlugin(query, undefined, px(message))).path;
      } catch (error) {
        return message.reply(`Can't disable it: ${(error as Error).message}`);
      }
    }
    if (!enabled.has(path)) return message.reply(`${code(path)} isn't enabled.`);
    const { ok, prompt } = await confirm(message, `Disable \`${path}\` and restart without it?`);
    if (!ok) return prompt.edit({ content: 'Cancelled.' });
    try {
      await disablePlugin(path);
    } catch (error) {
      return prompt.edit({ content: `Couldn't disable it: ${(error as Error).message}` });
    }
    log.notice(`Plugin ${path} disabled by ${who(message)}`);
    await record(message, 'plugin.disable', path);
    await prompt.edit({ content: `Disabled \`${path}\`. Restarting…` });
    await restart(`plugin ${path} disabled`);
  },
};

const remove: Command = {
  name: 'remove',
  description: 'Delete a plugin repo (its plugins are disabled; their data is kept) and restart without it.',
  usage: '<repo>',
  botPermissions: ['AddReactions'],
  run: async (message, [name], _rest, ctx) => {
    if (!name) return ctx.usage(`See \`${ctx.prefix}root plugins repos\`.`);
    const repo = (await listRepos()).find((r) => r.name === name);
    if (!repo) return message.reply(`No managed repo called ${code(name)}.`);
    const { ok, prompt } = await confirm(
      message,
      `Remove **${name}** and its plugins (${repo.plugins.map((p) => `\`${p.path}\``).join(', ') || 'none'}), then restart?`,
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
    // Enabled plugins whose lockfile changes in this update: confirming approves the new lockfiles.
    const enabled = await enabledPaths();
    const toApprove = (
      await Promise.all(
        pending.flatMap((u) => u.plugins).filter((p) => p.deps && enabled.has(p.path)).map(async (p) => ((await isApproved(p.path, p.deps!.lockHash)) ? null : p)),
      )
    ).filter((p) => p !== null);
    const depsNote = toApprove.map((p) => describeDeps(p.path, p.deps!)).join('\n');
    const summary = pending
      .map(
        (u) =>
          `**${u.name}** \`${u.from.slice(0, 7)}\` → \`${u.to.slice(0, 7)}\` (${u.count} commit${u.count === 1 ? '' : 's'}` +
          `${u.depsChanged ? ', dependencies changed' : ''})\n` +
          u.commits.map((c) => `  • ${c}`).join('\n') +
          (u.count > u.commits.length ? `\n  • …and ${u.count - u.commits.length} more` : '') +
          `\n  After the update:\n${compatList(u.plugins).replace(/^  /gm, '    ')}`,
      )
      .join('\n') + (depsNote ? `\n\n${depsNote}\n✅ also approves these dependencies.` : '');
    const { ok, prompt } = await confirm(message, `${summary}${unchecked ? `\n\n${unchecked}` : ''}\n\nApply and restart?`);
    if (!ok) return prompt.edit({ content: `${summary}${unchecked ? `\n\n${unchecked}` : ''}\n\nCancelled; nothing changed.` });
    await prompt.edit({ content: `${summary}\n\nUpdating…` });
    const { applied, failed } = await applyUpdates(pending, who(message));
    const failures = failed.map((f) => `⛔ **${f.name}** not updated (kept the old commit): ${f.error}`).join('\n');
    if (!applied.length) return prompt.edit({ content: `${summary}\n\n${failures}\nNothing changed; not restarting.` });
    for (const u of applied) await record(message, 'repo.update', u.name, { from: u.from, to: u.to });
    // Installed by the loader after the restart.
    for (const p of toApprove.filter((p) => applied.some((u) => u.name === p.path.split('/')[0]))) {
      await approve(p.path, p.deps!.lockHash, who(message));
      await record(message, 'plugin.approve', p.path, { lockHash: p.deps!.lockHash, packages: p.deps!.total, scripts: p.deps!.allowed });
      log.notice(`Dependencies of ${p.path} approved by ${who(message)} (with the update)`);
    }
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
      description: 'Inspect, enable and disable plugins; manage plugin repos.',
      subcommands: [pluginsList, pluginsInfo, repos, add, enable, approveCmd, disable, update, remove],
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
