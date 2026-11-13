import { audit } from './audit.js';
import { coreSettings } from './core-settings.js';

/* Helpers shared by the !root and !admin command groups. */

/** The prefix to show in hints: the one this guild uses. */
export const px = (m: { guildId?: string | null }) => coreSettings.prefix(m.guildId);

/** "name (id)", for log lines. */
export const who = (m: { author: { username: string; id: string } }) => `${m.author.username} (${m.author.id})`;

/** Record an action in the audit log, under the command group ("root" or "admin"). */
export const recorder =
  (source: string) =>
  (message: { author: { id: string; username: string } }, action: string, target: string, details?: Record<string, unknown>) =>
    audit(source, { action, actor: message.author, target, details });

const SOURCE: Record<string, string> = { env: 'env', guild: 'this guild', db: 'set here', default: 'default', missing: 'not set' };
/** A setting's source, for display; "missing" is reserved for required settings without a value. */
export const sourceLabel = (s: { source: string; missing: boolean }) => (s.missing ? '**missing**' : SOURCE[s.source]);
