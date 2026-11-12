import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkApiVersion } from './version.js';

test('compatible: same major, plugin minor not newer than the bot', () => {
  assert.deepEqual(checkApiVersion('1.0', '1.0'), { status: 'ok' });
  assert.deepEqual(checkApiVersion('1.0', '1.3'), { status: 'ok' });
  assert.deepEqual(checkApiVersion('1.3', '1.3'), { status: 'ok' });
});

test('incompatible: needs a newer minor, or a different major', () => {
  for (const [need, have] of [
    ['1.4', '1.3'],
    ['2.0', '1.9'],
    ['1.0', '2.0'],
    ['0.9', '1.0'],
  ]) {
    const r = checkApiVersion(need, have);
    assert.equal(r.status, 'incompatible', `${need} on ${have}`);
    assert.match((r as { reason: string }).reason, new RegExp(`needs bot API ${need.replace('.', '\\.')}`));
  }
});

test('undeclared vs malformed', () => {
  assert.deepEqual(checkApiVersion(undefined), { status: 'undeclared' });
  for (const bad of ['1', '1.0.0', '^1.0', 'one', '']) {
    assert.equal(checkApiVersion(bad, '1.0').status, 'incompatible', bad);
  }
});
