import type { Client } from '@fluxerjs/core';
import { audit } from './audit.js';
import { awaitingApproval, loadLate, type LateFailure } from './loader.js';
import { anyRoot, ask } from './confirm.js';
import { coreSettings } from './core-settings.js';
import { approve, describeDeps, type DepsInfo } from './deps.js';
import { createLogger } from './logger.js';
import { disablePlugin, type PluginFolder } from './repos.js';
import { ownerId } from './roles.js';

/*
 * Dependency approvals for enabled plugins that couldn't load at startup because their lockfile was never
 * approved (or changed): mostly local plugins, and repo plugins from before 0.4. Asked once connected, in
 * the log channel, else in a DM to the application owner, else only on the console. Any bot root may
 * answer. ✅ approves, installs and loads the plugin without a restart; ❌ disables it; no answer leaves it
 * waiting until the next start. `!root plugins approve <path>` does the same as ✅.
 */

const log = createLogger('plugins');
const WAIT_MS = 6 * 3_600_000;

/** Approve a plugin's lockfile, install it and load the plugin now. Returns why it didn't load, or null. */
export async function approveAndLoad(folder: PluginFolder, info: DepsInfo, by: { id: string; username: string }, client: Client) {
  await approve(folder.path, info.lockHash, `${by.username} (${by.id})`);
  await audit('root', { action: 'plugin.approve', actor: by, target: folder.path, details: { lockHash: info.lockHash, packages: info.total, scripts: info.allowed } });
  log.notice(`Dependencies of ${folder.path} approved by ${by.username} (${by.id})`);
  return loadLate(folder, client);
}

/** For a load refused by a clash: what the restart will do, and how to avoid it. */
export const refusedNote = (failed: LateFailure) =>
  failed.refused ? '. At the next restart both plugins in the clash are disabled, unless you disable one of them first.' : '';

async function promptTarget(client: Client) {
  const channel = coreSettings.logChannel();
  if (channel) return (text: string) => client.channels.send(channel, { content: text });
  const owner = ownerId();
  if (owner) {
    const user = await client.users.fetch(owner).catch(() => null);
    if (user) return (text: string) => user.send(text);
  }
  return null;
}

/** Ask about every plugin waiting for approval. Call once, after Ready (and the owner lookup). */
export async function askApprovals(client: Client) {
  if (!awaitingApproval.size) return;
  const send = await promptTarget(client);
  if (!send) {
    log.warn(`${awaitingApproval.size} plugin(s) wait for their dependencies to be approved, and there's no log channel or owner to ask: use \`root plugins approve <path>\``, {
      plugins: [...awaitingApproval.keys()],
    });
    return;
  }
  // One prompt per plugin, in parallel: each can be answered on its own.
  await Promise.all(
    [...awaitingApproval.values()].map(async ({ folder, info }) => {
      try {
        const { answer, by, prompt, noReactions } = await ask(
          `**\`${folder.path}\` is enabled but waiting:** its dependencies haven't been approved.\n${describeDeps(folder.path, info)}\n` +
            `Any bot root can answer. ✅ installs them and loads the plugin now; ❌ disables it. ` +
            `Or use \`${coreSettings.prefix()}root plugins approve ${folder.path}\`.`,
          { client, send, mayAnswer: anyRoot(client), timeoutMs: WAIT_MS },
        );
        if (noReactions) return; // the prompt says to use the command
        // Approved some other way meanwhile (the approve command): nothing to do.
        if (!awaitingApproval.has(folder.path)) return prompt.edit({ content: `\`${folder.path}\`: already handled.` });
        if (answer === null) return prompt.edit({ content: `\`${folder.path}\`: no answer; asked again at the next start.` });
        const user = await client.users.fetch(by!).catch(() => null);
        const actor = { id: by!, username: user?.username ?? by! };
        if (!answer) {
          await disablePlugin(folder.path);
          awaitingApproval.delete(folder.path);
          await audit('root', { action: 'plugin.disable', actor, target: folder.path, details: { reason: 'dependencies refused' } });
          log.notice(`Plugin ${folder.path} disabled by ${actor.username} (${actor.id}): dependencies refused`);
          return prompt.edit({ content: `\`${folder.path}\`: dependencies refused; the plugin is disabled.` });
        }
        await prompt.edit({ content: `\`${folder.path}\`: installing…` });
        const failed = await approveAndLoad(folder, info, actor, client);
        return prompt.edit({ content: failed ? `\`${folder.path}\`: approved, but it didn't load: ${failed.reason}${refusedNote(failed)}` : `\`${folder.path}\`: approved and loaded.` });
      } catch (error) {
        log.error(`Couldn't ask about ${folder.path}'s dependencies`, error);
      }
    }),
  );
}
