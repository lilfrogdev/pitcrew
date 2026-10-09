import { useMentionPicker } from "./mentions/Picker";
import type { Member } from "./api";
import type { AgentMention, MessageDestination, SubmittedMention } from "@pitcrew/protocol";
import { useLayoutEffect, useRef, useState } from "react";
import {
  ATTACHMENT_LIMITS,
  type UploadSubmission,
  type UploadReceipt,
  validateMessageAttachments,
  type SubmittedAttachment,
  type AttachmentCapabilities,
} from "@pitcrew/protocol";
import { UploadPreview } from "./uploads/Preview";
import uploadStyles from "./uploads/uploads.module.css";
import { Icon } from "./icons";
import { useDictation } from "./useDictation";

export interface AttachmentDraft {
  id: string;
  name: string;
  status: "reading" | "uploading" | "ready" | "error";
  attachment?: SubmittedAttachment | UploadSubmission;
  size?: number;
  upload?: UploadReceipt;
  preview?: string;
  video?: boolean;
  progress?: number;
  modelInput?: "text" | "image" | "storage";
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
  onRetry,
  uploadsEnabled = false,
  onSend,
  disabled,
  sending,
  canSend,
  capabilities,
  modelControls,
  sessionKey = "composer",
  dictationEnabled = true,
  attachmentsEnabled = true,
  onTyping,
  onTypingStop,
  mentionMembers = [],
  onMention,
  onAgentMention,
  destination = "team",
  onDestination,
  invoking = false,
}: {
  draft: string;
  onDraft: (text: string, typed?: boolean, replaced?: AgentMention) => void;
  attachments: AttachmentDraft[];
  onFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
  onRetry?: (id: string) => void;
  uploadsEnabled?: boolean;
  onSend: (event: React.FormEvent) => void;
  disabled: boolean;
  sending: boolean;
  canSend: boolean;
  capabilities?: AttachmentCapabilities;
  modelControls?: React.ReactNode;
  sessionKey?: string;
  dictationEnabled?: boolean;
  attachmentsEnabled?: boolean;
  onTyping?: (hasInput: boolean) => void;
  onTypingStop?: () => void;
  mentionMembers?: Member[];
  onMention?: (text: string, mention: SubmittedMention) => void;
  onAgentMention?: (text: string, mention: AgentMention) => void;
  destination?: MessageDestination;
  onDestination?: (destination: MessageDestination) => void;
  invoking?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const mentions = useMentionPicker(
    draft,
    disabled ? [] : mentionMembers,
    sessionKey,
    textarea,
    onDraft,
    onMention,
    onAgentMention,
  );
  const escapeTab = useRef(false);
  const literalInput = useRef(false);
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
      style={{ position: "relative" }}
      className={`composer${dragging ? " composer-dragging" : ""}`}
      onSubmit={(event) => {
        if (dictation.active) event.preventDefault();
        else {
          onTypingStop?.();
          onSend(event);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          if (!disabled && attachmentsEnabled) setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!event.dataTransfer.files.length) literalInput.current = true;
        if (!disabled && attachmentsEnabled) onFiles(Array.from(event.dataTransfer.files));
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
              {item.size !== undefined ? (
                <UploadPreview
                  {...item}
                  disabled={disabled}
                  capabilities={capabilities}
                  receipt={item.upload}
                  retry={item.status === "error" ? () => onRetry?.(item.id) : undefined}
                />
              ) : item.status === "reading" ? (
                <span role="status">Reading…</span>
              ) : item.status === "error" ? (
                <span role="alert">{item.error}</span>
              ) : ("mediaType" in item.attachment! ? item.attachment!.mediaType : undefined) ===
                "text/plain" ? (
                <details className="attachment-text">
                  <summary title={item.name}>
                    <Icon kind="file" />
                    <span>{item.name}</span>
                  </summary>
                  <pre>{"text" in item.attachment! ? item.attachment!.text : ""}</pre>
                </details>
              ) : (
                <img
                  className="attachment-image"
                  alt={`Preview of ${item.name}`}
                  src={`data:${"mediaType" in item.attachment! ? item.attachment!.mediaType : undefined};base64,${"data" in item.attachment! ? item.attachment!.data : ""}`}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <label className="sr-only" htmlFor="message">
        Message your crew
      </label>
      {mentions.picker}
      <textarea
        role="combobox"
        {...mentions.aria}
        onFocus={(event) => {
          escapeTab.current = false;
          mentions.selection(event.currentTarget);
        }}
        onSelect={(event) => mentions.selection(event.currentTarget)}
        ref={textarea}
        id="message"
        placeholder={
          destination === "agent" ? "Ask the agent about the work…" : "Message your team…"
        }
        aria-describedby="composer-keyboard"
        rows={1}
        value={draft}
        disabled={disabled}
        onChange={(event) => {
          const inputType = (event.nativeEvent as InputEvent).inputType;
          mentions.change(
            event.target,
            !literalInput.current && inputType === "insertText" && !mentions.composing,
          );
          onTyping?.(event.target.value.length > 0);
        }}
        onCompositionStart={() => {
          mentions.setComposing(true);
          onTyping?.(true);
        }}
        onCompositionUpdate={() => onTyping?.(true)}
        onCompositionEnd={(event) => {
          mentions.setComposing(false);
          mentions.selection(event.currentTarget);
          onTyping?.(event.currentTarget.value.length > 0);
        }}
        onBlur={() => {
          mentions.blur();
          onTypingStop?.();
        }}
        onPaste={(event) => {
          const replaced = {
            start: event.currentTarget.selectionStart,
            end: event.currentTarget.selectionEnd,
          };
          if (event.clipboardData.files.length) {
            event.preventDefault();
            if (!disabled && attachmentsEnabled) onFiles(Array.from(event.clipboardData.files));
          } else {
            literalInput.current = true;
            // React emits no change when a paste replaces a token with identical text.
            mentions.change(event.currentTarget, false, replaced);
          }
        }}
        onKeyDown={(event) => {
          if (
            event.key.length === 1 &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            !mentions.composing &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          )
            literalInput.current = false;
          if (event.key === "Escape") escapeTab.current = true;
          if (mentions.key(event)) return;
          if (
            event.key === "Tab" &&
            !event.shiftKey &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !mentions.composing &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229 &&
            onDestination
          ) {
            if (escapeTab.current) {
              escapeTab.current = false;
              return;
            }
            event.preventDefault();
            onDestination(destination === "team" ? "agent" : "team");
            return;
          }
          if (event.key !== "Escape") escapeTab.current = false;
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !mentions.composing &&
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
      {uploadsEnabled && attachments.length > 0 && (
        <p className={uploadStyles.hint}>
          4 files · 8 MiB each · 16 MiB total. Stored files are private to this thread.
        </p>
      )}
      <span id="composer-keyboard" className="sr-only">
        Tab switches between Team and Agent. Escape then Tab moves to the next control. Shift+Tab
        moves to the previous control.
      </span>
      <div className="composer-footer">
        <div className="composer-destination" role="group" aria-label="Message destination">
          {(["team", "agent"] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={destination === value}
              disabled={disabled}
              onClick={() => onDestination?.(value)}
            >
              {value === "team" ? "Team" : "Agent"}
            </button>
          ))}
        </div>
        <span className="sr-only" role="status" aria-live="polite">
          {destination === "agent"
            ? "Destination: Agent"
            : invoking
              ? "Destination: Team, agent mentioned"
              : "Destination: Team"}
        </span>
        <input
          ref={input}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose attachments"
          accept={uploadsEnabled ? undefined : extensions}
          multiple
          disabled={disabled || !attachmentsEnabled}
          onChange={(event) => {
            onFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="composer-attach"
          title={
            attachmentsEnabled
              ? uploadsEnabled
                ? "Images, videos and files · 4 files · 8 MiB each · 16 MiB total"
                : support
              : "Attachments unavailable for this connection."
          }
          aria-label="Attach files"
          disabled={disabled || !attachmentsEnabled}
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
            aria-label={
              sending ? (invoking ? "Sending to agent" : "Sending team message") : "Send message"
            }
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
