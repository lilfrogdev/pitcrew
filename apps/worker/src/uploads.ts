import {
  UPLOAD_LIMITS,
  ATTACHMENT_LIMITS,
  validUploadId,
  validUploadName,
  uploadMediaType,
  validateMessageAttachments,
  type UploadReceipt,
  type StoredFileAttachment,
  type SubmittedAttachment,
  type AttachmentCapabilities,
} from "@pitcrew/protocol";
import { AdmissionError } from "./coordinator";
import type { SqlStorage } from "@cloudflare/workers-types";

type Row = UploadReceipt & {
  actor: string;
  threadId: string;
  digest: string;
  messageId?: string;
};
export type AcceptedUpload = SubmittedAttachment | StoredFileAttachment;
export type UploadAuthority = <T>(operation: () => T | Promise<T>) => Promise<T>;
// Shared by every repository in this isolate, including direct API callers.
// Reserve the full bound before streaming; staged quotas do not bound in-flight memory.
let activeUploads = 0;
export interface UploadStore {
  stage(row: Row, bytes: Uint8Array): UploadReceipt;
  receipt(id: string, actor: string, threadId: string): UploadReceipt | undefined;
  remove(id: string, actor: string, threadId: string): void;
  resolve(
    input: unknown,
    actor: string,
    threadId: string,
    capabilities?: AttachmentCapabilities,
    previousMessageId?: string,
  ): { attachments: AcceptedUpload[]; ids: string[] };
  link(ids: string[], actor: string, threadId: string, messageId: string): void;
  download(
    id: string,
    threadId: string,
    messageId: string,
  ): { row: UploadReceipt; bytes: Uint8Array };
  cleanup(): void;
  nextExpiry(): number | undefined;
}
const publicRow = ({ uploadId, name, mediaType, size, expiresAt, input }: Row): UploadReceipt => ({
  uploadId,
  name,
  mediaType,
  size,
  expiresAt,
  input,
});
export const base64Bytes = (bytes: Uint8Array) => {
  let raw = "";
  for (let start = 0; start < bytes.length; start += 16384)
    raw += String.fromCharCode(...bytes.subarray(start, start + 16384));
  return btoa(raw);
};
export function classifyUpload(
  name: string,
  mediaType: string,
  bytes: Uint8Array,
): UploadReceipt["input"] {
  const id = "validation";
  if (["image/png", "image/jpeg", "image/webp"].includes(mediaType)) {
    if (bytes.length <= ATTACHMENT_LIMITS.imageFileBytes) {
      // Never preview or submit a claimed image without checking its content structure.
      validateMessageAttachments([{ id, name, mediaType, data: base64Bytes(bytes) }]);
      return "image";
    }
    return "storage";
  }
  if (
    bytes.length <= ATTACHMENT_LIMITS.fileBytes &&
    ATTACHMENT_LIMITS.extensions.some((extension) => name.toLowerCase().endsWith(extension))
  ) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      validateMessageAttachments([{ id, name, mediaType: "text/plain", text }]);
      return "text";
    } catch {
      return "storage";
    }
  }
  return "storage";
}
export function sqlUploadStore(
  sql: SqlStorage,
  atomic: <T>(operation: () => T) => T,
  now = () => Date.now(),
): UploadStore {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS composer_uploads(id TEXT PRIMARY KEY,value TEXT NOT NULL,size INTEGER NOT NULL,expires INTEGER NOT NULL,linked INTEGER NOT NULL)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS composer_upload_chunks(id TEXT NOT NULL,seq INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(id,seq))`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS composer_upload_cancellations(id TEXT PRIMARY KEY,actor TEXT NOT NULL,thread TEXT NOT NULL,expires INTEGER NOT NULL)`,
  );
  const read = (id: string): Row | undefined => {
    const row = sql
      .exec<{ value: string }>("SELECT value FROM composer_uploads WHERE id=?", id)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as Row) : undefined;
  };
  const drop = (id: string) => {
    sql.exec("DELETE FROM composer_upload_chunks WHERE id=?", id);
    sql.exec("DELETE FROM composer_uploads WHERE id=?", id);
  };
  const cleanup = () =>
    atomic(() => {
      sql.exec("DELETE FROM composer_upload_cancellations WHERE expires<=?", now());
      for (const { id } of sql
        .exec<{ id: string }>(
          "SELECT id FROM composer_uploads WHERE linked=0 AND expires<=?",
          now(),
        )
        .toArray())
        drop(id);
    });
  const owned = (id: string, actor: string, threadId: string, previousMessageId?: string) => {
    const row = read(id);
    if (
      !row ||
      row.actor !== actor ||
      row.threadId !== threadId ||
      (row.messageId ? row.messageId !== previousMessageId : row.expiresAt <= now())
    )
      throw new AdmissionError("upload_unavailable", 404);
    return row;
  };
  const bytes = (row: Row) => {
    const result = new Uint8Array(row.size);
    let offset = 0;
    for (const chunk of sql
      .exec<{ seq: number; bytes: ArrayBuffer }>(
        "SELECT seq,bytes FROM composer_upload_chunks WHERE id=? ORDER BY seq",
        row.uploadId,
      )
      .toArray()) {
      const part = new Uint8Array(chunk.bytes);
      if (chunk.seq * UPLOAD_LIMITS.chunkBytes !== offset || offset + part.length > result.length)
        throw new AdmissionError("upload_unavailable", 404);
      result.set(part, offset);
      offset += part.length;
    }
    if (offset !== row.size) throw new AdmissionError("upload_unavailable", 404);
    return result;
  };
  return {
    cleanup,
    nextExpiry() {
      const upload = sql
        .exec<{ expiry: number | null }>(
          "SELECT MIN(expires) AS expiry FROM composer_uploads WHERE linked=0",
        )
        .toArray()[0].expiry;
      const cancellation = sql
        .exec<{ expiry: number | null }>(
          "SELECT MIN(expires) AS expiry FROM composer_upload_cancellations",
        )
        .toArray()[0].expiry;
      const expiry = Math.min(upload ?? Infinity, cancellation ?? Infinity);
      return Number.isFinite(expiry) ? expiry : undefined;
    },
    stage(row, content) {
      cleanup();
      return atomic(() => {
        if (
          sql
            .exec("SELECT id FROM composer_upload_cancellations WHERE id=?", row.uploadId)
            .toArray().length
        )
          throw new AdmissionError("upload_cancelled", 409);
        const previous = read(row.uploadId);
        if (previous) {
          if (
            previous.actor !== row.actor ||
            previous.threadId !== row.threadId ||
            previous.messageId ||
            previous.digest !== row.digest ||
            previous.name !== row.name ||
            previous.mediaType !== row.mediaType
          )
            throw new AdmissionError("upload_conflict", 409);
          return publicRow(previous);
        }
        const staged = sql
          .exec<{ value: string; size: number }>(
            "SELECT value,size FROM composer_uploads WHERE linked=0",
          )
          .toArray()
          .filter((item) => (JSON.parse(item.value) as Row).actor === row.actor);
        const total = sql
          .exec<{ size: number }>("SELECT COALESCE(SUM(size),0) AS size FROM composer_uploads")
          .toArray()[0].size;
        if (
          staged.length >= UPLOAD_LIMITS.stagedCount ||
          staged.reduce((sum, item) => sum + item.size, 0) + row.size > UPLOAD_LIMITS.stagedBytes ||
          total + row.size > UPLOAD_LIMITS.repositoryBytes
        )
          throw new AdmissionError("upload_capacity", 429);
        sql.exec(
          "INSERT INTO composer_uploads VALUES(?,?,?,?,0)",
          row.uploadId,
          JSON.stringify(row),
          row.size,
          row.expiresAt,
        );
        for (
          let offset = 0, seq = 0;
          offset < content.length;
          offset += UPLOAD_LIMITS.chunkBytes, seq++
        )
          sql.exec(
            "INSERT INTO composer_upload_chunks VALUES(?,?,?)",
            row.uploadId,
            seq,
            content.slice(offset, offset + UPLOAD_LIMITS.chunkBytes),
          );
        return publicRow(row);
      });
    },
    receipt(id, actor, threadId) {
      cleanup();
      const row = read(id);
      if (!row || row.actor !== actor || row.threadId !== threadId || row.messageId) return;
      return publicRow(row);
    },
    remove(id, actor, threadId) {
      const row = read(id);
      if (row) owned(id, actor, threadId);
      cleanup();
      atomic(() => {
        const existing = sql
          .exec<{ actor: string; thread: string }>(
            "SELECT actor,thread FROM composer_upload_cancellations WHERE id=?",
            id,
          )
          .toArray()[0];
        if (existing && (existing.actor !== actor || existing.thread !== threadId))
          throw new AdmissionError("not_found", 404);
        const count = sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM composer_upload_cancellations WHERE actor=?",
            actor,
          )
          .toArray()[0].count;
        // One participant cannot fill other participants' cancellation budget.
        // Keep their most recent tombstones, always allowing owned removals/replays.
        if (!existing && count >= 128)
          sql.exec(
            "DELETE FROM composer_upload_cancellations WHERE id=(SELECT id FROM composer_upload_cancellations WHERE actor=? ORDER BY expires LIMIT 1)",
            actor,
          );
        sql.exec(
          "INSERT OR IGNORE INTO composer_upload_cancellations VALUES(?,?,?,?)",
          id,
          actor,
          threadId,
          now() + UPLOAD_LIMITS.ttlMs,
        );
        drop(id);
      });
    },
    resolve(input, actor, threadId, capabilities, previousMessageId) {
      if (input === undefined) return { attachments: [], ids: [] };
      if (!Array.isArray(input) || input.length > UPLOAD_LIMITS.count)
        throw new AdmissionError("invalid_attachments");
      const ids: string[] = [];
      let total = 0;
      const attachments = input.map((item): AcceptedUpload => {
        if (item && typeof item === "object" && "uploadId" in item) {
          if (
            Object.keys(item).some((key) => !["uploadId", "modelInput"].includes(key)) ||
            (item.modelInput !== undefined &&
              !["text", "image", "storage"].includes(item.modelInput)) ||
            !validUploadId(item.uploadId) ||
            ids.includes(item.uploadId)
          )
            throw new AdmissionError("invalid_upload_id");
          const row = owned(item.uploadId, actor, threadId, previousMessageId);
          ids.push(row.uploadId);
          total += row.size;
          if (
            item.modelInput !== undefined &&
            item.modelInput !== "storage" &&
            (item.modelInput !== row.input ||
              (item.modelInput === "image" && !capabilities?.images))
          )
            throw new AdmissionError("upload_model_input_unavailable");
          if (row.input === "text" && item.modelInput !== "storage") {
            return {
              id: row.uploadId,
              name: row.name,
              mediaType: "text/plain",
              text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes(row)),
            };
          }
          if (row.input === "image" && capabilities?.images && item.modelInput !== "storage") {
            return {
              id: row.uploadId,
              name: row.name,
              mediaType: row.mediaType as "image/png",
              data: base64Bytes(bytes(row)),
            };
          }
          return {
            kind: "file",
            id: row.uploadId,
            attachmentId: row.uploadId,
            name: row.name,
            mediaType: row.mediaType,
            size: row.size,
            modelInput: "storage",
          };
        }
        const legacy = validateMessageAttachments([item], capabilities)[0];
        total +=
          "data" in legacy
            ? atob(legacy.data).length
            : new TextEncoder().encode(legacy.text).byteLength;
        return legacy;
      });
      if (total > UPLOAD_LIMITS.totalBytes) throw new AdmissionError("attachments_too_large", 413);
      validateMessageAttachments(
        attachments.filter((item) => !("kind" in item)),
        capabilities,
      );
      if (new Set(attachments.map((item) => item.id)).size !== attachments.length)
        throw new AdmissionError("invalid_attachment_id");
      return { attachments, ids };
    },
    link(ids, actor, threadId, messageId) {
      for (const id of ids) {
        const row = owned(id, actor, threadId);
        sql.exec(
          "UPDATE composer_uploads SET value=?,linked=1 WHERE id=?",
          JSON.stringify({ ...row, messageId }),
          id,
        );
      }
    },
    download(id, threadId, messageId) {
      const row = read(id);
      if (!row || row.threadId !== threadId || row.messageId !== messageId)
        throw new AdmissionError("not_found", 404);
      return { row: publicRow(row), bytes: bytes(row) };
    },
  };
}
export async function readUpload(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > UPLOAD_LIMITS.fileBytes))
    throw new AdmissionError("upload_too_large", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AdmissionError("invalid_upload");
  const parts: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel();
      reject(new AdmissionError("upload_timeout", 408));
    }, 30000);
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part.done) break;
      size += part.value.length;
      if (size > UPLOAD_LIMITS.fileBytes) {
        await reader.cancel();
        throw new AdmissionError("upload_too_large", 413);
      }
      parts.push(part.value);
    }
  } finally {
    clearTimeout(timer);
  }
  if (!size || (declared && Number(declared) !== size)) throw new AdmissionError("invalid_upload");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
export async function stageUpload(
  request: Request,
  id: string,
  actor: string,
  threadId: string,
  store: UploadStore,
  authority: UploadAuthority,
): Promise<UploadReceipt> {
  if (activeUploads >= 1) throw new AdmissionError("upload_capacity", 429);
  activeUploads++;
  try {
    if (!validUploadId(id)) throw new AdmissionError("invalid_upload_id");
    let name: string;
    try {
      name = decodeURIComponent(request.headers.get("x-pitcrew-filename") ?? "");
    } catch {
      throw new AdmissionError("invalid_upload_name");
    }
    if (!validUploadName(name)) throw new AdmissionError("invalid_upload_name");
    let mediaType: string;
    try {
      mediaType = uploadMediaType(
        request.headers.get("content-type") ?? "application/octet-stream",
      );
    } catch {
      throw new AdmissionError("invalid_upload_type");
    }
    const bytes = await readUpload(request);
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const input = classifyUpload(name, mediaType, bytes);
    return await authority(() =>
      store.stage(
        {
          uploadId: id,
          actor,
          threadId,
          name,
          mediaType,
          size: bytes.length,
          digest,
          expiresAt: Date.now() + UPLOAD_LIMITS.ttlMs,
          input,
        },
        bytes,
      ),
    );
  } finally {
    activeUploads--;
  }
}
