import { EmbedBuilder } from '@fluxerjs/core';
import { px, recorder, sourceLabel, who } from './admin-util.js';
import { code } from './text.js';
import { recentAudit } from './audit.js';
import { createLogger } from './logger.js';
import type { Command } from './plugin.js';
import type { Module } from './registry.js';
import { hasRole } from './roles.js';
import { definitionsOf, describeScope, missingRequired, resolve, scopes, setSetting, unsetSetting } from './settings.js';
import { setStatusTemplate } from './status.js';

/*
 * !admin: running the bot day to day (settings, status, the audit log). Admin role or above, inherited
 * from the group. Root-only settings are refused here unless the caller is root. Plugin commands that
 * require the admin role are mounted here too.
 */

const log = createLogger('admin');
const record = recorder('admin');

const status: Command = {
  name: 'status',
  description: 'Set the bot status (placeholders {prefix}, {guilds}), or reset it to the default. Stored in the database.',
  usage: '<text|reset>',
  run: async (message, args, rest, ctx) => {
    if (!rest) return ctx.usage();
    const text = rest === 'reset' ? null : rest;
    try {
      const shown = await setStatusTemplate(message.client, text, who(message));
      log.notice(`Status ${text === null ? 'reset' : 'changed'} by ${who(message)}`, { status: shown });
      await record(message, text === null ? 'setting.unset' : 'setting.set', 'core.status', text === null ? {} : { value: text });
      return message.reply(`Status set to: ${code(shown)}${text === null ? ' (default)' : ''}`);
    } catch (error) {
      return message.reply(`Couldn't change it: ${(error as Error).message}`);
    }
  },
};


/** Root-only settings (immunity: an admin can't change what's reserved for root). Throws a readable reason. */
async function checkRootOnly(message: { author: Parameters<typeof hasRole>[0] }, scope: string, key: string) {
  if (definitionsOf(scope)[key]?.rootOnly && !(await hasRole(message.author, 'root'))) {
    throw new Error(`${scope}.${key} can only be changed by bot root`);
  }
}

const config: Command = {
  name: 'config',
  description: 'Show settings: all scopes, or one scope (core, or a plugin by short id).',
  usage: '[scope]',
  botPermissions: ['EmbedLinks'],
  run: async (message, [scope]) => {
    if (!scope) {
      const lines = scopes().map((s) => {
        const missing = missingRequired(s);
        return `\`${s}\`${missing.length ? ` · ⚠️ missing: ${missing.join(', ')}` : ''}`;
      });
      return message.reply(`**Settings scopes**\n${lines.join('\n')}\n\nDetails: \`${px(message)}admin config <scope>\``);
    }
    if (!scopes().includes(scope)) return message.reply(`No settings scope ${code(scope)}. See \`${px(message)}admin config\`.`);
    const embed = new EmbedBuilder().setTitle(`Settings: ${scope}`);
    for (const s of describeScope(scope).slice(0, 25)) {
      const value = s.display === undefined ? '—' : code(s.display.length > 200 ? `${s.display.slice(0, 200)}…` : s.display);
      const tags = [sourceLabel(s), s.def.secret ? 'secret' : '', s.def.restart ? 'restart to apply' : '', s.def.rootOnly ? 'root only' : '', s.source === 'env' ? `\`${s.envName}\`` : '']
        .filter(Boolean)
        .join(' · ');
      embed.addFields({ name: `${s.missing ? '⚠️ ' : ''}${s.key}`, value: `${value} (${tags})\n${s.def.description}` });
    }
    embed.setFooter({ text: `${px(message)}admin config set ${scope} <key> <value> · ${px(message)}admin config unset ${scope} <key>` });
    return message.reply({ embeds: [embed] });
  },
  subcommands: [
    {
      name: 'set',
      description: 'Store a setting (not secrets: those come from the environment or *_FILE).',
      usage: '<scope> <key> <value>',
      run: async (message, [scope, key], rest, ctx) => {
        // Everything after scope and key, spacing kept. One pair of matching outer quotes is dropped, so
        // `set core status "{prefix}help | hi"` stores the text, not the quotes.
        const value = rest.replace(/^\S+\s+\S+\s*/, '').replace(/^(["'])([\s\S]*)\1$/, '$2');
        if (!scope || !key || !value) return ctx.usage();
        try {
          await checkRootOnly(message, scope, key);
          const stored = await setSetting(scope, key, value, who(message));
          log.notice(`Setting ${scope}.${key} changed by ${who(message)}`, { value: String(stored) });
          await record(message, 'setting.set', `${scope}.${key}`, { value: stored });
          return message.reply(`Set **${scope}.${key}** to ${code(String(stored))}.`);
        } catch (error) {
          return message.reply(`Couldn't set it: ${(error as Error).message}`);
        }
      },
    },
    {
      name: 'unset',
      description: 'Remove a stored setting (back to its default).',
      usage: '<scope> <key>',
      run: async (message, [scope, key], _rest, ctx) => {
        if (!scope || !key) return ctx.usage();
        try {
          await checkRootOnly(message, scope, key);
          await unsetSetting(scope, key);
          log.notice(`Setting ${scope}.${key} reset by ${who(message)}`);
          await record(message, 'setting.unset', `${scope}.${key}`);
          return message.reply(`Removed **${scope}.${key}**; it's back to ${resolve(scope, key).source === 'env' ? 'the environment value' : 'its default'}.`);
        } catch (error) {
          return message.reply(`Couldn't unset it: ${(error as Error).message}`);
        }
      },
    },
  ],
};


const auditCmd: Command = {
  name: 'audit',
  description: 'The most recent entries in the audit log (who changed what), newest first.',
  usage: '[count]',
  run: async (message, [n]) => {
    const rows = await recentAudit({ limit: Number(n) || 15 });
    if (!rows.length) return message.reply('The audit log is empty.');
    const lines = rows.map((r) => {
      const when = `<t:${Math.floor(Date.parse(r.at) / 1000)}:R>`;
      const by = r.actor ? `${r.actor}` : 'the bot';
      const where = r.guild_id ? ` · guild \`${r.guild_id}\`` : '';
      return `${when} **${by}** ${r.source}/\`${r.action}\`${r.target ? ` \`${r.target}\`` : ''}${where}`;
    });
    // Keep under the message length limit.
    let text = '';
    for (const line of lines) {
      if (text.length + line.length > 1900) break;
      text += `${line}\n`;
    }
    return message.reply(text);
  },
};


/** The !admin group. Exported so plugins' admin commands can be mounted under it. */
export const adminGroup: Command = {
  name: 'admin',
  description: 'Bot administration: settings, status, audit log.',
  requiredRole: 'admin',
  subcommands: [config, status, auditCmd],
};

export const adminModule: Module = {
  id: 'admin',
  title: 'Admin',
  description: 'Bot administration (bot admins and root).',
  commands: [adminGroup],
};
