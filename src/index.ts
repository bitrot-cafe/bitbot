import { Client, EmbedBuilder, Events, parsePrefixCommand } from '@fluxerjs/core';
import { askApprovals } from './approvals.js';
import './commands.js'; // the core commands (registers them)
import { loadPlugins, startPlugins, startupWarnings, stopPlugins } from './loader.js';
import { databaseUrl, instance, token } from './config.js';
import { humanDuration, loadCooldowns, startCooldownPruning, takeCooldown, type Reservation } from './cooldown.js';
import type { CommandContext } from './plugin.js';
import { trackGuilds } from './guilds.js';
import { coreSettingProblems, coreSettings } from './core-settings.js';
import { closeDb, describeUrl, initDb, setPoolErrorHandler } from './db/index.js';
import { groupUsage, usageLine, writeHelpPage } from './help.js';
import { build } from './build.js';
import { botInviteUrl } from './invite.js';
import { onShutdown, shutdown } from './lifecycle.js';
import { attachLogChannel, checkLogChannel, createLogger, errorMessage, isDebug } from './logger.js';
import { checkAccess, permissionErrorReply } from './permissions.js';
import { loadApplicationOwner, loadPermissions, rolesOf, setRolesClient } from './roles.js';
import { disabledPlugins, plugins, resolveCommand } from './registry.js';
import { prepareRepos } from './repos.js';
import { loadSettings } from './settings.js';
import { startStatus } from './status.js';

const log = createLogger('core');

if (!token) {
  log.error('FLUXER_BOT_TOKEN is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
// A core setting's env value of the wrong type (e.g. DEBUG=*) is a configuration mistake: say so and stop,
// rather than silently running with the default.
if (coreSettingProblems.length) {
  log.error(`Invalid environment: ${coreSettingProblems.join('; ')}`);
  process.exit(1);
}
// Who administers the bot. A broken permissions.yaml stops the bot: guessing could grant too much.
try {
  const from = loadPermissions();
  log.info(from ? `Bot roles from ${from}` : 'No permissions.yaml: the application owner alone is bot root');
} catch (error) {
  log.error((error as Error).message);
  process.exit(1);
}

// Self-hosted instances publish their endpoints at /.well-known/fluxer; fromDiscovery reads them.
// A bare hostname is fine; https:// is assumed.
// No waitForGuilds: it has no timeout, so one guild that never arrives would hold back Ready forever.
// Guilds listed in READY are in client.guilds at Ready anyway (unavailable ones as stubs).
const client = instance
  ? await Client.fromDiscovery(instance.includes('://') ? instance : `https://${instance}`)
  : new Client();
setRolesClient(client);
// Prompts and paged lists each hold reaction listeners for a while; more than Node's default of 10 at once
// is normal here, not a leak.
client.setMaxListeners(50);

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
onShutdown(closeDb); // last: plugins may still write while stopping
// Containers stop with SIGTERM (Ctrl+C sends SIGINT). Node ignores both unless we handle them.
// Registered before login so a stop during startup is handled too.
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => shutdown(`${signal} received`));

client.on(Events.Ready, () => {
  loadApplicationOwner(client).catch((error) => log.error('Could not look up the application owner', error));
  log.info(`Logged in as ${client.user?.username} (prefix "${coreSettings.prefix()}", bitbot ${build.version} @ ${build.commit})`);
  checkLogChannel(client);
  if (disabledPlugins.length) {
    // Repeated now that we're connected, so it reaches the log channel (load-time logs can't).
    log.warn(`${disabledPlugins.length} plugin(s) not loaded`, {
      plugins: disabledPlugins.map((p) => `${p.path}: ${p.reason}`),
    });
  }
  for (const warning of startupWarnings) log.warn(warning);
  const undeclared = plugins.filter((p) => !p.meta.api).map((p) => p.path);
  if (undeclared.length) {
    log.notice(`${undeclared.length} plugin(s) don't declare a bot API version`, { plugins: undeclared });
  }
  writeHelpPage(client.user?.username ?? 'Bot');
  if (client.guilds.size === 0) {
    log.info(`Not in any guilds yet. Add the bot with:\n${botInviteUrl(client)}`);
  }
});

// Plugin setup hooks run once, on the first connect (not on reconnects). Then plugins waiting for their
// dependencies to be approved are asked about (that needs the owner, for a DM when there's no log channel).
client.once(Events.Ready, async () => {
  await startPlugins(client);
  await loadApplicationOwner(client).catch(() => {}); // logged by the Ready handler above
  void askApprovals(client);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.content) return;

  // The guild's prefix, or a mention of the bot (always works, so an odd prefix can't lock anyone out).
  const me = client.user?.id;
  const start = message.content.trimStart();
  const used = (me && [`<@${me}>`, `<@!${me}>`].find((m) => start.startsWith(m))) || coreSettings.prefix(message.guildId);
  const prefix = coreSettings.prefix(message.guildId); // shown in replies
  const parsed = parsePrefixCommand(message.content, used);
  if (!parsed) return;

  const resolved = resolveCommand(parsed.command, parsed.args);
  if (!resolved) return;
  const { command, args, depth } = resolved;
  // The text after the command path, spacing kept: drop the prefix, then one word per path level.
  let rest = message.content.trim().slice(used.length).trimStart(); // trimmed like parsePrefixCommand
  for (let i = 0; i < depth; i++) rest = rest.replace(/^\S+\s*/, '');

  try {
    const problem = await checkAccess(message, command);
    if (problem) {
      await message.reply(problem);
      return;
    }
    if (!command.run) return void (await message.reply(groupUsage(command, prefix))); // a group on its own: show what's in it
    // Bot root and admins are exempt; otherwise the command's own cooldown, else the plugin's, else the bot's.
    // The window is reserved now and charged only if the use counted (see cooldown.ts).
    const held = await rolesOf(message.author);
    let reservation: Reservation = { commit() {}, release() {} };
    if (!held.has('root') && !held.has('admin')) {
      const cooldown = takeCooldown(
        { userId: message.author.id, guildId: message.guildId },
        command,
        command.cooldown ?? coreSettings.cooldown(message.guildId),
      );
      if (!cooldown.ok) {
        const whose = cooldown.per === 'user' ? '' : cooldown.per === 'guild' ? ' (shared by this server)' : ' (shared by everyone)';
        if (cooldown.warn) await message.reply(`⏳ \`${prefix}${command.name}\` can be used again in ${humanDuration(cooldown.seconds)}${whose}.`);
        return;
      }
      reservation = cooldown;
    }
    let counted = true;
    const ctx: CommandContext = {
      prefix,
      refund: () => void (counted = false),
      usage: async (note) => {
        counted = false;
        await message.reply(`Usage: \`${usageLine(command, prefix)}\`${note ? `\n${note}` : ''}`);
      },
    };
    try {
      await command.run(message, args, rest, ctx);
    } catch (error) {
      reservation.release();
      throw error;
    }
    if (counted) reservation.commit();
    else reservation.release();
  } catch (error) {
    const context = {
      user: message.author.id,
      guild: message.guildId,
      channel: message.channelId,
      content: message.content.length > 300 ? `${message.content.slice(0, 300)}…` : message.content,
    };
    // The API refused for lack of a permission (often: the bot can't post in this channel). That's a
    // guild's configuration, not a bug: logged at info, so it reaches the console but not the log channel
    // (whose flood guard would otherwise spend its budget on these and drop real errors).
    const denied = permissionErrorReply(error);
    if (denied) {
      log.info(`Command "${command.name}" was refused a permission by the API`, { ...context, error: errorMessage(error) });
      return void (await message.reply(denied).catch(() => {}));
    }
    const ref = log.error(`Command "${command.name}" failed`, error, context);
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

// Database first: settings (and plugins' config/storage) live there. A failed migration is fatal,
// since running against a half-migrated schema is worse than not starting.
try {
  setPoolErrorHandler((error) => log.warn('Database connection error; the pool will reconnect', { error: error.message }));
  const { backend, applied } = await initDb(databaseUrl);
  await loadSettings();
  await loadCooldowns();
  startCooldownPruning();
  log.info(`Database: ${backend} (${describeUrl(databaseUrl)})${applied.length ? `, applied ${applied.join(', ')}` : ''}`);
} catch (error) {
  log.error(`Can't open the database (${describeUrl(databaseUrl)})`, error);
  process.exit(1);
}

attachLogChannel(client);
await prepareRepos(); // make the repo clones match the database
await loadPlugins();
startStatus(client);
trackGuilds(client);
await client.login(token);
