import { Events, type Client } from '@fluxerjs/core';
import { defaultStatus, prefix } from './config.js';

// Placeholders: {prefix}, {guilds}.
let template = defaultStatus;
let pending: NodeJS.Timeout | undefined;

function render(client: Client) {
  return template.replaceAll('{prefix}', prefix).replaceAll('{guilds}', String(client.guilds.size));
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
  client.on(Events.GuildDelete, () => update(client));
}

/** Change the status template at runtime (not persisted across restarts). Null restores the default. */
export function setStatusTemplate(client: Client, text: string | null): string {
  template = text ?? defaultStatus;
  update(client);
  return render(client);
}
