import type { Client, Message, PermissionString } from '@fluxerjs/core';
import type { AuditEntry } from './audit.js';
import type { EMOJI_DIMENSIONS, fetchLimits, getLimit } from './instance.js';
import type { createLogger, Logger } from './logger.js';
import type { permissionLabel, permissionsIn } from './permissions.js';
import type { canActOn, hasRole, hasStaffFlag } from './roles.js';
import type { SettingDef, SettingType, SettingValue } from './settings.js';
import type { Json, Store } from './store.js';

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
  /**
   * A bot role (permissions.yaml) the caller must hold: 'root', 'admin', or a role your plugin declares
   * in package.json ("bitbot": { "roles": [...] }). root holds every role. A top-level command needing
   * 'root' or 'admin' is mounted under that group (!admin <name>), so role-gated commands are grouped
   * the same way everywhere. Subcommands inherit it.
   */
  requiredRole?: string;
  /** Refuse to run in DMs. */
  guildOnly?: boolean;
  /**
   * How often it can be used. Seconds (per user), `{ seconds, per: 'user' | 'guild' | 'bot' }`, or a list
   * of those (all must allow it), e.g. once a day per guild: `{ seconds: 86_400, per: 'guild' }`.
   * 0: no cooldown. Unset: the plugin's default ("bitbot": { "cooldown": ... } in package.json), else the
   * bot's (setting core.cooldown, 5 s). Subcommands inherit it. Bot root and admins are exempt.
   */
  cooldown?: Cooldown;
  /** Child commands, e.g. "admin" -> "status". Children inherit this command's restrictions. */
  subcommands?: Command[];
  /**
   * `args` are the words after the command (and subcommand) name; `rest` is the same text unsplit,
   * spacing kept. `ctx` has the prefix in use and the "this didn't count" calls. Optional for a pure
   * group: running the group shows its subcommands.
   */
  run?: (message: Message, args: string[], rest: string, ctx: CommandContext) => Promise<unknown>;
  /** Set by the bot: every role required by this command and its parents. Don't set it yourself. */
  requiredRoles?: string[];
  /** Set by the bot: the plugin (folder id) the command comes from; undefined for the core. */
  origin?: string;
};

/**
 * Per-run helpers for a command. A use is charged against the command's cooldown when it finishes, unless
 * it threw, or called usage() or refund().
 */
export type CommandContext = {
  /** The prefix in this guild, for hints: `${ctx.prefix}mycommand`. */
  prefix: string;
  /**
   * The input was wrong: reply with the command's standard usage line (its `usage`, with this guild's
   * prefix), plus `note` if given, and don't charge the cooldown. `return ctx.usage()`.
   */
  usage(note?: string): Promise<void>;
  /** This use didn't count (nothing happened, for a reason you've told the user): don't charge the cooldown. */
  refund(): void;
};

export type CooldownLimit = { seconds: number; per: 'user' | 'guild' | 'bot' };
export type Cooldown = number | CooldownLimit | CooldownLimit[];

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
   * Settings the plugin uses, keyed by name. Stored in the bot's database and editable with
   * `!admin config <plugin> ...`; each also honours an environment variable (`env`, default
   * PLUGIN_KEY in upper case). Mark tokens and passwords `secret`: those come from env / *_FILE only.
   * Read them with bot.config.get(key) in commands and setup (not while the factory itself runs: they're
   * declared by what it returns).
   */
  config?: Record<string, SettingDef>;
  /**
   * Runs once, after the bot first connects: register event listeners, start timers.
   * A throw is logged and disables the plugin's setup, not the bot.
   */
  setup?: (ctx: PluginContext) => void | Promise<void>;
  /** Runs on shutdown: clear timers, flush state. Keep it quick (shutdown is capped at a few seconds). */
  stop?: () => void | Promise<void>;
};

/** A plugin's declared settings. Read on use, so chat changes apply immediately. */
export type PluginConfig = {
  /** The setting's value; pass a guild ID for a `perGuild` setting (falls back to the bot-wide value). */
  get<T extends SettingValue = SettingValue>(key: string, guildId?: string): T | undefined;
  /** Required settings that have no value. */
  missing(): string[];
};

/** What setup receives. The same config, store and log are on the factory's `bot` object. */
export type PluginContext = {
  client: Client;
  /** Logger scoped to the plugin's folder name. */
  log: Logger;
  config: PluginConfig;
  /** Key/value storage, private to this plugin; .guild(id) and .user(id) narrow it (see Store). */
  store: Store;
};

export type { AuditEntry, Json, SettingDef, SettingType, SettingValue, Store };

export type { Logger };

/** Core helpers handed to a plugin's factory. One object per plugin: config, store and log are its own. */
export type BotAPI = {
  /**
   * The plugin API version this bot implements: the bot's own "major.minor". Declare what your plugin
   * needs in its package.json, `"bitbot": { "api": "0.3" }`: same major, and at most this minor.
   */
  apiVersion: string;
  /** This plugin's declared settings (see Plugin.config). */
  config: PluginConfig;
  /** Key/value storage, private to this plugin; .guild(id) and .user(id) narrow it (see Store). */
  store: Store;
  /** Logger labelled as this plugin in the log channel. */
  log: Logger;
  /**
   * Record an action in the bot's audit log, under this plugin's name: anything an administrator may
   * later ask "who did that?" about (a ban, a role change, a deleted account). Never throws.
   */
  audit: (entry: AuditEntry) => Promise<void>;
  /**
   * The Fluxer library (@fluxerjs/core), the same instance the core uses. Use this for runtime values
   * (EmbedBuilder, Events, parseUserMention, ...) instead of importing the package: a plugin folder
   * mounted outside the bot can't resolve it, and a second copy wouldn't match the core's objects.
   * Types are fine to import directly: `import type { Message } from '@fluxerjs/core'`.
   */
  fluxer: typeof import('@fluxerjs/core');
  /**
   * The command prefix in a guild (its own, else the bot-wide one), for usage hints:
   * `bot.prefixFor(message.guildId)`. Guilds can each choose their prefix, so don't cache it.
   */
  prefixFor: (guildId?: string | null) => string;
  /** Another logger labelled as a plugin, for a named part of one. Usually `log` is enough. */
  createLogger: (name: string) => ReturnType<typeof createLogger>;
  /** Whether a user holds a bot role (permissions.yaml). root holds every role. */
  hasRole: typeof hasRole;
  /** The bot roles a user holds, sorted (for display). */
  rolesOf: (user: Parameters<typeof hasRole>[0]) => Promise<string[]>;
  /** Immunity: false when `target` outranks `actor` (root > admin > everyone). Check it before acting on a user. */
  canActOn: typeof canActOn;
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
