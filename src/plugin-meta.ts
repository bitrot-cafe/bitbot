import { parseCooldown } from './cooldown.js';
import type { Cooldown } from './plugin.js';
import type { SettingDef } from './settings.js';

/*
 * A plugin's metadata: its package.json. A folder is a plugin when its package.json has a "bitbot" object;
 * the code is its index.ts. Listing, adding and previewing plugins read this file only, so they never run
 * plugin code.
 *
 *   {
 *     "name": "bitbot-plugin-whoami", "version": "1.0.0", "description": "...", "author": "...",
 *     "repository": "https://...",
 *     "bitbot": {
 *       "api": "0.4",            // the bot API it needs
 *       "id": "whoami",          // its data identity: settings scope, store namespace (unique)
 *       "title": "Who Am I",     // display name (default: the id)
 *       "roles": ["..."],        // bot roles it defines (for permissions.yaml)
 *       "cooldown": 5,           // default cooldown for its commands
 *       "config": { ... },       // its settings (see SettingDef)
 *       "allowScripts": ["sharp"] // dependencies whose install scripts may run
 *     }
 *   }
 */

export type PluginMeta = {
  id: string;
  title: string;
  version: string;
  author?: string;
  description?: string;
  repository?: string;
  api?: string;
  roles?: string[];
  cooldown?: Cooldown;
  config?: Record<string, SettingDef>;
  allowScripts?: string[];
  /** It has (non-dev) dependencies to install. */
  hasDependencies: boolean;
};

/** Names a plugin id can't take: the core's settings scopes and the plugin sources. */
export const RESERVED_IDS = new Set(['core', 'admin', 'root', 'local', 'builtin']);
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SETTING_TYPES = new Set(['string', 'number', 'boolean', 'id', 'url']);
/** An npm package name, optionally scoped. */
export const PACKAGE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
/** npm's "author" / "repository": a string, or an object with a name / url. */
const nameOrField = (v: unknown, field: 'name' | 'url') => str(v) ?? (isObject(v) ? str(v[field]) : undefined);

function checkSetting(key: string, def: unknown): string | null {
  if (!/^[a-z0-9][a-z0-9_]{0,63}$/.test(key)) return `setting name "${key}" must be lower case letters, digits and "_"`;
  if (!isObject(def)) return `setting "${key}" must be an object`;
  if (!SETTING_TYPES.has(def.type as string)) return `setting "${key}": "type" must be one of ${[...SETTING_TYPES].join(', ')}`;
  if (typeof def.description !== 'string') return `setting "${key}" needs a "description"`;
  const types: Record<string, string[]> = {
    default: ['string', 'number', 'boolean'],
    required: ['boolean'],
    secret: ['boolean'],
    env: ['string', 'boolean'],
    pattern: ['string'],
    restart: ['boolean'],
    perGuild: ['boolean'],
    rootOnly: ['boolean'],
  };
  for (const [field, value] of Object.entries(def)) {
    if (field === 'type' || field === 'description') continue;
    if (!types[field]) return `setting "${key}": unknown field "${field}"`;
    if (!types[field].includes(typeof value)) return `setting "${key}": "${field}" must be ${types[field].join(' or ')}`;
  }
  if (def.env === true) return `setting "${key}": "env" is a variable name, or false`;
  return null;
}

/**
 * Read a plugin's package.json text. `null`: not a plugin (no file, or no "bitbot" object). Otherwise the
 * metadata, or a `problem` that keeps it from loading (it's still listed, so the mistake gets seen).
 * Never throws.
 */
export function parseMeta(packageJson: string | null): { meta: PluginMeta } | { problem: string; id?: string; title?: string } | null {
  if (packageJson === null) return null;
  let pkg: unknown;
  try {
    pkg = JSON.parse(packageJson);
  } catch {
    // Can't tell whether it's meant to be a plugin; a "bitbot" key in the text says it probably is.
    return /"bitbot"\s*:/.test(packageJson) ? { problem: "package.json isn't valid JSON" } : null;
  }
  if (!isObject(pkg) || !isObject(pkg.bitbot)) return null;
  const b = pkg.bitbot;
  const problems: string[] = [];
  const id = str(b.id);
  if (!id) problems.push('no "bitbot.id" (the name of the plugin\'s settings and data; added in bot API 0.4)');
  else if (!ID.test(id)) problems.push('"bitbot.id" must be lower case letters, digits and "-"');
  else if (RESERVED_IDS.has(id)) problems.push(`"bitbot.id" "${id}" is reserved`);
  const title = str(b.title) ?? id ?? '';

  for (const field of ['api', 'title'] as const) {
    if (b[field] !== undefined && typeof b[field] !== 'string') problems.push(`"bitbot.${field}" must be a string`);
  }
  // Shown in every list line and as embed titles.
  if (title.length > 64) problems.push('"bitbot.title" is longer than 64 characters');
  let roles: string[] | undefined;
  if (b.roles !== undefined) {
    if (Array.isArray(b.roles) && b.roles.every((r) => typeof r === 'string' && ID.test(r))) roles = b.roles;
    else problems.push('"bitbot.roles" must be a list of role names (lower case letters, digits, "-")');
  }
  let cooldown: Cooldown | undefined;
  if (b.cooldown !== undefined) {
    try {
      cooldown = parseCooldown(b.cooldown);
    } catch (error) {
      problems.push(`"bitbot.cooldown": ${(error as Error).message}`);
    }
  }
  let config: Record<string, SettingDef> | undefined;
  if (b.config !== undefined) {
    if (!isObject(b.config)) problems.push('"bitbot.config" must be an object of settings');
    else {
      const bad = Object.entries(b.config).map(([k, d]) => checkSetting(k, d)).filter((p): p is string => !!p);
      if (bad.length) problems.push(...bad.map((p) => `"bitbot.config": ${p}`));
      else config = b.config as Record<string, SettingDef>;
    }
  }
  let allowScripts: string[] | undefined;
  if (b.allowScripts !== undefined) {
    if (Array.isArray(b.allowScripts) && b.allowScripts.every((p) => typeof p === 'string' && PACKAGE.test(p))) allowScripts = b.allowScripts;
    else problems.push('"bitbot.allowScripts" must be a list of package names');
  }
  if (problems.length) return { problem: problems.join('; '), id, title };

  const deps = pkg.dependencies;
  return {
    meta: {
      id: id!,
      title,
      version: str(pkg.version) ?? '0.0.0',
      author: nameOrField(pkg.author, 'name'),
      description: str(pkg.description),
      repository: nameOrField(pkg.repository, 'url'),
      api: str(b.api),
      roles,
      cooldown,
      config,
      allowScripts,
      hasDependencies: isObject(deps) && Object.keys(deps).length > 0,
    },
  };
}
