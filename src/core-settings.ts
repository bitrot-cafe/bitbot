import { readEnv } from './config.js';
import { defineSettings, getSetting } from './settings.js';

/*
 * The core's own settings (scope "core"). Each still honours its old environment variable, which then
 * takes precedence over the value stored in the database. A bad env value is fatal at startup (index.ts
 * checks coreSettingProblems); until then it's ignored, so logging can never throw.
 */
const PREFIX_PATTERN = '^\\S{1,8}$';

export const coreSettingProblems = defineSettings('core', {
  prefix: {
    type: 'string',
    description: 'Command prefix. Each guild can have its own; mentioning the bot always works too.',
    // PREFIX in the environment is the default rather than a pin, so guilds can still choose their own.
    default: readEnv('PREFIX') ?? '!',
    env: false,
    perGuild: true,
    pattern: PREFIX_PATTERN,
  },
  cooldown: {
    type: 'number',
    description: 'Default seconds between uses of a command, per user, for commands that set none. 0: off. Bot root and admins are exempt.',
    default: 5,
    env: 'COMMAND_COOLDOWN',
    perGuild: true,
  },
  status: {
    type: 'string',
    description: 'Bot status text. Placeholders: {prefix}, {guilds}.',
    default: '{prefix}help | Live in {guilds} guilds',
    env: 'BOT_STATUS',
  },
  log_channel: {
    type: 'id',
    description: 'Channel that receives notices, warnings and errors. Use a private channel.',
    env: 'LOG_CHANNEL_ID',
  },
  debug: {
    type: 'boolean',
    description: 'Debug mode: debug logs, error details in replies, "DEBUG: commit" status, plugin guardrails off.',
    default: false,
    env: 'DEBUG',
    rootOnly: true, // also turns plugin guardrails off
  },
  help_page_path: {
    type: 'string',
    description: 'Where to write the static HTML command list, e.g. public/help.html. Empty: none.',
    env: 'HELP_PAGE_PATH',
    rootOnly: true, // a path on the host: a typo could overwrite another file
  },
  help_url: {
    type: 'url',
    description: 'Public URL of that page; !help links to it.',
    env: 'HELP_URL',
  },
});

// PREFIX is the prefix setting's default, and defaults aren't checked by defineSettings: check it here,
// so a bad value is fatal like every other bad environment value.
{
  const raw = readEnv('PREFIX');
  if (raw !== undefined && !new RegExp(PREFIX_PATTERN, 'u').test(raw)) {
    coreSettingProblems.push(`PREFIX: "${raw}" isn't a valid prefix (1 to 8 characters, no spaces)`);
  }
}

export const coreSettings = {
  /** The prefix in a guild (its own, else the bot-wide one); bot-wide for DMs. */
  prefix: (guildId?: string | null) => getSetting<string>('core', 'prefix', guildId ?? '') ?? '!',
  /** Default cooldown (seconds) for commands that set none. */
  cooldown: (guildId?: string | null) => Math.max(0, getSetting<number>('core', 'cooldown', guildId ?? '') ?? 5),
  status: () => getSetting<string>('core', 'status') ?? '',
  logChannel: () => getSetting<string>('core', 'log_channel') ?? '',
  debug: () => getSetting<boolean>('core', 'debug') ?? false,
  helpPagePath: () => getSetting<string>('core', 'help_page_path') ?? '',
  helpUrl: () => getSetting<string>('core', 'help_url') ?? '',
};
