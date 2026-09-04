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

The CachekitIO backend transmits cache keys as a single URL path segment (`/v1/cache/{key}`). Keys are percent-encoded with `encodeURIComponent`; keys that are exactly `.` or `..` are rejected with a `ConfigurationError` because the WHATWG URL Standard (used by `fetch` / undici / Cloudflare Workers) treats both literal and percent-encoded dots (`%2E`) as dot-segments and removes them before the request reaches the wire.

## Scope

This policy covers the `@cachekit-io/cachekit` and `@cachekit-io/cachekit-core-ts` packages. For issues with the CacheKit SaaS platform (api.cachekit.io), contact security@cachekit.io.
