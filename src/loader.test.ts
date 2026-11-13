import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Client } from '@fluxerjs/core';

// See repos.test.ts: PLUGINS_DIR first, then dynamic imports.
const root = await mkdtemp(join(tmpdir(), 'bitbot-loader-'));
process.env.PLUGINS_DIR = root;
const { loadLate, startPlugins } = await import('./loader.js');
const { parseMeta } = await import('./plugin-meta.js');
const { disabledPlugins, plugins } = await import('./registry.js');

const client = {} as Client;
/** A local plugin providing `command`; its setup counts its runs in globalThis. */
async function plugin(name: string, command: string) {
  const dir = join(root, 'local', name);
  await mkdir(dir, { recursive: true });
  const pkg = JSON.stringify({ bitbot: { api: '0.4', id: name } });
  await writeFile(join(dir, 'package.json'), pkg);
  await writeFile(
    join(dir, 'index.ts'),
    `export default () => ({ commands: [{ name: '${command}', description: 'x', run: async () => {} }], setup: () => { (globalThis as any).setups = ((globalThis as any).setups ?? 0) + 1; } });\n`,
  );
  const parsed = parseMeta(pkg);
  assert.ok(parsed && 'meta' in parsed);
  return { path: `local/${name}`, dir, source: 'local' as const, meta: parsed.meta, id: name, title: name };
}

test('late loading: loads and sets up once; a clash is refused and recorded', async () => {
  const a = await plugin('roller', 'roll');
  const b = await plugin('roller2', 'roll');
  assert.equal(await loadLate(a, client), null);
  assert.ok(plugins.some((p) => p.path === 'local/roller'));
  assert.equal((globalThis as any).setups, 1);
  await startPlugins(client); // startup's setup loop doesn't run it again
  assert.equal((globalThis as any).setups, 1);

  const refused = await loadLate(b, client);
  assert.ok(refused?.refused);
  assert.match(refused.reason, /roll/);
  assert.equal(disabledPlugins.find((d) => d.path === 'local/roller2')?.reason, refused.reason, 'list shows the real reason');
});

test('late loading: two loads of one plugin at once share one load', async () => {
  const c = await plugin('coin', 'flip');
  const [x, y] = await Promise.all([loadLate(c, client), loadLate(c, client)]);
  assert.equal(x, null);
  assert.equal(y, null);
  assert.equal(plugins.filter((p) => p.path === 'local/coin').length, 1);
});
