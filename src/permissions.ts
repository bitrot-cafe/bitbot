import { UserFlagsBits, type Client, type Message, type PermissionString, type User } from '@fluxerjs/core';
import type { Command } from './plugin.js';

// Labels as Fluxer's UI shows them (en-US), so users can find the toggle.
// Source: fluxerapp/fluxer fluxer_app/src/features/permissions/utils/PermissionLabelDescriptors.ts
const LABELS: Partial<Record<PermissionString, string>> = {
  Administrator: 'Administrator',
  ViewAuditLog: 'View activity log',
  ManageGuild: 'Manage community',
  ManageRoles: 'Manage roles',
  ManageChannels: 'Manage channels',
  KickMembers: 'Kick members',
  BanMembers: 'Ban members',
  CreateInstantInvite: 'Create invite links',
  ChangeNickname: 'Change own nickname',
  ManageNicknames: 'Manage nicknames',
  CreateExpressions: 'Create emoji & stickers',
  ManageExpressions: 'Manage emoji & stickers',
  ManageWebhooks: 'Manage webhooks',
  SendMessages: 'Send messages',
  SendTtsMessages: 'Send TTS messages',
  ManageMessages: 'Manage messages',
  PinMessages: 'Pin messages',
  EmbedLinks: 'Embed links',
  AttachFiles: 'Attach files',
  ReadMessageHistory: 'Read message history',
  UseExternalEmojis: 'Use external emoji',
  UseExternalStickers: 'Use external stickers',
  AddReactions: 'Add reactions',
  BypassSlowmode: 'Bypass slowmode',
  ModerateMembers: 'Time out members',
  ViewChannel: 'View channel',
  ViewChannelMembers: 'View channel members',
  Connect: 'Connect to voice',
  Speak: 'Speak',
  Stream: 'Stream video',
  UseVad: 'Use voice activity',
  PrioritySpeaker: 'Priority speaker',
  MuteMembers: 'Mute members',
  DeafenMembers: 'Deafen members',
  MoveMembers: 'Move members',
  UpdateRtcRegion: 'Set voice region',
};

/** "CreateExpressions" -> "Create emoji & stickers" (falls back to "Create Expressions") */
export const permissionLabel = (name: PermissionString) =>
  LABELS[name] ?? name.replace(/(?<=[a-z])(?=[A-Z])/g, ' ');

/*
 * Who may run a command. Checks run in this order (see checkAccess):
 *   1. Bot admin   — `botAdminOnly` commands: anything that affects the whole bot.
 *                    Bot admins = the application's owner (from the API), plus instance staff when
 *                    TRUST_INSTANCE_STAFF=true. Bot admins get no extra powers inside guilds.
 *   2. Guild scope — commands with `guildOnly` or `userPermissions` don't run in DMs.
 *   3. Guild perms — Fluxer's own permissions for the caller and the bot in that channel
 *                    (roles + channel overwrites; guild owner and Administrator pass everything).
 * Later, with storage: per-guild overrides (grant/restrict commands by role or channel) after step 3.
 */

let applicationOwnerId: string | null = null;
// Off by default: on fluxer.app "Staff" means Fluxer employees, not the people running this bot.
const trustInstanceStaff = process.env.TRUST_INSTANCE_STAFF === 'true';

/** Look up who owns the bot's application. Call once after login. */
export async function loadApplicationOwner(client: Client) {
  const app = await client.rest.get<{ owner?: { id: string } }>('/oauth2/applications/@me');
  applicationOwnerId = app.owner?.id ?? null;
}

export async function isBotAdmin(user: User): Promise<boolean> {
  if (user.id === applicationOwnerId) return true;
  if (!trustInstanceStaff) return false;
  // Public flags include Staff unless the user hid their staff badge.
  const flags = user.flags ?? (await user.client.users.fetch(user.id)).flags ?? 0;
  return (BigInt(flags) & UserFlagsBits.Staff) !== 0n;
}

/** Why `message.author` can't run `command` here, as a reply; null when they can. */
export async function checkAccess(message: Message, command: Command): Promise<string | null> {
  if (command.botAdminOnly && !(await isBotAdmin(message.author))) return 'Only bot administrators can use this.';
  if ((command.guildOnly || command.userPermissions?.length) && !message.guildId) return 'This only works in a server.';
  return missingPermissionsReply(await findMissingPermissions(message, command));
}

/**
 * Which of the command's declared permissions are missing, for the bot and for the caller.
 * Checks channel-level permissions (role + overwrites) where possible, guild-level otherwise.
 */
export async function findMissingPermissions(message: Message, command: Command) {
  const missing = { bot: [] as PermissionString[], user: [] as PermissionString[] };
  const guild = await message.resolveGuild();
  if (!guild) return missing; // DMs: nothing to check

  const channel = guild.channels.get(message.channelId);
  const check = async (memberPromise: Promise<any>, wanted: PermissionString[] = []) => {
    if (wanted.length === 0) return [];
    const member = await memberPromise;
    const perms = channel ? member.permissionsIn(channel) : member.permissions;
    return wanted.filter((p) => !perms.has(p));
  };

  missing.bot = await check(guild.members.me ? Promise.resolve(guild.members.me) : guild.members.fetchMe(), command.botPermissions);
  missing.user = await check(guild.members.resolve(message.author.id), command.userPermissions);
  return missing;
}

/** The API rejected a request because the bot lacks a permission. */
export function isMissingPermissionsError(error: unknown): boolean {
  const e = error as { statusCode?: number; code?: string };
  return e?.statusCode === 403 && (e.code === 'MISSING_PERMISSIONS' || e.code === undefined);
}

export function missingPermissionsReply(missing: { bot: PermissionString[]; user: PermissionString[] }): string | null {
  const list = (perms: PermissionString[]) => perms.map((p) => `**${permissionLabel(p)}**`).join(', ');
  if (missing.user.length) return `You need ${list(missing.user)} to use this.`;
  if (missing.bot.length) {
    return `I'm missing ${list(missing.bot)} here. Ask an admin to grant ${missing.bot.length > 1 ? 'them' : 'it'} to my role.`;
  }
  return null;
}
