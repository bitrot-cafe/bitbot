import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { helpPagePath, prefix } from './config.js';
import { createLogger } from './logger.js';
import { permissionLabel } from './permissions.js';
import type { Command } from './plugin.js';
import { commands, leaves, modules, plugins } from './registry.js';

/* Shared by the !help command and the generated web help page. */

const log = createLogger('help');

export type Section = { title: string; id: string; description?: string; commands: Command[] };

/**
 * Built-in modules first, then each plugin, as runnable commands (subcommands flattened, e.g. "admin status").
 * Commands that lost a name clash are left out (they can't be run).
 */
export function sections(): Section[] {
  const live = (list: Command[]) => list.filter((c) => commands.get(c.name) === c).flatMap(leaves);
  return [
    ...modules.map((m) => ({ title: m.title, id: m.id, description: m.description, commands: live(m.commands) })),
    ...plugins.map((p) => ({ title: p.name, id: p.id, description: p.description, commands: live(p.commands) })),
  ].filter((s) => s.commands.length);
}

/** Usage lines for a group's subcommands, shown when the group itself is run. */
export const groupUsage = (group: Command) =>
  leaves(group)
    .map((c) => `\`${usageLine(c)}\` — ${c.description}`)
    .join('\n');

export const usageLine = (c: Command) => `${prefix}${c.name}${c.usage ? ` ${c.usage}` : ''}`;

export const whoCanUse = (c: Command) =>
  c.botAdminOnly
    ? 'Bot administrators'
    : c.userPermissions?.length
      ? c.userPermissions.map(permissionLabel).join(', ')
      : 'Everyone';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/**
 * Write a static help page listing every command, if HELP_PAGE_PATH is set. Call after plugins load.
 * Returns the path written, or null if not configured or the write failed.
 */
export async function writeHelpPage(botName: string): Promise<string | null> {
  if (!helpPagePath) return null;
  const body = sections()
    .map(
      (s) => `<section>
  <h2>${escape(s.title)}</h2>${s.description ? `\n  <p>${escape(s.description)}</p>` : ''}
  <table>
    <thead><tr><th>Command</th><th>Description</th><th>Who can use it</th></tr></thead>
    <tbody>
${s.commands.map((c) => `      <tr><td><code>${escape(usageLine(c))}</code></td><td>${escape(c.description)}</td><td>${escape(whoCanUse(c))}</td></tr>`).join('\n')}
    </tbody>
  </table>
</section>`,
    )
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(botName)} commands</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --muted: #666; --line: #ddd; --code: #f2f2f2; }
  @media (prefers-color-scheme: dark) { :root { --bg: #18191c; --fg: #e6e6e6; --muted: #9a9a9a; --line: #333; --code: #26272b; } }
  body { background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  h1 { margin: 0 0 4px; } h2 { margin: 32px 0 4px; } p { color: var(--muted); margin: 0 0 12px; }
  /* Fixed layout + set widths so every section's columns line up, whatever their content. */
  table { width: 100%; border-collapse: collapse; table-layout: fixed; } th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th:nth-child(1) { width: 34%; } th:nth-child(2) { width: 46%; } th:nth-child(3) { width: 20%; }
  th { color: var(--muted); font-weight: 600; font-size: 13px; } code { background: var(--code); padding: 2px 6px; border-radius: 4px; overflow-wrap: anywhere; }
  footer { margin-top: 40px; color: var(--muted); font-size: 13px; }
  @media (max-width: 640px) { th:nth-child(3), td:nth-child(3) { display: none; } th:nth-child(1) { width: 45%; } th:nth-child(2) { width: 55%; } }
</style>
</head>
<body>
<h1>${escape(botName)} commands</h1>
<p>Prefix: <code>${escape(prefix)}</code> · <code>${escape(prefix)}help &lt;plugin | command&gt;</code> in chat for details.</p>
${body}
<footer>Generated ${new Date().toISOString().slice(0, 10)} from the plugins this bot has loaded.</footer>
</body>
</html>
`;
  try {
    await mkdir(dirname(helpPagePath), { recursive: true });
    await writeFile(helpPagePath, html);
    log.info(`Wrote help page to ${helpPagePath}`);
    return helpPagePath;
  } catch (error) {
    log.error('Could not write the help page', error);
    return null;
  }
}
