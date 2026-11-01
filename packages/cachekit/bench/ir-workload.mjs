// Hot-path workloads for the instruction-count suite (ir.mjs drives this file).
//
//   node [v8 flags] bench/ir-workload.mjs <workload> <n> [--wall]
//
// A run loads only what its workload needs, warms the op until V8 has
// finished compiling it, then runs it n times between two process.cpuUsage()
// calls. ir.mjs has callgrind dump its counters on entry to node::CPUUsage, so
// the counted window holds the n ops and nothing else: module load, setup,
// warm-up and V8's optimizing compiles stay out.
// --wall prints the steady-state ns per op of the n iterations instead
// (indicative only). Imports the built package: run `pnpm build` first.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const dist = new URL('../dist/', import.meta.url);
const load = (path) => import(new URL(path, dist));
const napi = () => createRequire(import.meta.url)('@cachekit-io/cachekit-core-ts');
// The wasm package's entry imports the .wasm as a module, which only workerd
// resolves; load its wasm-bindgen glue directly and hand it the bytes.
async function wasm() {
  const pkg = new URL('pkg/', import.meta.resolve('@cachekit-io/cachekit-core-wasm'));
  if (!existsSync(new URL('cachekit_core_wasm_bg.wasm', pkg))) {
    throw new Error(
      'the wasm workloads need the wasm build, which `pnpm build` does not make: run ' +
        '`pnpm --filter @cachekit-io/cachekit-core-wasm build:wasm` (needs the wasm32 target, ' +
        'wasm-bindgen and wasm-opt), or skip them with --only'
    );
  }
  const glue = await import(new URL('cachekit_core_wasm.js', pkg));
  glue.initSync({ module: readFileSync(new URL('cachekit_core_wasm_bg.wasm', pkg)) });
  return glue;
}

const MASTER_KEY = 'a'.repeat(64);
const KEY = 'bench:getUser:' + 'a'.repeat(64);
const ARGS = [42, 'user-profile', { region: 'au', tier: 3 }];
// 1,055 B of msgpack. Keep fixtures under the serializer's 10,000-element
// collection bound, or encode throws.
const VALUE = {
  rows: Array.from({ length: 32 }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    score: i * 1.5,
    ok: true,
  })),
};
const encoded = async () =>
  (await load('serialization/serializer.js')).defaultSerializer.encode(VALUE);
// 40 B of repeated ASCII: compressible, and under the core's 64 B cutover to a
// literals-only LZ4 block, so the store skips the match search.
const SMALL = new TextEncoder().encode('cachekit'.repeat(5));
// 65,536 B where per-byte costs dominate the per-call overhead that hides them
// at 1 KB. compressible: VALUE's msgpack repeated, for the LZ4 match search.
async function compressible() {
  const unit = await encoded();
  const bytes = new Uint8Array(65_536);
  for (let at = 0; at < bytes.length; at += unit.length)
    bytes.set(unit.subarray(0, bytes.length - at), at);
  return bytes;
}
// incompressible: xorshift32 output, so the envelope stays 64 KiB and AES-GCM
// seals all of it (the repeated msgpack packs to about 1 KB).
async function incompressible() {
  const bytes = new Uint8Array(65_536);
  let x = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[i] = x & 0xff;
  }
  return bytes;
}

let sink = 0;
// Ops run before the window opens. Under ir.mjs's V8_FLAGS every function a
// cheap op runs has finished its Maglev and TurboFan compiles within 2,000
// ops. A workload whose op tiers up later, or runs too long for 2,000, sets
// its own `warmup`. To check one, run it under V8_FLAGS with --trace-opt
// --trace-deopt and print a line at each process.cpuUsage() call: no compile
// or deopt may land between the two.
const WARMUP = 2000;

async function encryptedOp(manager, storage, bytes) {
  const packed = storage.pack(bytes);
  const ciphertext = await manager.encrypt(packed, KEY, true);
  return async () => {
    sink += (await manager.decrypt(ciphertext, KEY, true)).length;
    sink += (await manager.encrypt(packed, KEY, true)).length;
  };
}

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

// An L1 already full, so every set evicts: the cost of picking the victim at
// this capacity.
const l1AtCapacity = (entries, n) => ({
  n,
  // runs: the n this run executes, which may differ from the default above.
  setup: async (runs) => {
    const { L1Cache } = await load('l1/lru-cache.js');
    const l1 = new L1Cache({ maxEntries: entries });
    // Keys made up front (warm-up and window included), so the op allocates
    // only what L1 itself does.
    const keys = Array.from({ length: entries + WARMUP + runs }, (_, k) => `k${k}`);
    let i = 0;
    for (; i < entries; i++) l1.set(keys[i], i, 3_600_000, 'bench');
    return () => {
      l1.set(keys[i], i, 3_600_000, 'bench');
      i++;
    };
  },
});

// A plaintext set(): L1 is handed the decoded value, so its size accounting is
// part of the write.
const plaintextSetOf = (value, n, warmup) => ({
  n,
  warmup,
  setup: async () => {
    const { createCache } = await load('index.js');
    const cache = createCache({ backend: new MemoryBackend(), metrics: false });
    return async () => {
      await cache.set(KEY, value);
    };
  },
});
// Rows as in VALUE, ~33 B of msgpack each.
const rowsOf = (rows) => ({ rows: Array.from({ length: rows }, (_, i) => VALUE.rows[i % 32]) });
const plaintextSet = (rows, n, warmup) => plaintextSetOf(rowsOf(rows), n, warmup);

/**
 * generateKey(args) as wrap() runs it: after the Node entry has loaded, or, with
 * `wasmHash`, after Workers has instantiated its module. workers/runtime.js
 * imports the .wasm, which only workerd resolves, so this binds the wasm export
 * itself; the runtime's 64 KiB cutover to JS never applies at these sizes. A
 * build from before the key hash moved into the bindings has no
 * serialization/blake2b.js and hashes keys in JS: the base side of a compare.
 */
const keygen = (args, n, wasmHash = false, warmup) => ({
  n,
  warmup,
  setup: async () => {
    const hashing = existsSync(new URL('serialization/blake2b.js', dist))
      ? await load('serialization/blake2b.js')
      : null;
    if (!wasmHash) await load('index.js');
    else if (hashing) hashing.setKeyHashBinding((await wasm()).blake2b256Hex);
    // A stale binding without the export would measure JS under this name.
    if (hashing && !hashing.usingKeyHashBinding()) {
      throw new Error('keys are not hashed through the binding: rebuild it');
    }
    const { generateKey } = await load('serialization/key-generator.js');
    return () => {
      sink += generateKey('bench', args).length;
    };
  },
});

const napiStorage = async () => new (napi().ByteStorage)();
const wasmStorage = async () => new (await wasm()).ByteStorage();

// pack + unpack of one payload: a store and an L2 read of the envelope
const envelope = (storage, payload, n) => ({
  n,
  setup: async () => {
    const s = await storage();
    const bytes = await payload();
    return () => {
      sink += s.unpack(s.pack(bytes)).length;
    };
  },
});

const napiEncrypted = (payload, n) => ({
  n,
  setup: async () => {
    const { EncryptionManager } = await load('encryption/manager.js');
    return encryptedOp(new EncryptionManager(MASTER_KEY), await napiStorage(), await payload());
  },
});

const wasmEncrypted = (payload, n) => ({
  n,
  setup: async () => {
    const glue = await wasm();
    const { EncryptionManagerCore } = await load('encryption/manager-core.js');
    const manager = new EncryptionManagerCore(MASTER_KEY, undefined, async () => ({
      deriveTenantKeys: glue.deriveTenantKeys,
      encryptWithTenantKeys: glue.encryptWithTenantKeys,
      decryptWithTenantKeys: glue.decryptWithTenantKeys,
    }));
    return encryptedOp(manager, new glue.ByteStorage(), await payload());
  },
});

// An encrypted wrap() L1 hit: keygen, the L1 lookup, then decrypt, unpack and
// decode of the ciphertext L1 holds. Setup checks the second call is served by
// L1, so a value L1 refuses cannot pass for a hit.
const secureWrapHit = (value, n, warmup) => ({
  n,
  warmup,
  setup: async () => {
    const { createCache } = await load('index.js');
    const backend = new MemoryBackend();
    const cache = createCache({ backend, encryption: { masterKey: MASTER_KEY }, metrics: false });
    const get = cache.wrap(async (_id) => value, { namespace: 'bench', ttl: 3600 });
    let reads = 0;
    const read = backend.get.bind(backend);
    backend.get = (key) => (reads++, read(key));
    await get(1); // the miss: one L2 read
    await get(1);
    if (reads !== 1) throw new Error('the hit read L2: L1 did not keep the entry');
    return async () => {
      sink += (await get(1)) ? 1 : 0;
    };
  },
});

/**
 * Each workload's setup(n) gets the n the run executes and returns its op: one
 * call on the path its name gives. The default n is sized so n x Ir/op dwarfs
 * the noise of the fixed part, and of a GC cycle that lands in one run's
 * window and not another's: cheap ops that allocate need a larger n.
 */
export const WORKLOADS = {
  // what keeping recency costs a hit: round-robin over a full 1k L1, so each
  // get() reads an entry that is not already the most recent
  'l1-get-hit': {
    n: 2_000_000,
    setup: async () => {
      const { L1Cache } = await load('l1/lru-cache.js');
      const l1 = new L1Cache();
      const keys = Array.from({ length: 1_000 }, (_, i) => `k${i}`);
      keys.forEach((k, i) => l1.set(k, i, 3_600_000, 'bench'));
      let i = 0;
      return () => {
        sink += l1.get(keys[i++ % 1_000]);
      };
    },
  },
  'l1-set-at-capacity-1k': l1AtCapacity(1_000, 200_000),
  'l1-set-at-capacity-10k': l1AtCapacity(10_000, 4_000),
  // 20,000 ops: 100,000 live entries keep V8 marking the old generation
  // through the window, and over 2,000 ops the share of that marking in the
  // window differed between runs by up to 1.9%; over 20,000 it repeats within
  // 0.01%.
  'l1-set-at-capacity-100k': l1AtCapacity(100_000, 20_000),
  'plaintext-set-1kb': plaintextSet(32, 5_000),
  'plaintext-set-10kb': plaintextSet(320, 1_000),
  // 1,300 warm-up ops, not 2,000: V8 has finished compiling the set() path
  // around it by ~960 ops, and 2,000 made one process run ~9 minutes in CI.
  'plaintext-set-100kb': plaintextSet(3_200, 1_000, 1_300),
  // the ends of the object-heavy write range: one 64 B object, and 1,005,035 B
  // in 96 groups of 320 rows, so no collection nears the 10,000-element bound
  // and the whole stays under the 1 MiB encode limit. 20 warm-up ops for 1 MB:
  // the encoders it calls per row reach TurboFan in the first op, and the
  // set() path around them runs 40 times, too few for V8 to compile it, so
  // the window holds no compile.
  'plaintext-set-64b': plaintextSetOf(
    { id: 7, name: 'item-7', score: 10.5, ok: true, tags: ['a', 'b'], owner: 'user-424242' },
    20_000
  ),
  // Its own gate threshold (ir.mjs `fail`): 20 ops that each allocate
  // megabytes put several GCs in the window, whose cost follows the live heap.
  // In CI, a PR that only retained 50,000 small objects at load read +4.23%
  // on it with its code unchanged; every other workload stayed within 1.5%.
  'plaintext-set-1mb': {
    ...plaintextSetOf({ groups: Array.from({ length: 96 }, () => rowsOf(320)) }, 20, 20),
    fail: 0.1,
  },
  // the worst case for L1's container count: 2,000 empty objects, one
  // MessagePack byte each, so the count is a large share of the write
  'plaintext-set-containers': {
    n: 2_000,
    setup: async () => {
      const { createCache } = await load('index.js');
      const cache = createCache({ backend: new MemoryBackend(), metrics: false });
      const value = Array.from({ length: 2_000 }, () => ({}));
      return async () => {
        await cache.set(KEY, value);
      };
    },
  },
  // wrap(): a call that misses the key memo hashes its arguments before L1 is
  // consulted, through the NAPI binding once the Node entry has loaded it
  keygen: keygen(ARGS, 20_000),
  // 1 KB of arguments, where the hash's share of the cost grows with the bytes
  'keygen-1kb': keygen([VALUE], 5_000),
  // the same on Workers, where the wasm binding hashes keys once its module is
  // instantiated. 4,000 warm-up ops: the glue reads each hash back through
  // Node's TextDecoder decode, which V8 compiles with TurboFan at ~2,400 ops.
  'keygen-wasm': keygen(ARGS, 20_000, true, 4_000),
  'keygen-wasm-1kb': keygen([VALUE], 5_000, true, 4_000),
  // set encodes (normalize + msgpack, in one walk), an L2 hit decodes
  // (depth bounds + msgpack)
  'serializer-roundtrip': {
    n: 10_000,
    setup: async () => {
      const { defaultSerializer } = await load('serialization/serializer.js');
      return () => {
        sink += defaultSerializer.decode(defaultSerializer.encode(VALUE)) ? 1 : 0;
      };
    },
  },
  // Node envelope: LZ4 + xxHash3-64 through the NAPI core
  'napi-envelope': envelope(napiStorage, encoded, 20_000),
  'napi-envelope-40b': envelope(napiStorage, async () => SMALL, 50_000),
  'napi-envelope-64kb': envelope(napiStorage, compressible, 500),
  // Workers envelope: the same codec through the wasm core
  'wasm-envelope': envelope(wasmStorage, encoded, 10_000),
  'wasm-envelope-40b': envelope(wasmStorage, async () => SMALL, 20_000),
  'wasm-envelope-64kb': envelope(wasmStorage, compressible, 200),
  // secure cache on Node: AAD v0x03 + AES-256-GCM through the NAPI core, decrypt + encrypt.
  // Its own gate threshold (ir.mjs `fail`): its Ir/op moves with builds whose
  // changes it never runs, by up to 1.14% in CI (a comment added to index.ts),
  // the same on every run of those two builds.
  'napi-encrypted': { ...napiEncrypted(encoded, 10_000), fail: 0.04 },
  'napi-encrypted-64kb': napiEncrypted(incompressible, 500),
  // wasm-AES baseline: the same through the wasm core's AES-256-GCM. The
  // Workers entry encrypts through WebCrypto instead, which Node cannot stand
  // in for; bench/workers-crypto times that path inside workerd.
  'wasm-encrypted': wasmEncrypted(encoded, 5_000),
  'wasm-encrypted-64kb': wasmEncrypted(incompressible, 50),
  // a secure cache's L2 round trip on Node, L1 off: set + get, each running the
  // AAD-size pre-flight (validateKey) and then encrypt or decrypt. 4,000
  // warm-up ops: the get reads the envelope header through Node's TextDecoder,
  // whose decode V8 compiles with TurboFan at ~2,400 ops.
  'secure-set-get': {
    n: 5_000,
    warmup: 4_000,
    setup: async () => {
      const { createCache } = await load('index.js');
      const cache = createCache({
        backend: new MemoryBackend(),
        l1: { enabled: false },
        encryption: { masterKey: MASTER_KEY },
        metrics: false,
      });
      return async () => {
        await cache.set(KEY, VALUE);
        sink += (await cache.get(KEY)).rows.length;
      };
    },
  },
  // get() served from a plaintext L1, which holds the decoded value: the
  // lookup and the promises around it (l1-get-hit times L1Cache.get alone).
  // 4,000 warm-up ops: V8 compiles getEntry with TurboFan at ~2,200.
  'get-l1-hit': {
    n: 20_000,
    warmup: 4_000,
    setup: async () => {
      const { createCache } = await load('index.js');
      const cache = createCache({ backend: new MemoryBackend(), metrics: false });
      await cache.set(KEY, VALUE, { ttl: 3600 });
      return async () => {
        sink += (await cache.get(KEY)).rows.length;
      };
    },
  },
  // wrap() with an object among the arguments, which the key memo does not
  // keep: keygen + L1 lookup, where a plaintext L1 holds the decoded value
  'wrap-l1-hit': {
    n: 10_000,
    setup: async () => {
      const { createCache } = await load('index.js');
      const cache = createCache({ backend: new MemoryBackend(), metrics: false });
      const getUser = cache.wrap(async (id, kind, opts) => ({ id, kind, opts }), {
        namespace: 'bench',
        ttl: 3600,
      });
      return async () => {
        sink += (await getUser(...ARGS)).id;
      };
    },
  },
  // wrap-l1-hit with metrics on, the production, secure and io default
  'wrap-l1-hit-metrics': {
    n: 10_000,
    setup: async () => {
      const { createCache } = await load('index.js');
      const { Registry } = await import('prom-client');
      const registry = new Registry();
      const cache = createCache({ backend: new MemoryBackend(), metrics: { registry } });
      const getUser = cache.wrap(async (id, kind, opts) => ({ id, kind, opts }), {
        namespace: 'bench',
        ttl: 3600,
      });
      await getUser(...ARGS);
      // prom-client loads on a later turn of the event loop, which a loop of
      // awaited hits never yields: wait here until it has counted the miss.
      const deadline = Date.now() + 5_000;
      while (!(await registry.metrics()).includes('cachekit_misses_total 1')) {
        if (Date.now() > deadline)
          throw new Error('wrap-l1-hit-metrics: prom-client did not count the miss within 5 s');
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return async () => {
        sink += (await getUser(...ARGS)).id;
      };
    },
  },
  // an encrypted wrap() L1 hit at 100 B, 10 KB and 1 MB of msgpack (3, 320
  // and 96 x 320 rows). On Node 22 and 24 each repeats within 0.01%. On Node
  // 26 the 100 B and 1 MB hits sometimes have a run up to 1.7% off the rest,
  // and a 4x larger n did not remove it: gate on Node 22 or 24. 4,000 warm-up
  // ops at 100 B and 10 KB: V8 compiles normalize with TurboFan at ~2,200 ops,
  // and the encoder deoptimises and is compiled again up to ~2,500.
  'secure-wrap-l1-hit-100b': secureWrapHit(rowsOf(3), 40_000, 4_000),
  'secure-wrap-l1-hit-10kb': secureWrapHit(rowsOf(320), 500, 4_000),
  'secure-wrap-l1-hit-1mb': secureWrapHit(
    { groups: Array.from({ length: 96 }, () => rowsOf(320)) },
    50,
    20
  ),
  // the README benchmark's hit (bench/runtime/probe.mjs): one integer argument,
  // cycling over 64 values that are all in L1
  'wrap-l1-hit-int': {
    n: 20_000,
    setup: async () => {
      const { createCache } = await load('index.js');
      const cache = createCache({ backend: new MemoryBackend(), metrics: false });
      const getThing = cache.wrap(async (id) => ({ id }), { namespace: 'bench', ttl: 3600 });
      for (let i = 0; i < 64; i++) await getThing(i);
      let i = 0;
      return async () => {
        sink += (await getThing(i++ & 63)).id;
      };
    },
  },
};

// The warm-up and the window run their ops through this one function, so it
// is as warm as the op when the window opens. A loop in the module body
// instead had V8 compile the module body inside the window and deoptimise it
// at the window's end.
async function repeat(op, times) {
  for (let i = 0; i < times; i++) await op();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name, nArg] = process.argv.slice(2);
  const n = Number(nArg);
  if (!Object.hasOwn(WORKLOADS, name)) {
    throw new Error(`unknown workload "${name}"; one of: ${Object.keys(WORKLOADS).join(', ')}`);
  }
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`n must be a non-negative integer, got "${nArg}"`);

  const op = await WORKLOADS[name].setup(n);
  await repeat(op, WORKLOADS[name].warmup ?? WARMUP);
  process.cpuUsage(); // window start: callgrind dump 1
  const t0 = process.hrtime.bigint();
  await repeat(op, n);
  const ns = Number(process.hrtime.bigint() - t0);
  process.cpuUsage(); // window end: callgrind dump 2
  if (process.argv.includes('--wall')) console.log(JSON.stringify({ nsPerOp: n ? ns / n : 0 }));
  if (sink < 0) console.log(sink);
  // Exit without teardown: closing the cache or freeing keys would only add
  // the same Ir to both runs.
  process.exit(0);
}
