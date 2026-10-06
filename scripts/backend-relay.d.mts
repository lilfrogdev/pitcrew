import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
export const BACKEND_ACCESS: Readonly<{
  origin: string;
  issuer: string;
  audience: string;
  email: string;
  emails: readonly string[];
}>;
export function readCachedAccessToken(options?: {
  spawnProcess?: typeof import("node:child_process").spawn;
  homeDirectory?: string;
  cloudflaredPath?: string;
}): Promise<string>;
export function verifyUserAccessToken(token: string): Promise<number>;
type Options = {
  enabled?: boolean;
  userAccessSession?: boolean;
  origin?: string | (() => string | undefined);
  sharedApi?: boolean;
  sessionHeaders?: (req: IncomingMessage, accessToken: string) => Promise<Record<string, string>>;
};
export function createBackendRelayMiddleware(
  options?: Options,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>;
export function backendRelayPlugin(options?: Options): Plugin;
