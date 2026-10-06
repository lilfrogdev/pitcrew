/** Read-only repository content. These identifiers never confer Git authority. */
export interface SourceBinding {
  projectId: string;
  threadId: string;
  sourceId: string;
  sha: string;
  version: string;
}
export type SourceEntry = {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "submodule";
  mode: string;
};
export interface SourceTree extends SourceBinding {
  path: string;
  entries: SourceEntry[];
  cursor: string | null;
}
export type SourceContent = {
  path: string;
  status: "text" | "binary" | "too_large" | "symlink" | "submodule";
  bytes?: number;
  text?: string;
};
export interface SourceFile extends SourceBinding, SourceContent {}
export interface DiffBinding {
  projectId: string;
  threadId: string;
  runId: string;
  sourceId: string;
  artifactId: string;
  baseSha: string;
  candidateSha: string;
  configurationRevision: string;
  version: string;
}
export interface DiffEntry {
  path: string;
  change: "added" | "deleted" | "modified";
  beforeMode?: string;
  afterMode?: string;
}
export interface SourceDiff extends DiffBinding {
  entries: DiffEntry[];
  total: number;
  cursor: string | null;
  /** Renames are displayed as an addition and a deletion. */
  renameDetection: false;
}
export interface SourcePatch extends DiffBinding {
  path: string;
  status: SourceContent["status"] | "mode_only";
  patch?: string;
  beforeMode?: string;
  afterMode?: string;
}
export interface SourceApi {
  tree(threadId: string, path?: string, version?: string, cursor?: string): Promise<SourceTree>;
  file(threadId: string, path: string, version: string): Promise<SourceFile>;
  diff(threadId: string, runId: string, version?: string, cursor?: string): Promise<SourceDiff>;
  patch(threadId: string, runId: string, path: string, version: string): Promise<SourcePatch>;
}
