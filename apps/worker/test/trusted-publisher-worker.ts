import { DurableObject } from "cloudflare:workers";
import { SqlitePublisherJournal } from "../src/trusted-publisher-agent.ts";
import type { PublisherRecord } from "../../../packages/execution/src/trusted-publisher.ts";

// Test-only SQLite fixture. This class never starts a container or creates a token.
export class PublisherJournalFixture extends DurableObject {
  private readonly journal = new SqlitePublisherJournal(this.ctx.storage);
  async exercise(body: { operation: string; id: string; fingerprint?: string; bundle?: string }) {
    const fingerprint = body.fingerprint ?? "fingerprint";
    if (body.operation === "claim") return this.journal.claim(body.id, {
      fingerprint, state: "pending", cancelled: false, containerOwned: false, writeAttempted: false,
      input: { kind: "publish", operationId: body.id, runId: "run", repositoryAgentName: "pitcrew",
        admissionFingerprint: "admission", artifactId: "fork", artifactRepositoryId: "fork-id",
        artifactRemote: "https://fixture.artifacts.cloudflare.net/git/ns/fork.git", sourceId: "source",
        sourceRepositoryId: "source-id", sourceRemote: "https://fixture.artifacts.cloudflare.net/git/ns/source.git",
        baseSha: "a".repeat(40), candidateSha: "b".repeat(40), configurationRevision: "revision",
        deadline: Date.now() + 120_000, bundleDigest: "c".repeat(64), authorization: "fixture" },
    });
    if (body.operation === "read") return this.journal.read(body.id);
    if (body.operation === "bundle") {
      this.journal.storeBundle(body.id, fingerprint, body.bundle ?? "");
      return { bundle: this.journal.bundle(body.id) };
    }
    if (body.operation === "cancel") return this.journal.update(body.id, fingerprint, { cancelled: true });
    if (body.operation === "uncancel") return this.journal.update(body.id, fingerprint, { cancelled: false });
    if (body.operation === "mutate") return this.journal.update(body.id, fingerprint,
      { input: { operationId: "spoof" } as PublisherRecord["input"] });
    if (body.operation === "complete") return this.journal.update(body.id, fingerprint, { state: "complete",
      result: { status: "published", fingerprint, cleanupVerified: true } });
    throw Error("fixture_unknown_operation");
  }
}

export default {
  async fetch(request: Request, env: { JOURNAL: DurableObjectNamespace<PublisherJournalFixture> }) {
    try {
      const body = await request.json() as { operation: string; id: string };
      const result = await env.JOURNAL.get(env.JOURNAL.idFromName("fixture")).exercise(body);
      return Response.json(result ?? null);
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "fixture_error" }, { status: 409 }); }
  },
};
