/** Canonical account-local ASCII repository name, independent of runtime bindings. */
export function logicalRepositoryName(value: unknown): string {
  if (typeof value !== "string") throw Error("invalid_name");
  const trimmed = value.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(trimmed)) throw Error("invalid_name");
  return trimmed.toLowerCase();
}
