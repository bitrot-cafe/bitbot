import { PermissionFlags, type Client } from '@fluxerjs/core';

// Permissions requested when the bot is added to a guild. Extend as features need them.
const PERMISSIONS = [
  PermissionFlags.ViewChannel,
  PermissionFlags.SendMessages,
  PermissionFlags.ReadMessageHistory,
  PermissionFlags.EmbedLinks,
  PermissionFlags.AddReactions,
];

/** Link that adds the bot to a guild, on whichever instance the client is connected to. */
export function botInviteUrl(client: Client): string {
  const permissions = PERMISSIONS.reduce((all, flag) => all | flag, 0n);
  const url = new URL('/oauth2/authorize', client.instance.endpoints.webapp);
  url.searchParams.set('client_id', client.user!.id); // a bot's user ID is its application ID
  url.searchParams.set('scope', 'bot');
  url.searchParams.set('permissions', permissions.toString());
  return url.toString();
}
