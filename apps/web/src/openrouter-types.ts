export interface OpenRouterStatus {
  available: boolean;
  storageAvailable: boolean;
  configured: boolean;
  executionEnabled: boolean;
}
export interface OpenRouterConnectionApi {
  status(): Promise<OpenRouterStatus>;
  store(key: string): Promise<OpenRouterStatus>;
  remove(): Promise<OpenRouterStatus>;
}
