import { Socket } from 'node:net';
import type { Client as MemjsClient, Server as MemjsServer } from 'memjs';
import { Backend, MemcachedBackendConfig } from './types.js';
import { BackendError, ConfigurationError, TimeoutError } from '../errors.js';
import { logError } from '../logger.js';

/**
 * Memcached maximum relative TTL: 30 days in seconds. The protocol treats any
 * larger `expires` as an absolute UNIX timestamp, so cachekit clamps here
 * (matching cachekit-py) instead of letting a "31 days" TTL expire instantly.
 */
export const MAX_MEMCACHED_TTL = 30 * 24 * 60 * 60;

/** Server default item-size limit (-I flag): 1 MiB. */
const DEFAULT_MAX_ITEM_SIZE_BYTES = 1024 * 1024;

/** Memcached protocol key limit, in bytes (key prefix included). */
const MAX_KEY_BYTES = 250;

/** memjs's fixed `retry_delay` between tries (0.2 s). */
const MEMJS_RETRY_DELAY_MS = 200;

/** Headroom over memjs's own worst case, so the deadline fires only once memjs has lost the request. */
const DEADLINE_SLACK_MS = 500;

/** A client's servers, or none if memjs internals ever stop matching. */
function memjsServers(client: MemjsClient): readonly MemjsServer[] {
  return Array.isArray(client.servers) ? client.servers : [];
}

/** A server's live connection, which memjs 1.3.2 keeps in the undeclared `_socket`. */
function currentSocket(server: MemjsServer): Socket | undefined {
  const socket = '_socket' in server ? server._socket : undefined;
  return socket instanceof Socket ? socket : undefined;
}

/** Every socket memjs has opened for a client and not yet closed, with its server. */
const clientSockets = new WeakMap<MemjsClient, Map<Socket, MemjsServer>>();

/** Clients the backend has discarded. memjs must never connect one again. */
const discardedClients = new WeakSet<MemjsClient>();

/**
 * Record each socket memjs opens, so the ones it abandons can be destroyed.
 *
 * memjs end()s a socket it gives up on (request timeout, connect timeout) and
 * drops its reference. Against a server that never closes its side, that
 * leaves the connection half-open for good. Each abandoned socket is released
 * once its end() flushes, and whenever memjs opens a replacement.
 */
function trackSockets(client: MemjsClient): void {
  const tracked = new Map<Socket, MemjsServer>();
  clientSockets.set(client, tracked);
  for (const server of memjsServers(client)) {
    const sock = server.sock;
    if (!sock) continue;
    server.sock = function (this: MemjsServer, sasl, go) {
      // A memjs retry still pending on a discarded client would open a
      // connection that nothing ever closes. Drop it: its op has already failed.
      if (discardedClients.has(client)) return;
      const previous = currentSocket(this);
      sock.call(this, sasl, go);
      const socket = currentSocket(this);
      if (!socket || socket === previous) return;
      tracked.set(socket, this);
      socket.once('close', () => tracked.delete(socket));
      socket.once('finish', () => releaseSockets(client, 'abandoned'));
      releaseSockets(client, 'abandoned');
    };
  }
}

/**
 * A socket memjs has ended and moved off: it never touches it again. Wait for
 * the FIN to flush, because a destroy while end() is still shutting the socket
 * down leaves the handle open. A socket still connecting never flushes, so it
 * goes at once.
 */
function isAbandoned(socket: Socket, server: MemjsServer): boolean {
  return (
    socket.writableEnded &&
    currentSocket(server) !== socket &&
    (socket.writableFinished || socket.connecting)
  );
}

/**
 * Destroy a client's sockets: `'abandoned'` takes only those {@link isAbandoned}
 * accepts; `'all'` takes every one, for a client being discarded.
 */
function releaseSockets(client: MemjsClient, which: 'abandoned' | 'all'): void {
  for (const [socket, server] of clientSockets.get(client) ?? []) {
    if (which === 'abandoned' && !isAbandoned(socket, server)) continue;
    clientSockets.get(client)?.delete(socket);
    // memjs's 'close' and 'error' handlers act on the server's CURRENT socket,
    // not their own: fired from an abandoned one, they would disarm the live
    // request's timeout and orphan it. A discarded client's ops are failed by
    // the backend, not by memjs. Strip them before destroying.
    socket
      .removeAllListeners('close')
      .removeAllListeners('error')
      .on('error', () => {});
    // RST, not FIN: memjs already sent FIN, and a server that never closes its
    // side would otherwise hold the connection open. resetAndDestroy() on a
    // socket still connecting waits for the connect, so destroy that outright.
    if (socket.connecting) socket.destroy();
    else socket.resetAndDestroy();
  }
}

/**
 * Memcached backend using memjs (binary protocol, multi-server support).
 *
 * Node-runtime only, behind the `@cachekit-io/cachekit/backends/memcached`
 * subpath export. `memjs` is an optional peer dependency loaded lazily on
 * first use — install it alongside cachekit (`pnpm add memjs`); browser/edge
 * bundles that never import this subpath never see it.
 *
 * Capability surface matches cachekit-py's Memcached backend: base Backend
 * only, plus a directly-callable {@link refreshTTL}. It is deliberately NOT a
 * TTLBackend — the memcached protocol has no command to *read* a key's
 * remaining TTL (memjs exposes no meta protocol), so `getTTL` cannot exist.
 * `refreshTTL` ships anyway because the `touch` command makes it trivially
 * free, exactly mirroring py's `refresh_ttl`.
 *
 * Every operation settles within a deadline of
 * `tries × (connectTimeout + timeout) + (tries − 1) × 200 ms + 500 ms`, where
 * `tries` is `retries` (memjs counts total tries; 0 or 1 means one try) —
 * 3.5 s at the defaults. memjs can lose a request's timeout when it is sent
 * just after another request timed out, which would otherwise hang the op
 * forever against a server that stops answering. On expiry the op rejects
 * with `TimeoutError` (retryable, so retries and the circuit breaker see a
 * bounded failure) and the memjs client is discarded, so the next op starts
 * on a fresh connection. Every other op still running on that client rejects
 * with `TimeoutError` at the same moment, and the discarded client never
 * connects again. Connections memjs gives up on are reset rather than left
 * half-open, so a stalled server cannot accumulate them.
 *
 * @example
 * ```typescript
 * import { memcached } from '@cachekit-io/cachekit/backends/memcached';
 *
 * const backend = memcached({ servers: ['mc1:11211', 'mc2:11211'] });
 * await backend.set('key', new TextEncoder().encode('value'), 3600);
 * await backend.close();
 * ```
 */
export class MemcachedBackend implements Backend {
  private readonly config: Required<MemcachedBackendConfig>;
  /** Per-op bound — see the class docs. */
  private readonly deadlineMs: number;
  private closed = false;
  /** Memoized lazy client — memjs is an optional peer dep, imported on first use. */
  private clientPromise: Promise<MemjsClient> | null = null;
  /** Set once a failed memjs load has been logged; every command retries the load. */
  private loadFailureLogged = false;
  /** Ops awaiting memjs, each with its client, so a discard can fail its client's ops. */
  private readonly inFlight = new Set<{ client: MemjsClient; fail: () => void }>();

  /** Applied client-side to every key (like py) — exposed so secure caches
   * bind it into the AAD and interop mode can fail closed; see
   * Backend.keyPrefix for the contract. */
  get keyPrefix(): string {
    return this.config.keyPrefix;
  }

  constructor(config: MemcachedBackendConfig = {}) {
    const servers = config.servers ?? ['127.0.0.1:11211'];
    if (servers.length === 0) {
      throw new ConfigurationError('At least one Memcached server must be specified');
    }
    for (const server of servers) {
      const port = Number(server.slice(server.lastIndexOf(':') + 1));
      if (!server.includes(':') || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ConfigurationError(
          `Memcached server address must be 'host:port' with port 1-65535, got: ${server}`
        );
      }
    }

    this.config = {
      servers,
      defaultTtl: config.defaultTtl ?? 0,
      timeout: config.timeout ?? 1000,
      connectTimeout: config.connectTimeout ?? 2000,
      retries: config.retries ?? 1,
      keyPrefix: config.keyPrefix ?? '',
      maxItemSizeBytes: config.maxItemSizeBytes ?? DEFAULT_MAX_ITEM_SIZE_BYTES,
    };

    // Each try may spend connectTimeout connecting before memjs arms its
    // request timer, and every retry reconnects — leaving out the connect term
    // would cut off a try memjs is still running legitimately.
    const tries = Math.max(1, Math.ceil(this.config.retries));
    this.deadlineMs =
      tries * (this.config.connectTimeout + this.config.timeout) +
      (tries - 1) * MEMJS_RETRY_DELAY_MS +
      DEADLINE_SLACK_MS;
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.ensureNotClosed();
    this.validateKey(key);
    const { value } = await this.run('get', (client) => client.get(this.prefixedKey(key)));
    return value ? new Uint8Array(value) : null;
  }

  async set(key: string, value: Uint8Array, ttl?: number): Promise<void> {
    this.ensureNotClosed();
    this.validateKey(key);

    // Fail loudly BEFORE sending: the server rejects items over its -I limit
    // (default 1 MiB), and that rejection is easy to lose — guard client-side
    // so the caller can compress, shard, or switch backends (matches py).
    const maxSize = this.config.maxItemSizeBytes;
    if (maxSize > 0 && value.length > maxSize) {
      throw new BackendError(
        `Value for key '${key}' is ${value.length} bytes, which exceeds the Memcached max ` +
          `item size of ${maxSize} bytes. Enable compression, use a larger-payload backend ` +
          `(Redis/SaaS/File), or raise both the server's -I limit and maxItemSizeBytes.`,
        'permanent'
      );
    }

    const effectiveTtl = ttl ?? this.config.defaultTtl;
    const expires =
      effectiveTtl > 0 ? Math.min(Math.max(1, Math.floor(effectiveTtl)), MAX_MEMCACHED_TTL) : 0;

    await this.run('set', (client) =>
      client.set(this.prefixedKey(key), Buffer.from(value), { expires })
    );
  }

  async delete(key: string): Promise<boolean> {
    this.ensureNotClosed();
    this.validateKey(key);
    return this.run('delete', (client) => client.delete(this.prefixedKey(key)));
  }

  /** Memcached has no native EXISTS command; GET and check for null (matches py). */
  async exists(key: string): Promise<boolean> {
    this.ensureNotClosed();
    this.validateKey(key);
    const { value } = await this.run('exists', (client) => client.get(this.prefixedKey(key)));
    return value !== null;
  }

  /**
   * Refresh a key's TTL via the memcached `touch` command. Returns false when
   * the key doesn't exist. TTLs are clamped to the 30-day maximum like `set`.
   *
   * This is the ONLY half of TTLBackend memcached can ship (see class docs) —
   * it is a plain method, not a TTLBackend implementation, so capability
   * checks (`'getTTL' in backend`) correctly exclude this backend. Throws on
   * ttl <= 0 per the ts-wide refreshTTL contract (py's refresh_ttl(0) means
   * "make permanent"; ts rejects non-positive TTLs on every backend so
   * swapping backends never changes zero-semantics).
   */
  async refreshTTL(key: string, ttl: number): Promise<boolean> {
    this.ensureNotClosed();
    this.validateKey(key);

    const seconds = Math.floor(ttl);
    if (seconds <= 0) {
      throw new BackendError(
        `Memcached refreshTTL requires ttl >= 1 second, got ${ttl}`,
        'permanent'
      );
    }

    return this.run('refreshTTL', (client) =>
      client.touch(this.prefixedKey(key), Math.min(seconds, MAX_MEMCACHED_TTL))
    );
  }

  /**
   * Backend.validateKey capability — rejects a key over the protocol's
   * 250-byte limit (key prefix included), before anything is sent. The
   * server answers such a key with "Invalid arguments" and then closes the
   * connection, stranding any request queued behind it on that socket.
   * Every operation also checks, for callers that use the backend directly.
   */
  validateKey(key: string): void {
    const bytes = Buffer.byteLength(this.prefixedKey(key));
    if (bytes > MAX_KEY_BYTES) {
      throw new BackendError(
        `Memcached key is ${bytes} bytes (key prefix included), over the protocol limit of ` +
          `${MAX_KEY_BYTES} bytes. Shorten or hash the key, or use a backend without this limit.`,
        'permanent'
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.clientPromise) {
      // quit() flushes outstanding requests before closing (vs close()'s abort).
      const client = await this.clientPromise.catch(() => null);
      if (client) {
        client.quit();
        releaseSockets(client, 'abandoned');
      }
    }
  }

  // ==================== private ====================

  /**
   * Run one memjs call, bounded by the per-op deadline. On expiry, reject with
   * TimeoutError and discard the client: its sockets may carry the stale
   * close handler and timeout state that lost the request.
   */
  private async run<T>(operation: string, call: (client: MemjsClient) => Promise<T>): Promise<T> {
    const clientPromise = this.getClient();
    const client = await clientPromise;

    let reject!: (error: Error) => void;
    const deadline = new Promise<never>((_, rejectDeadline) => {
      reject = rejectDeadline;
    });
    const op = {
      client,
      fail: () =>
        reject(
          new TimeoutError(
            `Memcached ${operation} timed out: its connection was reset when another ` +
              `operation hit the ${this.deadlineMs}ms deadline`
          )
        ),
    };
    const timer = setTimeout(() => {
      reject(
        new TimeoutError(
          `Memcached ${operation} timed out: no response within ${this.deadlineMs}ms`
        )
      );
      this.discardClient(clientPromise, client);
    }, this.deadlineMs);
    this.inFlight.add(op);

    try {
      return await Promise.race([call(client), deadline]);
    } catch (error) {
      if (error instanceof TimeoutError) throw error;
      throw this.wrapError(operation, error);
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(op);
    }
  }

  private discardClient(clientPromise: Promise<MemjsClient>, client: MemjsClient): void {
    // A concurrent op may already have replaced it; never discard the new one.
    if (this.clientPromise === clientPromise) this.clientPromise = null;
    discardedClients.add(client);
    releaseSockets(client, 'all');
    // Destroying a socket also clears memjs's request timer on it, so an op
    // still on this client would otherwise wait out its own deadline.
    for (const op of this.inFlight) {
      if (op.client === client) op.fail();
    }
  }

  private prefixedKey(key: string): string {
    return this.config.keyPrefix ? `${this.config.keyPrefix}${key}` : key;
  }

  private getClient(): Promise<MemjsClient> {
    this.clientPromise ??= (async () => {
      let memjs: typeof import('memjs');
      try {
        memjs = await import('memjs');
      } catch (error) {
        this.clientPromise = null; // don't cache the failure
        const failure = new ConfigurationError(
          "The Memcached backend requires the optional peer dependency 'memjs'. " +
            'Install it alongside @cachekit-io/cachekit: pnpm add memjs (or npm install memjs).',
          { cause: error }
        );
        // A cache with degradation on swallows the per-command errors, so
        // this line is the only trace; once, because every command retries.
        // Fixed text only: the cause is whatever loading memjs threw, and a
        // logger would print it. Callers still get it on the rejection.
        if (!this.loadFailureLogged) {
          this.loadFailureLogged = true;
          logError(`[cachekit] ${failure.message}`);
        }
        throw failure;
      }
      // memjs timeouts are in (fractional) seconds; cachekit config is ms.
      const client = memjs.Client.create(this.config.servers.join(','), {
        expires: 0, // per-op expires is always passed explicitly in set()
        timeout: this.config.timeout / 1000,
        conntimeout: this.config.connectTimeout / 1000,
        retries: this.config.retries,
      });
      trackSockets(client);
      return client;
    })();
    return this.clientPromise;
  }

  private ensureNotClosed(): void {
    if (this.closed) {
      throw new BackendError('Memcached backend is closed', 'permanent');
    }
  }

  private wrapError(operation: string, error: unknown): Error {
    if (error instanceof Error) {
      if (error.message.includes('timed out') || error.message.includes('timeout')) {
        return new TimeoutError(`Memcached ${operation} timed out: ${error.message}`, {
          cause: error,
        });
      }
      return new BackendError(`Memcached ${operation} failed: ${error.message}`, 'transient', {
        cause: error,
      });
    }
    return new BackendError(`Memcached ${operation} failed: Unknown error`);
  }
}

/**
 * Factory function to create a Memcached backend.
 *
 * @example
 * ```typescript
 * import { memcached } from '@cachekit-io/cachekit/backends/memcached';
 *
 * const backend = memcached({
 *   servers: ['127.0.0.1:11211'],
 *   keyPrefix: 'myapp:',
 * });
 * ```
 */
export function memcached(config: MemcachedBackendConfig = {}): MemcachedBackend {
  return new MemcachedBackend(config);
}
