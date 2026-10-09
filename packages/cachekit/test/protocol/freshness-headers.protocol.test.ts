/**
 * Freshness Header Protocol Tests
 *
 * Verifies `freshnessFromHeaders` against protocol/test-vectors/freshness-headers.json
 * (vendored in ./fixtures/ and sha256-pinned below). Spec: protocol/spec/saas-api.md
 * § GET /v1/cache/{key} (response headers) and § Remaining Freshness.
 *
 * Each row's `value` goes through a real `Headers` object, as `fetch` delivers it,
 * so header-value normalisation in the platform is part of what is tested.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { freshnessFromHeaders } from '../../src/backends/cachekitio.js';
import { assertFixture, table } from '../fixtures/fixture-shape.js';

interface FreshnessVector {
  name: string;
  value: string | null;
  stale: boolean;
}

interface FreshForVector {
  name: string;
  value: string | null;
  fresh_for: number | null;
}

/**
 * sha256 of test-vectors/freshness-headers.json (fixture version 1.0.0).
 * Provenance: cachekit-io/protocol @ f3563544 (the merge of
 * cachekit-io/protocol#154). Re-vendoring means copying the file byte-for-byte
 * from a named protocol revision, then updating this docblock and
 * FIXTURE_SHA256 together.
 */
const FIXTURE_SHA256 = '74beb975b6855f52d9dd453279873faf8048a9c3c79a8167cfda099beec5fcd3'; // pragma: allowlist secret

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, 'fixtures', 'freshness-headers.json'));

interface VectorFile {
  freshness_vectors: FreshnessVector[];
  fresh_for_vectors: FreshForVector[];
}

function assertVectorFile(value: unknown): asserts value is VectorFile {
  assertFixture(
    value,
    {
      freshness_vectors: table({ name: 'string', value: ['string', 'null'], stale: 'boolean' }),
      fresh_for_vectors: table({
        name: 'string',
        value: ['string', 'null'],
        fresh_for: ['number', 'null'],
      }),
    },
    'freshness-headers.json'
  );
}

const parsed: unknown = JSON.parse(raw.toString('utf8'));
assertVectorFile(parsed);
const { freshness_vectors: freshnessVectors, fresh_for_vectors: freshForVectors } = parsed;

/** The headers of a `GET 200` carrying `name: value`, or neither when `value` is null. */
function headersWith(name: string, value: string | null): Headers {
  return value === null ? new Headers() : new Headers({ [name]: value });
}

describe('protocol freshness-headers.json fixture', () => {
  it('is the pinned upstream file, unedited since vendoring', () => {
    expect(
      createHash('sha256').update(raw).digest('hex'),
      'fixture differs from the pinned protocol revision; if intentional, refresh FIXTURE_SHA256 and the provenance'
    ).toBe(FIXTURE_SHA256);
  });

  // Vitest registers nothing for an empty `it.each` table, so a renamed or
  // dropped array would otherwise pass with no rows run.
  it('carries rows for both headers', () => {
    expect(freshnessVectors.length).toBeGreaterThan(0);
    expect(freshForVectors.length).toBeGreaterThan(0);
  });
});

describe('X-CacheKit-Freshness', () => {
  it.each(freshnessVectors)('$name: stale is $stale', ({ value, stale }) => {
    const result = freshnessFromHeaders(headersWith('X-CacheKit-Freshness', value));
    expect(result.isStale).toBe(stale);
  });
});

describe('X-CacheKit-Fresh-For', () => {
  it.each(freshForVectors)('$name: fresh_for is $fresh_for', ({ value, fresh_for }) => {
    const result = freshnessFromHeaders(headersWith('X-CacheKit-Fresh-For', value));
    if (fresh_for === null) {
      expect(result).not.toHaveProperty('freshFor');
    } else {
      expect(result.freshFor).toBe(fresh_for);
    }
  });
});
