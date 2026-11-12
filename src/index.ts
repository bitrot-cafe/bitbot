import { Client, EmbedBuilder, Events, parsePrefixCommand } from '@fluxerjs/core';
import { loadPlugins, startPlugins, stopPlugins } from './commands.js';
import { instance, prefix, token } from './config.js';
import { groupUsage, writeHelpPage } from './help.js';
import { build } from './build.js';
import { botInviteUrl } from './invite.js';
import { onShutdown, shutdown } from './lifecycle.js';
import { attachLogChannel, checkLogChannel, createLogger, errorMessage, isDebug } from './logger.js';
import { checkAccess, loadApplicationOwner, permissionErrorReply } from './permissions.js';
import { disabledPlugins, plugins, resolveCommand } from './registry.js';
import { ensureRepos } from './repos.js';
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
  setTimeout(() => shutdown('uncaught exception', 1), 1000).unref(); // give the log channel a moment
});

// Clean-up on shutdown or restart: plugins first, then the gateway connection.
onShutdown(stopPlugins);
onShutdown(() => client.destroy());
// Containers stop with SIGTERM (Ctrl+C sends SIGINT). Node ignores both unless we handle them.
// Registered before login so a stop during startup is handled too.
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => shutdown(`${signal} received`));

client.on(Events.Ready, () => {
  loadApplicationOwner(client).catch((error) => log.error('Could not look up the application owner', error));
  log.info(`Logged in as ${client.user?.username} (prefix "${prefix}", bitbot ${build.version} @ ${build.commit})`);
  checkLogChannel(client);
  if (disabledPlugins.length) {
    // Repeated now that we're connected, so it reaches the log channel (load-time logs can't).
    log.warn(`${disabledPlugins.length} plugin(s) not loaded`, {
      plugins: disabledPlugins.map((p) => `${p.id}: ${p.reason}`),
    });
  }
  const undeclared = plugins.filter((p) => !p.api).map((p) => p.id);
  if (undeclared.length) {
    log.notice(`${undeclared.length} plugin(s) don't declare a bot API version`, { plugins: undeclared });
  }
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
  let rest = message.content.trim().slice(prefix.length).trimStart(); // trimmed like parsePrefixCommand
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
    const denied = permissionErrorReply(error);
    if (denied) return void (await message.reply(denied).catch(() => {}));
    const embed = new EmbedBuilder()
      .setTitle('❌ Something went wrong')
      .setColor(0xef4444)
      .setDescription(`\`${prefix}${command.name}\` failed. A bot admin can look it up with the ref below.`)
      .addFields({ name: 'Ref', value: `\`${ref}\``, inline: true });
    if (isDebug()) embed.addFields({ name: 'Error (debug mode)', value: `\`\`\`\n${errorMessage(error).slice(0, 990)}\n\`\`\`` });
    // No Embed links here? Fall back to text. Can't even reply? It's logged; nothing more to do.
    await message
      .reply({ embeds: [embed] })
      .catch(() => message.reply(`❌ \`${prefix}${command.name}\` failed (ref ${ref}).`))
      .catch(() => {});
  }
});

attachLogChannel(client);
await ensureRepos(); // clone any repo in plugins.json that's missing (fresh install)
await loadPlugins();
startStatus(client);
await client.login(token);
