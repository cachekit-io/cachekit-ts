/**
 * Interop Mode (interop/v1) Protocol Tests
 *
 * Byte-verifies the SDK against protocol/test-vectors/interop-mode.json
 * (vendored in ./fixtures/ — regenerate upstream with
 * `python3 tools/interop-reference.py generate` and re-copy on spec change).
 *
 * Spec: protocol/spec/interop-mode.md. The vectors were produced by the
 * stdlib Python reference implementation and independently cross-checked by
 * tools/interop-crosscheck.mjs; this suite is the cachekit-ts SDK's own
 * mandatory verification (spec "SDK Implementation Requirements" #7).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  encodeInteropArgs,
  interopArgsHash,
  generateInteropKey,
  encodeInteropValue,
  decodeInteropValue,
  InteropFloat,
} from '../../src/serialization/interop.js';
import { EncryptionManager } from '../../src/encryption/manager.js';
import { AAD_VERSION } from '../../src/constants.js';

interface KeyVector {
  name: string;
  namespace: string;
  operation: string;
  args: unknown[];
  canonical_args_hex: string;
  args_hash: string;
  expected_key: string;
}

interface ValueVector {
  name: string;
  value: unknown;
  canonical_msgpack_hex: string;
}

interface ErrorVector {
  name: string;
  namespace?: string;
  operation?: string;
  args: unknown[];
  error: string;
}

interface VectorFile {
  segment_pattern: string;
  key_vectors: KeyVector[];
  value_vectors: ValueVector[];
  aad_vectors: {
    name: string;
    tenant_id: string;
    cache_key: string;
    format: string;
    compressed: boolean;
    aad_hex: string;
  }[];
  encryption_vectors: {
    name: string;
    master_key_hex: string;
    tenant_id: string;
    derived_key_fingerprint_hex: string;
    cache_key: string;
    aad_hex: string;
    plaintext_hex: string;
    nonce_hex: string;
    ciphertext_hex: string;
  }[];
  error_vectors: ErrorVector[];
}

const here = dirname(fileURLToPath(import.meta.url));
const vectors: VectorFile = JSON.parse(
  readFileSync(join(here, 'fixtures', 'interop-mode.json'), 'utf8')
) as VectorFile;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * ISO 8601 (offset mandatory) -> integer micros since epoch -> ONE float64
 * division by 10^6, exactly per spec "DateTime determinism". JS Date only
 * carries milliseconds, so vector datetimes with microsecond precision are
 * converted here (mirroring tools/interop-crosscheck.mjs) and fed to the SDK
 * as the normalized number. Naive datetimes (no offset) are rejected — the
 * reject_naive_datetime vector pins this rule for any future ISO-parsing
 * path in the SDK.
 */
function isoToUnixFloat64(iso: string): number {
  const m = iso.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/
  );
  if (!m) {
    throw new Error(`naive or malformed datetime: ${iso}`);
  }
  const [, y, mo, d, h, mi, s, frac, off] = m;
  let ms = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!);
  if (off !== 'Z') {
    const sign = off![0] === '-' ? -1 : 1;
    ms -= sign * (Number(off!.slice(1, 3)) * 60 + Number(off!.slice(4, 6))) * 60_000;
  }
  const micros = BigInt(ms) * 1000n + BigInt((frac ?? '').padEnd(6, '0') || '0');
  return Number(micros) / 1_000_000.0;
}

/**
 * Decode the vector file's tagged-JSON inputs into the values a TypeScript
 * caller would pass to the SDK (see the file's `tagged_json` header):
 * - $int -> BigInt (integers beyond 2^53 MUST be BigInt in JS)
 * - $float -> InteropFloat (declared float64 semantics — a bare `number`
 *   integral beyond Number.isSafeInteger is rejected by the SDK, so the
 *   $float inputs use the explicit float wrapper, mirroring the reference
 *   crosscheck's Float class)
 * - $uuid -> lowercase hyphenated string (TS has no UUID type; the spec
 *   requires callers to pass the lowercase form)
 * - $datetime -> normalized Unix float64 (see isoToUnixFloat64)
 * - $set -> Set, $bytes -> Uint8Array
 */
function fromTagged(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(fromTagged);
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v);
    const record = v as Record<string, unknown>;
    if (keys.length === 1 && keys[0]!.startsWith('$')) {
      const val = record[keys[0]!];
      switch (keys[0]) {
        case '$set':
          return new Set((val as unknown[]).map(fromTagged));
        case '$bytes':
          return hexToBytes(val as string);
        case '$datetime':
          return new InteropFloat(isoToUnixFloat64(val as string));
        case '$uuid':
          return (val as string).toLowerCase();
        case '$float':
          return new InteropFloat(Number(val));
        case '$int':
          return BigInt(val as string);
        default:
          throw new Error(`unknown tag ${keys[0]}`);
      }
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      out[k] = fromTagged(record[k]);
    }
    return out;
  }
  return v;
}

/** Mirror of EncryptionManager's private buildAAD (protocol v1.0.1 §5.6.2) —
 * same convention as aad-format.protocol.test.ts. The REAL builder is
 * exercised end-to-end by the encryption vector decrypt below (a wrong AAD
 * fails the AES-GCM tag check). */
function buildAAD(
  tenantId: string,
  cacheKey: string,
  format: string,
  compressed: boolean
): Uint8Array {
  const encoder = new TextEncoder();
  const components = [
    encoder.encode(tenantId),
    encoder.encode(cacheKey),
    encoder.encode(format),
    encoder.encode(compressed ? 'True' : 'False'),
  ];
  const aad = new Uint8Array(1 + components.reduce((sum, c) => sum + 4 + c.length, 0));
  const view = new DataView(aad.buffer);
  let offset = 0;
  aad[offset++] = AAD_VERSION;
  for (const component of components) {
    view.setUint32(offset, component.length, false);
    offset += 4;
    aad.set(component, offset);
    offset += component.length;
  }
  return aad;
}

describe('interop/v1 key vectors', () => {
  it.each(vectors.key_vectors)(
    '$name',
    ({ namespace, operation, args, canonical_args_hex, args_hash, expected_key }) => {
      const converted = args.map(fromTagged);
      expect(bytesToHex(encodeInteropArgs(converted))).toBe(canonical_args_hex);
      expect(interopArgsHash(converted)).toBe(args_hash);
      expect(generateInteropKey(namespace, operation, converted)).toBe(expected_key);
    }
  );
});

describe('interop/v1 value vectors', () => {
  // float_value_stays_float64 pins that the VALUE profile does not collapse
  // Python float 2.0 to int. A bare JS number cannot carry that distinction
  // (`2.0 === 2` — the spec's "a JS-written 2 may come back to Python as
  // int" caveat); the harness expresses it with the InteropFloat wrapper.
  it.each(vectors.value_vectors)('$name encodes canonically', ({ value, canonical_msgpack_hex }) => {
    expect(bytesToHex(encodeInteropValue(fromTagged(value)))).toBe(canonical_msgpack_hex);
  });

  it('accepts every published value payload on read (canonical or not)', () => {
    for (const v of vectors.value_vectors) {
      expect(() => decodeInteropValue(hexToBytes(v.canonical_msgpack_hex))).not.toThrow();
    }
  });

  it('reads float64 2.0 from another SDK as the number 2', () => {
    const v = vectors.value_vectors.find((x) => x.name === 'float_value_stays_float64')!;
    expect(decodeInteropValue<number>(hexToBytes(v.canonical_msgpack_hex))).toBe(2);
  });

  it('revives the __datetime__ sentinel map into a Date', () => {
    const v = vectors.value_vectors.find((x) => x.name === 'datetime_sentinel_value')!;
    const revived = decodeInteropValue<Date>(hexToBytes(v.canonical_msgpack_hex));
    expect(revived).toBeInstanceOf(Date);
    // JS Date carries milliseconds; the microsecond tail truncates on revival.
    expect(revived.getTime()).toBe(Date.UTC(2024, 0, 1, 12, 30, 45, 123));
  });
});

describe('interop/v1 AAD vector', () => {
  it.each(vectors.aad_vectors)('$name', ({ tenant_id, cache_key, format, compressed, aad_hex }) => {
    expect(bytesToHex(buildAAD(tenant_id, cache_key, format, compressed))).toBe(aad_hex);
  });
});

describe('interop/v1 encryption vector', () => {
  // Requires the native cachekit-core-ts bindings (same requirement as the
  // existing cross-sdk-interop protocol tests).
  it.each(vectors.encryption_vectors)(
    '$name: decrypts with the real AAD builder and HKDF chain',
    async ({
      master_key_hex,
      tenant_id,
      derived_key_fingerprint_hex,
      cache_key,
      plaintext_hex,
      ciphertext_hex,
    }) => {
      const manager = new EncryptionManager(master_key_hex, tenant_id);
      try {
        // compressed=false: interop mode never sets the compressed AAD flag.
        const plaintext = await manager.decrypt(hexToBytes(ciphertext_hex), cache_key, false);
        expect(bytesToHex(plaintext)).toBe(plaintext_hex);

        // The derived key must be the one already pinned in
        // test-vectors/encryption.json (ground-truth continuity).
        const fingerprint = await manager.getKeyFingerprint();
        expect(bytesToHex(fingerprint!)).toBe(derived_key_fingerprint_hex);

        // Full cross-SDK read path: ciphertext -> plaintext -> value.
        expect(decodeInteropValue(plaintext)).toEqual({ name: 'alice', age: 30 });
      } finally {
        manager.dispose();
      }
    }
  );

  it.each(vectors.encryption_vectors)(
    '$name: rejects the ciphertext under a tampered AAD (wrong key binding)',
    async ({ master_key_hex, tenant_id, ciphertext_hex }) => {
      const manager = new EncryptionManager(master_key_hex, tenant_id);
      try {
        await expect(
          manager.decrypt(hexToBytes(ciphertext_hex), 'users:get_user:' + '0'.repeat(64), false)
        ).rejects.toThrow();
      } finally {
        manager.dispose();
      }
    }
  );
});

describe('interop/v1 error vectors (MUST reject)', () => {
  it.each(vectors.error_vectors)('$name', ({ namespace, operation, args }) => {
    expect(() => {
      const converted = args.map(fromTagged);
      if (namespace !== undefined) {
        generateInteropKey(namespace, operation!, converted);
      } else {
        encodeInteropArgs(converted);
      }
    }).toThrow();
  });

  it('rejects a lone surrogate (self-test — inexpressible in portable JSON)', () => {
    expect(() => encodeInteropArgs([String.fromCharCode(0xd800)])).toThrow(
      /well-formed Unicode/
    );
  });
});
