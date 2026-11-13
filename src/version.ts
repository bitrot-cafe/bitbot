import { readFileSync } from 'node:fs';

/*
 * Plugin API version: the bot's own major.minor (package.json), so the two can't drift. Plugins declare
 * the version they need in their package.json:
 *   { "bitbot": { "api": "0.3" } }   →  needs 0.3 or later, within the same major
 * Within a major, a minor release only adds to the API; a new major may break plugins. While on 0.x,
 * anything may change in any minor (unstable, best effort): the check still only compares majors and
 * minors, so an older 0.x plugin loads and may need updating.
 */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
export const API_VERSION = pkg.version.split('.').slice(0, 2).join('.');

export type ApiCheck = { status: 'ok' } | { status: 'undeclared' } | { status: 'incompatible'; reason: string };

const parse = (v: string) => {
  const m = /^(\d+)\.(\d+)$/.exec(v.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
};

/** Can a plugin needing `required` run on this bot? Compatible: same major, and our minor is at least theirs. */
export function checkApiVersion(required: string | undefined, current = API_VERSION): ApiCheck {
  if (required === undefined) return { status: 'undeclared' };
  const need = parse(required);
  if (!need) return { status: 'incompatible', reason: `"${required}" isn't a valid bot API version (expected major.minor, e.g. 0.3)` };
  const have = parse(current)!;
  if (need.major !== have.major || need.minor > have.minor) {
    return { status: 'incompatible', reason: `needs bot API ${required}; this bot has ${current}` };
  }
  return { status: 'ok' };
}
