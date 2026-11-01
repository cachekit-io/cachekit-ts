import { ConfigurationError } from '../errors.js';
import { logError } from '../logger.js';

/**
 * The telemetry switch and the L1 hit-latency report of a CachekitIO backend
 * (protocol spec/saas-api.md § Optional Metrics Headers).
 */

type Control = 'on' | 'off' | 'unset';

let bindingsReader: (() => unknown) | undefined;
let warnedUnknownValue = false;
let warnedUnreadable = false;

/**
 * Package-internal: where the Workers entrypoint reads `CACHEKIT_TELEMETRY`
 * from the Worker's bindings. Unset on Node, which has only `process.env`.
 * The reader throws when it cannot see the bindings, which reads as off.
 */
export function setTelemetryBindingsReader(reader: (() => unknown) | undefined): void {
  bindingsReader = reader;
}

/**
 * One `CACHEKIT_TELEMETRY` value by the spec's own rule (API-95): trimmed and
 * case-insensitive; unset or empty is unset, and a value that is neither on
 * nor off reads as off, with one warning per process.
 */
function parseControl(raw: unknown): Control {
  if (raw === undefined || raw === null) return 'unset';
  const value = String(raw).trim().toLowerCase();
  if (value === '') return 'unset';
  if (value === 'true' || value === '1' || value === 'on' || value === 'yes') return 'on';
  if (value === 'false' || value === '0' || value === 'off' || value === 'no') return 'off';
  if (!warnedUnknownValue) {
    warnedUnknownValue = true;
    logError(
      `[cachekit] CACHEKIT_TELEMETRY=${JSON.stringify(String(raw))} is not one of ` +
        'true/false/1/0/on/off/yes/no: telemetry is off'
    );
  }
  return 'off';
}

/**
 * One `CACHEKIT_TELEMETRY` source, parsed, or off when it cannot be read:
 * the user may have set it to off there, so an unreadable source is off, as
 * an unknown value is (API-95), with one warning per process. Deno without
 * `--allow-env` throws on a `process.env` read; Workers under
 * `disallow_importable_env` hides the bindings.
 */
function readControl(read: () => unknown): Control {
  try {
    return parseControl(read());
  } catch (error) {
    if (!warnedUnreadable) {
      warnedUnreadable = true;
      const reason = error instanceof Error ? error.message : String(error);
      logError(`[cachekit] CACHEKIT_TELEMETRY could not be read (${reason}): telemetry is off`);
    }
    return 'off';
  }
}

function readProcessEnv(): unknown {
  return typeof process !== 'undefined' ? process.env?.CACHEKIT_TELEMETRY : undefined;
}

/**
 * Resolve a CachekitIO backend's telemetry switch (API-94, API-95). Called
 * once, at construction. `CACHEKIT_TELEMETRY` is read from `process.env`
 * wherever there is one and, on Workers, from the bindings too. The spec's
 * truth table reduces to: off from any control wins, and otherwise
 * telemetry is on, the closed-beta default.
 */
export function resolveTelemetry(setting: unknown): boolean {
  if (setting !== undefined && typeof setting !== 'boolean') {
    // A JavaScript caller's 'false' is truthy: refuse it rather than read it as on.
    throw new ConfigurationError(
      `telemetry must be true, false or undefined, got ${JSON.stringify(setting)}`
    );
  }
  // Read both before deciding, so an unknown value warns whatever the setting says.
  const fromProcess = readControl(readProcessEnv);
  const fromBindings = bindingsReader === undefined ? 'unset' : readControl(bindingsReader);
  return setting !== false && fromProcess !== 'off' && fromBindings !== 'off';
}

/** Package-internal: forget the one-time warnings. Tests only. */
export function _resetTelemetryWarningForTesting(): void {
  warnedUnknownValue = false;
  warnedUnreadable = false;
}

/**
 * The sampling denominator N (`X-CacheKit-L1-Latency-One-In`): each call is
 * timed with probability 1/N (API-81). A timed hit costs about 5,000
 * instructions more than an untimed one (two clock reads and the bucket),
 * against about 4,700 for a whole memoised wrap() hit on Node 24, measured.
 * At 1 in 1024 that is 5 per hit; the draw itself costs about 80.
 */
export const L1_LATENCY_ONE_IN = 1024;

/** Bucket 16's upper bound: 60 s. A longer duration is discarded (API-87). */
const MAX_DURATION_NS = 60_000_000_000;
/** Bucket 15's upper bound, 2^21 ns: anything above it is bucket 16. */
const BUCKET_15_MAX_NS = 2_097_152;

/**
 * One CachekitIO backend's L1 hit-latency accumulator (§ L1 hit latency).
 * The cache records the durations of the calls it timed; the backend takes
 * them, as one report, onto its next request.
 */
export class L1LatencyReport {
  private readonly buckets = new Array<number>(16).fill(0);
  private sumNs = 0;

  constructor(readonly oneIn: number) {}

  /**
   * Add one timed L1 hit, in whole nanoseconds. Over 60 s is discarded
   * (API-87), as is a hit that would take the sum past 2^53 - 1, the
   * largest value the wire grammar allows.
   */
  record(durationNs: number): void {
    if (durationNs > MAX_DURATION_NS || this.sumNs + durationNs > Number.MAX_SAFE_INTEGER) return;
    // Bucket i (from 0) holds (2^(i+6), 2^(i+7)] ns; bucket 0 holds 0..128.
    // 32 - clz32(d - 1) is ceil(log2 d) for 1 <= d <= 2^32, and d is at most
    // 2^21 by then.
    const bucket =
      durationNs <= 128
        ? 0
        : durationNs > BUCKET_15_MAX_NS
          ? 15
          : 32 - Math.clz32(durationNs - 1) - 7;
    this.buckets[bucket]++;
    this.sumNs += durationNs;
  }

  /** True while the sum is 0: there is no report to attach (API-85). */
  get empty(): boolean {
    return this.sumNs < 1;
  }

  /**
   * Take the report as its three headers and reset the accumulator, or
   * return undefined while the sum is 0, leaving it in place (API-85). One
   * synchronous step, so no other request can carry the same hits.
   */
  take(): Record<string, string> | undefined {
    if (this.empty) return undefined;
    const headers = {
      'X-CacheKit-L1-Latency-Buckets': this.buckets.join(','),
      'X-CacheKit-L1-Latency-Sum-Ns': String(this.sumNs),
      'X-CacheKit-L1-Latency-One-In': String(this.oneIn),
    };
    this.buckets.fill(0);
    this.sumNs = 0;
    return headers;
  }
}
