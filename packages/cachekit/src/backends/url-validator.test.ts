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
});
