import { Client, Events, parsePrefixCommand } from '@fluxerjs/core';
import { commands } from './commands.js';
import { botInviteUrl } from './invite.js';

const token = process.env.FLUXER_BOT_TOKEN;
const prefix = process.env.PREFIX || '!';
const instance = process.env.FLUXER_INSTANCE; // e.g. chat.example.com — unset means fluxer.app

if (!token) {
  console.error('FLUXER_BOT_TOKEN is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Self-hosted instances publish their endpoints at /.well-known/fluxer; fromDiscovery reads them.
// A bare hostname is fine; https:// is assumed.
const client = instance
  ? await Client.fromDiscovery(instance.includes('://') ? instance : `https://${instance}`)
  : new Client();

client.on(Events.Ready, () => {
  console.log(`Logged in as ${client.user?.username} (prefix "${prefix}")`);
  if (client.guilds.size === 0) {
    console.log(`Not in any guilds yet. Add the bot with:\n${botInviteUrl(client)}`);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.content) return;

  const parsed = parsePrefixCommand(message.content, prefix);
  if (!parsed) return;

  const command = commands.get(parsed.command);
  if (!command) return;

  try {
    await command.run(message, parsed.args);
  } catch (error) {
    console.error(`Command "${command.name}" failed:`, error);
  }
});

await client.login(token);

// Containers stop with SIGTERM (Ctrl+C sends SIGINT). Node ignores both unless we handle them.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    console.log(`${signal} received, shutting down.`);
    await client.destroy();
    process.exit(0);
  });
}
