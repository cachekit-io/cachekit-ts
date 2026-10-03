// Local TLS fake of the CacheKit SaaS data plane for the per-runtime probes.
// run.mjs starts one per probe.
//
// It answers in the shapes the CachekitIO backend reads (protocol spec/saas-api.md):
// GET 200 octet-stream | 404, HEAD 200 | 404 (the `exists` route), PUT 200 {"success":true},
// DELETE 200 | 404. What it imitates of the real edge, because each changes what a client's
// connection pool does:
// - ALPN offers h2 AND http/1.1, so each runtime's fetch picks the protocol it prefers.
// - No Keep-Alive hint on http/1.1 responses (the edge sends none). Node's http server
//   writes `Keep-Alive: timeout=N` whenever keepAliveTimeout is non-zero, and undici then
//   trusts that hint over its own 4 s default; so keepAliveTimeout is 0 and the 400 s idle
//   limit is the socket timeout instead.
// - Idle connections are held 400 s, the edge's documented idle limit.
// - TCP_NODELAY on accepted sockets, as edge servers set it. Without it, the server's TLS 1.3
//   NewSessionTicket write and its first response write meet Nagle's algorithm on one side
//   and the client's delayed ACK on the other: a ~40 ms stall on every new http/1.1
//   connection that belongs to this fake, not to the runtime under test.
// - HEAD is answered like the SaaS `exists` route. headCl 1: the Content-Length and
//   Content-Type of the GET-equivalent JSON body stay on the bodiless HEAD response, as a
//   framework that builds the JSON response and drops the body does. headCl 0: no
//   Content-Length. Clients treat the two differently, so every probe row records which.
//
// Counters live on a separate plain-HTTP control port (GET /stats, GET /reset): a different
// origin, so reading them never touches the connection pool being measured.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The name the SDK is configured with; probe.mjs routes it to the bench host. */
export const FAKE_NAME = 'api.cachekit.test';
/** Where the fake listens and the probes connect. Loopback unless overridden. */
export const BENCH_HOST = process.env.CACHEKIT_BENCH_HOST || '127.0.0.1';

const EXISTS_BODY = JSON.stringify({ exists: true });
const IDLE_MS = 400_000;

/**
 * Mint a throwaway self-signed certificate for FAKE_NAME and `host` with the openssl CLI.
 * Returns the PEMs and the path of the certificate (for NODE_EXTRA_CA_CERTS) plus a
 * cleanup that deletes the directory. The key never leaves the temp directory.
 */
export function mintCert(host = BENCH_HOST) {
  const dir = mkdtempSync(join(tmpdir(), 'cachekit-runtime-bench-'));
  const san = [`DNS:${FAKE_NAME}`, isIP(host) ? `IP:${host}` : `DNS:${host}`].join(',');
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
        `/CN=${FAKE_NAME}`,
        '-addext',
        `subjectAltName=${san}`,
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'pipe' }
    );
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('the runtime bench needs the openssl CLI to mint its TLS certificate', {
      cause: error,
    });
  }
  return {
    key: readFileSync(join(dir, 'key.pem')),
    cert: readFileSync(join(dir, 'cert.pem')),
    certPath: join(dir, 'cert.pem'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const listen = (server, host) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });

/** Start one fake. Each has its own counters, so concurrent probes need one each. */
export async function startFake({ key, cert, headCl, host = BENCH_HOST }) {
  if (headCl !== 0 && headCl !== 1) throw new Error(`headCl must be 0 or 1, got ${headCl}`);
  const store = new Map();
  const fresh = () => ({
    connections: 0,
    alpn: [],
    requests: 0,
    byVersion: {},
    serverIdleCloses: 0,
  });
  let stats = fresh();
  const sockets = new Set(); // so close() ends idle connections instead of waiting 400 s

  const server = http2.createSecureServer(
    { key, cert, allowHTTP1: true, ALPNProtocols: ['h2', 'http/1.1'] },
    (req, res) => {
      stats.requests++;
      stats.byVersion[req.httpVersion] = (stats.byVersion[req.httpVersion] ?? 0) + 1;
      const path = new URL(req.url, `https://${FAKE_NAME}`).pathname;
      const match = /^\/v1\/cache\/([^/]+)$/.exec(path);
      if (!match) return void res.writeHead(404).end();
      const cacheKey = decodeURIComponent(match[1]);
      const body = [];
      req.on('data', (chunk) => body.push(chunk));
      req.on('end', () => {
        const value = store.get(cacheKey);
        switch (req.method) {
          case 'GET':
            if (!value) return void res.writeHead(404).end();
            return void res
              .writeHead(200, {
                'content-type': 'application/octet-stream',
                'content-length': value.length,
              })
              .end(value);
          case 'HEAD':
            if (!value) return void res.writeHead(404).end();
            return void res
              .writeHead(
                200,
                headCl
                  ? {
                      'content-type': 'application/json',
                      'content-length': Buffer.byteLength(EXISTS_BODY),
                    }
                  : {}
              )
              .end();
          case 'PUT':
            store.set(cacheKey, Buffer.concat(body));
            return void res
              .writeHead(200, { 'content-type': 'application/json' })
              .end('{"success":true}');
          case 'DELETE':
            return void (store.delete(cacheKey)
              ? res.writeHead(200, { 'content-type': 'application/json' }).end('{"success":true}')
              : res
                  .writeHead(404, { 'content-type': 'application/json' })
                  .end('{"error":"Not Found"}'));
        }
        res.writeHead(405).end();
      });
    }
  );
  server.keepAliveTimeout = 0; // no Keep-Alive hint (see the header comment)
  server.setTimeout(IDLE_MS); // the idle limit, for h2 sessions and http/1.1 sockets alike
  server.on('connection', (socket) => socket.setNoDelay(true));
  server.on('secureConnection', (socket) => {
    stats.connections++;
    stats.alpn.push(socket.alpnProtocol || 'none');
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('timeout', () => stats.serverIdleCloses++); // http/1.1
  });
  // h2 idles on the session's own timer, which never fires the socket's 'timeout'.
  server.on('session', (session) => session.on('timeout', () => stats.serverIdleCloses++));
  const port = await listen(server, host);

  const control = http.createServer((req, res) => {
    if (req.url === '/reset') stats = fresh();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stats));
  });
  const ctlPort = await listen(control, host);

  return {
    headCl,
    port,
    ctlPort,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      control.closeAllConnections();
      await Promise.all([server, control].map((s) => new Promise((done) => s.close(done))));
    },
  };
}
