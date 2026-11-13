import type { Migration } from 'kysely/migration';
import * as init from './0001_init.js';

/** Every migration, in order. Names sort in the order they must run; never rename or edit a shipped one. */
export const migrations: Record<string, Migration> = {
  '0001_init': init,
};
