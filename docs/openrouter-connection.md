# OpenRouter connection

The user opens **Profile → Providers**, enters their existing key in a masked field, and selects
**Save**. The short storage hint identifies the Pitcrew Cloudflare Worker. Save also replaces an
existing key; **Remove** deletes the fixed binding. No separate checkbox or composer popup is used.
The field clears immediately, including on failure and navigation. The browser never persists a key
in localStorage, conversation state, or repository configuration. The agent must never enter,
inspect, capture, or test a real key.

The local controller is opt-in through `PITCREW_OPENROUTER_SETUP=true`. Storage has a separate,
default-off `PITCREW_OPENROUTER_AUTH_CONTEXT=user-preferences` option. Do not enable this option
without action-time approval for the subprocess auth boundary below. Route availability alone does
not indicate usable storage: public `storageAvailable` is false until this explicit option is enabled,
and the Profile form stays disabled. Actual OAuth validity is determined by the fixed preflight when
the user acts; status never claims cloud execution is connected.

Use the exact `http://127.0.0.1:<port>` origin; `localhost` and network hosts are rejected.
Managed preview installation belongs to the preview owner after parent review. Do not change port
5173 directly. A deployed static frontend needs the reviewed controller wired separately.

The controller requires loopback peer/listener, exact Host and Origin, and an expiring HttpOnly,
SameSite=Strict session cookie with a matching nonce header. It accepts at most 8 KiB JSON:
`{action:"store",key:"…"}` or exactly `{action:"remove"}`. Both mutations share a lock. The fixed
account is Pitcrew `004227d2029c56b084ce15356768def3`, Worker `pitcrew-backend`, secret binding
`OPENROUTER_API_KEY`. A read-only existence preflight precedes fixed secret put/delete commands.
Wrangler receives the key through stdin only; stdout/stderr are discarded and its log is redirected
to `/dev/null`. Temporary configuration contains public target metadata only. The Worker must stay
stable during save: Wrangler could create a draft if a trusted operator deletes it between preflight
and the write.

The secret persists encrypted in Cloudflare until replaced/removed. Local status records only a
successful mutation during this process; it cannot verify previously stored key material. No endpoint
returns the key or tests validity with OpenRouter. Replace/remove only with no active cloud runs.

## Subprocess auth proposal — approval pending

The managed service retains its isolated HOME. Only the fixed Wrangler preflight/store/remove child
receives `XDG_CONFIG_HOME=/Users/lilfrogdev/Library/Preferences`. This selects the existing macOS
Wrangler config directory `/Users/lilfrogdev/Library/Preferences/.wrangler`; it does not copy or symlink
credentials, expand the service HOME, or expose management credentials to the browser or Worker.
The option remains off in this candidate and must not be applied by the agent without approval.

Metadata confirmed `config/default.toml` exists in that normal-user directory and is absent in the
isolated HOME; no file contents or OAuth scopes were read. Existing Wrangler may read and refresh
its OAuth configuration, so approval must cover config-directory reads and refresh writes, including
any temporary/atomic replacement files it needs. This is access to existing auth, not permission to
create a new token, broaden scopes, run provider inference, or deploy execution settings. The fixed
child environment omits ambient API tokens. Legacy HOME-based Wrangler discovery still takes
precedence if the isolated HOME later gains a legacy config; keep that isolated directory absent.

## Backend handoff

Saving a key does not deploy or enable cloud execution. Ingress, authenticated local relay, execution
budgets and Cloudflare deployment configuration remain owned by the infrastructure task. The current
backend has execution disabled. The non-secret configuration below is a reviewed handoff, not an
automatic deployment. The initial testing choice is Qwen; it is not a permanent user preference.

```json
{
  "MODEL_CONFIGURATION": "{\"provider\":\"byok\",\"providerId\":\"openrouter\",\"model\":\"qwen/qwen3.8-flash\",\"secretBinding\":\"OPENROUTER_API_KEY\"}",
  "MODELS_CONFIGURATION": "[{\"id\":\"deepseek-flash\",\"configuration\":{\"provider\":\"byok\",\"providerId\":\"openrouter\",\"model\":\"deepseek/deepseek-v4-flash\",\"secretBinding\":\"OPENROUTER_API_KEY\"}},{\"id\":\"deepseek-flash-0731\",\"configuration\":{\"provider\":\"byok\",\"providerId\":\"openrouter\",\"model\":\"deepseek/deepseek-v4-flash-0731\",\"secretBinding\":\"OPENROUTER_API_KEY\"}},{\"id\":\"deepseek-vision\",\"configuration\":{\"provider\":\"byok\",\"providerId\":\"openrouter\",\"model\":\"deepseek/deepseek-v4-flash-vision-exp\",\"secretBinding\":\"OPENROUTER_API_KEY\"}}]"
}
```

The existing server catalog, thread picker and frozen run-model contracts apply. Missing credentials,
unsupported IDs/efforts and image-incompatible role selections fail closed. Secret binding names
and secret values are excluded from public choices. Qwen supports automatic/no tool choice;
required/specific tool forcing is rejected before provider transport. Qwen gateway catalog exposes
token budgets but omits named effort values; initial reasoning **Off** sends `reasoning.enabled:false`.
No arbitrary low effort or budget is advertised. DeepSeek's native supported effort mappings are retained.

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

All integration verification uses synthetic credentials, mocked subprocesses and mocked provider
transport. Real inference/private image transfer is a separate explicit user action; OpenRouter usage
is billed outside the Cloudflare infrastructure budget.
