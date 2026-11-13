import { randomUUID } from 'node:crypto';
import { db } from './db/index.js';
import { NONE } from './db/schema.js';
import { createLogger } from './logger.js';

/*
 * The audit log: a permanent, queryable record of who changed what (settings, plugins, and anything a
 * plugin records with bot.audit). The log channel is for noticing things now; this is for looking them
 * up later. Writing never throws: a failed write is logged, and the action itself still happens.
 */

const log = createLogger('audit');

export type AuditEntry = {
  /** e.g. "setting.set", "plugin.enable". */
  action: string;
  /** Who did it; omit for the bot itself. */
  actor?: { id: string; username: string };
  guildId?: string | null;
  /** What it was done to. */
  target?: string;
  details?: Record<string, unknown>;
};

export async function audit(source: string, entry: AuditEntry) {
  try {
    await db()
      .insertInto('audit_log')
      .values({
        id: randomUUID(),
        at: new Date().toISOString(),
        guild_id: entry.guildId ?? NONE,
        actor_id: entry.actor?.id ?? NONE,
        actor: entry.actor?.username ?? '',
        source,
        action: entry.action,
        target: entry.target ?? '',
        details: JSON.stringify(entry.details ?? {}),
      })
      .execute();
  } catch (error) {
    log.error(`Couldn't write the audit log (${source} ${entry.action})`, error);
  }
}

/** The most recent entries, newest first: bot-wide, or for one guild. */
export async function recentAudit({ guildId, limit = 15 }: { guildId?: string; limit?: number } = {}) {
  let query = db().selectFrom('audit_log').selectAll();
  if (guildId !== undefined) query = query.where('guild_id', '=', guildId);
  return query.orderBy('at', 'desc').limit(Math.min(Math.max(limit, 1), 50)).execute();
}
