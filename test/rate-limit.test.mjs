import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumeRateLimit, resetRateLimitsForTests } from '../src/rate-limit.mjs';

const req = (ip) => ({ socket: { remoteAddress: ip } });

 test('fixed-window limiter counts per IP and optional account without leaking raw account values', () => {
  resetRateLimitsForTests();
  const first = req('192.0.2.10');
  for (let i = 0; i < 2; i += 1) assert.equal(consumeRateLimit(first, { scope: 'test-ip', now: 1_000, windowMs: 60_000, ipMax: 2 }), 0);
  assert.equal(consumeRateLimit(first, { scope: 'test-ip', now: 1_001, windowMs: 60_000, ipMax: 2 }), 60);
  assert.equal(consumeRateLimit(req('192.0.2.11'), { scope: 'test-ip', now: 1_001, windowMs: 60_000, ipMax: 2 }), 0, 'another IP has its own bucket');

  resetRateLimitsForTests();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(consumeRateLimit(req(`198.51.100.${i + 1}`), { scope: 'test-account', account: 'sha256:account-hash', now: 2_000, windowMs: 30_000, ipMax: 10, accountMax: 3 }), 0);
  }
  assert.equal(consumeRateLimit(req('203.0.113.22'), { scope: 'test-account', account: 'sha256:account-hash', now: 2_001, windowMs: 30_000, ipMax: 10, accountMax: 3 }), 30, 'the account bucket follows the credential across IP addresses');
  assert.equal(consumeRateLimit(req('203.0.113.22'), { scope: 'test-account', account: 'different-hash', now: 2_001, windowMs: 30_000, ipMax: 10, accountMax: 3 }), 0);
  assert.equal(consumeRateLimit(req('192.0.2.22'), { scope: 'test-account', account: 'different-hash', now: 32_000, windowMs: 30_000, ipMax: 10, accountMax: 3 }), 0, 'expired buckets reset');
});

 test('a rejected account bucket does not consume the IP bucket', () => {
  resetRateLimitsForTests();
  const request = req('192.0.2.30');
  assert.equal(consumeRateLimit(request, { scope: 'atomic', account: 'same', now: 100, windowMs: 60_000, ipMax: 2, accountMax: 1 }), 0);
  assert.equal(consumeRateLimit(request, { scope: 'atomic', account: 'same', now: 200, windowMs: 60_000, ipMax: 2, accountMax: 1 }), 60);
  assert.equal(consumeRateLimit(request, { scope: 'atomic', account: 'other', now: 200, windowMs: 60_000, ipMax: 2, accountMax: 1 }), 0, 'the rejected attempt did not spend the IP allowance');
});
