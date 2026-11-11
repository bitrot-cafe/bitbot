import type { Client } from '@fluxerjs/core';
import { createLogger } from './logger.js';

const log = createLogger('instance');

/*
 * Instance limits.
 *
 * /.well-known/fluxer only publishes rules that *differ* from Fluxer's built-in defaults,
 * plus a hash identifying which defaults the server is using. Fluxer's own clients bundle
 * those defaults; we do the same for the keys we use.
 * Source: fluxerapp/fluxer packages/limits/src/LimitDefaults.ts
 */
const DEFAULT_LIMITS = {
  emoji_max_size: 512 * 1024,
  max_guild_emojis: 500,
};
const DEFAULTS_HASH = '6hiv7l'; // defaultsHash the table above was copied from

export type LimitKey = keyof typeof DEFAULT_LIMITS;

/* Fixed platform rules, hardcoded in Fluxer's upload validation (not configurable per instance).
 * Source: fluxerapp/fluxer packages/constants/src/AssetFormatPolicy.ts */
export const EMOJI_DIMENSIONS = { min: 32, max: 512 };

type LimitRule = {
  filters?: { traits?: string[]; guildFeatures?: string[] };
  overrides: Record<string, number>;
};
type Limits = { rules: LimitRule[]; defaultsHash?: string };

/** Fetch the instance's current limit rules. Not cached: it's one small request. */
export async function fetchLimits(client: Client): Promise<Limits> {
  const discovery = (await client.fetchInstance()) as unknown as { limits?: Limits };
  const limits = discovery.limits ?? { rules: [] };
  if (limits.defaultsHash && limits.defaultsHash !== DEFAULTS_HASH) {
    log.warn(
      `Instance limit defaults changed (hash ${limits.defaultsHash}, expected ${DEFAULTS_HASH}); ` +
        'fallback values in src/instance.ts may be stale.',
    );
  }
  return limits;
}

/**
 * Resolve a guild-scoped limit: built-in default, then the unfiltered rule, then rules whose
 * guildFeatures filter matches (more specific wins, as in Fluxer's LimitResolver).
 * User-trait rules (e.g. premium) don't apply to guild limits and are skipped.
 */
export function getLimit(limits: Limits, key: LimitKey, guildFeatures: string[] = []): number {
  let value = DEFAULT_LIMITS[key];
  const matching = limits.rules
    .filter((rule) => !rule.filters?.traits?.length)
    .filter((rule) => (rule.filters?.guildFeatures ?? []).every((f) => guildFeatures.includes(f)))
    .sort((a, b) => (a.filters?.guildFeatures?.length ?? 0) - (b.filters?.guildFeatures?.length ?? 0));
  for (const rule of matching) {
    if (key in rule.overrides) value = rule.overrides[key];
  }
  return value;
}
