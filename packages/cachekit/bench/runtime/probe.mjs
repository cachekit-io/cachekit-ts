// One probe, run unchanged under every runtime (node, bun, deno), one mode per process.
// run.mjs drives it; to run a mode by hand:
//
//   <runtime> bench/runtime/probe.mjs <mode> '<json params>'
//
//   counts {port, ctlPort, gaps}  deterministic transport counts against fake-saas.mjs:
//                                 negotiated ALPN; new connections and requests per op for
//                                 set, warm get and exists()->get pairs; new connections
//                                 after each idle gap (seconds)
//   wall   {port, ctlPort}        warm per-op wall time (median) for get, set, exists()->get
//   cpu    {}                     per-op time of the SDK's CPU paths on an in-memory backend
//                                 (no transport): key generation, L1 hit, encode/decode,
//                                 encrypted get
//   import {}                     cold import of the root entry in this fresh process
//   load   {entry: root|workers}  which file the package's exports resolve to under this
//                                 runtime, and which core (NAPI or wasm) an encrypted round
//                                 trip loads
//
// Prints one JSON line. Every mode imports this checkout's build (../../dist), never a
// published install; `load` resolves the package name only via self-reference, which
// lands in this same package and is checked to.
//
// The host. The backend refuses plain http and private or loopback addresses
// (src/backends/url-validator.ts), and allowCustomHost lifts only the hostname allowlist.
// So the SDK is configured with a public-looking name (FAKE_NAME), and this probe routes
// that one origin to CACHEKIT_BENCH_HOST (loopback by default) by rewriting the URL in a
// thin global-fetch wrapper. That is the one approach that works on every runtime with no
// /etc/hosts entry: patching node:dns (as test/transport/fake-saas.ts does) reaches only
// Node, because Bun's fetch does its own resolution. The wrapper does a prefix check and a
// string concat per call; the request itself still goes through the runtime's own fetch,
// connection pool and TLS stack, which is what is measured. The fake's certificate names
// both FAKE_NAME and the bench host; children trust it via NODE_EXTRA_CA_CERTS (Node, Bun)
// and DENO_CERT (Deno).
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

const FAKE_NAME = 'api.cachekit.test'; // keep in step with fake-saas.mjs
const BENCH_HOST = process.env.CACHEKIT_BENCH_HOST || '127.0.0.1';
const DIST = new URL('../../dist/', import.meta.url);
const PACKAGE = new URL('../../', import.meta.url);

const runtime = globalThis.Bun
  ? { name: 'bun', version: globalThis.Bun.version }
  : globalThis.Deno
    ? { name: 'deno', version: globalThis.Deno.version.deno }
    : { name: 'node', version: process.versions.node };

const [mode, rawParams = '{}'] = process.argv.slice(2);
const params = JSON.parse(rawParams);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x, d = 3) => +x.toFixed(d);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

class MemoryBackend {
  map = new Map();
  async get(key) {
    return this.map.get(key) ?? null;
  }
  async set(key, value) {
    this.map.set(key, value);
  }
  async delete(key) {
    return this.map.delete(key);
  }
  async exists(key) {
    return this.map.has(key);
  }
  async close() {}
}

/** A cache on the fake, with the fake's origin routed to the bench host (see the header). */
async function fakeCache({ port, ctlPort }) {
  const host = isIP(BENCH_HOST) === 6 ? `[${BENCH_HOST}]` : BENCH_HOST;
  const from = `https://${FAKE_NAME}:${port}/`;
  const to = `https://${host}:${port}/`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    realFetch(
      typeof input === 'string' && input.startsWith(from) ? to + input.slice(from.length) : input,
      init
    );
  // The control plane is plain http on another port: its own origin and its own pool.
  const ctl = async (path = '/stats') =>
    (await realFetch(`http://${host}:${ctlPort}${path}`)).json();
  const { createCache } = await import(new URL('index.js', DIST).href);
  const cache = createCache({
    backend: { apiKey: 'ck_test_bench-not-a-secret', apiUrl: from, allowCustomHost: true }, // pragma: allowlist secret
    l1: { enabled: false },
    metrics: false,
    reliability: { retry: { maxAttempts: 1 }, degradation: false },
  });
  await ctl('/reset');
  return { cache, ctl };
}

const VALUE = { v: 1, pad: 'x'.repeat(80) };
const KEY = 'bench:k';

async function counts(p) {
  const { cache, ctl } = await fakeCache(p);
  const phase = async (n, op) => {
    const before = await ctl();
    for (let i = 0; i < n; i++) await op();
    const after = await ctl();
    return {
      ops: n,
      new_conn: after.connections - before.connections,
      requests_per_op: round((after.requests - before.requests) / n),
    };
  };
  const first = await phase(1, () => cache.set(KEY, VALUE)); // opens the first connection
  const get = await phase(100, () => cache.get(KEY));
  // Idle gaps run while the pool holds the one connection the gets used. After the set or
  // exists() phases a pool can hold extra or half-closed connections (undici on http/1.1
  // closes a connection after any HEAD), and a gap would then measure that, not the idle limit.
  const gaps = [];
  for (const gapS of p.gaps) {
    const before = await ctl(); // before the sleep, so a server-side idle close is counted
    await sleep(gapS * 1000);
    await cache.get(KEY);
    const after = await ctl();
    gaps.push({
      gap_s: gapS,
      new_conn: after.connections - before.connections,
      server_idle_closes: after.serverIdleCloses - before.serverIdleCloses,
    });
  }
  const set = await phase(50, () => cache.set(KEY, VALUE));
  const existsGet = await phase(10, async () => {
    await cache.exists(KEY);
    await cache.get(KEY);
  });
  const end = await ctl();
  await cache.close();
  return {
    alpn: [...new Set(end.alpn)].join(','),
    first_op_new_conn: first.new_conn,
    set,
    get,
    exists_get_pairs: existsGet,
    gaps,
    by_version: end.byVersion,
  };
}

async function wall(p) {
  const { cache, ctl } = await fakeCache(p);
  const timeEach = async (n, op) => {
    const xs = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await op();
      xs.push(performance.now() - t0);
    }
    return round(median(xs));
  };
  await cache.set(KEY, VALUE);
  await timeEach(50, () => cache.get(KEY)); // warm-up: connection, JIT
  const getMs = await timeEach(300, () => cache.get(KEY));
  const setMs = await timeEach(100, () => cache.set(KEY, VALUE));
  const pairMs = await timeEach(30, async () => {
    await cache.exists(KEY);
    await cache.get(KEY);
  });
  const { connections } = await ctl();
  await cache.close();
  return { get_ms: getMs, set_ms: setMs, exists_get_ms: pairMs, connections };
}

async function cpu() {
  const { createCache } = await import(new URL('index.js', DIST).href);
  const { generateKey } = await import(new URL('serialization/key-generator.js', DIST).href);
  // Batch median: warm up, then `batches` batches of k calls; median per-call time.
  const bench = async (fn, { k, batches = 15, warm = 300 }) => {
    for (let i = 0; i < warm; i++) await fn();
    const per = [];
    for (let b = 0; b < batches; b++) {
      const t0 = performance.now();
      for (let i = 0; i < k; i++) await fn();
      per.push(((performance.now() - t0) / k) * 1000);
    }
    return round(median(per), 2);
  };
  const value = (bytes) => ({
    rows: Array.from({ length: Math.ceil(bytes / 48) }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      score: i * 1.5,
      tags: ['a', 'b'],
      ok: true,
    })),
  });
  const us = {};
  us.keygen = await bench(() => generateKey('svc:getThing', ['user-42', 7, true]), { k: 2000 });
  {
    const c = createCache({ backend: new MemoryBackend(), metrics: false });
    const f = c.wrap(async (id) => ({ id, pad: 'y'.repeat(200) }), {
      namespace: 'svc:getThing',
      ttl: 3600,
    });
    for (let i = 0; i < 64; i++) await f(i);
    let i = 0;
    us.wrap_l1_hit = await bench(() => f(i++ & 63), { k: 2000 });
    await c.close();
  }
  for (const [label, bytes, k] of [
    ['100B', 100, 2000],
    ['10KB', 10_000, 200],
  ]) {
    const v = value(bytes);
    const plain = createCache({
      backend: new MemoryBackend(),
      metrics: false,
      l1: { enabled: false },
    });
    const secure = createCache({
      backend: new MemoryBackend(),
      metrics: false,
      l1: { enabled: false },
      encryption: { masterKey: 'a'.repeat(64) },
    });
    await plain.set('ns:k', v);
    await secure.set('ns:k', v);
    us[`get_${label}`] = await bench(() => plain.get('ns:k'), { k, warm: 30 });
    us[`set_${label}`] = await bench(() => plain.set('ns:k', v), { k, warm: 30 });
    us[`secure_get_${label}`] = await bench(() => secure.get('ns:k'), { k, warm: 30 });
    await plain.close();
    await secure.close();
  }
  return { us_per_op: us };
}

async function coldImport() {
  const t0 = performance.now();
  await import(new URL('index.js', DIST).href);
  return { import_ms: round(performance.now() - t0, 2) };
}

const napiMapped = () => {
  try {
    return readFileSync('/proc/self/maps', 'utf8').includes('cachekit-core-ts');
  } catch {
    return null; // no procfs (macOS): core unknown
  }
};

async function load(p) {
  const spec = p.entry === 'workers' ? '@cachekit-io/cachekit/workers' : '@cachekit-io/cachekit';
  const out = { entry: p.entry, resolved: null, core: null, roundtrip: null, load_error: null };
  try {
    const url = import.meta.resolve(spec);
    if (!url.startsWith(PACKAGE.href))
      throw new Error(`${spec} resolved outside this package: ${url}`);
    out.resolved = url.slice(PACKAGE.href.length);
    const { createCache } = await import(url);
    const cache = createCache({
      backend: new MemoryBackend(),
      metrics: false,
      l1: { enabled: false },
      encryption: { masterKey: 'a'.repeat(64) },
    });
    await cache.set('ns:b', { x: 2 });
    out.roundtrip = (await cache.get('ns:b'))?.x === 2;
    await cache.close();
    const mapped = napiMapped();
    out.core = mapped === null ? 'unknown' : mapped ? 'napi' : 'wasm';
  } catch (error) {
    out.load_error = `${error?.name}: ${String(error?.message ?? error)
      .split('\n')[0]
      .slice(0, 200)}`;
  }
  return out;
}

const MODES = { counts, wall, cpu, import: coldImport, load };
if (!(mode in MODES)) throw new Error(`unknown mode "${mode}"; one of ${Object.keys(MODES)}`);
const result = await MODES[mode](params);
console.log(
  JSON.stringify({ mode, runtime: runtime.name, runtime_version: runtime.version, ...result })
);
// A runtime may hold the process open on pooled sockets; the result is out.
process.exit(0);
