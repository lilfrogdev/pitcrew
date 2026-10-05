import { useLayoutEffect, useRef, useState } from "react";
import {
  ATTACHMENT_LIMITS,
  validateMessageAttachments,
  type SubmittedAttachment,
  type AttachmentCapabilities,
} from "@pitcrew/protocol";
import { Icon } from "./icons";
import { useDictation } from "./useDictation";

export interface AttachmentDraft {
  id: string;
  name: string;
  status: "reading" | "ready" | "error";
  attachment?: SubmittedAttachment;
  error?: string;
}
export function attachmentError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code.includes("too_large"))
    return "Attachment size exceeds the displayed file or combined limit. Nothing has been truncated.";
  if (code.includes("too_many")) return "Attach at most four files.";
  if (code.includes("images_unsupported"))
    return "Images are not supported by all selected agents. Choose compatible models or remove the images.";
  if (code.includes("image"))
    return "Use a static PNG, JPEG or WebP image with valid bytes, at most 4096 pixels per edge. Animated images are not supported.";
  return "Use a supported UTF-8 text/source file or static PNG/JPEG/WebP image. Invalid binary data, PDFs and control characters are not supported.";
}
export function Composer({
  draft,
  onDraft,
  attachments,
  onFiles,
  onRemove,
  onSend,
  disabled,
  sending,
  canSend,
  capabilities,
  modelControls,
  sessionKey = "composer",
  dictationEnabled = true,
}: {
  draft: string;
  onDraft: (text: string) => void;
  attachments: AttachmentDraft[];
  onFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
  onSend: (event: React.FormEvent) => void;
  disabled: boolean;
  sending: boolean;
  canSend: boolean;
  capabilities?: AttachmentCapabilities;
  modelControls?: React.ReactNode;
  sessionKey?: string;
  dictationEnabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);
  const dictation = useDictation(draft, onDraft, dictationEnabled && !disabled, sessionKey);
  const imagesSupported = capabilities?.images === true;
  const extensions = [
    ...ATTACHMENT_LIMITS.extensions,
    ...(imagesSupported ? [".png", ".jpg", ".jpeg", ".webp"] : []),
  ].join(",");
  const support = `4 files · UTF-8 text/source: 64 KiB each, ${Math.floor((capabilities?.textTotalBytes ?? ATTACHMENT_LIMITS.totalBytes) / 1024)} KiB total. ${imagesSupported ? `Static PNG/JPEG/WebP: ${Math.floor(capabilities.imageFileBytes / 1024)} KiB each, ${Math.floor(capabilities.imageTotalBytes / 1024)} KiB total, 4096 pixels per edge.` : "Images are unavailable for this connection."} PDFs and other binary files are not supported.`;
  useLayoutEffect(() => {
    const field = textarea.current;
    if (!field) return;
    const resize = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(field).lineHeight) || 24;
      const limit = lineHeight * 6;
      field.style.height = "auto";
      const contentHeight = field.scrollHeight;
      field.style.height = `${Math.min(limit, Math.max(lineHeight, contentHeight))}px`;
      field.style.overflowY = contentHeight > limit ? "auto" : "hidden";
    };
    resize();
    if (typeof ResizeObserver === "undefined") return;
    let width = field.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = field.getBoundingClientRect().width;
      if (nextWidth !== width) {
        width = nextWidth;
        resize();
      }
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [draft]);
  return (
    <form
      className={`composer${dragging ? " composer-dragging" : ""}`}
      onSubmit={(event) => {
        if (dictation.active) event.preventDefault();
        else onSend(event);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled) onFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {attachments.length > 0 && (
        <ul className="attachment-previews" aria-label="Attached files">
          {attachments.map((item) => (
            <li key={item.id} className={`attachment-preview ${item.status}`} title={item.name}>
              <button
                type="button"
                className="attachment-remove"
                aria-label={`Remove ${item.name}`}
                disabled={disabled}
                onClick={() => onRemove(item.id)}
              >
                <Icon kind="close" />
              </button>
              {item.status === "reading" ? (
                <span role="status">Reading…</span>
              ) : item.status === "error" ? (
                <span role="alert">{item.error}</span>
              ) : item.attachment!.mediaType === "text/plain" ? (
                <details className="attachment-text">
                  <summary title={item.name}>
                    <Icon kind="file" />
                    <span>{item.name}</span>
                  </summary>
                  <pre>{item.attachment!.text}</pre>
                </details>
              ) : (
                <img
                  className="attachment-image"
                  alt={`Preview of ${item.name}`}
                  src={`data:${item.attachment!.mediaType};base64,${item.attachment!.data}`}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <label className="sr-only" htmlFor="message">
        Message your crew
      </label>
      <textarea
        ref={textarea}
        id="message"
        placeholder="Describe a change or ask about the work…"
        rows={1}
        value={draft}
        disabled={disabled}
        onChange={(event) => onDraft(event.target.value)}
        onPaste={(event) => {
          if (event.clipboardData.files.length) {
            event.preventDefault();
            if (!disabled) onFiles(Array.from(event.clipboardData.files));
          }
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            if (canSend && !dictation.active) event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      {draft.length > 8000 && (
        <p role="alert" className="composer-error">
          The prompt exceeds 8,000 characters. Shorten it before sending; nothing has been
          truncated.
        </p>
      )}
      <div className="composer-footer">
        <input
          ref={input}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose attachments"
          accept={extensions}
          multiple
          disabled={disabled}
          onChange={(event) => {
            onFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="composer-attach"
          title={support}
          aria-label="Attach files"
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          <Icon kind="plus" />
        </button>
        {modelControls && <div className="composer-models">{modelControls}</div>}
        <div className="composer-actions">
          <button
            type="button"
            className={`composer-mic${dictation.active ? " recording" : ""}`}
            aria-label={dictation.active ? "Stop dictation" : "Dictate message"}
            aria-pressed={dictation.active}
            title={
              dictation.supported
                ? dictation.active
                  ? "Stop dictation"
                  : "Dictate message"
                : "On-device dictation unavailable in this browser"
            }
            disabled={disabled || !dictationEnabled}
            onClick={() => void dictation.toggle()}
          >
            <Icon kind={dictation.active ? "stopped" : "microphone"} />
          </button>
          <button
            type="submit"
            className="composer-send"
            aria-label={sending ? "Sending message" : "Send message"}
            title="Send message"
            disabled={!canSend || dictation.active}
          >
            <Icon kind={sending ? "working" : "send"} />
          </button>
        </div>
      </div>
      {dictation.phase !== "idle" && (
        <span className="sr-only" role="status">
          {dictation.phase === "installing"
            ? "Downloading dictation language"
            : dictation.phase === "checking"
              ? "Checking on-device dictation"
              : "Listening"}
        </span>
      )}
      {dictation.error && (
        <p className="dictation-error" role="alert">
          {dictation.error}
        </p>
      )}
      {dictation.downloadable && (
        <button
          type="button"
          className="dictation-download"
          disabled={dictation.active}
          onClick={() => void dictation.install()}
        >
          Download dictation language
        </button>
      )}
    </form>
  );
}

export async function readAttachment(file: File, id: string): Promise<SubmittedAttachment> {
  const imageType = /\.png$/i.test(file.name)
    ? "image/png"
    : /\.jpe?g$/i.test(file.name)
      ? "image/jpeg"
      : /\.webp$/i.test(file.name)
        ? "image/webp"
        : undefined;
  if (file.size > (imageType ? ATTACHMENT_LIMITS.imageFileBytes : ATTACHMENT_LIMITS.fileBytes))
    throw Error("attachment_too_large");
  const bytes = file.arrayBuffer
    ? await file.arrayBuffer()
    : await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(Error("attachment_read_failed"));
        reader.onabort = () => reject(Error("attachment_read_failed"));
        reader.readAsArrayBuffer(file);
      });
  const attachment: SubmittedAttachment = imageType
    ? {
        id,
        name: file.name,
        mediaType: imageType,
        data: btoa(Array.from(new Uint8Array(bytes), (byte) => String.fromCharCode(byte)).join("")),
      }
    : {
        id,
        name: file.name,
        mediaType: "text/plain",
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      };
  validateMessageAttachments([attachment]);
  return attachment;
}
