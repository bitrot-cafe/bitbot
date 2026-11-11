import { PermissionFlags, type Client, type PermissionString } from '@fluxerjs/core';
import { commands } from './commands.js';

// Every command needs these; commands add their own via `botPermissions`.
const BASE_PERMISSIONS: PermissionString[] = ['ViewChannel', 'SendMessages', 'ReadMessageHistory'];

/** Link that adds the bot to a guild, on whichever instance the client is connected to. */
export function botInviteUrl(client: Client): string {
  const wanted = new Set([...BASE_PERMISSIONS, ...[...commands.values()].flatMap((c) => c.botPermissions ?? [])]);
  const permissions = [...wanted].reduce((all, name) => all | PermissionFlags[name], 0n);
  const url = new URL('/oauth2/authorize', client.instance.endpoints.webapp);
  url.searchParams.set('client_id', client.user!.id); // a bot's user ID is its application ID
  url.searchParams.set('scope', 'bot');
  url.searchParams.set('permissions', permissions.toString());
  return url.toString();
}
