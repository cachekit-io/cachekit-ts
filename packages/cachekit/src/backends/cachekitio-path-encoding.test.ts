import { describe, it, expect } from 'vitest';
import { encodeKey } from './cachekitio.js';
import { ConfigurationError } from '../errors.js';

const BASE = 'https://api.cachekit.io';

const cacheUrl = (key: string) => `${BASE}/v1/cache/${encodeKey(key)}`;
const ttlUrl = (key: string) => `${BASE}/v1/cache/${encodeKey(key)}/ttl`;
const lockUrl = (key: string) => `${BASE}/v1/cache/${encodeKey(key)}/lock`;

// AC-0 — Repro: raw encodeURIComponent lets dot-segments escape /v1/cache/
describe('AC-0: dot-segment traversal repro (pre-fix behavior)', () => {
  it('"." collapses to /v1/cache/ with raw encodeURIComponent', () => {
    const raw = `${BASE}/v1/cache/${encodeURIComponent('.')}`;
    expect(new URL(raw).pathname).toBe('/v1/cache/');
  });

  it('".." escapes /v1/cache/ with raw encodeURIComponent', () => {
    const raw = `${BASE}/v1/cache/${encodeURIComponent('..')}`;
    expect(new URL(raw).pathname).toBe('/v1/');
  });

  it('"../ttl" path collapses to /v1/ttl', () => {
    const raw = `${BASE}/v1/cache/${encodeURIComponent('..')}/ttl`;
    expect(new URL(raw).pathname).toBe('/v1/ttl');
  });

  it('"../lock" path collapses to /v1/lock', () => {
    const raw = `${BASE}/v1/cache/${encodeURIComponent('..')}/lock`;
    expect(new URL(raw).pathname).toBe('/v1/lock');
  });

  // Proves that %2E encoding (Python's approach) does NOT survive WHATWG
  // URL normalization — justifies the rejection approach for TS.
  it('%2E is also collapsed by WHATWG URL parser (unlike RFC-3986)', () => {
    expect(new URL(`${BASE}/v1/cache/%2E`).pathname).toBe('/v1/cache/');
    expect(new URL(`${BASE}/v1/cache/%2E%2E`).pathname).toBe('/v1/');
    expect(new URL(`${BASE}/v1/cache/%2E%2E/ttl`).pathname).toBe('/v1/ttl');
    expect(new URL(`${BASE}/v1/cache/%2E%2E/lock`).pathname).toBe('/v1/lock');
  });
});

// AC-1 — encodeKey rejects bare dot-segments, passes everything else through
describe('AC-1: encodeKey helper', () => {
  it('rejects "." with ConfigurationError', () => {
    expect(() => encodeKey('.')).toThrow(ConfigurationError);
    expect(() => encodeKey('.')).toThrow(/CWE-22/);
  });

  it('rejects ".." with ConfigurationError', () => {
    expect(() => encodeKey('..')).toThrow(ConfigurationError);
    expect(() => encodeKey('..')).toThrow(/CWE-22/);
  });

  const passthrough: [string, string][] = [
    ['a:..', 'key containing dots is not all-dot'],
    ['..a', 'prefix dots with trailing alpha'],
    [`ns:default:func:m.f:args:${'a'.repeat(64)}:`, 'canonical 7-segment key'],
    ['a b', 'space-containing key'],
    ['k?x=1#f', 'query/fragment characters'],
    ['...', 'triple dot is not a traversal segment'],
  ];

  for (const [key, label] of passthrough) {
    it(`${label} ("${key}") matches encodeURIComponent`, () => {
      expect(encodeKey(key)).toBe(encodeURIComponent(key));
    });
  }
});

// AC-2 — Post-normalisation pathname stays inside /v1/cache/ for all safe vectors
describe('AC-2: URL pathname assertions', () => {
  const safeVectors: [string, string][] = [
    ['a:..', `/v1/cache/${encodeURIComponent('a:..')}`],
    ['default:../../admin', `/v1/cache/${encodeURIComponent('default:../../admin')}`],
    ['k?x=1#f', `/v1/cache/${encodeURIComponent('k?x=1#f')}`],
    ['a b', `/v1/cache/${encodeURIComponent('a b')}`],
    [
      `ns:default:func:m.f:args:${'a'.repeat(64)}:`,
      `/v1/cache/${encodeURIComponent(`ns:default:func:m.f:args:${'a'.repeat(64)}:`)}`,
    ],
    ['...', `/v1/cache/${encodeURIComponent('...')}`],
  ];

  describe('base backend (/v1/cache/{key})', () => {
    for (const [key, expectedPath] of safeVectors) {
      it(`key "${key}" → ${expectedPath}`, () => {
        const parsed = new URL(cacheUrl(key));
        expect(parsed.pathname).toBe(expectedPath);
        expect(parsed.pathname.startsWith('/v1/cache/')).toBe(true);
      });
    }
  });

  describe('TTL wrapper (/v1/cache/{key}/ttl)', () => {
    for (const [key, expectedPath] of safeVectors) {
      it(`key "${key}" → ${expectedPath}/ttl`, () => {
        const parsed = new URL(ttlUrl(key));
        expect(parsed.pathname).toBe(`${expectedPath}/ttl`);
        expect(parsed.pathname.startsWith('/v1/cache/')).toBe(true);
      });
    }
  });

  describe('lockable wrapper (/v1/cache/{key}/lock)', () => {
    for (const [key, expectedPath] of safeVectors) {
      it(`key "${key}" → ${expectedPath}/lock`, () => {
        const parsed = new URL(lockUrl(key));
        expect(parsed.pathname).toBe(`${expectedPath}/lock`);
        expect(parsed.pathname.startsWith('/v1/cache/')).toBe(true);
      });
    }
  });

  it('dot-segment keys are rejected before URL construction', () => {
    for (const key of ['.', '..']) {
      for (const builder of [cacheUrl, ttlUrl, lockUrl]) {
        expect(() => builder(key)).toThrow(ConfigurationError);
      }
    }
  });
});

// AC-3 — Decode-once round-trip for all safe keys
describe('AC-3: decode-once round-trip', () => {
  const keys = [
    'a:..',
    '..a',
    'default:../../admin',
    '...',
    `ns:default:func:m.f:args:${'a'.repeat(64)}:`,
    'a b',
    'k?x=1#f',
    'hello',
    '',
  ];

  for (const key of keys) {
    it(`round-trips "${key}"`, () => {
      expect(decodeURIComponent(encodeKey(key))).toBe(key);
    });
  }

  it('dot-segment keys cannot round-trip (rejected)', () => {
    expect(() => encodeKey('.')).toThrow();
    expect(() => encodeKey('..')).toThrow();
  });
});
