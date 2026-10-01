import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { memcached, type MemcachedBackend } from './memcached.js';
import { TimeoutError } from '../errors.js';
import { createCache } from '../intents.js';

/**
 * MemcachedBackend against a server that accepts connections and never
 * replies, using the real memjs client (memcached.test.ts mocks it).
 *
 * memjs 1.3.2 loses the timeout of a request sent just after another one
 * timed out: the timed-out socket's late 'close' handler disarms the timer
 * of whichever socket is current. Without the backend's per-op deadline the
 * second op below hangs forever, so every test carries its own timeout and
 * the unfixed build fails fast instead of hanging the run.
 */

const TIMEOUT = 100;
const CONNECT_TIMEOUT = 100;
const RETRIES = 2; // the backend default: memjs counts it as total tries
// The documented bound, computed independently of the implementation:
// tries × (connectTimeout + timeout) + (tries − 1) × memjs retry_delay + slack.
const DEADLINE = RETRIES * (CONNECT_TIMEOUT + TIMEOUT) + (RETRIES - 1) * 200 + 500;
// Timer and event-loop scheduling headroom on top of the deadline.
const SCHEDULING_MS = 250;

interface Stub {
  port: number;
  /** false: read and never reply. true: answer GET with a miss and SET with OK. */
  answering: boolean;
  close(): Promise<void>;
}

/**
 * A memcached binary-protocol stub. `closeDelayMs` makes it ignore the
 * client's FIN for that long, so a timed-out socket's 'close' lands late.
 */
async function startStub(closeDelayMs?: number): Promise<Stub> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: closeDelayMs !== undefined }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (closeDelayMs !== undefined) {
      socket.on('end', () => setTimeout(() => socket.end(), closeDelayMs));
    }
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      if (!stub.answering) return;
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 24 && buffered.length >= 24 + buffered.readUInt32BE(8)) {
        const opcode = buffered[1];
        const reply = Buffer.alloc(24);
        reply[0] = 0x81; // response magic
        reply[1] = opcode;
        reply.writeUInt16BE(opcode === 0x00 ? 0x0001 : 0x0000, 6); // GET → key not found
        buffered.copy(reply, 12, 12, 16); // opaque
        socket.write(reply);
        buffered = buffered.subarray(24 + buffered.readUInt32BE(8));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stub: Stub = {
    port: (server.address() as AddressInfo).port,
    answering: false,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  return stub;
}

async function elapsed(op: Promise<unknown>): Promise<{ error: unknown; ms: number }> {
  const start = Date.now();
  const error = await op.then(
    () => undefined,
    (e: unknown) => e
  );
  return { error, ms: Date.now() - start };
}

describe('MemcachedBackend against a stalled server', () => {
  let stub: Stub;
  let backend: MemcachedBackend;

  const open = async (closeDelayMs?: number) => {
    stub = await startStub(closeDelayMs);
    backend = memcached({
      servers: [`127.0.0.1:${stub.port}`],
      timeout: TIMEOUT,
      connectTimeout: CONNECT_TIMEOUT,
      retries: RETRIES,
    });
  };

  beforeEach(async () => {
    await open();
  });

  afterEach(async () => {
    await backend.close();
    await stub.close();
  });

  it(
    '(a) back-to-back gets with no gap both reject with TimeoutError',
    { timeout: 4 * DEADLINE },
    async () => {
      for (const key of ['a', 'b']) {
        const { error, ms } = await elapsed(backend.get(key));
        expect(error).toBeInstanceOf(TimeoutError);
        expect(ms).toBeLessThan(DEADLINE + SCHEDULING_MS);
      }
    }
  );

  it(
    '(b) a wrap() miss on createCache.production settles, its set included',
    { timeout: 15_000 },
    async () => {
      const cache = createCache.production({ backend, metrics: false, l1: { enabled: false } });
      const load = cache.wrap(async (id: number) => `value-${id}`, { namespace: 'stall', ttl: 60 });

      // Graceful degradation serves the computed value once the backend fails.
      await expect(load(1)).resolves.toBe('value-1');
    }
  );

  it(
    '(c) a late close still lets every op settle within the deadline',
    { timeout: 15 * DEADLINE },
    async () => {
      await backend.close();
      await stub.close();
      // Each timed-out socket's 'close' lands 650 ms (6.5 × timeout) after it
      // gave up, which is in the middle of a later op.
      await open(650);

      const ops: Array<[string, () => Promise<unknown>]> = [
        ['get', () => backend.get('k')],
        ['set', () => backend.set('k', new Uint8Array([1]), 60)],
        ['delete', () => backend.delete('k')],
        ['exists', () => backend.exists('k')],
        ['refreshTTL', () => backend.refreshTTL('k', 60)],
      ];
      for (const [name, op] of [...ops, ...ops]) {
        const { error, ms } = await elapsed(op());
        expect(error, name).toBeInstanceOf(TimeoutError);
        expect(ms, name).toBeLessThan(DEADLINE + SCHEDULING_MS);
      }
    }
  );

  it(
    '(d) after the stall ends, the next 10 ops succeed on a fresh client',
    { timeout: 4 * DEADLINE },
    async () => {
      for (const key of ['a', 'b']) {
        await expect(backend.get(key)).rejects.toBeInstanceOf(TimeoutError);
      }

      stub.answering = true;
      for (let i = 0; i < 5; i++) {
        await expect(backend.get(`k${i}`)).resolves.toBeNull();
        await expect(backend.set(`k${i}`, new Uint8Array([i]), 60)).resolves.toBeUndefined();
      }
    }
  );
});
