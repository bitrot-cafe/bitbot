import { Client, Events, parsePrefixCommand } from '@fluxerjs/core';
import { loadPlugins } from './commands.js';
import { instance, prefix, token } from './config.js';
import { writeHelpPage } from './help.js';
import { botInviteUrl } from './invite.js';
import { attachLogChannel, checkLogChannel, createLogger, errorMessage, isDebug } from './logger.js';
import { checkAccess, loadApplicationOwner, permissionErrorReply } from './permissions.js';
import { commands } from './registry.js';
import { startStatus } from './status.js';

const log = createLogger('core');

if (!token) {
  log.error('FLUXER_BOT_TOKEN is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Self-hosted instances publish their endpoints at /.well-known/fluxer; fromDiscovery reads them.
// A bare hostname is fine; https:// is assumed.
const client = instance
  ? await Client.fromDiscovery(instance.includes('://') ? instance : `https://${instance}`)
  : new Client();

// Containers stop with SIGTERM (Ctrl+C sends SIGINT). Node ignores both unless we handle them.
// Registered before login so a stop during startup is handled too.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    log.info(`${signal} received, shutting down.`);
    setTimeout(() => process.exit(0), 5000).unref(); // don't let a hung disconnect block shutdown
    await client.destroy();
    process.exit(0);
  });
}

client.on(Events.Ready, () => {
  loadApplicationOwner(client).catch((error) => log.error('Could not look up the application owner', error));
  log.info(`Logged in as ${client.user?.username} (prefix "${prefix}")`);
  checkLogChannel(client);
  writeHelpPage(client.user?.username ?? 'Bot');
  if (client.guilds.size === 0) {
    log.info(`Not in any guilds yet. Add the bot with:\n${botInviteUrl(client)}`);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.content) return;

  const parsed = parsePrefixCommand(message.content, prefix);
  if (!parsed) return;

  const command = commands.get(parsed.command);
  if (!command) return;

  try {
    const problem = await checkAccess(message, command);
    if (problem) {
      await message.reply(problem);
      return;
    }
    await command.run(message, parsed.args);
  } catch (error) {
    const ref = log.error(`Command "${command.name}" failed`, error, {
      user: message.author.id,
      guild: message.guildId,
      channel: message.channelId,
      content: message.content,
    });
    const reply =
      permissionErrorReply(error) ??
      `Something went wrong running \`${prefix}${command.name}\`${isDebug() ? `: ${errorMessage(error)}` : '.'} (ref ${ref})`;
    await message.reply(reply).catch(() => {}); // can't even reply: it's logged, nothing more to do
  }
});

attachLogChannel(client);
await loadPlugins();
startStatus(client);
await client.login(token);
