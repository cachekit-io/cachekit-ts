# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in CacheKit, please report it responsibly.

**Do not open a public issue.**

Instead, use [GitHub's private vulnerability reporting](https://github.com/cachekit-io/cachekit-ts/security/advisories/new) to submit your report. We will acknowledge receipt within 48 hours and provide a timeline for a fix.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.x     | Yes       |

## Cache-Key Path Encoding (CWE-22)

The CachekitIO backend transmits cache keys as a single URL path segment (`/v1/cache/{key}`, `…/{key}/ttl`, `…/{key}/lock`). Keys are percent-encoded with `encodeURIComponent`; a key that is exactly `.`, `..`, `health`, `ttl` or `lock` is rejected with a `ConfigurationError` before any request is built ([protocol `spec/saas-api.md` § Cache-Key Path Encoding](https://github.com/cachekit-io/protocol/blob/main/spec/saas-api.md#cache-key-path-encoding), rule 2): the WHATWG URL parser behind `fetch` removes literal and percent-encoded (`%2E`) dot segments before the request reaches the wire, and the other three words are live route tokens at that path level. Every other key — including `a:..` and every canonical `ns:…` key — is sent unchanged and decodes once server-side to the original key.

## Scope

This policy covers the `@cachekit-io/cachekit` and `@cachekit-io/cachekit-core-ts` packages. For issues with the CacheKit SaaS platform (api.cachekit.io), contact security@cachekit.io.
