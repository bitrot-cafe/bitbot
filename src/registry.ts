import type { Command, Plugin } from './plugin.js';

/** Loaded plugins, in load order (alphabetical by folder). `id` is the folder name. */
export const plugins: (Plugin & { id: string })[] = [];

/** Every runnable command: core commands plus those from plugins. Filled by commands.ts. */
export const commands = new Map<string, Command>();

/** The built-in commands (help, ping, ...), in display order. Filled by commands.ts. */
export const coreCommands: Command[] = [];
