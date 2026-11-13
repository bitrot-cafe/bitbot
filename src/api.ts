import * as fluxer from '@fluxerjs/core';
import { coreSettings } from './core-settings.js';
import { EMOJI_DIMENSIONS, fetchLimits, getLimit } from './instance.js';
import { createLogger } from './logger.js';
import { permissionLabel, permissionsIn } from './permissions.js';
import { canActOn, hasRole, hasStaffFlag, rolesOf } from './roles.js';
import { audit } from './audit.js';
import type { BotAPI } from './plugin.js';
import { configFor } from './settings.js';
import { createStore } from './store.js';
import { API_VERSION } from './version.js';

/**
 * The object a plugin's factory receives. `id` is its folder id; `scope` its short id (settings scope and
 * store namespace). Adding to it is adding to the plugin API: keep it small.
 */
export function botApiFor(id: string, scope: string): BotAPI {
  return {
    apiVersion: API_VERSION,
    config: configFor(scope),
    store: createStore(scope),
    log: createLogger(id, 'plugin'),
    audit: (entry) => audit(scope, entry),
    fluxer,
    prefixFor: (guildId) => coreSettings.prefix(guildId),
    createLogger: (name) => createLogger(name, 'plugin'),
    hasRole,
    rolesOf: async (user) => [...(await rolesOf(user))].sort(),
    canActOn,
    hasStaffFlag,
    permissionLabel,
    permissionsIn,
    limits: { fetch: fetchLimits, get: getLimit, emojiDimensions: EMOJI_DIMENSIONS },
  };
}
