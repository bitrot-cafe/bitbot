import type { Client, Message, PermissionString } from '@fluxerjs/core';
import type { EMOJI_DIMENSIONS, fetchLimits, getLimit } from './instance.js';
import type { createLogger, Logger } from './logger.js';
import type { hasStaffFlag, isBotAdmin, permissionLabel, permissionsIn } from './permissions.js';

/*
 * The plugin API. This file is TYPES ONLY: plugins `import type { ... } from 'bitbot'` (erased at
 * runtime) and get every runtime helper through the `bot` object passed to their factory. That way a
 * plugin works wherever its folder is mounted, with no import paths into the core.
 */

export type Command = {
  name: string;
  description: string;
  /** Arguments shown by !help, e.g. "<search> [source]". */
  usage?: string;
  /** Checked before run; also added to the bot's invite link. */
  botPermissions?: PermissionString[];
  /** The caller must have these (Fluxer permissions, in this channel). Implies guildOnly. */
  userPermissions?: PermissionString[];
  /** Only bot administrators may run it. For anything that affects the bot as a whole. */
  botAdminOnly?: boolean;
  /** Refuse to run in DMs. */
  guildOnly?: boolean;
  /** Child commands, e.g. "admin" -> "status". Children inherit this command's restrictions. */
  subcommands?: Command[];
  /**
   * `args` are the words after the command (and subcommand) name; `rest` is the same text unsplit,
   * spacing kept. Optional for a pure group: running the group shows its subcommands.
   */
  run?: (message: Message, args: string[], rest: string) => Promise<unknown>;
};

/**
 * A plugin is a folder in PLUGINS_DIR whose index.ts default-exports a PluginFactory.
 * Each plugin folder is self-contained (its own package.json for dependencies, if it needs any),
 * so a repo can hold several of them.
 */
export type Plugin = {
  name: string;
  version: string;
  author: string;
  repo?: string;
  description?: string;
  commands: Command[];
  /**
   * Runs once, after the bot first connects: register event listeners, start timers.
   * A throw is logged and disables the plugin's setup, not the bot.
   */
  setup?: (ctx: PluginContext) => void | Promise<void>;
  /** Runs on shutdown: clear timers, flush state. Keep it quick (shutdown is capped at a few seconds). */
  stop?: () => void | Promise<void>;
};

export type PluginContext = {
  client: Client;
  /** Logger scoped to the plugin's folder name. */
  log: Logger;
};

export type { Logger };

/** Core helpers handed to every plugin. */
export type BotAPI = {
  /**
   * The plugin API version this bot implements ("major.minor"). Declare what your plugin needs in its
   * package.json, `"bitbot": { "api": "1.0" }`: same major, and at most this minor, or it won't load.
   */
  apiVersion: string;
  /**
   * The Fluxer library (@fluxerjs/core), the same instance the core uses. Use this for runtime values
   * (EmbedBuilder, Events, parseUserMention, ...) instead of importing the package: a plugin folder
   * mounted outside the bot can't resolve it, and a second copy wouldn't match the core's objects.
   * Types are fine to import directly: `import type { Message } from '@fluxerjs/core'`.
   */
  fluxer: typeof import('@fluxerjs/core');
  /** The command prefix, for usage hints. */
  prefix: string;
  /** A logger labelled as this plugin in the log channel (setup's ctx.log is one already). */
  createLogger: (name: string) => ReturnType<typeof createLogger>;
  isBotAdmin: typeof isBotAdmin;
  hasStaffFlag: typeof hasStaffFlag;
  /** Fluxer UI name for a permission: "CreateExpressions" -> "Create emoji & stickers". */
  permissionLabel: typeof permissionLabel;
  /** A member's effective permissions in a channel. */
  permissionsIn: typeof permissionsIn;
  /** Instance limits (fetched fresh) and fixed platform rules. */
  limits: { fetch: typeof fetchLimits; get: typeof getLimit; emojiDimensions: typeof EMOJI_DIMENSIONS };
};

/**
 * What a plugin's index.ts default-exports:
 *   import type { PluginFactory } from 'bitbot';
 *   const plugin: PluginFactory = (bot) => ({ name: 'Cool', version: '1.0.0', author: 'me', commands: [...] });
 *   export default plugin;
 */
export type PluginFactory = (bot: BotAPI) => Plugin | Promise<Plugin>;
