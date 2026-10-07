import type { Plugin } from "vite-plus";
export function openRouterConnectionPlugin(options?: {
  enabled?: boolean;
  userAccessSession?: boolean;
  origin?: string | (() => string | undefined);
  sharedApi?: boolean;
  passwordMode?: boolean;
  sessionHeaders?: (
    req: import("node:http").IncomingMessage,
    accessToken?: string,
  ) => Promise<Record<string, string>>;
}): Plugin;
