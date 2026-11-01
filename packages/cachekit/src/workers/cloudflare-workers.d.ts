// The one export of workerd's built-in module the Workers runtime reads. The
// module is typed here rather than through @cloudflare/workers-types, which
// the package does not depend on.
declare module 'cloudflare:workers' {
  export const env: Record<string, unknown> | null | undefined;
}
