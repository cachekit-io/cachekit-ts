// AES-256-GCM per op on Workers, A/B inside workerd: the wasm core (A) against
// WebCrypto (B), both driven through EncryptionManagerCore on the current build.
//
//   pnpm --filter @cachekit-io/cachekit bench:workers-crypto
//
// Method:
// - Sizes 100 B, 1 KB, 16 KB, 64 KB and 1 MB; encrypt and decrypt each.
// - A, B and an A/A twin (a second wasm manager) are interleaved within every
//   rep, in an order rotated each rep, so host drift lands on all three alike.
//   60 reps at 1 KB and below, 9 above.
// - workerd's clock has 1 ms resolution, so each sample is a batch of k ops,
//   k calibrated per arm to fill about 40 ms. The same k of no-op awaits is
//   timed right before it and subtracted.
// - Per size and op: median µs/op of each arm; the A/A floor is
//   |A − A/A| / A; the gain is (A − B) / A. Each rep also gives a paired gain
//   (A_i − B_i) / A_i; a seeded bootstrap (2,000 resamples) of their median
//   gives a 95% CI. PASS when the gain clears the floor or the CI excludes
//   zero; REGRESS when the loss clears the floor or the CI is below zero;
//   otherwise PARITY. The run fails unless every row passes.
//
// Local workerd numbers are indicative, not production timings.
import { expect, it } from 'vitest';
import * as wasm from '@cachekit-io/cachekit-core-wasm';
import {
  EncryptionManagerCore,
  type EncryptionBindings,
} from '../../src/encryption/manager-core.js';
import { webCryptoEncryptionBindings } from '../../src/workers/webcrypto.js';

const MASTER_KEY = 'ab'.repeat(32);
const KEY = 'ns:bench:func:mod.fn:args:' + '0'.repeat(64) + ':';
const SIZES = [100, 1024, 16 * 1024, 64 * 1024, 1024 * 1024];
const TARGET_MS = 40;
const reps = (size: number) => (size <= 1024 ? 60 : 9);
const RESAMPLES = 2000;

function wasmBindings(): EncryptionBindings {
  wasm.ensureInitialized();
  return {
    deriveTenantKeys: wasm.deriveTenantKeys,
    encryptWithTenantKeys: (p, a, tk) => wasm.encryptWithTenantKeys(p, a, tk as wasm.TenantKeys),
    decryptWithTenantKeys: (c, a, tk) => wasm.decryptWithTenantKeys(c, a, tk as wasm.TenantKeys),
  };
}

function webCryptoBindings(): EncryptionBindings {
  wasm.ensureInitialized();
  return webCryptoEncryptionBindings({
    deriveKey: wasm.deriveKey,
    deriveTenantKeys: wasm.deriveTenantKeys,
  });
}

type Op = () => Promise<unknown>;
const noop: Op = async () => undefined;

async function batchMs(k: number, op: Op): Promise<number> {
  const t0 = performance.now();
  for (let i = 0; i < k; i++) await op();
  return performance.now() - t0;
}

/** Ops per batch so one batch fills about TARGET_MS. */
async function calibrate(op: Op): Promise<number> {
  let k = 1;
  for (;;) {
    const ms = await batchMs(k, op);
    if (ms >= TARGET_MS / 4) return Math.max(3, Math.ceil((k * TARGET_MS) / ms));
    k *= 4;
  }
}

/** One sample: µs per op, the no-op await baseline subtracted. */
async function sample(k: number, op: Op): Promise<number> {
  const base = await batchMs(k, noop);
  return ((await batchMs(k, op)) - base) * (1000 / k);
}

/** mulberry32: a seeded PRNG, so a rerun of the same samples gives the same CI. */
function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 95% percentile-bootstrap CI of the median paired gain. */
function pairedCi(gains: number[]): [number, number] {
  const random = prng(0x5eed);
  const medians: number[] = [];
  for (let r = 0; r < RESAMPLES; r++) {
    medians.push(median(gains.map(() => gains[Math.floor(random() * gains.length)])));
  }
  medians.sort((a, b) => a - b);
  return [medians[Math.floor(RESAMPLES * 0.025)], medians[Math.ceil(RESAMPLES * 0.975) - 1]];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

interface Arm {
  ops: Record<'encrypt' | 'decrypt', Op>;
  k: Record<'encrypt' | 'decrypt', number>;
  us: Record<'encrypt' | 'decrypt', number[]>;
}

async function arm(bindings: EncryptionBindings, data: Uint8Array) {
  const manager = new EncryptionManagerCore(MASTER_KEY, undefined, async () => bindings);
  const ciphertext = await manager.encrypt(data, KEY);
  const ops = {
    encrypt: () => manager.encrypt(data, KEY),
    decrypt: () => manager.decrypt(ciphertext, KEY),
  };
  const k = { encrypt: await calibrate(ops.encrypt), decrypt: await calibrate(ops.decrypt) };
  const result: Arm = { ops, k, us: { encrypt: [], decrypt: [] } };
  return { arm: result, manager };
}

it('WebCrypto vs wasm AES-256-GCM, interleaved A/B with an A/A row', async () => {
  const rows: string[] = [];
  let failures = 0;
  for (const size of SIZES) {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 0xff;
    const built = [
      await arm(wasmBindings(), data), // A
      await arm(webCryptoBindings(), data), // B
      await arm(wasmBindings(), data), // A/A
    ];
    const arms = built.map((b) => b.arm);
    for (let rep = 0; rep < reps(size); rep++) {
      for (let i = 0; i < arms.length; i++) {
        const a = arms[(rep + i) % arms.length];
        for (const op of ['encrypt', 'decrypt'] as const)
          a.us[op].push(await sample(a.k[op], a.ops[op]));
      }
    }
    for (const b of built) b.manager.dispose();

    for (const op of ['encrypt', 'decrypt'] as const) {
      const [a, b, aa] = arms.map((x) => median(x.us[op]));
      const floor = Math.abs(a - aa) / a;
      const gain = (a - b) / a;
      const [lo, hi] = pairedCi(arms[0].us[op].map((ai, i) => (ai - arms[1].us[op][i]) / ai));
      const verdict =
        gain > floor || lo > 0 ? 'PASS' : gain < -floor || hi < 0 ? 'REGRESS' : 'PARITY';
      if (verdict !== 'PASS') failures++;
      rows.push(
        [
          String(size).padStart(8),
          op.padEnd(8),
          a.toFixed(2).padStart(10),
          b.toFixed(2).padStart(10),
          aa.toFixed(2).padStart(10),
          `${(floor * 100).toFixed(1)}%`.padStart(8),
          `${(gain * 100).toFixed(1)}%`.padStart(8),
          `${(a / b).toFixed(1)}x`.padStart(8),
          `[${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]`.padStart(18),
          verdict,
        ].join(' ')
      );
    }
  }
  console.log(
    [
      'AES-256-GCM per op in local workerd (indicative): A = wasm core, B = WebCrypto',
      '    size op           A µs       B µs     A/A µs  A/A flr     gain  speedup     paired 95% CI',
      ...rows,
    ].join('\n')
  );
  expect(failures).toBe(0);
});
