/**
 * Local TLS fake of the CacheKit SaaS data plane, for counting what the SDK
 * puts on the wire. It answers only the routes these tests drive, in the
 * shapes the CachekitIO backend reads (protocol spec/saas-api.md); anything
 * else is still counted, then answered 405:
 *
 *   GET    /v1/cache/{key}       200 octet-stream | 404
 *   PUT    /v1/cache/{key}       200 {"success":true}
 *   POST   /v1/cache/{key}/lock  200 {"lock_id": "<id>" | null}
 *   DELETE /v1/cache/{key}/lock  200 {"success":true}
 *
 * Two keys exist only to test redirect handling, for any method:
 * `redirect-{3xx}` answers that status with `Location: /v1/cache/redirected`,
 * and `redirected` answers 200. A client that follows a redirect therefore
 * succeeds and shows a `redirected` request.
 *
 * The backend refuses private IPs and plain http (url-validator.ts), so the
 * fake serves a throwaway self-signed certificate for FAKE_HOST, and
 * startFakeSaas() resolves FAKE_HOST to 127.0.0.1 and trusts that
 * certificate for this thread only. Every connection then goes through the
 * real global fetch dispatcher, which is the thing being measured.
 */
import dns from 'node:dns';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';

export const FAKE_HOST = 'api.cachekit.test';

export interface FakeSaas {
  /** Base URL for CachekitIOBackendConfig.apiUrl (needs allowCustomHost). */
  readonly url: string;
  /** Distinct TLS connections that carried a request since the last resetCounters(). */
  connections(): number;
  /** Requests received since the last resetCounters(), as `METHOD route`
   * (route: cache | lock | redirect | redirected). */
  requests(): string[];
  /** Zero both counters; stored entries, held locks and open connections stay. */
  resetCounters(): void;
  close(): Promise<void>;
}

// One certificate per test module: minting is a subprocess, the listener per test is not.
let minted: { key: Buffer; cert: Buffer } | undefined;

function selfSignedCert(): { key: Buffer; cert: Buffer } {
  if (minted) return minted;
  const dir = mkdtempSync(join(tmpdir(), 'cachekit-fake-saas-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/CN=${FAKE_HOST}`,
        '-addext',
        `subjectAltName=DNS:${FAKE_HOST}`,
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'pipe' }
    );
    minted = { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
    return minted;
  } catch (error) {
    throw new Error(
      'fake-saas needs the openssl CLI to mint its throwaway TLS certificate; install openssl',
      { cause: error }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function startFakeSaas(): Promise<FakeSaas> {
  if (typeof tls.setDefaultCACertificates !== 'function') {
    throw new Error(
      `fake-saas needs tls.setDefaultCACertificates (Node >= 22.19 or >= 24.5); this is ${process.version}`
    );
  }
  const { key, cert } = selfSignedCert();

  const store = new Map<string, Buffer>();
  const locks = new Map<string, string>();
  let lockSeq = 0;
  let sockets = new Set<Socket>();
  let requests: string[] = [];

  const server = https.createServer({ key, cert, keepAliveTimeout: 60_000 }, (req, res) => {
    const path = new URL(req.url ?? '/', `https://${FAKE_HOST}`).pathname;
    const match = /^\/v1\/cache\/([^/]+)(\/lock)?$/.exec(path);
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const cacheKey = decodeURIComponent(match[1]);
    const redirectStatus = /^redirect-(3\d\d)$/.exec(cacheKey)?.[1];
    let route = match[2] ? 'lock' : 'cache';
    if (route === 'cache' && redirectStatus) route = 'redirect';
    if (route === 'cache' && cacheKey === 'redirected') route = 'redirected';
    requests.push(`${req.method} ${route}`);
    sockets.add(req.socket);

    const body: Buffer[] = [];
    req.on('data', (chunk: Buffer) => body.push(chunk));
    req.on('end', () => {
      const json = (status: number, value: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));

      if (route === 'redirect') {
        return res.writeHead(Number(redirectStatus), { location: '/v1/cache/redirected' }).end();
      }
      if (route === 'redirected') return res.writeHead(200).end('followed');
      if (route === 'lock') {
        if (req.method === 'POST') {
          if (locks.has(cacheKey)) return json(200, { lock_id: null });
          const lockId = `lock-${++lockSeq}`;
          locks.set(cacheKey, lockId);
          return json(200, { lock_id: lockId });
        }
        if (req.method === 'DELETE') {
          if (locks.get(cacheKey) === req.headers['x-cachekit-lock-id']) locks.delete(cacheKey);
          return json(200, { success: true });
        }
      } else {
        const value = store.get(cacheKey);
        switch (req.method) {
          case 'GET':
            if (!value) return res.writeHead(404).end();
            return res
              .writeHead(200, {
                'content-type': 'application/octet-stream',
                'content-length': value.length,
              })
              .end(value);
          case 'PUT':
            store.set(cacheKey, Buffer.concat(body));
            return json(200, { success: true });
        }
      }
      res.writeHead(405).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error(`fake-saas: expected a TCP listener address, got ${String(address)}`);
  }
  const { port } = address;

  // Route FAKE_HOST to the listener and trust its certificate; everything
  // else resolves and verifies as normal. Both are undone by close().
  const realLookup = dns.lookup;
  const patchedLookup = ((hostname: string, options: unknown, callback: unknown) => {
    if (hostname !== FAKE_HOST) {
      return (realLookup as (...args: unknown[]) => void)(hostname, options, callback);
    }
    const cb = (typeof options === 'function' ? options : callback) as (
      err: null,
      address: string | { address: string; family: number }[],
      family?: number
    ) => void;
    const all = typeof options === 'object' && options !== null && 'all' in options && options.all;
    if (all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
    else cb(null, '127.0.0.1', 4);
  }) as typeof dns.lookup;
  dns.lookup = patchedLookup;
  const realCAs = tls.getCACertificates('default');
  tls.setDefaultCACertificates([...realCAs, cert.toString()]);

  return {
    url: `https://${FAKE_HOST}:${port}`,
    connections: () => sockets.size,
    requests: () => [...requests],
    resetCounters: () => {
      sockets = new Set();
      requests = [];
    },
    close: async () => {
      dns.lookup = realLookup;
      tls.setDefaultCACertificates(realCAs);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
