import { DurableObject } from "cloudflare:workers";
import {
  encryptCredential,
  decryptCredential,
  validCredentialActor,
  type CredentialEnv,
  type EncryptedCredential,
} from "./user-credentials";

/** One object per authenticated principal. Only ciphertext is persisted. */
export class UserCredentials extends DurableObject<CredentialEnv> {
  constructor(ctx: DurableObjectState, env: CredentialEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS credential(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
    );
  }
  private assertOwner(actor: string) {
    if (
      !validCredentialActor(actor) ||
      !this.env.USER_CREDENTIALS ||
      !this.ctx.id.equals(this.env.USER_CREDENTIALS.idFromName(`openrouter:${actor}`))
    )
      throw Error("provider_identity_required");
  }
  async save(actor: string, key: string) {
    this.assertOwner(actor);
    await this.ctx.blockConcurrencyWhile(async () => {
      const value = await encryptCredential(actor, key, this.env.CREDENTIAL_ENCRYPTION_KEY);
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO credential VALUES(1,?)",
        JSON.stringify(value),
      );
    });
  }
  async read(actor: string) {
    this.assertOwner(actor);
    return this.ctx.blockConcurrencyWhile(async () => {
      const row = [
        ...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM credential WHERE id=1"),
      ][0];
      return row
        ? decryptCredential(
            actor,
            JSON.parse(row.value) as EncryptedCredential,
            this.env.CREDENTIAL_ENCRYPTION_KEY,
          )
        : undefined;
    });
  }
  async configured(actor: string) {
    return !!(await this.read(actor));
  }
  async remove(actor: string) {
    this.assertOwner(actor);
    this.ctx.storage.sql.exec("DELETE FROM credential WHERE id=1");
  }
}
