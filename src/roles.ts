import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { UserFlagsBits, type Client, type User } from '@fluxerjs/core';
import { parse } from 'yaml';
import { appRoot, readEnv } from './config.js';

/*
 * Bot-wide roles, from permissions.yaml: who may administer the bot itself. Operator-owned, read once at
 * startup, never editable from chat (so a compromised admin account can't promote itself).
 *
 *   roles:
 *     root:   { users: ["1234567890123456789"] }   # plugins, restarts, debug mode
 *     admin:  { staff: true, users: [] }            # settings, status, audit log
 *     access-sync-operator: { users: [] }           # a role a plugin defines and checks
 *
 * - The application owner is always root. root holds every role and can't be overruled by anyone below it.
 * - `staff: true` grants a role to anyone with the instance Staff badge (don't use it on fluxer.app, where
 *   Staff means Fluxer employees).
 * - No file: the application owner alone, as root.
 * - Rank (immunity): root 2, admin 1, everyone else 0. A lower rank can't act on a higher one.
 *
 * Guild roles (who may use what inside one guild) are a separate, per-guild system in the database.
 */

export const RANK: Record<string, number> = { root: 2, admin: 1 };
export const BUILTIN_ROLES = ['root', 'admin'];

type RoleDef = { users: Set<string>; staff: boolean };
let roles = new Map<string, RoleDef>();
let applicationOwnerId: string | null = null;
/** The application owner (always root), once looked up at Ready; null before. */
export const ownerId = () => applicationOwnerId;

const ROLE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Parse permissions.yaml's text. Throws one readable message listing every problem. */
export function parsePermissions(text: string, source = 'permissions.yaml'): Map<string, RoleDef> {
  const problems: string[] = [];
  let doc: unknown;
  try {
    doc = parse(text) ?? {};
  } catch (error) {
    throw new Error(`${source} isn't valid YAML: ${(error as Error).message}`);
  }
  const result = new Map<string, RoleDef>();
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${source} must be a mapping with a "roles" key`);
  for (const key of Object.keys(doc as object)) if (key !== 'roles') problems.push(`unknown top-level key "${key}" (only "roles")`);
  const list = (doc as { roles?: unknown }).roles ?? {};
  if (typeof list !== 'object' || list === null || Array.isArray(list)) {
    problems.push('"roles" must be a mapping of role name → { users, staff }');
  } else {
    for (const [name, raw] of Object.entries(list)) {
      if (!ROLE_NAME.test(name)) {
        problems.push(`role "${name}": names are lower case letters, digits and "-"`);
        continue;
      }
      const def = raw ?? {};
      if (typeof def !== 'object' || Array.isArray(def)) {
        problems.push(`role "${name}" must be a mapping ({ users: [...], staff: true|false })`);
        continue;
      }
      for (const key of Object.keys(def)) if (key !== 'users' && key !== 'staff') problems.push(`role "${name}": unknown key "${key}"`);
      const { users = [], staff = false } = def as { users?: unknown; staff?: unknown };
      if (typeof staff !== 'boolean') problems.push(`role "${name}": staff must be true or false`);
      const ids = new Set<string>();
      if (!Array.isArray(users)) problems.push(`role "${name}": users must be a list of user IDs`);
      else {
        for (const u of users) {
          // IDs are bigger than YAML (JavaScript) numbers can hold exactly: an unquoted one is already wrong.
          if (typeof u === 'number') problems.push(`role "${name}": quote user IDs ("${u}" may already have lost digits)`);
          else if (typeof u !== 'string' || !/^\d{1,25}$/.test(u)) problems.push(`role "${name}": "${String(u)}" isn't a user ID`);
          else ids.add(u);
        }
      }
      result.set(name, { users: ids, staff: staff === true });
    }
  }
  if (problems.length) throw new Error(`${source}: ${problems.join('; ')}`);
  return result;
}

/**
 * Load permissions.yaml (PERMISSIONS_FILE, default permissions.yaml in the app folder). A missing default
 * file means "owner only"; a missing file that PERMISSIONS_FILE names, or any problem in it, throws.
 * Returns where it was read from, or null.
 */
export function loadPermissions(): string | null {
  const configured = readEnv('PERMISSIONS_FILE');
  const path = configured ? (isAbsolute(configured) ? configured : join(appRoot, configured)) : join(appRoot, 'permissions.yaml');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !configured) {
      roles = new Map();
      return null;
    }
    throw new Error(`Can't read ${path}: ${(error as Error).message}`);
  }
  roles = parsePermissions(text, path);
  return path;
}

/** For tests. */
export const setRoles = (text: string) => void (roles = parsePermissions(text));

/** Role names in permissions.yaml that nothing declares (not built in, not in any plugin's package.json). */
export const unknownRoles = (known: Iterable<string>) => {
  const all = new Set([...BUILTIN_ROLES, ...known]);
  return [...roles.keys()].filter((r) => !all.has(r));
};

// The bot's client, for looking up users passed as a bare { id } (e.g. by bot.canActOn).
let botClient: Pick<Client, 'users'> | null = null;
export const setRolesClient = (client: Pick<Client, 'users'> | null) => {
  botClient = client;
  cache.clear();
};

/** Look up who owns the bot's application. Runs on every (re)connect; cheap. */
export async function loadApplicationOwner(client: Client) {
  const app = await client.rest.get<{ owner?: { id: string } }>('/oauth2/applications/@me');
  applicationOwnerId = app.owner?.id ?? null;
  cache.clear();
}
/** For tests. */
export const setApplicationOwner = (id: string | null) => {
  applicationOwnerId = id;
  cache.clear();
};

/**
 * Whether the user carries the instance Staff flag. Public flags include it unless they hid their staff
 * badge. Gateway users can be partial, and plugins may pass a bare { id }: those are fetched. Throws if the
 * flag can't be determined (no client to fetch with), so callers never mistake "unknown" for "no".
 */
export async function hasStaffFlag(user: Who): Promise<boolean> {
  let flags = user.flags;
  if (flags == null) {
    const users = user.client?.users ?? botClient?.users;
    if (!users) throw new Error(`can't look up user ${user.id}'s staff flag (no client)`);
    flags = (await users.fetch(user.id)).flags ?? 0;
  }
  return (BigInt(flags) & UserFlagsBits.Staff) !== 0n;
}

export type Who = Pick<User, 'id'> & { flags?: User['flags'] | null; client?: Pick<Client, 'users'> };

// A user's roles, cached briefly: !help checks every command, and the staff flag can need a fetch.
const cache = new Map<string, { roles: Set<string>; until: number }>();
const CACHE_MS = 30_000;



/** Every bot role the user holds. root implies all of them. */
export async function rolesOf(user: Who): Promise<Set<string>> {
  return (await resolveRoles(user)).held;
}

/**
 * The user's roles, and whether that answer is certain: not certain when a `staff: true` role exists and
 * the user's staff flag couldn't be read (the answer then lacks any staff-granted role).
 */
async function resolveRoles(user: Who): Promise<{ held: Set<string>; certain: boolean }> {
  const hit = cache.get(user.id);
  if (hit && hit.until > Date.now()) return { held: hit.roles, certain: true };
  const held = new Set<string>();
  // Only cache an answer that's certain: if the staff flag couldn't be read, a staff-granted role is
  // missing from this answer, and caching it would refuse that user (or under-rank them) for a while.
  let certain = true;
  let staff = false;
  if ([...roles.values()].some((r) => r.staff)) {
    staff = await hasStaffFlag(user).catch(() => ((certain = false), false));
  }
  for (const [name, def] of roles) if (def.users.has(user.id) || (def.staff && staff)) held.add(name);
  if (user.id === applicationOwnerId) held.add('root');
  if (held.has('root')) for (const name of [...BUILTIN_ROLES, ...roles.keys()]) held.add(name);
  if (certain) cache.set(user.id, { roles: held, until: Date.now() + CACHE_MS });
  return { held, certain };
}

const rankFrom = (held: Set<string>) => Math.max(0, ...[...held].map((r) => RANK[r] ?? 0));

/** Whether the user holds `role`. root holds every role, including ones only a plugin knows about. */
export async function hasRole(user: Who, role: string) {
  const held = await rolesOf(user);
  return held.has(role) || held.has('root');
}

/** root 2, admin 1, anyone else 0. */
export async function rankOf(user: Who): Promise<number> {
  return rankFrom(await rolesOf(user));
}

/**
 * Immunity: false when the target outranks the actor (an admin can't act on root). Root outranks everyone,
 * so root always may. Otherwise it fails closed: if the target's rank can't be determined (their staff flag
 * can't be read), the answer is false. Each user is looked up once.
 */
export async function canActOn(actor: Who, target: Who) {
  const a = await resolveRoles(actor);
  if (a.held.has('root')) return true;
  const t = await resolveRoles(target);
  if (!t.certain) return false;
  return rankFrom(a.held) >= rankFrom(t.held);
}
