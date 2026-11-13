import { db } from './db/index.js';
import { createLogger } from './logger.js';
import type { Command, Cooldown, CooldownLimit } from './plugin.js';

/*
 * Command cooldowns. A command's cooldown is a number (seconds, per user), { seconds, per }, or a list of
 * those, all of which must allow the use:
 *   per 'user'  — each user on their own (across guilds)
 *   per 'guild' — everyone in a guild shares it (a DM counts as the user's own)
 *   per 'bot'   — everyone everywhere shares it (e.g. to cap calls to a paid API)
 * Unset falls back to the plugin's default, then the bot's (core.cooldown); index.ts resolves that and
 * exempts bot root and admins.
 *
 * Only a use that counts is charged. Taking a cooldown reserves the window before the command runs (so two
 * simultaneous uses can't both get through); the caller then commits it, or releases it if the command
 * threw or said the use didn't count (ctx.usage(), ctx.refund()).
 *
 * Kept in memory. Committed cooldowns longer than a minute are also stored (the `timers` table) so a
 * restart or a plugin update doesn't reset a once-a-day command. A user who hits a cooldown is told once
 * per window.
 */

const log = createLogger('cooldown');
const PERSIST_OVER_S = 60;

/** Normalise and validate a cooldown declaration. Throws a readable message. */
export function parseCooldown(raw: unknown): Cooldown {
  const one = (v: unknown): CooldownLimit => {
    if (typeof v === 'number') return { seconds: v, per: 'user' };
    const o = v as Partial<CooldownLimit> | null;
    if (!o || typeof o !== 'object' || typeof o.seconds !== 'number' || !['user', 'guild', 'bot'].includes(o.per as string)) {
      throw new Error('expected seconds, { seconds, per: "user" | "guild" | "bot" }, or a list of those');
    }
    return { seconds: o.seconds, per: o.per! };
  };
  const limits = Array.isArray(raw) ? raw.map(one) : [one(raw)];
  for (const l of limits) if (!Number.isFinite(l.seconds) || l.seconds < 0) throw new Error(`"${l.seconds}" isn't a number of seconds`);
  return Array.isArray(raw) ? limits : limits[0];
}

export const limitsOf = (c: Cooldown): CooldownLimit[] => (Array.isArray(c) ? c : [typeof c === 'number' ? { seconds: c, per: 'user' as const } : c]).filter((l) => l.seconds > 0);

const until = new Map<string, number>(); // bucket → ms
const warned = new Map<string, Map<string, number>>(); // bucket → user → ms (told until then)
let lastSweep = 0;

// ":" separates: IDs are digits and command names have no ":". (Not NUL: Postgres text can't hold it.)
function bucketOf(limit: CooldownLimit, command: string, userId: string, guildId: string | null | undefined) {
  if (limit.per === 'bot') return `b:${command}`;
  if (limit.per === 'guild' && guildId) return `g:${guildId}:${command}`;
  return `u:${userId}:${command}`;
}

/** A reserved use: commit() when it counted, release() when it didn't. Calling either twice is harmless. */
export type Reservation = { commit(): void; release(): void };
export type CooldownCheck =
  | ({ ok: true } & Reservation)
  | { ok: false; seconds: number; per: CooldownLimit['per']; warn: boolean };

const NOTHING: Reservation = { commit() {}, release() {} };

/**
 * Try to use `command` now under `cooldown` (already resolved). On ok, every limit's window is reserved;
 * commit or release it once the command has run. On refusal: the longest remaining wait, which limit caused
 * it, and whether to tell the user (once per window).
 */
export function takeCooldown(
  who: { userId: string; guildId?: string | null },
  command: Pick<Command, 'name' | 'origin'>,
  cooldown: Cooldown,
  now = Date.now(),
): CooldownCheck {
  const limits = limitsOf(cooldown);
  if (!limits.length) return { ok: true, ...NOTHING };
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, t] of until) if (t <= now) until.delete(k);
    for (const [bucket, users] of warned) {
      for (const [user, t] of users) if (t <= now) users.delete(user);
      if (!users.size) warned.delete(bucket);
    }
  }
  const buckets = limits.map((limit) => ({ limit, key: bucketOf(limit, command.name, who.userId, who.guildId) }));
  let worst: { left: number; per: CooldownLimit['per']; key: string } | null = null;
  for (const { limit, key } of buckets) {
    const left = (until.get(key) ?? 0) - now;
    if (left > 0 && (!worst || left > worst.left)) worst = { left, per: limit.per, key };
  }
  if (worst) {
    let users = warned.get(worst.key);
    if (!users) warned.set(worst.key, (users = new Map()));
    const warn = (users.get(who.userId) ?? 0) <= now;
    if (warn) users.set(who.userId, now + worst.left);
    return { ok: false, seconds: Math.ceil(worst.left / 1000), per: worst.per, warn };
  }
  const reserved = buckets.map(({ limit, key }) => ({ limit, key, t: now + limit.seconds * 1000 }));
  for (const r of reserved) until.set(r.key, r.t);
  let settled = false;
  return {
    ok: true,
    commit() {
      if (settled) return;
      settled = true;
      for (const { limit, key, t } of reserved) {
        if (limit.seconds > PERSIST_OVER_S) persist(key, t, command.origin ?? 'core', limit.per === 'guild' ? (who.guildId ?? '') : '');
      }
    },
    release() {
      if (settled) return;
      settled = true;
      // Only undo our own reservation (nothing else can have taken these buckets while they were reserved),
      // and forget who was told to wait for it: that wait no longer applies.
      for (const { key, t } of reserved) {
        if (until.get(key) === t) {
          until.delete(key);
          warned.delete(key);
        }
      }
    },
  };
}

function persist(key: string, t: number, owner: string, guildId: string) {
  const row = { key: `cooldown:${key}`, kind: 'cooldown', owner, guild_id: guildId, due_at: new Date(t).toISOString(), payload: '{}' };
  db()
    .insertInto('timers')
    .values(row)
    .onConflict((oc) => oc.column('key').doUpdateSet({ due_at: row.due_at }))
    .execute()
    .catch((error) => log.warn("Couldn't store a cooldown; it resets if the bot restarts", { error: String(error) }));
}

/** Startup: load stored cooldowns that haven't expired, and drop the ones that have. */
export async function loadCooldowns(now = Date.now()) {
  const nowIso = new Date(now).toISOString();
  await db().deleteFrom('timers').where('kind', '=', 'cooldown').where('due_at', '<=', nowIso).execute();
  for (const row of await db().selectFrom('timers').select(['key', 'due_at']).where('kind', '=', 'cooldown').execute()) {
    until.set(row.key.slice('cooldown:'.length), Date.parse(row.due_at));
  }
}

/** Drop expired stored cooldowns now and then (the in-memory ones are swept as they're checked). */
export function startCooldownPruning() {
  setInterval(() => {
    db()
      .deleteFrom('timers')
      .where('kind', '=', 'cooldown')
      .where('due_at', '<=', new Date().toISOString())
      .execute()
      .catch(() => {});
  }, 10 * 60_000).unref();
}

/** "45s", "3m", "2h 5m", "1d 4h": for "wait" replies. */
export function humanDuration(seconds: number) {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return `${m}m`;
  return `${seconds}s`;
}

/** For tests. */
export const resetCooldowns = () => {
  until.clear();
  warned.clear();
};
