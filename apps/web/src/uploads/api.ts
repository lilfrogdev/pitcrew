import {
  validUploadId,
  validUploadName,
  UPLOAD_LIMITS,
  type UploadReceipt,
} from "@pitcrew/protocol";
export interface UploadApi {
  put(
    threadId: string,
    id: string,
    file: File,
    signal: AbortSignal,
    progress: (percent: number) => void,
  ): Promise<UploadReceipt>;
  remove(threadId: string, id: string): Promise<void>;
}
export function createUploadApi(headers: () => Promise<Record<string, string>>): UploadApi {
  const path = (thread: string, id: string) =>
    `/api/threads/${encodeURIComponent(thread)}/uploads/${encodeURIComponent(id)}`;
  return {
    async put(thread, id, file, signal, progress) {
      if (
        !validUploadId(id) ||
        !validUploadName(file.name) ||
        !file.size ||
        file.size > UPLOAD_LIMITS.fileBytes
      )
        throw Error("invalid_upload");
      const admission = await headers();
      if (signal.aborted) throw Error("upload_cancelled");
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const abort = () => xhr.abort();
        signal.addEventListener("abort", abort, { once: true });
        const finish = () => signal.removeEventListener("abort", abort);
        xhr.open("PUT", path(thread, id));
        xhr.timeout = 60000;
        for (const [name, value] of Object.entries(admission))
          if (name.toLowerCase() !== "content-type") xhr.setRequestHeader(name, value);
        xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
        xhr.setRequestHeader("X-Pitcrew-Filename", encodeURIComponent(file.name));
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable)
            progress(Math.min(99, Math.floor((event.loaded / event.total) * 100)));
        };
        xhr.onerror = xhr.ontimeout = () => {
          finish();
          reject(Error("upload_failed"));
        };
        xhr.onabort = () => {
          finish();
          reject(Error("upload_cancelled"));
        };
        xhr.onload = () => {
          finish();
          if (xhr.status === 401) window.dispatchEvent(new Event("pitcrew-auth-required"));
          if (xhr.status < 200 || xhr.status >= 300) return reject(Error(`upload_${xhr.status}`));
          try {
            const row = JSON.parse(xhr.responseText) as UploadReceipt;
            if (
              row.uploadId !== id ||
              row.name !== file.name ||
              row.size !== file.size ||
              !["text", "image", "storage"].includes(row.input) ||
              !Number.isFinite(row.expiresAt)
            )
              throw Error();
            resolve(row);
          } catch {
            reject(Error("upload_failed"));
          }
        };
        xhr.send(file);
      });
    },
    async remove(thread, id) {
      const response = await fetch(path(thread, id), {
        method: "DELETE",
        headers: await headers(),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok && response.status !== 404) throw Error("upload_cleanup_failed");
    },
  };
}
