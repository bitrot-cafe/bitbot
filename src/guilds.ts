import { Events, type Client } from '@fluxerjs/core';
import { db } from './db/index.js';
import { createLogger } from './logger.js';

/*
 * Which guilds the bot is in, and since when; and which it left. Per-guild data belonging to a guild the
 * bot has left is orphaned, and this table is how that's told apart from a quiet guild.
 *
 * At Ready the client's guild list holds every guild from the READY payload; ones not sent in full are
 * unavailable stubs with no name yet. On Ready the table is brought in line with that list: present
 * guilds are recorded, missing ones marked as left (the bot was removed while it was offline). If READY
 * listed no guilds, the sweep is skipped and guilds are recorded as they arrive (GuildAvailable), so a
 * removal while offline goes unnoticed: the safe way to fall short. After Ready, GuildCreate means
 * "joined" and GuildDelete "removed" (the library doesn't emit GuildDelete for an outage).
 * GuildAvailable also fills in a stub's name.
 */

const log = createLogger('guilds');

type GuildLike = { id: string; name?: string | null };

async function joined(guild: GuildLike) {
  const now = new Date().toISOString();
  const name = guild.name ?? '';
  await db()
    .insertInto('guilds')
    .values({ guild_id: guild.id, name, joined_at: now, left_at: '', updated_at: now })
    .onConflict((oc) =>
      oc.column('guild_id').doUpdateSet((eb) => ({
        // An unavailable guild has no name yet: keep the one we have.
        ...(name ? { name } : {}),
        // Rejoining after leaving starts a new stay; otherwise keep the original join date.
        joined_at: eb.case().when('guilds.left_at', '!=', '').then(now).else(eb.ref('guilds.joined_at')).end(),
        left_at: '',
        updated_at: now,
      })),
    )
    .execute();
}

async function left(guildId: string) {
  const now = new Date().toISOString();
  await db().updateTable('guilds').set({ left_at: now, updated_at: now }).where('guild_id', '=', guildId).execute();
}

/**
 * Bring the table in line with the complete guild list at Ready: record every current guild, and mark
 * stored guilds that aren't in it as left. An empty list while guilds are stored is never read as "removed
 * from all of them" (it means the list isn't complete): the sweep is skipped. Returns the guilds marked left.
 */
export async function syncGuilds(current: GuildLike[]) {
  for (const guild of current) await joined(guild);
  const ids = new Set(current.map((g) => g.id));
  const stored = await db().selectFrom('guilds').select('guild_id').where('left_at', '=', '').execute();
  const gone = stored.map((r) => r.guild_id).filter((id) => !ids.has(id));
  if (!gone.length) return [];
  if (!current.length) {
    log.warn(`The guild list was empty at startup while ${gone.length} guild(s) are recorded; not marking them as left`);
    return [];
  }
  for (const id of gone) await left(id);
  log.notice(`Removed from ${gone.length} guild(s) while offline`, { guilds: gone });
  return gone;
}

const quietly = (what: string, work: Promise<unknown>) => work.catch((error) => log.error(`Couldn't record ${what}`, error));

/** Keep the guilds table current (see the comment at the top). */
export function trackGuilds(client: Client) {
  client.on(Events.Ready, () => void quietly('the guild list', syncGuilds([...client.guilds.values()])));
  client.on(Events.GuildCreate, (guild) => void quietly(`guild ${guild.id}`, joined(guild)));
  client.on(Events.GuildAvailable, (guild) => void quietly(`guild ${guild.id}`, joined(guild)));
  client.on(Events.GuildDelete, (guild) => {
    log.notice(`Removed from guild ${guild.name ?? guild.id}`, { guild: guild.id });
    void quietly(`leaving guild ${guild.id}`, left(guild.id));
  });
}

/** Guilds the bot has left, with when. */
export const leftGuilds = () => db().selectFrom('guilds').selectAll().where('left_at', '!=', '').orderBy('left_at', 'desc').execute();
