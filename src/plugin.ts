import type { Message, PermissionString } from '@fluxerjs/core';

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
  run: (message: Message, args: string[]) => Promise<unknown>;
};

/**
 * A plugin is a folder under plugins/ whose index.ts default-exports definePlugin({...}).
 * Each plugin folder is self-contained, so a repo can later hold several of them.
 */
export type Plugin = {
  name: string;
  version: string;
  author: string;
  repo?: string;
  description?: string;
  commands: Command[];
};

/** The command prefix, for plugins that show usage hints. */
export { prefix } from './config.js';

/** Identity function that gives plugin files type checking. */
export const definePlugin = (plugin: Plugin): Plugin => plugin;
