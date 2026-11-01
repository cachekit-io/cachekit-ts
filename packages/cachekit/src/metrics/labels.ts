/**
 * Metrics config checks that need no prom-client, so cache-core can run them
 * before it resolves the backend, on every platform.
 */
import { ConfigurationError } from '../errors.js';

/** Labels the metrics set per call; a default label of the same name would replace them. */
const INTRINSIC_LABELS: readonly string[] = ['layer', 'operation', 'status', 'error_type'];

/** Throw ConfigurationError when `defaultLabels` sets a label the metrics set themselves. */
export function checkDefaultLabels(defaultLabels: Record<string, string> | undefined): void {
  const reserved = Object.keys(defaultLabels ?? {}).filter((l) => INTRINSIC_LABELS.includes(l));
  if (reserved.length > 0) {
    throw new ConfigurationError(
      `metrics.defaultLabels cannot set ${reserved.join(', ')}: ` +
        `${INTRINSIC_LABELS.join(', ')} are set by the metrics themselves`
    );
  }
}
