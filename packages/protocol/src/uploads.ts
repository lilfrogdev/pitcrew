import { validAttachmentText, type MessageAttachment } from "./attachments";

export const UPLOAD_LIMITS = {
  count: 4,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  stagedBytes: 32 * 1024 * 1024,
  repositoryBytes: 128 * 1024 * 1024,
  stagedCount: 16,
  ttlMs: 24 * 60 * 60 * 1000,
  chunkBytes: 256 * 1024,
} as const;
export type UploadSubmission = { uploadId: string; modelInput?: "text" | "image" | "storage" };
export type UploadReceipt = {
  uploadId: string;
  name: string;
  mediaType: string;
  size: number;
  expiresAt: number;
  input: "text" | "image" | "storage";
};
export type StoredFileAttachment = {
  kind: "file";
  id: string;
  attachmentId: string;
  name: string;
  mediaType: string;
  size: number;
  modelInput: "storage";
};
export const isStoredFile = (item: MessageAttachment): item is StoredFileAttachment =>
  "kind" in item && item.kind === "file";
export const validUploadId = (id: unknown): id is string =>
  typeof id === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
export function validUploadName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 128 &&
    name === name.trim() &&
    name !== "." &&
    name !== ".." &&
    validAttachmentText(name) &&
    // eslint-disable-next-line no-control-regex -- prevent paths, header injection and bidi spoofing
    !/[/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name)
  );
}
export function uploadMediaType(value: string): string {
  const type = value.split(";", 1)[0].trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type))
    throw Error("invalid_upload_type");
  return type;
}
