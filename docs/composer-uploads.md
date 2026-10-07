# Composer uploads

The authenticated composer accepts images, videos and arbitrary files through its
native multiple-file picker, drag/drop and clipboard files. Uploads show a local
preview when the browser supports the format, filename, size, progress, failure,
retry and removal. Draft files remain scoped to their thread and are disposed on
account changes or access loss. Only explicitly selected files enter the upload
path.

## Storage and limits

Bytes are stored in the existing repository coordinator's SQLite Durable Object,
in 256 KiB chunks. No R2 bucket or other resource is required. A file is limited to
8 MiB; one message permits four files and 16 MiB total. An account can stage at
most 16 files and 32 MiB. The Durable Object admits 128 MiB of total upload bytes,
including committed uploads. Upload requests are serialized per isolate while
their body is buffered.

Unlinked stages expire after 24 hours. Existing Agent scheduling runs cleanup
without overwriting conversation wake jobs. Removing a stage leaves an owned,
expiring cancellation tombstone, preventing a pending PUT from resurrecting it.
Committed files remain linked to their message; the staging DELETE cannot remove
them. The initial implementation provides no committed-file deletion endpoint.

## API contract

All routes require the current authenticated account and live thread access. The
local relay requires its mutation nonce and same local origin on writes, holds the
backend session cookie privately, and rejects an account change during streaming.
Password mode uses the merged `/app/api` ingress; callers cannot choose an actor.

| Operation               | Route                                                   | Body / response                                                                                                                                 |
| ----------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage bytes             | `PUT /api/threads/:threadId/uploads/:uuid`              | Raw file bytes, MIME `Content-Type`, percent-encoded basename in `X-Pitcrew-Filename`; returns `{uploadId,name,mediaType,size,expiresAt,input}` |
| Read own stage          | `GET /api/threads/:threadId/uploads/:uuid`              | The same receipt; another account cannot inspect or adopt a stage                                                                               |
| Cancel own stage        | `DELETE /api/threads/:threadId/uploads/:uuid`           | `{ok:true}`; cancellation is idempotent                                                                                                         |
| Link to message         | Existing `POST /api/threads/:threadId/messages`         | `attachments: [{uploadId,modelInput}]`, with existing content, model selection and idempotency key                                              |
| Download committed file | Existing `GET /api/threads/:threadId/attachments/:uuid` | Exact bytes, authorized by live membership in the linked message's thread                                                                       |

Upload IDs are UUIDs. Names cannot contain paths, controls or bidi overrides. MIME
syntax and image structure are validated. The client never supplies storage keys,
ownership or trusted attachment metadata. Linking bytes and persisting message
metadata use the same SQLite transaction; a persistence failure restores the
unlinked stage and rolls back message state.

Generic downloads use `application/octet-stream`, a sanitized attachment filename,
`nosniff`, a restrictive CSP, and private/no-store caching. There are no public
object URLs or private filesystem paths in receipts. Local preview object URLs
are revoked on removal, successful send and disposal. HTML and SVG are never
rendered as active file previews.

## Model input is separate from storage

`input` identifies whether stored bytes are eligible for bounded UTF-8 text or
static-image input. The composer explicitly submits `modelInput` as `text`,
`image`, or `storage`, using the currently admitted provider capabilities and
remaining conversation limits. Unsupported images, videos, PDFs and other binary
files show **Stored only · crew cannot read this content**. Human-note threads
store files without model ingestion. Video previews do not imply model video
support. There is no automatic transcription, transcoding or paid inference.

The server validates explicit ingestion choices rather than silently downgrading
them. Storage-only file metadata reaches the conversation context, but its bytes
are not loaded into model messages or tools. Existing inline text/image
attachments remain compatible. An unchanged uncertain send retains its original
input decisions and idempotency key, including after transcript refresh, stage
expiry, or sends in other threads.
