// Client wall time of cachekit.io operations, one JSON line per request.
//
//   CACHEKIT_API_KEY=… CACHEKIT_API_URL=https://api.dev.cachekit.io \
//     node bench/live/wall-time-probe.mjs --run R1 --phase aa-warm --out rows.jsonl \
//     --ledger keys.txt --samples 40 --block 10 --ops put,get,delete
//
// Runs unchanged under node or bun (`bun bench/live/wall-time-probe.mjs …`), against this
// workspace's build (`pnpm build` first). It times the real SDK — `createCache` over the
// built-in CachekitIO backend, L1 off, no retry, no circuit breaker, degradation off so an
// error reaches the caller — and appends one JSON object per request to `--out`. Every row
// names the runtime and its version and the SDK version.
//
// Two slots, A and B, run the same arm (`sdk`) in ABBA blocks, so their difference is the
// run's A/A floor. Each block gets a new cache and, as far as the runtime lets a script
// choose, a new connection: one connection for the whole run would put every request on
// the edge server it first landed on, a fixed offset that resampling blocks cannot see.
// After a block's samples, one `GET /cdn-cgi/trace` (answered by the edge without the
// Worker, so its reused-connection wait is the round-trip floor) reports the protocol the
// connection speaks; then the connection is dropped — on node by replacing fetch's global
// dispatcher, on runtimes without one by sending that trace with `Connection: close`. The
// next block opens with one GET miss (a `warmup` row) that absorbs the handshake. A
// warm-up row whose `connection_new` is false means the drop did not take.
//
// The SDK calls the runtime's global fetch, so this script wraps it. The wrapper reads each
// response's status, `cf-ray` and time to headers without touching the body, and it is
// also where the rails are enforced, below every code path that could send a request:
// - it writes, so it runs only against WRITABLE_HOSTS, an allowlist; every request's
//   host is checked again before it is sent;
// - a PUT is sent only if its key is already in `--ledger` (appended and fsynced first)
//   and its `X-CacheKit-TTL` is at most 900 s, so a crash leaves only keys the ledger
//   names and the TTL removes;
// - redirects are not followed, so a 3xx can never carry a request to an unchecked host;
// - total requests, warm-ups and traces included, are capped (`--max-ops`, at most 2000)
//   and paced under `--max-per-min`;
// - the API key is read from CACHEKIT_API_KEY only, and never reaches argv, stdout or a
//   row; error messages are scrubbed of it.
// After each op its row is written, then judged: a 429, a 503, any other 4xx but 404
// (a 3xx included), or a transport error stops the run (exit 3). Other 5xx are recorded
// and the run goes on, up to 5, so a server's sporadic errors are counted rather than
// ending it. Nothing is retried, and every op must send exactly one request.
//
// A new connection is detected from outside the HTTP stack, by diffing this process's
// established TCP sockets to port 443 before and after each request (/proc, Linux only;
// null elsewhere). Fetch exposes no HTTP version, so `http_version` on a cache row is the
// one the opening trace reported for this process; each block's trace row carries what
// its own connection reported.
//
// Exit codes: 0 done, 1 fault, 2 usage, 3 stopped by a rail (never retry into it).
import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeSync,
} from 'node:fs';
import { loadavg } from 'node:os';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

import { createCache } from '../../dist/index.js';
import { VERSION } from '../../dist/version.js';

/** The only hosts this harness may send to. */
const WRITABLE_HOSTS = ['api.dev.cachekit.io'];
const MAX_TTL_S = 900;
const MAX_OPS = 2000;
/** 5xx responses (503 excepted) a run records before it stops. */
const MAX_SERVER_ERRORS = 5;
const ABBA = [0, 1, 1, 0];
const SLOTS = ['A', 'B'];
const OPS = ['put', 'get', 'head', 'delete'];
const KEEP_HEADERS = [
  'cf-ray',
  'content-length',
  'x-cachekit-store-source',
  'x-cachekit-l0-status',
  'x-cachekit-freshness',
  'ratelimit-remaining',
  'retry-after',
];
const RUNTIME = process.versions.bun ? 'bun' : 'node';
const RUNTIME_VERSION = process.versions.bun ?? process.versions.node;

const USAGE = `usage: wall-time-probe.mjs --run ID --phase NAME --out FILE --ledger FILE
  [--key-prefix P] [--samples N per arm] [--block N]
  [--gap-ms MS] [--ops put,get,head,delete] [--size BYTES] [--ttl-s S]
  [--max-per-min N] [--max-ops N] [--user-agent UA]
env: CACHEKIT_API_KEY, CACHEKIT_API_URL`;

/** A rail refused the run: exit 3, never retried. */
class Stop extends Error {}

// ── Arguments ────────────────────────────────────────────────────────────────

function parse(argv) {
  const str = (d) => ({ type: 'string', ...(d === undefined ? {} : { default: d }) });
  const { values: v } = parseArgs({
    args: argv,
    strict: true,
    options: {
      run: str(),
      phase: str(),
      out: str(),
      ledger: str(),
      'key-prefix': str(`wall-time-probe-${Math.floor(Date.now() / 1000)}`),
      samples: str('20'),
      block: str('10'),
      'gap-ms': str('0'),
      ops: str('put,get,delete'),
      size: str('1024'),
      'ttl-s': str('900'),
      'max-per-min': str('60'),
      'max-ops': str('400'),
      'user-agent': str(),
    },
  });
  for (const k of ['run', 'phase', 'out', 'ledger']) {
    if (!v[k]) throw new Error(`--${k} is required`);
  }
  const num = (k) => {
    if (!/^\d+$/.test(v[k])) throw new Error(`--${k}: not a whole number: ${v[k]}`);
    return Number(v[k]);
  };
  const a = {
    run: v.run,
    phase: v.phase,
    out: v.out,
    ledger: v.ledger,
    keyPrefix: v['key-prefix'],
    samples: num('samples'),
    block: num('block'),
    gapMs: num('gap-ms'),
    ops: v.ops.split(','),
    size: num('size'),
    ttl: num('ttl-s'),
    maxPerMin: num('max-per-min'),
    maxOps: num('max-ops'),
    userAgent: v['user-agent'],
  };
  if (a.ops.some((op) => !OPS.includes(op))) throw new Error(`--ops: one of ${OPS.join(',')}`);
  if (!a.block || !a.samples || a.samples % a.block) {
    throw new Error('--samples must be a positive multiple of --block');
  }
  if (!a.ttl || a.ttl > MAX_TTL_S) throw new Error(`--ttl-s must be 1..${MAX_TTL_S}`);
  if (a.maxOps > MAX_OPS || !a.maxPerMin) {
    throw new Error(`--max-ops must be at most ${MAX_OPS}, --max-per-min positive`);
  }
  if (a.userAgent !== undefined && !/^[\x21-\x7e][\x20-\x7e]*$/.test(a.userAgent)) {
    throw new Error('--user-agent must be printable ASCII');
  }
  // Per block: its samples, one warm-up and one trace; plus the opening trace.
  const blocks = (2 * a.samples) / a.block;
  const total = 2 * a.samples * a.ops.length + 2 * blocks + 1;
  if (total > a.maxOps)
    throw new Error(`this run sends ${total} requests, over --max-ops ${a.maxOps}`);
  return a;
}

// ── Wire: the wrapped global fetch ───────────────────────────────────────────

/**
 * Wraps globalThis.fetch: enforces the rails on every request before it is sent, and
 * records what came back. The response is returned untouched, body unread, so the SDK
 * behaves exactly as it does unwrapped.
 */
function wire({ apiKey, ledgered, maxOps, userAgent }) {
  const realFetch = globalThis.fetch;
  const state = { sent: 0, exchanges: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    if (!WRITABLE_HOSTS.includes(url.hostname.replace(/\.$/, '')) || url.protocol !== 'https:') {
      throw new Stop(`refused ${method} to ${url.host}: not an allowlisted https host`);
    }
    if (method === 'PUT') {
      const key = decodeURIComponent(url.pathname.slice('/v1/cache/'.length));
      if (!ledgered.has(key)) throw new Stop(`refused PUT of a key not in the ledger`);
      const ttl = Number(headers.get('x-cachekit-ttl'));
      if (!(ttl > 0 && ttl <= MAX_TTL_S)) throw new Stop(`refused PUT with TTL ${ttl}`);
    }
    if (++state.sent > maxOps) throw new Stop(`request ${state.sent} is over --max-ops ${maxOps}`);
    if (userAgent !== undefined) headers.set('user-agent', userAgent);
    const ex = { method, path: url.pathname, ua: headers.get('user-agent'), status: null };
    state.exchanges.push(ex);
    const t0 = performance.now();
    try {
      const res = await realFetch(input, { ...init, headers, redirect: 'manual' });
      ex.ttfb = performance.now() - t0;
      ex.status = res.status;
      ex.names = [...res.headers.keys()].sort();
      ex.headers = Object.fromEntries(
        KEEP_HEADERS.filter((h) => res.headers.has(h)).map((h) => [h, res.headers.get(h)])
      );
      return res;
    } catch (error) {
      ex.error = scrub(String(error?.cause ?? error), apiKey);
      throw error;
    }
  };
  return state;
}

function scrub(text, apiKey) {
  return apiKey ? text.replaceAll(apiKey, '***') : text;
}

/**
 * Node's fetch keeps its pool on the global dispatcher, under the symbol undici's
 * setGlobalDispatcher uses (`.2` from undici 7, `.1` before); null on other runtimes.
 */
function dispatcherSymbol() {
  for (const name of ['undici.globalDispatcher.2', 'undici.globalDispatcher.1']) {
    const sym = Symbol.for(name);
    const d = globalThis[sym];
    if (d?.constructor?.name === 'Agent' && typeof d.close === 'function') return sym;
  }
  return null;
}

/** Replace node's global dispatcher, closing the old one's connections. A fresh Agent of
 * the same class has the same defaults (allowH2 included). */
async function dropDispatcher(sym) {
  const old = globalThis[sym];
  globalThis[sym] = new old.constructor();
  await old.close();
}

// ── Measurement ──────────────────────────────────────────────────────────────

/** Inodes of this process's established TCP sockets to port 443; null off Linux. */
function tlsSockets() {
  let fds;
  try {
    fds = readdirSync('/proc/self/fd');
  } catch {
    return null;
  }
  const mine = new Set();
  for (const fd of fds) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/self/fd/${fd}`));
      if (m) mine.add(m[1]);
    } catch (error) {
      // ENOENT: closed between readdir and readlink. Anything else would undercount silently.
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const out = new Set();
  for (const table of ['/proc/self/net/tcp', '/proc/self/net/tcp6']) {
    let text;
    try {
      text = readFileSync(table, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      // rem_address ends in the hex port; state 01 is ESTABLISHED.
      if (c.length > 9 && c[2].endsWith(':01BB') && c[3] === '01' && mine.has(c[9])) out.add(c[9]);
    }
  }
  return out;
}

function newConnection(before, after) {
  if (!before || !after) return null;
  // With no socket open before, the request opened one, even if `Connection: close`
  // shut it before `after` was read.
  return before.size === 0 || [...after].some((s) => !before.has(s));
}

const ms = (v) => (v === undefined || v === null ? null : Math.round(v * 100) / 100);
const isoNow = () => new Date().toISOString();
const shortId = () => randomBytes(4).toString('hex');
const sleep = (msec) => new Promise((r) => setTimeout(r, msec));

/** Run `call` with its requests recorded; returns the timing and what went over the wire. */
async function timed(state, call) {
  state.exchanges = [];
  const before = tlsSockets();
  const started = isoNow();
  const t0 = performance.now();
  let result;
  let error = null;
  try {
    result = await call();
  } catch (e) {
    error = e;
  }
  const total = performance.now() - t0;
  const ended = isoNow();
  const connectionNew = newConnection(before, tlsSockets());
  // The backend wraps whatever fetch throws, a refusal included: find it in the chain.
  for (let e = error; e; e = e.cause) if (e instanceof Stop) throw e;
  return { started, ended, total, result, error, connectionNew, exchanges: state.exchanges };
}

// ── Output ───────────────────────────────────────────────────────────────────

class Sink {
  constructor(args, host, apiKey) {
    this.args = args;
    this.host = host;
    this.apiKey = apiKey;
    this.out = openSync(args.out, 'a');
    this.ledgerFd = openSync(args.ledger, 'a');
    this.ledgered = new Set();
    this.serverErrors = 0;
    this.protocol = null;
    // Block numbers restart at 0 in every process: this tells two runs of one phase apart.
    this.invocation = `${Date.now()}-${process.pid}`;
  }

  /** Record a key, synced, before the request that writes it is sent. */
  ledger(key) {
    writeSync(this.ledgerFd, `${key}\n`);
    fsyncSync(this.ledgerFd);
    this.ledgered.add(key);
  }

  /** Write one row, then apply the stop rules to it. */
  row({ label, slot, block, sample, key, t, http }) {
    const ex = t.exchanges.length === 1 ? t.exchanges[0] : null;
    const status = ex?.status ?? null;
    const reused = t.connectionNew === false;
    const version = http ?? this.protocol;
    const errormsg = t.error
      ? scrub(String(t.error.message ?? t.error), this.apiKey)
      : t.exchanges.length !== 1
        ? `sent ${t.exchanges.length} requests, expected 1`
        : null;
    const row = {
      session_started: t.started,
      session_ended: t.ended,
      host: this.host,
      label,
      method: ex?.method ?? null,
      path_class: label === 'trace' ? 'trace' : 'cache',
      key,
      status,
      http_version: version,
      protocol: version === 'HTTP/2' ? 'h2' : version === 'HTTP/1.1' ? 'h1' : null,
      connection_new: t.connectionNew,
      ttfb_ms: ms(ex?.ttfb),
      // Request sent -> headers in, comparable to curl's `wait` only on a reused connection.
      wait_ms: reused ? ms(ex?.ttfb) : null,
      total_ms: ms(t.total),
      exitcode: errormsg ? 1 : 0,
      errormsg: [errormsg, ex?.error].filter(Boolean).join(': ') || null,
      headers: ex?.headers ?? {},
      header_names: ex?.names ?? [],
      ray_id: ex?.headers?.['cf-ray'] ?? null,
      user_agent: ex?.ua ?? null,
      run: this.args.run,
      env: 'dev',
      phase: this.args.phase,
      client: 'ts',
      client_version: VERSION,
      runtime: RUNTIME,
      runtime_version: RUNTIME_VERSION,
      arm: slot ? 'sdk' : null,
      slot,
      block,
      sample,
      size: this.args.size,
      invocation: this.invocation,
      loadavg: loadavg(),
    };
    writeSync(this.out, `${JSON.stringify(row)}\n`);
    const f = (v) => (v === null ? '-' : v.toFixed(1));
    console.log(
      `  ${this.args.phase.padEnd(10)} ${slot ?? '-'} ${RUNTIME.padEnd(4)} ${label.padEnd(10)} ` +
        `${String(row.method).padEnd(6)} ${String(status ?? '-').padStart(4)} ` +
        `new=${String(t.connectionNew).padEnd(5)} total=${f(row.total_ms).padStart(7)} ` +
        `ttfb=${f(row.ttfb_ms).padStart(7)} ray=${row.ray_id ?? '-'}`
    );
    this.judge(row, t.exchanges);
  }

  /** The stop rules: every request the op sent, and the op's own outcome. */
  judge(row, exchanges) {
    if (exchanges.length !== 1) throw new Stop(`${row.label}: ${row.errormsg}`);
    const s = exchanges[0].status;
    if (s !== null && ((s >= 200 && s < 300) || s === 404) && !row.exitcode) return;
    // A 503 is this service's limiter or fail-closed verdict: stop. Any other 5xx is
    // counted and the run goes on, so sporadic server errors become a measured rate.
    if (s !== null && s >= 500 && s !== 503 && this.serverErrors < MAX_SERVER_ERRORS) {
      this.serverErrors += 1;
      return;
    }
    throw new Stop(`${row.method} in ${row.label}: status ${s}, ${row.errormsg}`);
  }

  close() {
    closeSync(this.out);
    closeSync(this.ledgerFd);
  }
}

// ── Schedule ─────────────────────────────────────────────────────────────────

/** Paces request starts at most `perMin` per minute. */
function pacer(perMin) {
  const every = 60_000 / perMin;
  let next = performance.now();
  return async () => {
    const wait = next - performance.now();
    if (wait > 0) await sleep(wait);
    next = Math.max(performance.now(), next) + every;
  };
}

const LABELS = {
  put: () => 'put',
  get: (r) => (r === null || r === undefined ? 'get-miss' : 'get-hit'),
  head: (r) => (r ? 'head-hit' : 'head-miss'),
  delete: (r) => (r ? 'delete' : 'delete-miss'),
};

async function trace(sink, state, apiUrl, close, where) {
  const t = await timed(state, async () => {
    const res = await fetch(
      `${apiUrl}/cdn-cgi/trace`,
      close ? { headers: { Connection: 'close' } } : {}
    );
    return res.text();
  });
  const http = /^http=(\S+)$/m.exec(t.result ?? '')?.[1];
  const version = http === 'http/2' ? 'HTTP/2' : http === 'http/1.1' ? 'HTTP/1.1' : (http ?? null);
  sink.row({ label: 'trace', key: '', t, http: version, ...where });
  return version;
}

/**
 * A trace, then drop its connection. Node drops by replacing its dispatcher (an HTTP/2
 * stream has no `Connection` header); other runtimes speak HTTP/1.1 here and close the
 * connection after the trace's response.
 */
async function traceAndDrop(sink, state, apiUrl, where) {
  const http = await trace(sink, state, apiUrl, RUNTIME !== 'node', where);
  if (RUNTIME === 'node') {
    const sym = dispatcherSymbol();
    if (sym) await dropDispatcher(sym);
    else console.error('wall-time-probe: no global dispatcher found; connections are not rotated');
  }
  return http;
}

async function schedule(sink, state, apiKey, apiUrl) {
  const a = sink.args;
  const pace = pacer(a.maxPerMin);
  const value = 'x'.repeat(a.size);
  const build = () =>
    createCache({
      backend: { apiKey, apiUrl, allowCustomHost: true },
      l1: { enabled: false },
      reliability: { degradation: false },
    });
  await pace();
  // The opening trace learns the protocol; dropping its connection makes block 0's
  // warm-up open one, like every other block's.
  sink.protocol = await traceAndDrop(sink, state, apiUrl, { slot: null, block: -1, sample: 0 });
  let counter = 0;
  let warmNew = 0;
  const blocks = (2 * a.samples) / a.block;
  for (let b = 0; b < blocks; b++) {
    const i = ABBA[b % 4];
    const slot = SLOTS[i];
    const cache = build();
    // Warm-up: one GET miss that writes nothing and absorbs the new connection's handshake.
    await pace();
    const warmKey = `${a.keyPrefix}:warmup${slot}:${shortId()}`;
    const w = await timed(state, () => cache.get(warmKey));
    warmNew += w.connectionNew ? 1 : 0;
    sink.row({ label: 'warmup', slot, block: b, sample: 0, key: warmKey, t: w });
    for (let s = 0; s < a.block; s++) {
      if (a.gapMs) await sleep(a.gapMs);
      counter += 1;
      const key = `${a.keyPrefix}:ts${slot}${counter}:${shortId()}`;
      for (const op of a.ops) {
        if (op === 'put') sink.ledger(key);
        await pace();
        const t = await timed(state, () => {
          if (op === 'put') return cache.set(key, value, { ttl: a.ttl });
          if (op === 'get') return cache.get(key);
          return op === 'head' ? cache.exists(key) : cache.delete(key);
        });
        sink.row({ label: LABELS[op](t.result), slot, block: b, sample: s, key, t });
      }
    }
    await cache.close();
    // The round-trip floor on this block's connection, after its samples so it never
    // warms one; then drop the connection so the next block opens its own.
    await pace();
    const http = await traceAndDrop(sink, state, apiUrl, { slot, block: b, sample: a.block });
    if (http !== sink.protocol) console.error(`wall-time-probe: block ${b} spoke ${http}`);
  }
  console.log(`warm-ups on a new connection: ${warmNew} of ${blocks}; ${state.sent} requests`);
}

async function main() {
  let args;
  try {
    args = parse(process.argv.slice(2));
  } catch (e) {
    console.error(`wall-time-probe: ${e.message}\n${USAGE}`);
    return 2;
  }
  const { CACHEKIT_API_KEY: apiKey, CACHEKIT_API_URL: rawUrl } = process.env;
  if (!apiKey || !rawUrl) {
    console.error(`wall-time-probe: set CACHEKIT_API_KEY and CACHEKIT_API_URL\n${USAGE}`);
    return 2;
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    console.error('wall-time-probe: CACHEKIT_API_URL is not a URL');
    return 2;
  }
  const host = url.hostname.replace(/\.$/, '');
  if (
    !WRITABLE_HOSTS.includes(host) ||
    url.protocol !== 'https:' ||
    url.port ||
    url.pathname !== '/'
  ) {
    console.error(
      `wall-time-probe: refusing ${url.host}: this harness writes and deletes keys, so it ` +
        `runs only against https://${WRITABLE_HOSTS.join(', https://')}`
    );
    return 2;
  }
  const apiUrl = `https://${host}`;
  let sink;
  try {
    sink = new Sink(args, host, apiKey);
  } catch (e) {
    console.error(`wall-time-probe: cannot open --out/--ledger: ${e.message}`);
    return 2;
  }
  const state = wire({
    apiKey,
    ledgered: sink.ledgered,
    maxOps: args.maxOps,
    userAgent: args.userAgent,
  });
  try {
    await schedule(sink, state, apiKey, apiUrl);
    return 0;
  } catch (e) {
    if (e instanceof Stop) {
      console.error(`wall-time-probe: STOPPED (no retry): ${scrub(e.message, apiKey)}`);
      return 3;
    }
    console.error(`wall-time-probe: ${scrub(String(e?.stack ?? e), apiKey)}`);
    return 1;
  } finally {
    sink.close();
  }
}

process.exitCode = await main();
