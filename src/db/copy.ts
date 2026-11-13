import { pathToFileURL } from 'node:url';
import { backendOf, describeUrl, migrate, openDb } from './index.js';
import { DATA_TABLES } from './schema.js';

/*
 * Copy all bot data from one database to another, e.g. SQLite → Postgres when a community grows, or
 * Postgres → SQLite for a local copy. The target is migrated first and must be empty; the copy runs in
 * one transaction and row counts are checked afterwards.
 *
 *   pnpm db:copy --from sqlite:data/bitbot.db --to postgres://bitbot:secret@db:5432/bitbot
 */

const BATCH = 500;

export async function copyDatabase(fromUrl: string, toUrl: string, log: (line: string) => void = console.log) {
  if (fromUrl === toUrl) throw new Error('--from and --to are the same database');
  const from = openDb(fromUrl);
  const to = openDb(toUrl);
  try {
    await migrate(from); // both ends on the same schema version
    await migrate(to);

    for (const table of DATA_TABLES) {
      const { n } = await to.selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
      if (Number(n) > 0) throw new Error(`Target table "${table}" isn't empty (${n} rows); refusing to overwrite`);
    }

    const counts: Record<string, number> = {};
    await to.transaction().execute(async (trx) => {
      for (const table of DATA_TABLES) {
        const rows = await from.selectFrom(table).selectAll().execute();
        for (let i = 0; i < rows.length; i += BATCH) {
          await trx.insertInto(table).values(rows.slice(i, i + BATCH) as never).execute();
        }
        counts[table] = rows.length;
      }
    });

    for (const table of DATA_TABLES) {
      const { n } = await to.selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
      if (Number(n) !== counts[table]) throw new Error(`Row count mismatch in "${table}": copied ${counts[table]}, found ${n}`);
    }
    log(`Copied ${describeUrl(fromUrl)} (${backendOf(fromUrl)}) → ${describeUrl(toUrl)} (${backendOf(toUrl)}):`);
    for (const table of DATA_TABLES) log(`  ${table}: ${counts[table]} rows`);
    return counts;
  } finally {
    await from.destroy();
    await to.destroy();
  }
}

// CLI: pnpm db:copy --from <url> --to <url>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const fromUrl = arg('from');
  const toUrl = arg('to');
  if (!fromUrl || !toUrl) {
    console.error('Usage: pnpm db:copy --from <database url> --to <database url>');
    process.exit(2);
  }
  copyDatabase(fromUrl, toUrl).catch((error) => {
    console.error(`db:copy failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
