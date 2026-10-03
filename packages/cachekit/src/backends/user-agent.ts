import { VERSION } from '../version.js';

/**
 * The runtime token from the runtime's own navigator.userAgent: Node 21.1+ reports `Node.js/<ver>`,
 * Bun `Bun/<ver>`, Deno `Deno/<ver>` and workerd `Cloudflare-Workers`. Transport behaviour (ALPN,
 * idle-socket reuse) differs by runtime, so edge analytics needs it to attribute a regression.
 */
export function runtimeToken(userAgent: string | undefined): string {
  if (userAgent === undefined) return 'unknown';
  if (userAgent.startsWith('Node.js/')) return 'node';
  if (userAgent.startsWith('Bun/')) return 'bun';
  if (userAgent.startsWith('Deno/')) return 'deno';
  if (userAgent === 'Cloudflare-Workers') return 'workerd';
  return 'unknown';
}

const navigatorUserAgent = (globalThis as { navigator?: { userAgent?: unknown } }).navigator
  ?.userAgent;

/** `cachekit-ts/<version> (<runtime>)`, sent on every CachekitIO request. */
export const USER_AGENT = `cachekit-ts/${VERSION} (${runtimeToken(
  typeof navigatorUserAgent === 'string' ? navigatorUserAgent : undefined
)})`;
