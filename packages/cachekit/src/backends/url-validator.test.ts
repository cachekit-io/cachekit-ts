import { describe, it, expect } from 'vitest';
import { validateCachekitUrl } from './url-validator.js';
import { ConfigurationError } from '../errors.js';

describe('URL Validator', () => {
  it('accepts production URL', () => {
    expect(() => validateCachekitUrl('https://api.cachekit.io')).not.toThrow();
  });

  it('accepts staging URL', () => {
    expect(() => validateCachekitUrl('https://api.staging.cachekit.io')).not.toThrow();
  });

  it('rejects HTTP', () => {
    expect(() => validateCachekitUrl('http://api.cachekit.io')).toThrow(ConfigurationError);
    expect(() => validateCachekitUrl('http://api.cachekit.io')).toThrow('must use HTTPS');
  });

  it('rejects unknown host without allowCustomHost', () => {
    expect(() => validateCachekitUrl('https://evil.example.com')).toThrow(ConfigurationError);
    expect(() => validateCachekitUrl('https://evil.example.com')).toThrow('not permitted');
  });

  it('allows custom host with allowCustomHost flag', () => {
    expect(() => validateCachekitUrl('https://my-proxy.example.com', true)).not.toThrow();
  });

  it('blocks private IPs even with allowCustomHost', () => {
    const privateIps = ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254'];
    for (const ip of privateIps) {
      expect(() => validateCachekitUrl(`https://${ip}`, true)).toThrow('private IP');
    }
  });

  it('error message does not enumerate the allowlist', () => {
    try {
      validateCachekitUrl('https://evil.example.com');
      expect.fail('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain('api.cachekit.io');
      expect(msg).not.toContain('api.staging.cachekit.io');
    }
  });

  // ── Missing branch coverage: IPv6, more private ranges, edge cases ──

  describe('IPv6 private address blocking', () => {
    it('blocks IPv6 loopback ::1', () => {
      expect(() => validateCachekitUrl('https://[::1]', true)).toThrow('private IP');
    });

    it('blocks IPv6 link-local fe80::', () => {
      expect(() => validateCachekitUrl('https://[fe80::1]', true)).toThrow('private IP');
    });

    it('blocks IPv6 unique local fc00::/fd00::', () => {
      expect(() => validateCachekitUrl('https://[fc00::1]', true)).toThrow('private IP');
      expect(() => validateCachekitUrl('https://[fd12::1]', true)).toThrow('private IP');
    });

    it('blocks IPv4-mapped IPv6 (::ffff:)', () => {
      expect(() => validateCachekitUrl('https://[::ffff:127.0.0.1]', true)).toThrow('private IP');
    });

    it.each([
      ['unspecified', '[::]'],
      ['unspecified, uncompressed', '[0:0:0:0:0:0:0:0]'],
      ['link-local fe80::/10, upper half', '[fe90::1]'],
      ['link-local fe80::/10, top', '[febf::1]'],
      ['site-local fec0::/10', '[fec0::1]'],
      ['site-local fec0::/10, top', '[feff::1]'],
      ['IPv4-compatible loopback', '[::7f00:1]'],
      ['IPv4-compatible loopback, dotted', '[::127.0.0.1]'],
      ['IPv4-compatible 10/8', '[::a00:1]'],
      ['NAT64 10/8', '[64:ff9b::a00:1]'],
      ['NAT64 loopback', '[64:ff9b::127.0.0.1]'],
      ['NAT64 metadata', '[64:ff9b::a9fe:a9fe]'],
      ['6to4 10/8', '[2002:a00:1::]'],
      ['6to4 loopback', '[2002:7f00:1::1]'],
      ['6to4 192.168/16', '[2002:c0a8:101::]'],
    ])('blocks %s %s', (_name, host) => {
      expect(() => validateCachekitUrl(`https://${host}`, true)).toThrow('private IP');
    });

    it.each([
      ['NAT64 of a public IPv4', '[64:ff9b::808:808]'],
      ['6to4 of a public IPv4', '[2002:808:808::1]'],
      ['documentation prefix', '[2001:db8::1]'],
    ])('allows %s %s', (_name, host) => {
      expect(() => validateCachekitUrl(`https://${host}`, true)).not.toThrow();
    });
  });

  describe('query and fragment', () => {
    // The SDK appends /v1/cache/{key} to the configured URL as a string, so a
    // query or fragment there would swallow the whole request path.
    it.each([
      'https://api.cachekit.io/?',
      'https://api.cachekit.io?',
      'https://api.cachekit.io/?x=1',
      'https://api.cachekit.io/#',
      'https://api.cachekit.io#frag',
    ])('rejects %s', (url) => {
      expect(() => validateCachekitUrl(url)).toThrow(ConfigurationError);
      expect(() => validateCachekitUrl(url)).toThrow('query or a fragment');
    });

    it('rejects them on a custom host too', () => {
      expect(() => validateCachekitUrl('https://proxy.example.com/base?', true)).toThrow(
        'query or a fragment'
      );
    });

    it('still accepts a custom host with a path prefix', () => {
      expect(() => validateCachekitUrl('https://proxy.example.com/base/', true)).not.toThrow();
    });
  });

  describe('credentials', () => {
    it.each([
      'https://u:p@api.cachekit.io',
      'https://u@api.cachekit.io',
      'https://:p@api.cachekit.io',
    ])('rejects %s', (url) => {
      expect(() => validateCachekitUrl(url)).toThrow('must not carry credentials');
      expect(() => validateCachekitUrl(url, true)).toThrow('must not carry credentials');
    });
  });

  describe('returned base URL', () => {
    // Requests go to the serialization of the URL that was checked, never the
    // raw input, so every URL parser downstream reads the same host.
    it.each([
      ['https://api.cachekit.io', 'https://api.cachekit.io'],
      ['https://api.cachekit.io/', 'https://api.cachekit.io'],
      ['https://API.cachekit.io:443//', 'https://api.cachekit.io'],
      ['https://api.cachekit.io\\@evil.example', 'https://api.cachekit.io/@evil.example'],
      ['https://api.cachekit.io\\evil', 'https://api.cachekit.io/evil'],
    ])('%s becomes %s', (url, base) => {
      expect(validateCachekitUrl(url)).toBe(base);
    });

    it('keeps a custom host path prefix', () => {
      expect(validateCachekitUrl('https://proxy.example.com/base/', true)).toBe(
        'https://proxy.example.com/base'
      );
    });
  });

  describe('additional IPv4 private ranges', () => {
    it('blocks 172.16.0.0/12 range', () => {
      expect(() => validateCachekitUrl('https://172.16.0.1', true)).toThrow('private IP');
      expect(() => validateCachekitUrl('https://172.31.255.255', true)).toThrow('private IP');
    });

    it('blocks 169.254.0.0/16 link-local', () => {
      expect(() => validateCachekitUrl('https://169.254.169.254', true)).toThrow('private IP');
    });

    it('blocks 0.0.0.0/8 range', () => {
      expect(() => validateCachekitUrl('https://0.0.0.0', true)).toThrow('private IP');
    });

    it('allows public IPv4 with allowCustomHost', () => {
      expect(() => validateCachekitUrl('https://8.8.8.8', true)).not.toThrow();
    });
  });

  describe('SSRF bypass prevention', () => {
    it('blocks numeric hostname bypass (octal/hex encodings)', () => {
      expect(() => validateCachekitUrl('https://0177.0.0.1', true)).toThrow('private IP');
      expect(() => validateCachekitUrl('https://0x7f.0.0.1', true)).toThrow('private IP');
      expect(() => validateCachekitUrl('https://2130706433', true)).toThrow('private IP');
    });

    it('blocks localhost and localhost.', () => {
      expect(() => validateCachekitUrl('https://localhost', true)).toThrow('private IP');
      expect(() => validateCachekitUrl('https://localhost.', true)).toThrow('private IP');
    });
  });

  describe('malformed URL', () => {
    it('rejects malformed URL', () => {
      expect(() => validateCachekitUrl('https://not a valid url')).toThrow('malformed');
    });
  });

  describe('public IPv6 allowed', () => {
    it('allows public IPv6 addresses with allowCustomHost', () => {
      expect(() => validateCachekitUrl('https://[2001:db8::1]', true)).not.toThrow();
    });
  });
});
