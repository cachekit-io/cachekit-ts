// Loads the ESM and the CommonJS build into one process, puts a cache from
// each on one registry, and prints the circuit-breaker gauge after each one in
// turn finishes an op last:
//
//   node dual-entry-gauge-probe.mjs <path to dist/index.js> <path to dist/cjs/index.js>
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const [esmEntry, cjsEntry] = process.argv.slice(2);
const require = createRequire(cjsEntry);
const { createCache: esmCache } = await import(pathToFileURL(esmEntry).href);
const { createCache: cjsCache } = require(cjsEntry);
const { Registry } = require(require.resolve('prom-client', { paths: [dirname(cjsEntry)] }));

class HealthyBackend {
  async get() {
    return null;
  }
  async set() {}
  async delete() {
    return false;
  }
  async exists() {
    return false;
  }
  async close() {}
}
class FailingBackend extends HealthyBackend {
  async get() {
    throw new Error('backend down');
  }
}

const registry = new Registry();
const options = {
  l1: { enabled: false },
  metrics: { registry },
  reliability: { circuitBreaker: { failureThreshold: 1 }, retry: { maxAttempts: 1 } },
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const state = async () =>
  (await registry.getSingleMetric('cachekit_circuit_breaker_state').get()).values[0]?.value;

// Each build's healthy cache and failing cache, in both orders of creation.
const esmHealthy = esmCache({ ...options, backend: new HealthyBackend() });
const cjsFailing = cjsCache({ ...options, backend: new FailingBackend() });
const cjsHealthy = cjsCache({ ...options, backend: new HealthyBackend() });
const esmFailing = esmCache({ ...options, backend: new FailingBackend() });
// Let both builds load prom-client before any cache publishes.
await new Promise((resolve) => setTimeout(resolve, 100));

// Two ops between scrapes, from different builds: the second one's state must
// win. Each build follows the other, to each state.
const seen = [];
for (const pair of [
  [esmHealthy, cjsFailing],
  [cjsFailing, esmHealthy],
  [cjsHealthy, esmFailing],
  [esmFailing, cjsHealthy],
]) {
  for (const cache of pair) await cache.get('ns:k');
  await settle();
  seen.push(await state(), await state());
}
for (const cache of [esmHealthy, cjsFailing, cjsHealthy, esmFailing]) await cache.close();
console.log(JSON.stringify(seen));
