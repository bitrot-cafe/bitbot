import * as fluxer from '@fluxerjs/core';
import { prefix } from './config.js';
import { EMOJI_DIMENSIONS, fetchLimits, getLimit } from './instance.js';
import { createLogger } from './logger.js';
import { hasStaffFlag, isBotAdmin, permissionLabel, permissionsIn } from './permissions.js';
import type { BotAPI } from './plugin.js';

/** The object every plugin factory receives. Adding to it is adding to the plugin API: keep it small. */
export const botApi: BotAPI = {
  fluxer,
  prefix,
  createLogger: (name) => createLogger(name, 'plugin'),
  isBotAdmin,
  hasStaffFlag,
  permissionLabel,
  permissionsIn,
  limits: { fetch: fetchLimits, get: getLimit, emojiDimensions: EMOJI_DIMENSIONS },
};
