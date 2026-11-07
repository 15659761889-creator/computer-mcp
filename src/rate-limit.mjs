// Small in-process fixed-window limiter shared by public endpoints.
const buckets = new Map();
const MAX_BUCKETS = 20000;

function ipOf(req) {
  return String(req?.socket?.remoteAddress || 'unknown').slice(0, 80);
}

function prune(now) {
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
  while (buckets.size > MAX_BUCKETS) buckets.delete(buckets.keys().next().value);
}

/**
 * Consume one request against an IP bucket and, when supplied, an account bucket.
 * Returns 0 when allowed, otherwise the number of seconds to wait.
 * The account identifier must already be a one-way hash, never a raw credential.
 */
export function consumeRateLimit(req, {
  scope,
  account = null,
  windowMs = 60_000,
  ipMax = 60,
  accountMax = 10,
  now = Date.now(),
} = {}) {
  if (!scope || !Number.isInteger(windowMs) || windowMs < 1
    || !Number.isInteger(ipMax) || ipMax < 1
    || !Number.isInteger(accountMax) || accountMax < 1) throw new TypeError('invalid rate limit configuration');

  prune(now);
  const keys = [{ key: `${scope}:ip:${ipOf(req)}`, max: ipMax }];
  if (account) keys.push({ key: `${scope}:account:${String(account)}`, max: accountMax });
  const limited = keys.map(({ key, max }) => {
    const entry = buckets.get(key);
    return entry && entry.count >= max ? entry : null;
  }).find(Boolean);
  if (limited) return Math.max(1, Math.ceil((limited.resetAt - now) / 1000));

  for (const { key } of keys) {
    const entry = buckets.get(key);
    if (!entry || entry.resetAt <= now) buckets.set(key, { count: 1, resetAt: now + windowMs });
    else entry.count += 1;
  }
  return 0;
}

export function resetRateLimitsForTests() {
  buckets.clear();
}
