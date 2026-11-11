import { Client, Events, parsePrefixCommand } from '@fluxerjs/core';
import { loadPlugins, startPlugins, stopPlugins } from './commands.js';
import { instance, prefix, token } from './config.js';
import { groupUsage, writeHelpPage } from './help.js';
import { botInviteUrl } from './invite.js';
import { attachLogChannel, checkLogChannel, createLogger, errorMessage, isDebug } from './logger.js';
import { checkAccess, loadApplicationOwner, permissionErrorReply } from './permissions.js';
import { resolveCommand } from './registry.js';
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

// Last-resort safety net for async code outside a command's try/catch (event listeners, timers):
// log instead of letting Node kill the process. A truly uncaught exception leaves the process in an
// unknown state, so log it and exit; the container's restart policy brings the bot back.
process.on('unhandledRejection', (reason) => log.error('Unhandled promise rejection', reason));
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception, exiting', error);
  setTimeout(() => process.exit(1), 1000).unref(); // give the log channel a moment
});

// Containers stop with SIGTERM (Ctrl+C sends SIGINT). Node ignores both unless we handle them.
// Registered before login so a stop during startup is handled too.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    log.info(`${signal} received, shutting down.`);
    setTimeout(() => process.exit(0), 5000).unref(); // don't let a hung disconnect block shutdown
    await stopPlugins();
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

// Plugin setup hooks run once, on the first connect (not on reconnects).
client.once(Events.Ready, () => startPlugins(client));

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.content) return;

  const parsed = parsePrefixCommand(message.content, prefix);
  if (!parsed) return;

  const resolved = resolveCommand(parsed.command, parsed.args);
  if (!resolved) return;
  const { command, args, depth } = resolved;
  // The text after the command path, spacing kept: drop the prefix, then one word per path level.
  let rest = message.content.slice(prefix.length).trimStart();
  for (let i = 0; i < depth; i++) rest = rest.replace(/^\S+\s*/, '');

  try {
    const problem = await checkAccess(message, command);
    if (problem) {
      await message.reply(problem);
      return;
    }
    if (command.run) await command.run(message, args, rest);
    else await message.reply(groupUsage(command)); // a group on its own: show what's in it
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
