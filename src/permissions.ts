import { type Guild, type GuildMember, type Message, type PermissionString } from '@fluxerjs/core';
import type { Command } from './plugin.js';
import { requiredRolesOf } from './registry.js';
import { rolesOf } from './roles.js';

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
 *   1. Bot roles   — the command's requiredRole (inherited from its group): root, admin, or a role a
 *                    plugin defines. From permissions.yaml (roles.ts); root holds every role.
 *   2. Guild scope — commands with `guildOnly` or `userPermissions` don't run in DMs.
 *   3. Guild perms — Fluxer's own permissions for the caller and the bot in that channel (roles +
 *                    channel overwrites; guild owner and Administrator pass everything). root skips the
 *                    caller's check (root can do anything); the bot's own permissions are always checked.
 * Later: per-guild rules (grant/restrict commands by role, user or channel), after step 1.
 */

/**
 * A member's effective permissions in a channel (roles + overwrites). If the channel isn't cached this
 * falls back to the member's guild-wide permissions, which ignore channel overwrites: fine for display,
 * not for access decisions (checkAccess resolves the channel instead).
 */
export function permissionsIn(member: GuildMember, guild: Guild, channelId: string) {
  const channel = guild.channels.get(channelId);
  return channel ? member.permissionsIn(channel) : member.permissions;
}

/** Why `message.author` can't run `command` here, as a reply; null when they can. */
export async function checkAccess(message: Message, command: Command): Promise<string | null> {
  const held = await rolesOf(message.author);
  const root = held.has('root');
  const missingRole = root ? undefined : requiredRolesOf(command).find((r) => !held.has(r));
  if (missingRole) return `🔒 Only ${roleLabel(missingRole)} can use this.`;
  if ((command.guildOnly || command.userPermissions?.length) && !message.guildId) return '🔒 This only works in a server.';
  const missing = await findMissingPermissions(message, root ? { ...command, userPermissions: [] } : command);
  return missingPermissionsReply(missing);
}

/** "bot root", "bot admins", or "the bot role **x**". */
export const roleLabel = (role: string) =>
  role === 'root' ? 'bot root' : role === 'admin' ? 'bot admins' : `holders of the bot role **${role}**`;

/**
 * Which of the command's declared permissions are missing, for the bot and for the caller, in this
 * channel (roles + channel overwrites). Throws if the guild or channel can't be loaded: the command
 * then doesn't run, rather than being checked against guild-wide permissions.
 */
async function findMissingPermissions(message: Message, command: Command) {
  const missing = { bot: [] as PermissionString[], user: [] as PermissionString[] };
  if (!message.guildId) return missing; // DMs: nothing to check
  const guild = await message.resolveGuild();
  // A guild message whose guild can't be loaded: the permissions can't be checked, so don't run it.
  if (!guild) throw new Error(`Couldn't load guild ${message.guildId} to check permissions`);

  // The channel itself, so its overwrites count: from the cache, else the API. If it can't be resolved,
  // refuse rather than fall back to guild-wide permissions, which would ignore a channel-level deny.
  let channel: Parameters<GuildMember['permissionsIn']>[0] | null = null;
  const resolveChannel = async () => {
    channel ??= (guild.channels.get(message.channelId) ?? (await message.resolveChannel().catch(() => null))) as typeof channel;
    if (!channel) throw new Error(`Couldn't load channel ${message.channelId} to check permissions`);
    return channel;
  };
  const check = async (getMember: () => Promise<GuildMember>, wanted: PermissionString[] = []) => {
    if (wanted.length === 0) return [];
    const perms = (await getMember()).permissionsIn(await resolveChannel());
    return wanted.filter((p) => !perms.has(p));
  };

  missing.bot = await check(async () => guild.members.me ?? guild.members.fetchMe(), command.botPermissions);
  missing.user = await check(() => guild.members.resolve(message.author.id), command.userPermissions);
  return missing;
}

/** The API rejected a request because the bot lacks a permission. */
function isMissingPermissionsError(error: unknown): boolean {
  const e = error as { statusCode?: number; code?: string };
  return e?.statusCode === 403 && (e.code === 'MISSING_PERMISSIONS' || e.code === undefined);
}

/**
 * Reply for a command that failed mid-run because the API refused a permission: one the command
 * didn't declare, or a channel overwrite checkAccess couldn't see. Null for any other error.
 */
export function permissionErrorReply(error: unknown): string | null {
  return isMissingPermissionsError(error)
    ? "🔒 I don't have permission to do that here. Ask an admin to check my role and this channel's permissions."
    : null;
}

function missingPermissionsReply(missing: { bot: PermissionString[]; user: PermissionString[] }): string | null {
  const list = (perms: PermissionString[]) => perms.map((p) => `**${permissionLabel(p)}**`).join(', ');
  if (missing.user.length) return `🔒 You need ${list(missing.user)} to use this.`;
  if (missing.bot.length) {
    return `🔒 I'm missing ${list(missing.bot)} here. Ask an admin to grant ${missing.bot.length > 1 ? 'them' : 'it'} to my role.`;
  }
  return null;
}
