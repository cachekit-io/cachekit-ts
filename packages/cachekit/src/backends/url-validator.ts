import { ConfigurationError } from '../errors.js';

const ALLOWED_HOSTS = new Set(['api.cachekit.io', 'api.staging.cachekit.io']);

/**
 * Strict IPv4 dotted-decimal check, matching node:net's isIP(x) === 4
 * semantics (four octets, 0-255, no leading zeros). Local so the Workers
 * entrypoint needs no node:* builtins and no nodejs_compat flag.
 */
function isStrictIPv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  return parts.every(
    (part) =>
      /^\d{1,3}$/.test(part) &&
      Number(part) <= 255 &&
      // isIP rejects leading zeros (octal ambiguity): '01' invalid, '0' valid
      (part.length === 1 || part[0] !== '0')
  );
}

function isPrivateIPv4([a, b]: number[]): boolean {
  return (
    a === 127 || // 127.0.0.0/8
    a === 10 || // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) || // 169.254.0.0/16
    a === 0 // 0.0.0.0/8
  );
}

/**
 * The eight 16-bit groups of an IPv6 host as WHATWG `URL` serializes it:
 * lowercase hex, at most one `::`, never a dotted quad.
 */
function ipv6Groups(bare: string): number[] {
  const [head, tail] = bare.split('::');
  const groups = (part: string) => (part ? part.split(':').map((g) => parseInt(g, 16)) : []);
  if (tail === undefined) return groups(head);
  const left = groups(head);
  const right = groups(tail);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

function isPrivateIPv6(g: number[]): boolean {
  const v4 = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return true; // ::ffff:0:0/96 IPv4-mapped
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return isPrivateIPv4(v4(g[6], g[7])); // ::ffff:0:0:0/96 IPv4-translated
  if (zero(0, 6)) return isPrivateIPv4(v4(g[6], g[7])); // ::/96 IPv4-compatible, incl. :: and ::1
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return isPrivateIPv4(v4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isPrivateIPv4(v4(g[1], g[2])); // 2002::/16 6to4
  // 64:ff9b:1::/48 local-use NAT64: never global, and it fixes no position for the embedded IPv4
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;
  if ((g[0] & 0xff80) === 0xfe80) return true; // fe80::/10 link-local, fec0::/10 site-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  return false;
}

function isPrivateIp(hostname: string): boolean {
  // Exact loopback names
  if (hostname === 'localhost' || hostname === 'localhost.') return true;

  // IPv6 (WHATWG keeps the brackets on the hostname)
  if (hostname.startsWith('[')) return isPrivateIPv6(ipv6Groups(hostname.slice(1, -1)));

  // IPv4 standard dotted-decimal (strict validation)
  if (isStrictIPv4(hostname)) return isPrivateIPv4(hostname.split('.').map(Number));

  // Reject hostnames that look numeric but bypass isIP (octal/hex/decimal encodings)
  // These resolve to IPs at the OS level even though isIP doesn't recognize them
  if (/^[\d.ox]+$/i.test(hostname)) return true;

  return false;
}

/**
 * Validate a CachekitIO API URL and return it as `URL` serialized it, trailing
 * slashes trimmed: the base every request path is appended to. Requests go to
 * that serialization, never the raw input, so a runtime whose URL parser
 * differs from this one still reads the host that was checked.
 */
export function validateCachekitUrl(url: string, allowCustomHost?: boolean): string {
  if (!url.startsWith('https://')) {
    throw new ConfigurationError('CachekitIO API URL must use HTTPS.');
  }

  // Request paths are appended to the base URL, so a query or fragment in it
  // would swallow every one of them.
  if (/[?#]/.test(url)) {
    throw new ConfigurationError('CachekitIO API URL must not carry a query or a fragment.');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigurationError('CachekitIO API URL is malformed.');
  }

  if (parsed.username || parsed.password) {
    throw new ConfigurationError('CachekitIO API URL must not carry credentials.');
  }

  if (isPrivateIp(parsed.hostname)) {
    throw new ConfigurationError('CachekitIO API URL must not point to a private IP address.');
  }

  if (!allowCustomHost && !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new ConfigurationError('API URL hostname not permitted. See documentation.');
  }

  return parsed.href.replace(/\/+$/, '');
}
