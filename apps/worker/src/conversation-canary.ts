import { createHash } from "node:crypto";
import { AdmissionError } from "./coordinator";
import type { ConversationTurn } from "./conversation";
import type { ModelEnv } from "./model-selection";

export const CANARY_MODEL = "qwen/qwen3.8-flash";
type Scope = {
  id: string;
  actor: string;
  projectId: string;
  threadId: string;
  expiresAt: string;
  maxTurns: number;
};
type NormalScope = { id: string; actor: string; projectId: string };
type CanaryEnv = ModelEnv & {
  CLOUD_CONVERSATION_CANARY?: string;
  CLOUD_CONVERSATION_SCOPE?: string;
};
/** Normal interactive scope has no lifetime quota, deadline, model or thread pin. */
export function normalConversationScope(env: CanaryEnv): NormalScope | undefined {
  if (env.CLOUD_CONVERSATION_SCOPE === undefined) return;
  try {
    if (env.CLOUD_CONVERSATION_CANARY !== undefined) throw Error();
    const value = JSON.parse(env.CLOUD_CONVERSATION_SCOPE);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "actor,id,projectId" ||
      ![value.id, value.projectId].every(
        (s) => typeof s === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(s),
      ) ||
      typeof value.actor !== "string" ||
      !/^account:[a-zA-Z0-9_-]{1,128}$/.test(value.actor)
    )
      throw Error();
    return { id: value.id, actor: value.actor, projectId: value.projectId };
  } catch {
    throw new AdmissionError("conversation_scope_denied", 403);
  }
}
/** Absence alone preserves legacy admission. Empty, malformed or unknown fields deny. */
export function canaryScope(env: CanaryEnv): Scope | undefined {
  if (env.CLOUD_CONVERSATION_CANARY === undefined) return;
  try {
    if (env.CLOUD_CONVERSATION_SCOPE !== undefined) throw Error();
    const value = JSON.parse(env.CLOUD_CONVERSATION_CANARY);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "actor,expiresAt,id,maxTurns,projectId,threadId" ||
      ![value.id, value.projectId, value.threadId].every(
        (s) => typeof s === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(s),
      ) ||
      typeof value.actor !== "string" ||
      !/^account:[a-zA-Z0-9_-]{1,128}$/.test(value.actor) ||
      typeof value.expiresAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.expiresAt) ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      new Date(value.expiresAt).toISOString() !== value.expiresAt ||
      !Number.isSafeInteger(value.maxTurns) ||
      value.maxTurns < 1 ||
      value.maxTurns > 2
    )
      throw Error();
    return {
      id: value.id,
      actor: value.actor,
      projectId: value.projectId,
      threadId: value.threadId,
      expiresAt: value.expiresAt,
      maxTurns: value.maxTurns,
    };
  } catch {
    throw new AdmissionError("conversation_canary_denied", 403);
  }
}

/** Policy latches on first inspection; quota receipts commit with message/turn/grant. */
export class ConversationCanary {
  constructor(private sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS conversation_canary_scope(slot INTEGER PRIMARY KEY CHECK(slot=1),id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS conversation_canary_receipt(turn_id TEXT PRIMARY KEY,canary_id TEXT NOT NULL,fingerprint TEXT NOT NULL,actor TEXT NOT NULL,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,models TEXT NOT NULL)",
    );
  }
  private scope(env: CanaryEnv, actor: string, projectId: string, threadId: string) {
    const finite = canaryScope(env),
      normal = normalConversationScope(env);
    const scope = finite ?? normal;
    const deny = () => {
      throw new AdmissionError("conversation_canary_denied", 403);
    };
    const latch = this.sql
      .exec<{ id: string; fingerprint: string }>(
        "SELECT id,fingerprint FROM conversation_canary_scope LIMIT 1",
      )
      .toArray()[0];
    // Once armed, removing policy or changing IDs must not restore global mode.
    if (!scope) {
      if (latch) deny();
      return;
    }
    if (latch && latch.id !== scope.id) deny();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          finite
            ? { version: 1, ...scope, model: CANARY_MODEL, effort: "off" }
            : { version: 1, ...scope, profile: "normal" },
        ),
      )
      .digest("hex");
    const pin = this.sql
      .exec<{ fingerprint: string }>(
        "SELECT fingerprint FROM conversation_canary_scope WHERE id=?",
        scope.id,
      )
      .toArray()[0];
    if (pin && pin.fingerprint !== fingerprint) deny();
    // Pin even rejected/non-target requests. Removing an inspected policy before
    // the first accepted turn cannot silently restore legacy global admission.
    this.sql.exec(
      "INSERT OR IGNORE INTO conversation_canary_scope VALUES(1,?,?)",
      scope.id,
      fingerprint,
    );
    if (finite)
      try {
        const model = JSON.parse(env.MODEL_CONFIGURATION ?? "null");
        if (
          model?.provider !== "byok" ||
          model.providerId !== "openrouter" ||
          model.model !== CANARY_MODEL ||
          model.secretBinding !== "OPENROUTER_API_KEY"
        )
          deny();
      } catch {
        deny();
      }
    if (
      scope.actor !== actor ||
      scope.projectId !== projectId ||
      (finite && (finite.threadId !== threadId || Date.parse(finite.expiresAt) <= Date.now()))
    )
      deny();
    return { scope, finite, normal, fingerprint };
  }
  preflight(env: CanaryEnv, actor: string, projectId: string, threadId: string) {
    const current = this.scope(env, actor, projectId, threadId);
    if (!current?.finite) return;
    const count = this.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM conversation_canary_receipt WHERE canary_id=?",
        current.scope.id,
      )
      .toArray()[0].count;
    if (count >= current.finite.maxTurns)
      throw new AdmissionError("conversation_canary_exhausted", 429);
  }
  claim(env: CanaryEnv, projectId: string, turn: ConversationTurn) {
    const current = this.scope(env, turn.membershipActor ?? turn.actor, projectId, turn.threadId);
    if (!current) return;
    if (current.finite) this.models(turn);
    const existing = this.sql
      .exec("SELECT turn_id FROM conversation_canary_receipt WHERE turn_id=?", turn.id)
      .toArray()[0];
    if (existing) {
      this.assertTurn(env, projectId, turn);
      return;
    }
    this.preflight(env, turn.membershipActor ?? turn.actor, projectId, turn.threadId);
    if (current.finite) turn.canaryId = current.scope.id;
    else turn.normalConversationScopeId = current.scope.id;
    this.sql.exec(
      "INSERT INTO conversation_canary_receipt VALUES(?,?,?,?,?,?,?)",
      turn.id,
      current.scope.id,
      current.fingerprint,
      current.scope.actor,
      projectId,
      turn.threadId,
      JSON.stringify(turn.models),
    );
  }
  private models(turn: ConversationTurn) {
    if (
      ![turn.models.repoAgent, turn.models.implementer, turn.models.reviewer].every(
        (s) => s.modelId === "default" && s.effort === "off",
      )
    )
      throw new AdmissionError("conversation_canary_denied", 403);
  }
  assertTurn(env: CanaryEnv, projectId: string, turn: ConversationTurn) {
    const current = this.scope(env, turn.membershipActor ?? turn.actor, projectId, turn.threadId);
    if (!current) return;
    if (current.finite) this.models(turn);
    const receipt = this.sql
      .exec<{
        canary_id: string;
        fingerprint: string;
        actor: string;
        project_id: string;
        thread_id: string;
        models: string;
      }>("SELECT * FROM conversation_canary_receipt WHERE turn_id=?", turn.id)
      .toArray()[0];
    if (
      (current.finite ? turn.canaryId : turn.normalConversationScopeId) !== current.scope.id ||
      !receipt ||
      receipt.canary_id !== current.scope.id ||
      receipt.fingerprint !== current.fingerprint ||
      receipt.actor !== current.scope.actor ||
      receipt.project_id !== projectId ||
      receipt.thread_id !== turn.threadId ||
      receipt.models !== JSON.stringify(turn.models) ||
      (turn.input &&
        ((current.finite ? turn.input.canaryId : turn.input.normalConversationScopeId) !==
          current.scope.id ||
          turn.input.turnId !== turn.id ||
          turn.input.threadId !== turn.threadId ||
          turn.input.projectId !== projectId ||
          turn.input.credentialActor !== current.scope.actor ||
          JSON.stringify(turn.input.models) !== receipt.models))
    )
      throw new AdmissionError("conversation_canary_denied", 403);
  }
}
