/** Logical repository names are normalized within the current owner's namespace. */
export function canonicalRepositoryName(value: string): string | undefined {
  const name = value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(name) ? name.toLowerCase() : undefined;
}
