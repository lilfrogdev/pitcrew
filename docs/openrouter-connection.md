# OpenRouter connection

Each authenticated Pitcrew user saves and removes their own key in **Profile → Providers**. Save replaces that user's key. The password field clears immediately on submission, failure, and navigation. The browser does not persist keys in localStorage, conversations, or repository configuration. No endpoint returns keys or validates them by calling OpenRouter.

## Identity and storage

The Worker verifies Cloudflare Access RS256 signature, issuer, audience, expiry, subject, and exact email allowlist before provider operations. Mutations require the exact application Origin. The credential owner comes from the verified `access:<sub>` principal, never a request body, query, email hint, or forwarded browser identity header. The existing Access issuer is fixed for this deployment; changing issuers requires explicit credential migration/reset rather than reusing subjects.

`USER_CREDENTIALS` addresses one SQLite Durable Object per principal. `UserCredentials` checks its own object ID against the supplied principal. Only a versioned AES-256-GCM ciphertext and fresh 96-bit IV are persisted. Authenticated additional data binds the record to its version, provider, and principal. The separate `CREDENTIAL_ENCRYPTION_KEY` Worker secret is a canonical base64 encoding of 32 random bytes. Missing storage, malformed encryption keys, corruption, and decryption errors fail closed with stable error codes. This is application isolation and encrypted storage under trusted infrastructure administration: Cloudflare/account administrators who control Worker secrets or code can access the keys.

GET `/api/provider-connection/openrouter` returns only `available`, `storageAvailable`, `configured`, and `executionEnabled` booleans. POST accepts exactly `{action:"store",key:"…"}` or `{action:"remove"}`, with an 8 KiB bound. No read/export route exists. Responses are private/no-store. Save does not check upstream validity or enable execution. Status reflects persisted storage across restarts. Provider error details are replaced with a stable code before Pi stores or exposes them.

## Runtime

Conversation turns freeze their initiating principal. Direct runs, intake dispatch, delegation, and retries carry that principal into the worker and reviewer admission and persist it across restart. A retry uses the user who initiated the retry. The OpenRouter credential store resolves that user's current record for every model request, including follow-up tool calls. Removing a key blocks subsequent requests and queued work using it. A provider HTTP request already sent before deletion may finish; deletion does not undo prior spending or revoke the key at OpenRouter. Replacing a key affects the next lookup.

There is no global `OPENROUTER_API_KEY` fallback, no other-user lookup, and no ambient credential discovery for OpenRouter. The historical model configuration `secretBinding` field is retained for catalog compatibility but ignored by the OpenRouter runtime. Legacy queued work without a frozen principal fails closed and must be resubmitted. Catalog metadata contains no credentials. Capabilities are unavailable when the requesting user's credential cannot be read.

## Local controller

The opt-in `PITCREW_OPENROUTER_SETUP=true` helper uses `PITCREW_ACCESS_SESSION=user-cache` and the existing verified user Access session. It forwards only provider status/save/remove to the fixed protected backend, rebuilding headers from that session. It no longer uses Wrangler OAuth or writes a shared Worker secret. The retired `PITCREW_OPENROUTER_AUTH_CONTEXT` setting grants no access. The local signed-in identity is the verified cloudflared cache for that OS user; no browser-supplied owner selector is accepted.

Loopback listener/peer, exact Host/Origin, HttpOnly Strict cookie plus matching expiring nonce, body bounds, capacity, and write serialization guard the helper. Cloud authentication failures and backend diagnostics return stable codes. No inference or arbitrary URL proxy is added. Work capabilities continue to use their separately configured backend; installing this helper alone does not route or enable paid execution.

## Production provisioning — separate approval required

This branch is local and production execution remains disabled. An approved rollout must:

1. Provision the `USER_CREDENTIALS` binding and `v4` SQLite class migration from the backend config.
2. Generate and install `CREDENTIAL_ENCRYPTION_KEY` through the approved secret-management path. Never commit it, place it in UI/build variables, or print it. No encryption secret was generated or installed by this implementation task.
3. Deploy the reviewed Worker and frontend/controller together, preserving the Access protection and exact owner/Bryan allowlist. Provisioning and deployment require explicit approval.
4. Have each user enter their own existing OpenRouter key. There is no migration from the shared slot. Any removal of the old global binding is a separate approved infrastructure action; this runtime ignores it.
5. Keep `EXECUTION_MODE`, `INFRASTRUCTURE_ADMISSION_ENABLED`, and `CLOUD_CONVERSATION_ENABLED` off until the separate execution and budget approval. No paid verification is needed to test storage.

Keep the encryption secret backed up under the infrastructure owner's controls. Replacing it without migration makes all saved records unreadable; this minimal implementation intentionally has no automatic key rotation. Users can replace or remove their records once the new key is provisioned. SQLite/platform backup retention may retain old ciphertext after logical deletion; deletion blocks live retrieval but does not claim physical erasure from backups. Access issuer/subject changes likewise require controlled migration or fresh user entry.

## Catalog snapshot

Verified 2026-10-05 from [OpenRouter catalog](https://openrouter.ai/api/v1/models),
[Qwen endpoint capabilities](https://openrouter.ai/api/v1/models/qwen/qwen3.8-flash/endpoints) and
[reasoning documentation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).
Prices are USD per million tokens and can change; reasoning tokens are billed as output.

| ID                                      | Input/output price | Inputs admitted by Pitcrew | Reasoning selection                |
| --------------------------------------- | ------------------ | -------------------------- | ---------------------------------- |
| `qwen/qwen3.8-flash`                    | $0.15 / $0.47      | text, images               | Off (budgets pending verification) |
| `deepseek/deepseek-v4-flash`            | $0.027 / $1.28     | text                       | Off, High, Xhigh                   |
| `deepseek/deepseek-v4-flash-0731`       | $0.0152 / $1.28    | text                       | Off, Low, High, Max                |
| `deepseek/deepseek-v4-flash-vision-exp` | $0.2156 / $0.6468  | text, images               | Off, Low, High, Max                |

Both image-capable choices use Pi's conservative resize limits (2000 px, 4.5 MiB before Pitcrew's
stricter request budget). Pitcrew admits at most two images per message/request, max 1 MiB each,
subject to the smaller total request budget. These are application safeguards, not claimed provider
hard limits. Video is not admitted by the existing attachment contract. No latest aliases are selected
automatically and no equivalent performance is assumed.

All integration verification uses synthetic credentials, native local Durable Objects and mocked provider
transport. Real inference/private image transfer is a separate explicit user action; OpenRouter usage
is billed outside the Cloudflare infrastructure budget.
