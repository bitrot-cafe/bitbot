import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { helpPagePath, prefix } from './config.js';
import { createLogger } from './logger.js';
import { permissionLabel } from './permissions.js';
import type { Command } from './plugin.js';
import { commands, coreCommands, plugins } from './registry.js';

/* Shared by the !help command and the generated web help page. */

const log = createLogger('help');

export type Section = { title: string; id: string | null; description?: string; commands: Command[] };

/** Core first, then each plugin. Commands that lost a name clash are left out (they can't be run). */
export function sections(): Section[] {
  const live = (list: Command[]) => list.filter((c) => commands.get(c.name) === c);
  return [
    { title: 'Core', id: null, commands: live(coreCommands) },
    ...plugins.map((p) => ({ title: p.name, id: p.id, description: p.description, commands: live(p.commands) })),
  ].filter((s) => s.commands.length);
}

export const usageLine = (c: Command) => `${prefix}${c.name}${c.usage ? ` ${c.usage}` : ''}`;

export const whoCanUse = (c: Command) =>
  c.botAdminOnly
    ? 'Bot administrators'
    : c.userPermissions?.length
      ? c.userPermissions.map(permissionLabel).join(', ')
      : 'Everyone';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Write a static help page listing every command, if HELP_PAGE_PATH is set. Call after plugins load. */
export async function writeHelpPage(botName: string) {
  if (!helpPagePath) return;
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
  table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 13px; } code { background: var(--code); padding: 2px 6px; border-radius: 4px; white-space: nowrap; }
  footer { margin-top: 40px; color: var(--muted); font-size: 13px; }
  @media (max-width: 640px) { th:nth-child(3), td:nth-child(3) { display: none; } code { white-space: normal; } }
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
  } catch (error) {
    log.error('Could not write the help page', error);
  }
}
