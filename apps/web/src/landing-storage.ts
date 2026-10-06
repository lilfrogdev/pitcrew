import type { Authorization } from "./api";
import type { LandingState } from "./LandingControl";
const storageKey = (account: string) => `pitcrew.landing.pending.v1:${encodeURIComponent(account)}`;
export const landingStateKey = (account: string | undefined, project: string, run: string) =>
  JSON.stringify([account ?? "memory", project, run]);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length < 1024;
function authorization(value: unknown, runId: string): value is Authorization {
  if (!value || typeof value !== "object") return false;
  const item = value as Authorization;
  return (
    text(item.authorizationId) &&
    item.runId === runId &&
    text(item.expectedTargetSha) &&
    text(item.candidateSha) &&
    text(item.configurationRevision) &&
    Number.isFinite(item.expiresAt) &&
    Number.isFinite(new Date(item.expiresAt).getTime()) &&
    ["fixture", "artifacts"].includes(item.backend) &&
    ["authorized", "pending", "landed", "rejected", "uncertain"].includes(item.state)
  );
}
function records(account: string): Record<string, LandingState> {
  const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(account)) ?? "{}");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, LandingState>)
    : {};
}
export function readLandingStates(account?: string): Record<string, LandingState> {
  if (!account) return {};
  try {
    const result: Record<string, LandingState> = {};
    for (const [key, value] of Object.entries(records(account))) {
      let tuple: unknown;
      try {
        tuple = JSON.parse(key);
      } catch {
        continue;
      }
      if (
        !Array.isArray(tuple) ||
        tuple.length !== 2 ||
        !tuple.every(text) ||
        !value ||
        typeof value !== "object"
      )
        continue;
      const [project, runId] = tuple as [string, string];
      const auth = value.authorization;
      const state: LandingState = {
        ...(text(value.key) ? { key: value.key } : {}),
        ...(text(value.fingerprint) ? { fingerprint: value.fingerprint } : {}),
      };
      if (auth !== undefined) {
        if (!authorization(auth, runId)) continue;
        state.authorization = auth;
        const receipt = value.result;
        // Browser storage is recovery data, not proof of a source update. Every
        // consumed/interrupted operation needs a fresh server receipt on reload.
        if (value.busy || auth.state !== "authorized" || receipt) {
          state.result = {
            authorizationId: auth.authorizationId,
            backend: auth.backend,
            status: "uncertain",
            code: "RECEIPT_RECHECK_REQUIRED",
          };
        }
      }
      if (state.authorization || state.key)
        result[landingStateKey(account, project, runId)] = state;
    }
    return result;
  } catch {
    return {};
  }
}
export function saveLandingState(
  account: string | undefined,
  project: string,
  runId: string,
  state: LandingState,
): void {
  if (!account) throw Error("landing_account_required");
  const all = records(account);
  const key = JSON.stringify([project, runId]);
  if (state.result?.status === "landed") delete all[key];
  else all[key] = state;
  localStorage.setItem(storageKey(account), JSON.stringify(all));
}
