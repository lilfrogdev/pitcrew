import type {
  UploadReceipt,
  AttachmentCapabilities,
  StoredFileAttachment,
} from "@pitcrew/protocol";
import styles from "./uploads.module.css";
export function uploadInputLabel(row: UploadReceipt, capabilities?: AttachmentCapabilities) {
  if (row.input === "text") return "Text available to crew";
  if (row.input === "image" && capabilities?.images) return "Image available to crew";
  return "Stored only · crew cannot read this content";
}
export function UploadPreview({
  name,
  size,
  preview,
  video,
  status,
  progress,
  error,
  receipt,
  capabilities,
  retry,
  modelInput,
  disabled,
}: {
  name: string;
  size?: number;
  preview?: string;
  video?: boolean;
  status: "reading" | "uploading" | "ready" | "error";
  progress?: number;
  error?: string;
  receipt?: UploadReceipt;
  capabilities?: AttachmentCapabilities;
  retry?: () => void;
  modelInput?: "text" | "image" | "storage";
  disabled?: boolean;
}) {
  return (
    <div className={styles.preview}>
      {preview &&
        (video ? (
          <video src={preview} controls preload="metadata" aria-label={`Preview of ${name}`} />
        ) : (
          <img src={preview} alt={`Preview of ${name}`} />
        ))}
      <strong>{name}</strong>
      {size !== undefined && (
        <span>
          {size < 1024
            ? `${size} B`
            : size < 1024 * 1024
              ? `${(size / 1024).toFixed(1)} KiB`
              : `${(size / 1024 / 1024).toFixed(1)} MiB`}
        </span>
      )}
      {status === "uploading" && (
        <span role="status">
          Uploading {progress ?? 0}%
          <progress max={100} value={progress ?? 0} aria-label={`Uploading ${name}`} />
        </span>
      )}
      {status === "error" && (
        <>
          <span role="alert">{error ?? "Upload failed. Retry or remove the file."}</span>
          {retry && (
            <button type="button" disabled={disabled} onClick={retry}>
              Retry {name}
            </button>
          )}
        </>
      )}
      {status === "ready" && receipt && (
        <span>
          {modelInput === "storage"
            ? "Stored only · crew cannot read this content"
            : uploadInputLabel(receipt, capabilities)}
        </span>
      )}
    </div>
  );
}
export function StoredFile({ attachment, url }: { attachment: StoredFileAttachment; url: string }) {
  return (
    <div className={styles.stored}>
      <a href={url} download={attachment.name}>
        {attachment.name}
      </a>
      <span>
        {(attachment.size / 1024).toFixed(1)} KiB · Stored only · crew cannot read this content
      </span>
    </div>
  );
}
