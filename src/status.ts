import { Events, type Client } from '@fluxerjs/core';
import { build } from './build.js';
import { coreSettings } from './core-settings.js';
import { isDebug } from './logger.js';
import { setSetting, unsetSetting } from './settings.js';

// The template is the core "status" setting. Placeholders: {prefix}, {guilds}.
let pending: NodeJS.Timeout | undefined;

function render(client: Client) {
  // Debug mode overrides the status, so a debug build is obvious at a glance.
  if (isDebug()) return `DEBUG: commit ${build.commit}`;
  return coreSettings.status().replaceAll('{prefix}', coreSettings.prefix()).replaceAll('{guilds}', String(client.guilds.size));
}

/** Push the current status to the gateway. Debounced: guild joins arrive in bursts at startup. */
function update(client: Client) {
  clearTimeout(pending);
  pending = setTimeout(() => {
    if (!client.user) return;
    client.user.setPresence({ status: 'online', customStatus: { text: render(client) } });
  }, 2000);
}

/** Keep the bot's status current: on every (re)connect and whenever the guild count changes. */
export function startStatus(client: Client) {
  client.on(Events.Ready, () => update(client));
  client.on(Events.GuildCreate, () => update(client));
  client.on(Events.GuildAvailable, () => update(client));
  client.on(Events.GuildDelete, () => update(client));
}

/** Re-render the status now (e.g. after debug mode is toggled). */
export const refreshStatus = (client: Client) => update(client);

/** Change and store the status template. Null restores the default. Throws if it's set in env. */
export async function setStatusTemplate(client: Client, text: string | null, by: string): Promise<string> {
  if (text === null) await unsetSetting('core', 'status');
  else await setSetting('core', 'status', text, by);
  update(client);
  return render(client);
}
