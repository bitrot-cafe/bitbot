import { randomBytes } from 'node:crypto';
import { EmbedBuilder, serializeError, type Client, type PermissionString } from '@fluxerjs/core';
import { debug, logChannelId } from './config.js';
import { permissionLabel, permissionsIn } from './permissions.js';

/*
 * Logging. Every line goes to the console; notices, warnings and errors also go to LOG_CHANNEL_ID when set.
 * Use notice for normal events an operator should see (e.g. an account was disabled), not for problems.
 * Debug mode (DEBUG=true, or !admin debug on) shows debug lines and puts error details in user replies.
 */

type Level = 'debug' | 'info' | 'notice' | 'warn' | 'error';
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
    const needed: PermissionString[] = ['ViewChannel', 'SendMessages', 'EmbedLinks'];
    const missing = needed.filter((p) => !perms.has(p));
    return missing.length ? `the bot is missing ${missing.map(permissionLabel).join(', ')} there` : null;
  })().catch((error) => `checking it failed: ${errorMessage(error)}`);

  if (problem) console.warn(`LOG_CHANNEL_ID ${logChannelId} can't be used: ${problem}. Errors will only be logged here.`);
}

/** Short message for an unknown thrown value. */
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Who wrote a log line: a part of the core ("core", "repos", ...) or a plugin (its id). */
export type Source = { kind: 'module' | 'plugin'; name: string };

type Entry = { level: Level; source: Source; message: string; fields?: Fields; error?: unknown; ref?: string };

const STYLE: Record<Exclude<Level, 'debug' | 'info'>, { emoji: string; color: number }> = {
  notice: { emoji: '🔵', color: 0x3b82f6 },
  warn: { emoji: '🟡', color: 0xeab308 },
  error: { emoji: '🔴', color: 0xef4444 },
};

/** Fit text into an embed field: trimmed, wrapped in a code block. */
const block = (text: string, lang = '') => `\`\`\`${lang}\n${text.length > 990 ? `${text.slice(0, 990)}…` : text}\n\`\`\``;

/** The log-channel post for an entry: an embed with a colour bar per level. */
function toEmbed({ level, source, message, fields, error, ref }: Entry) {
  const style = STYLE[level as keyof typeof STYLE];
  const embed = new EmbedBuilder()
    .setTitle(`${style.emoji} ${level.toUpperCase()}`)
    .setColor(style.color)
    .setDescription(message.slice(0, 2000))
    .setTimestamp()
    .addFields({ name: source.kind === 'plugin' ? 'Plugin' : 'Module', value: `\`${source.name}\``, inline: true });
  if (ref) embed.addFields({ name: 'Ref', value: `\`${ref}\``, inline: true });
  if (error !== undefined) {
    const text = error instanceof Error ? error.message : String(error);
    embed.addFields({ name: 'Error', value: block(text) });
    if (debugMode && error instanceof Error && error.stack) {
      embed.addFields({ name: 'Stack', value: block(error.stack.split('\n').slice(1, 8).join('\n')) });
    }
  }
  if (fields && Object.keys(fields).length) embed.addFields({ name: 'Details', value: block(JSON.stringify(fields, null, 2), 'json') });
  return embed;
}

function emit(entry: Entry) {
  const { level, source, message, fields, error, ref } = entry;
  if (level === 'debug' && !debugMode) return;
  const extra = { ...fields, ...(error === undefined ? {} : { error: serializeError(error) }) };
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(6)} [${source.name}] ${message}${ref ? ` (ref ${ref})` : ''}`;
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  Object.keys(extra).length ? out(line, extra) : out(line);

  // Only once connected: before login the API rejects us (startup errors stay console-only).
  if (client?.user && (level === 'notice' || level === 'warn' || level === 'error')) {
    client.channels
      .send(logChannelId, { embeds: [toEmbed(entry)] })
      .catch((postError) => console.error('Could not post to the log channel:', postError)); // console only: no loop
  }
}

/** A logger labelled with where its lines come from. Plugins get theirs with kind "plugin". */
export function createLogger(name: string, kind: Source['kind'] = 'module') {
  const source: Source = { kind, name };
  return {
    debug: (message: string, fields?: Fields) => emit({ level: 'debug', source, message, fields }),
    info: (message: string, fields?: Fields) => emit({ level: 'info', source, message, fields }),
    /** Like info, but also posted to the log channel. */
    notice: (message: string, fields?: Fields) => emit({ level: 'notice', source, message, fields }),
    warn: (message: string, fields?: Fields) => emit({ level: 'warn', source, message, fields }),
    /** Logs the error and returns a short reference ID to show users, so they can be matched up. */
    error: (message: string, error?: unknown, fields?: Fields): string => {
      const ref = randomBytes(3).toString('hex');
      emit({ level: 'error', source, message, fields, error, ref });
      return ref;
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
