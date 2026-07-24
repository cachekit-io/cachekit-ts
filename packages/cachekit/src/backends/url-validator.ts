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

function isPrivateIp(hostname: string): boolean {
  // Exact loopback names
  if (hostname === 'localhost' || hostname === 'localhost.') return true;

  // Strip IPv6 brackets
  const bare = hostname.replace(/^\[|\]$/g, '');

  // IPv6 checks (only for strings containing ':')
  if (bare.includes(':')) {
    const lower = bare.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fe80:')) return true; // Link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // Unique local fc00::/7
    if (lower.startsWith('::ffff:')) return true; // IPv4-mapped
    return false;
  }

  // IPv4 standard dotted-decimal (strict validation)
  if (isStrictIPv4(hostname)) {
    const nums = hostname.split('.').map(Number);
    if (nums[0] === 127) return true; // 127.0.0.0/8
    if (nums[0] === 10) return true; // 10.0.0.0/8
    if (nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31) return true; // 172.16.0.0/12
    if (nums[0] === 192 && nums[1] === 168) return true; // 192.168.0.0/16
    if (nums[0] === 169 && nums[1] === 254) return true; // 169.254.0.0/16
    if (nums[0] === 0) return true; // 0.0.0.0/8
    return false;
  }

  // Reject hostnames that look numeric but bypass isIP (octal/hex/decimal encodings)
  // These resolve to IPs at the OS level even though isIP doesn't recognize them
  if (/^[\d.ox]+$/i.test(hostname)) return true;

  return false;
}

export function validateCachekitUrl(url: string, allowCustomHost?: boolean): void {
  if (!url.startsWith('https://')) {
    throw new ConfigurationError('CachekitIO API URL must use HTTPS.');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigurationError('CachekitIO API URL is malformed.');
  }

  if (isPrivateIp(parsed.hostname)) {
    throw new ConfigurationError('CachekitIO API URL must not point to a private IP address.');
  }

  if (!allowCustomHost && !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new ConfigurationError('API URL hostname not permitted. See documentation.');
  }
}
