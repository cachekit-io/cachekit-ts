// Hot-path workloads for the instruction-count suite (ir.mjs drives this file).
//
//   node [v8 flags] bench/ir-workload.mjs <workload> <n> [--wall]
//
// A run loads only what its workload needs, warms the op past tier-up, then
// runs it n times between two process.cpuUsage() calls. ir.mjs has callgrind
// dump its counters on entry to node::CPUUsage, so the counted window holds
// the n ops and nothing else: module load, setup and warm-up stay out.
// --wall prints the steady-state ns per op of the n iterations instead
// (indicative only). Imports the built package: run `pnpm build` first.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const dist = new URL('../dist/', import.meta.url);
const load = (path) => import(new URL(path, dist));
const napi = () => createRequire(import.meta.url)('@cachekit-io/cachekit-core-ts');
// The wasm package's entry imports the .wasm as a module, which only workerd
// resolves; load its wasm-bindgen glue directly and hand it the bytes.
async function wasm() {
  const pkg = new URL('pkg/', import.meta.resolve('@cachekit-io/cachekit-core-wasm'));
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

let sink = 0;

async function encryptedOp(manager, storage) {
  const packed = storage.pack(await encoded());
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

/**
 * Each workload's setup returns its op: one call on the path its name gives.
 * n is sized so n x Ir/op dwarfs the noise of the fixed part.
 */
export const WORKLOADS = {
  // wrap(): every call hashes its arguments before L1 is consulted
  keygen: {
    n: 20_000,
    setup: async () => {
      const { generateKey } = await load('serialization/key-generator.js');
      return () => {
        sink += generateKey('bench', ARGS).length;
      };
    },
  },
  // set encodes, an L2 hit decodes (normalize + msgpack + depth bounds)
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
  'napi-envelope': {
    n: 20_000,
    setup: async () => {
      const storage = new (napi().ByteStorage)();
      const bytes = await encoded();
      return () => {
        sink += storage.unpack(storage.pack(bytes)).length;
      };
    },
  },
  // Workers envelope: the same codec through the wasm core
  'wasm-envelope': {
    n: 10_000,
    setup: async () => {
      const storage = new (await wasm()).ByteStorage();
      const bytes = await encoded();
      return () => {
        sink += storage.unpack(storage.pack(bytes)).length;
      };
    },
  },
  // secure cache on Node: AAD v0x03 + AES-256-GCM through the NAPI core, decrypt + encrypt
  'napi-encrypted': {
    n: 10_000,
    setup: async () => {
      const { EncryptionManager } = await load('encryption/manager.js');
      return encryptedOp(new EncryptionManager(MASTER_KEY), new (napi().ByteStorage)());
    },
  },
  // secure cache on Workers: the same through the wasm core
  'wasm-encrypted': {
    n: 5_000,
    setup: async () => {
      const glue = await wasm();
      const { EncryptionManagerCore } = await load('encryption/manager-core.js');
      const manager = new EncryptionManagerCore(MASTER_KEY, undefined, async () => ({
        deriveTenantKeys: glue.deriveTenantKeys,
        encryptWithTenantKeys: glue.encryptWithTenantKeys,
        decryptWithTenantKeys: glue.decryptWithTenantKeys,
      }));
      return encryptedOp(manager, new glue.ByteStorage());
    },
  },
  // the public API's fastest path: keygen + L1 lookup + L1 decode
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
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name, nArg] = process.argv.slice(2);
  const n = Number(nArg);
  if (!Object.hasOwn(WORKLOADS, name)) {
    throw new Error(`unknown workload "${name}"; one of: ${Object.keys(WORKLOADS).join(', ')}`);
  }
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`n must be a non-negative integer, got "${nArg}"`);

  const op = await WORKLOADS[name].setup();
  // Past V8's tier-up, so the n ops measure optimized code.
  for (let i = 0; i < 2000; i++) await op();
  process.cpuUsage(); // window start: callgrind dump 1
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) await op();
  const ns = Number(process.hrtime.bigint() - t0);
  process.cpuUsage(); // window end: callgrind dump 2
  if (process.argv.includes('--wall')) console.log(JSON.stringify({ nsPerOp: n ? ns / n : 0 }));
  if (sink < 0) console.log(sink);
  // Exit without teardown: closing the cache or freeing keys would only add
  // the same Ir to both runs.
  process.exit(0);
}
