/** Shared storage format for production and local emulator fixtures. */
export function readRepositoryState(sql: Pick<SqlStorage, "exec">): string | undefined {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS repository_state(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS repository_state_chunks(part INTEGER PRIMARY KEY,value TEXT NOT NULL)",
  );
  const chunks = [
    ...sql.exec<{ value: string }>("SELECT value FROM repository_state_chunks ORDER BY part"),
  ];
  return chunks.length
    ? chunks.map((chunk) => chunk.value).join("")
    : [...sql.exec<{ value: string }>("SELECT value FROM repository_state WHERE id=1")][0]?.value;
}
/** Caller owns the transaction, including any configuration and admission checks. */
export function writeRepositoryState(sql: Pick<SqlStorage, "exec">, value: string) {
  readRepositoryState(sql);
  sql.exec("DELETE FROM repository_state_chunks");
  // At most 512 KiB of UTF-8 per record, even for four-byte characters.
  for (let offset = 0, part = 0; offset < value.length; part++) {
    let end = Math.min(offset + 131072, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
    sql.exec("INSERT INTO repository_state_chunks VALUES(?,?)", part, value.slice(offset, end));
    offset = end;
  }
  sql.exec("DELETE FROM repository_state WHERE id=1");
}
