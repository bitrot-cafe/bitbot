import { randomBytes } from 'node:crypto';
import { serializeError, type Client, type PermissionString } from '@fluxerjs/core';
import { debug, logChannelId } from './config.js';
import { permissionLabel, permissionsIn } from './permissions.js';

/*
 * Logging. Every line goes to the console; warnings and errors also go to LOG_CHANNEL_ID when set.
 * Debug mode (DEBUG=true, or !admin debug on) shows debug lines and puts error details in user replies.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

let debugMode = debug;
let client: Client | null = null;

export const isDebug = () => debugMode;
export function setDebug(on: boolean) {
  debugMode = on;
}

/** Start posting warnings and errors to the log channel (if configured). Call once the client exists. */
export function attachLogChannel(c: Client) {
  if (logChannelId) client = c;
}

/**
 * Verify the log channel is usable: it exists, the bot can see it, and can post there.
 * Runs on every (re)connect; problems go to the console only (the channel is what's broken).
 */
export async function checkLogChannel(c: Client) {
  if (!logChannelId) return;
  const problem = await (async () => {
    const channel = await c.channels.resolve(logChannelId).catch(() => null);
    if (!channel) return "it doesn't exist or the bot can't see it";
    const guildId = (channel as { guildId?: string | null }).guildId;
    const guild = guildId ? c.guilds.get(guildId) : null;
    if (!guild) return "it isn't a channel in a server the bot is in";
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const perms = permissionsIn(me, guild, logChannelId);
    const needed: PermissionString[] = ['ViewChannel', 'SendMessages'];
    const missing = needed.filter((p) => !perms.has(p));
    return missing.length ? `the bot is missing ${missing.map(permissionLabel).join(', ')} there` : null;
  })().catch((error) => `checking it failed: ${errorMessage(error)}`);

  if (problem) console.warn(`LOG_CHANNEL_ID ${logChannelId} can't be used: ${problem}. Errors will only be logged here.`);
}

/** Short message for an unknown thrown value. */
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function emit(level: Level, scope: string, message: string, fields?: Fields, error?: unknown) {
  if (level === 'debug' && !debugMode) return;
  const extra = { ...fields, ...(error === undefined ? {} : { error: serializeError(error) }) };
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  Object.keys(extra).length ? out(line, extra) : out(line);

  if (client && (level === 'warn' || level === 'error')) {
    const details = Object.keys(extra).length ? `\n\`\`\`json\n${JSON.stringify(extra, null, 2).slice(0, 1500)}\n\`\`\`` : '';
    client.channels
      .send(logChannelId, `**${level.toUpperCase()}** [${scope}] ${message}${details}`)
      .catch((postError) => console.error('Could not post to the log channel:', postError)); // console only: no loop
  }
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, fields?: Fields) => emit('debug', scope, message, fields),
    info: (message: string, fields?: Fields) => emit('info', scope, message, fields),
    warn: (message: string, fields?: Fields) => emit('warn', scope, message, fields),
    /** Logs the error and returns a short reference ID to show users, so they can be matched up. */
    error: (message: string, error?: unknown, fields?: Fields): string => {
      const ref = randomBytes(3).toString('hex');
      emit('error', scope, `${message} (ref ${ref})`, fields, error);
      return ref;
    },
  };
}
