export interface CredentialEnv {
  USER_CREDENTIALS?: DurableObjectNamespace<import("./user-credentials-agent").UserCredentials>;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  EXECUTION_MODE?: string;
  INFRASTRUCTURE_ADMISSION_ENABLED?: string;
  CLOUD_CONVERSATION_ENABLED?: string;
}
export interface EncryptedCredential {
  version: 1;
  iv: string;
  ciphertext: string;
}
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
export function validCredentialActor(actor: unknown): actor is string {
  return typeof actor === "string" && actor.length > 0 && actor.length <= 256;
}
export function validOpenRouterKey(key: unknown): key is string {
  return typeof key === "string" && /^sk-or-v1-[a-zA-Z0-9_-]{16,4000}$/.test(key);
}
async function encryptionKey(secret?: string) {
  if (!secret || !/^[A-Za-z0-9+/]{43}=$/.test(secret)) throw Error("provider_storage_unavailable");
  const bytes = decode(secret);
  if (bytes.length !== 32 || encode(bytes) !== secret) throw Error("provider_storage_unavailable");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export function credentialStorageAvailable(env: CredentialEnv) {
  return !!env.USER_CREDENTIALS && /^[A-Za-z0-9+/]{43}=$/.test(env.CREDENTIAL_ENCRYPTION_KEY ?? "");
}
function authenticatedData(actor: string) {
  if (!validCredentialActor(actor)) throw Error("provider_identity_required");
  return new TextEncoder().encode(JSON.stringify([1, "openrouter", actor]));
}
export async function encryptCredential(
  actor: string,
  key: string,
  secret?: string,
): Promise<EncryptedCredential> {
  if (!validOpenRouterKey(key)) throw Error("provider_request_invalid");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: authenticatedData(actor), tagLength: 128 },
    await encryptionKey(secret),
    new TextEncoder().encode(key),
  );
  return { version: 1, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}
export async function decryptCredential(
  actor: string,
  value: EncryptedCredential,
  secret?: string,
) {
  try {
    if (value.version !== 1 || value.iv.length !== 16 || value.ciphertext.length > 5500)
      throw Error();
    const result = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decode(value.iv),
        additionalData: authenticatedData(actor),
        tagLength: 128,
      },
      await encryptionKey(secret),
      decode(value.ciphertext),
    );
    const key = new TextDecoder("utf-8", { fatal: true }).decode(result);
    if (!validOpenRouterKey(key)) throw Error();
    return key;
  } catch {
    throw Error("provider_storage_unavailable");
  }
}
export function userCredential(env: CredentialEnv, actor?: string) {
  if (!validCredentialActor(actor)) throw Error("provider_identity_required");
  if (!credentialStorageAvailable(env)) throw Error("provider_storage_unavailable");
  return env.USER_CREDENTIALS!.get(env.USER_CREDENTIALS!.idFromName(`openrouter:${actor}`));
}
/** Only trusted server callers receive plaintext. This function has no HTTP route. */
export async function readUserOpenRouterKey(env: CredentialEnv, actor?: string) {
  try {
    const key = await userCredential(env, actor).read(actor!);
    if (!key) throw Error();
    return key;
  } catch {
    throw Error("provider_credential_unavailable");
  }
}
export async function providerConnectionRequest(
  request: Request,
  env: CredentialEnv,
  actor: string,
) {
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers });
  const status = (configured: boolean) => ({
    available: true,
    storageAvailable: credentialStorageAvailable(env),
    configured,
    executionEnabled:
      configured &&
      env.EXECUTION_MODE === "cloud" &&
      env.INFRASTRUCTURE_ADMISSION_ENABLED === "true" &&
      env.CLOUD_CONVERSATION_ENABLED === "true",
  });
  if (new URL(request.url).search) return reply({ error: "provider_request_invalid" }, 400);
  if (!["GET", "POST"].includes(request.method))
    return reply({ error: "provider_method_not_allowed" }, 405);
  if (!credentialStorageAvailable(env))
    return request.method === "GET"
      ? reply(status(false))
      : reply({ error: "provider_storage_unavailable" }, 503);
  try {
    const credential = userCredential(env, actor);
    if (request.method === "GET") return reply(status(await credential.configured(actor)));
    if (
      request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json" ||
      request.headers.has("content-encoding")
    )
      return reply({ error: "provider_request_invalid" }, 400);
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) {
          await reader.cancel();
          return reply({ error: "body_too_large" }, 413);
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let body: { action?: unknown; key?: unknown };
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return reply({ error: "provider_request_invalid" }, 400);
    }
    const fields =
      body && typeof body === "object" && !Array.isArray(body)
        ? Object.keys(body).sort().join(",")
        : "";
    if (fields === "action,key" && body.action === "store" && validOpenRouterKey(body.key)) {
      await credential.save(actor, body.key);
      return reply(status(true));
    }
    if (fields === "action" && body.action === "remove") {
      await credential.remove(actor);
      return reply(status(false));
    }
    return reply({ error: "provider_request_invalid" }, 400);
  } catch {
    return reply({ error: "provider_storage_unavailable" }, 503);
  }
}

/** Bind only the trusted initiating identity; no credential value is copied into model configuration. */
export function userModelEnv<T extends CredentialEnv>(env: T, actor?: string) {
  return { ...env, openRouterKey: () => readUserOpenRouterKey(env, actor) };
}
