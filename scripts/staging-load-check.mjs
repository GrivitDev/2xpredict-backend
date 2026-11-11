#!/usr/bin/env node

const baseValue = process.env.LOAD_TEST_BASE_URL?.trim();
if (!baseValue) {
  console.error('Set LOAD_TEST_BASE_URL to an explicit staging backend URL.');
  process.exit(2);
}

let base;
try {
  base = new URL(baseValue);
} catch {
  console.error('LOAD_TEST_BASE_URL must be a valid absolute URL.');
  process.exit(2);
}

const productionHosts = new Set(['2xpredict.com', 'www.2xpredict.com']);
if (productionHosts.has(base.hostname.toLowerCase()) && process.env.LOAD_TEST_ALLOW_PRODUCTION !== 'true') {
  console.error('Refusing to load-test the production domain. Use staging or explicitly set LOAD_TEST_ALLOW_PRODUCTION=true after approval.');
  process.exit(2);
}

const path = process.env.LOAD_TEST_PATH?.trim() || '/plan-config';
if (!path.startsWith('/') || path.startsWith('//')) {
  console.error('LOAD_TEST_PATH must be an absolute path beginning with one slash.');
  process.exit(2);
}

const parseBoundedInt = (name, fallback, min, max) => {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
};

let requestCount;
let concurrency;
try {
  requestCount = parseBoundedInt('LOAD_TEST_REQUESTS', 50, 1, 200);
  concurrency = parseBoundedInt('LOAD_TEST_CONCURRENCY', 5, 1, 20);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const url = new URL(path, base);
const headers = { accept: 'application/json' };
if (process.env.LOAD_TEST_BEARER_TOKEN) {
  headers.authorization = `Bearer ${process.env.LOAD_TEST_BEARER_TOKEN}`;
}

const timings = [];
const statuses = new Map();
const failures = [];
let cursor = 0;
const startedAt = performance.now();

async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= requestCount) return;
    const requestStarted = performance.now();
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      const elapsed = performance.now() - requestStarted;
      timings.push(elapsed);
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      await response.arrayBuffer();
      if (!response.ok) failures.push(`request ${index + 1}: HTTP ${response.status}`);
    } catch (error) {
      failures.push(`request ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
const totalMs = performance.now() - startedAt;
const sorted = [...timings].sort((a, b) => a - b);
const percentile = (fraction) => sorted.length
  ? Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)].toFixed(1))
  : null;

console.log(JSON.stringify({
  target: url.toString(),
  requests: requestCount,
  concurrency,
  completed: timings.length,
  failures: failures.length,
  statuses: Object.fromEntries(statuses),
  latencyMs: {
    p50: percentile(0.50),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.length ? Number(sorted[sorted.length - 1].toFixed(1)) : null,
  },
  elapsedMs: Number(totalMs.toFixed(1)),
  requestsPerSecond: Number((timings.length / (totalMs / 1000)).toFixed(2)),
}, null, 2));

if (failures.length) {
  console.error('Load check failures (first 10):');
  for (const failure of failures.slice(0, 10)) console.error(`- ${failure}`);
  process.exitCode = 1;
}
