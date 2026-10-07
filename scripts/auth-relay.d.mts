export interface AuthRelayOptions {
  enabled?: boolean;
  userAccessSession?: boolean;
  passwordMode?: boolean;
  origin?: string;
  tokenProvider?: () => Promise<string>;
  verifyAccess?: (token: string) => Promise<number>;
  requestBackend?: typeof fetch;
  now?: () => number;
}
export function createAuthRelayMiddleware(options?: AuthRelayOptions): {
  (req: any, res: any, next?: () => void): Promise<void>;
  sessionHeaders(req: any, accessToken?: string): Promise<Record<string, string>>;
  clearSessions(): void;
};
export function authRelayPlugin(options?: AuthRelayOptions): {
  name: string;
  sessionHeaders(req: any, accessToken?: string): Promise<Record<string, string>>;
  configureServer(server: any): void;
};
