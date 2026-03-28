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
