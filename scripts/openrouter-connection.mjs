import { backendRelayPlugin, createBackendRelayMiddleware } from "./backend-relay.mjs";

// The local helper forwards only this user's authenticated provider connection.
// Password mode uses the common server-held session cookie and scoped ingress.
// It has no Wrangler credentials, shared-secret writer, inference, or arbitrary URL proxy.
export function createOpenRouterConnectionMiddleware(options = {}) {
  return createBackendRelayMiddleware({ ...options, providerOnly: true });
}
export function openRouterConnectionPlugin(options = {}) {
  return backendRelayPlugin({ ...options, providerOnly: true });
}
