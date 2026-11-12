/*
 * Plugin API version. Plugins declare the version they need in their package.json:
 *   { "bitbot": { "api": "1.0" } }   →  needs 1.0 or later, but not 2.0
 * Bump the MINOR when the plugin API only gains things (old plugins keep working).
 * Bump the MAJOR on any breaking change to the `bot` object or the plugin format.
 */
export const API_VERSION = '1.0';

export type ApiCheck = { status: 'ok' } | { status: 'undeclared' } | { status: 'incompatible'; reason: string };

const parse = (v: string) => {
  const m = /^(\d+)\.(\d+)$/.exec(v.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
};

/** Can a plugin needing `required` run on this bot? Compatible: same major, and our minor is at least theirs. */
export function checkApiVersion(required: string | undefined, current = API_VERSION): ApiCheck {
  if (required === undefined) return { status: 'undeclared' };
  const need = parse(required);
  if (!need) return { status: 'incompatible', reason: `"${required}" isn't a valid bot API version (expected major.minor, e.g. 1.0)` };
  const have = parse(current)!;
  if (need.major !== have.major || need.minor > have.minor) {
    return { status: 'incompatible', reason: `needs bot API ${required}; this bot has ${current}` };
  }
  return { status: 'ok' };
}
