/* All settings, read once from the environment.
 * These should be configured in ../.env (see .env.example), not here in config.ts directly!
 */
const env = process.env;

/** Bot token. Required. */
export const token = env.FLUXER_BOT_TOKEN ?? '';

/** Self-hosted instance (bare hostname or URL); empty means fluxer.app. */
export const instance = env.FLUXER_INSTANCE ?? '';

/** Command prefix, shared by the core and plugins. */
export const prefix = env.PREFIX || '!';

/** Status template; placeholders {prefix} and {guilds}. */
export const defaultStatus = env.BOT_STATUS || '{prefix}help | Live in {guilds} guilds';

/** Treat instance staff (Staff badge) as bot administrators. Off on fluxer.app, where Staff means Fluxer employees. */
export const trustInstanceStaff = env.TRUST_INSTANCE_STAFF === 'true';

/** Debug mode at startup (toggle at runtime with !admin debug). Shows debug logs and error details in replies. */
export const debug = env.DEBUG === 'true';

/** Channel ID that receives warnings and errors. Empty: console only. Use a private channel. */
export const logChannelId = env.LOG_CHANNEL_ID ?? '';

/** Where to write the static command list (HTML) at startup. Empty: don't write one. */
export const helpPagePath = env.HELP_PAGE_PATH ?? '';

/** Public URL of that page; when set, !help links to it. */
export const helpUrl = env.HELP_URL ?? '';
