import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { Coordinator, initialState } from "./coordinator";
import { attachmentStore } from "./attachment-store";
import { resolveCatalog } from "./model-selection";
import { api } from "./api";
import type { ImageAttachment } from "@pitcrew/protocol";
import { readRepositoryState, writeRepositoryState } from "./repository-state";
it("migrates legacy SQLite state to bounded chunk rows and rolls back atomically", () => {
  const database = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: (string | number)[]) {
      const statement = database.prepare(query);
      if (statement.columns().length) return statement.all(...bindings);
      statement.run(...bindings);
      return [];
    },
  } as unknown as SqlStorage;
  try {
    expect(readRepositoryState(sql)).toBeUndefined();
    database.prepare("INSERT INTO repository_state VALUES(1,?)").run('{"legacy":true}');
    expect(JSON.parse(readRepositoryState(sql)!)).toEqual({ legacy: true });
    const large = JSON.stringify({ transcript: "😀".repeat(600000) });
    database.exec("BEGIN");
    writeRepositoryState(sql, large);
    database.exec("COMMIT");
    expect(readRepositoryState(sql) === large).toBe(true);
    expect(database.prepare("SELECT COUNT(*) AS n FROM repository_state").get()!.n).toBe(0);
    const sizes = database
      .prepare("SELECT length(CAST(value AS BLOB)) AS n FROM repository_state_chunks")
      .all();
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.every((row) => Number(row.n) <= 524288)).toBe(true);
    database.exec("BEGIN");
    writeRepositoryState(sql, '{"replacement":true}');
    database.exec("ROLLBACK");
    expect(readRepositoryState(sql) === large).toBe(true);
  } finally {
    database.close();
  }
});

it("rolls image admission back with SQLite state and scopes image retrieval to its thread", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE images(id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const images = attachmentStore(
    (id) => {
      const row = database.prepare("SELECT value FROM images WHERE id=?").get(id);
      return row ? (JSON.parse(String(row.value)) as ImageAttachment) : undefined;
    },
    (id, image) => {
      database.prepare("INSERT INTO images VALUES(?,?)").run(id, JSON.stringify(image));
    },
  );
  let rejectPersist = false;
  const atomic = <T>(operation: () => T): T => {
    database.exec("BEGIN");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };
  const core = new Coordinator(
    initialState(),
    () => {
      if (rejectPersist) throw Error("fixture_write_failure");
    },
    undefined,
    undefined,
    images,
    atomic,
  );
  const thread = core.createThread("image", "thread");
  const other = core.createThread("other", "other");
  const image: ImageAttachment = {
    id: "one",
    name: "one.png",
    mediaType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  };
  const catalog = resolveCatalog({});
  try {
    rejectPersist = true;
    expect(() =>
      core.queueTurn(thread.id, "inspect", "failed", "owner", catalog, undefined, [image]),
    ).toThrow("fixture_write_failure");
    expect(database.prepare("SELECT COUNT(*) AS n FROM images").get()!.n).toBe(0);
    expect(core.state.messages).toHaveLength(0);
    rejectPersist = false;
    const admitted = core.queueTurn(thread.id, "inspect", "accepted", "owner", catalog, undefined, [
      image,
    ]);
    const ref = admitted.message.attachments![0];
    if (!("attachmentId" in ref)) throw Error("missing_ref");
    const routes = api(core, () => {});
    const response = await routes.request(
      `/api/threads/${thread.id}/attachments/${ref.attachmentId}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0)),
    );
    expect(
      (await routes.request(`/api/threads/${other.id}/attachments/${ref.attachmentId}`)).status,
    ).toBe(404);
    expect((await routes.request(`/api/threads/${thread.id}/attachments/unknown`)).status).toBe(
      404,
    );
  } finally {
    database.close();
  }
});
