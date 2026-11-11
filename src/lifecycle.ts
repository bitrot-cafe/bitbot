import { utimes } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';

/*
 * Shutdown and restart. index.ts registers what to clean up (plugins' stop hooks, the gateway
 * connection); anything can then call shutdown() or restart().
 */

const log = createLogger('core');
const hooks: (() => unknown)[] = [];
let stopping = false;

/** Run `fn` during shutdown, in registration order. */
export const onShutdown = (fn: () => unknown) => void hooks.push(fn);

/** Clean up and exit. Capped at 5 seconds so a hung disconnect can't block it. */
export async function shutdown(why: string, code = 0) {
  if (stopping) return;
  stopping = true;
  log.info(`Shutting down: ${why}`);
  setTimeout(() => process.exit(code), 5000).unref();
  for (const fn of hooks) {
    try {
      await fn();
    } catch (error) {
      log.error('Shutdown step failed', error);
    }
  }
  process.exit(code);
}

/**
 * Restart the bot, e.g. to load changed plugins (ES modules can't be cleanly unloaded).
 * Production: exit, and the container's restart policy (`restart: unless-stopped`) starts it again.
 * Dev: `tsx watch` doesn't restart a process that exits, so touch the entry file instead; the watcher
 * then stops this process (SIGTERM, the normal shutdown) and starts a fresh one.
 */
export async function restart(why: string) {
  if (process.env.NODE_ENV !== 'production') {
    log.info(`Restarting (dev, via the file watcher): ${why}`);
    const now = new Date();
    await utimes(fileURLToPath(new URL('./index.ts', import.meta.url)), now, now);
    return;
  }
  await shutdown(`restart: ${why}`);
}
