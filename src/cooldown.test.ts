import assert from 'node:assert/strict';
import { test } from 'node:test';
import { humanDuration, parseCooldown, resetCooldowns, takeCooldown } from './cooldown.js';

const u = (userId: string, guildId: string | null = 'g1') => ({ userId, guildId });

test('cooldowns: per user and command; told once per window', () => {
  resetCooldowns();
  const cmd = { name: 'addemote' };
  assert.equal(takeCooldown(u('u1'), cmd, 10, 0).ok, true);
  assert.deepEqual(takeCooldown(u('u1'), cmd, 10, 1_000), { ok: false, seconds: 9, per: 'user', warn: true });
  assert.deepEqual(takeCooldown(u('u1'), cmd, 10, 2_000), { ok: false, seconds: 8, per: 'user', warn: false }); // not told again
  assert.equal(takeCooldown(u('u2'), cmd, 10, 2_000).ok, true); // another user
  assert.equal(takeCooldown(u('u1'), { name: 'other' }, 10, 2_000).ok, true); // another command
  assert.equal(takeCooldown(u('u1'), cmd, 10, 10_000).ok, true); // window over
  assert.equal(takeCooldown(u('u1'), { name: 'ping' }, 0, 0).ok, true);
  assert.equal(takeCooldown(u('u1'), { name: 'ping' }, 0, 0).ok, true); // 0: none
});

test('cooldowns: per guild and per bot, and several limits at once', () => {
  resetCooldowns();
  const lotto = { name: 'lotto' };
  const daily = { seconds: 50, per: 'guild' } as const;
  assert.equal(takeCooldown(u('u1', 'g1'), lotto, daily, 0).ok, true);
  assert.equal(takeCooldown(u('u2', 'g1'), lotto, daily, 1_000).ok, false); // same guild, other user
  assert.equal(takeCooldown(u('u2', 'g2'), lotto, daily, 1_000).ok, true); // other guild
  // In a DM, "per guild" is the user's own.
  assert.equal(takeCooldown(u('u1', null), lotto, daily, 1_000).ok, true);
  assert.equal(takeCooldown(u('u2', null), lotto, daily, 1_000).ok, true);

  // An LLM command: 30 s per user, and 2 s shared by everyone.
  const ask = { name: 'ask' };
  const limits = [{ seconds: 30, per: 'user' as const }, { seconds: 2, per: 'bot' as const }];
  assert.equal(takeCooldown(u('u1'), ask, limits, 0).ok, true);
  assert.deepEqual(takeCooldown(u('u2', 'g9'), ask, limits, 1_000), { ok: false, seconds: 1, per: 'bot', warn: true });
  assert.equal(takeCooldown(u('u2', 'g9'), ask, limits, 2_000).ok, true); // bot window over
  assert.deepEqual(takeCooldown(u('u1'), ask, limits, 3_000), { ok: false, seconds: 27, per: 'user', warn: true }); // longest wait wins
});

test('parseCooldown and humanDuration', () => {
  assert.deepEqual(parseCooldown(5), { seconds: 5, per: 'user' });
  assert.deepEqual(parseCooldown({ seconds: 86_400, per: 'guild' }), { seconds: 86_400, per: 'guild' });
  assert.deepEqual(parseCooldown([10, { seconds: 2, per: 'bot' }]), [{ seconds: 10, per: 'user' }, { seconds: 2, per: 'bot' }]);
  for (const bad of ['5', { seconds: 5 }, { seconds: 5, per: 'server' }, -1, [{ seconds: 'x', per: 'user' }]]) {
    assert.throws(() => parseCooldown(bad), Error, JSON.stringify(bad));
  }
  assert.deepEqual([45, 180, 7500, 100_000, 86_400].map(humanDuration), ['45s', '3m', '2h 5m', '1d 3h', '1d']);
});

test('cooldowns: a released use is not charged; a committed one is; settling twice is harmless', () => {
  resetCooldowns();
  const cmd = { name: 'lotto' };
  const first = takeCooldown(u('u1'), cmd, 60, 0);
  assert.ok(first.ok);
  // While reserved, a simultaneous use is refused (the window is held during the run).
  assert.equal(takeCooldown(u('u1'), cmd, 60, 500).ok, false);
  first.release(); // e.g. ctx.usage(): the input was wrong
  first.release();
  const second = takeCooldown(u('u1'), cmd, 60, 1_000);
  assert.ok(second.ok);
  second.commit();
  second.release(); // ignored: already committed
  assert.equal(takeCooldown(u('u1'), cmd, 60, 2_000).ok, false);
});

test('cooldowns: someone refused during a released reservation is told again next time', () => {
  resetCooldowns();
  const cmd = { name: 'raffle' };
  const shared = { seconds: 60, per: 'guild' } as const;
  const slow = takeCooldown(u('u1'), cmd, shared, 0);
  assert.ok(slow.ok);
  const refused = takeCooldown(u('u2'), cmd, shared, 100);
  assert.equal(refused.ok ? null : refused.warn, true); // told to wait
  slow.release(); // the first use didn't count
  const real = takeCooldown(u('u3'), cmd, shared, 200);
  assert.ok(real.ok);
  real.commit();
  const again = takeCooldown(u('u2'), cmd, shared, 300);
  assert.equal(again.ok ? null : again.warn, true); // told again: the earlier wait never applied
});
