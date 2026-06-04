// src/types.ts
export type Severity = 'low' | 'medium' | 'high';

export type ReviewerName =
  | 'docs_staleness'
  | 'code_hygiene'
  | 'spec_flow'
  | 'visual_icon'
  | 'duplicate_orphan'
  | 'convention'
  | 'i18n';

export type Modality = 'text' | 'vector_diagram' | 'raster_image' | 'binary';

export type Category =
  | 'code' | 'doc' | 'spec' | 'visual' | 'flow' | 'icon' | 'config' | 'other';

export interface ReviewerConfig {
  enabled: boolean;
  paths?: string[];
  rubric?: string; // repo 內相對路徑
}

export interface AuditConfig {
  version: number;
  reviewers: Record<ReviewerName, ReviewerConfig>;
  report: { issueLabel: string; minSeverity: Severity };
}

export interface FileEntry {
  path: string;          // 相對 repo root，POSIX 分隔
  modality: Modality;
  category: Category;
  sizeBytes: number;
  hash: string;          // sha256 hex；binary 也算
  oversizedText: boolean; // 文字類且 > MAX_FILE_KB
  lastCommitISO: string | null; // 無 git 記錄為 null
  referencedBy: string[];       // 哪些檔在內文提及此檔 basename
}

export interface ConventionSource {
  path: string;          // 探索到的規範來源檔
  kind: 'claude_md' | 'skill' | 'workflow' | 'gha_workflow' | 'audit_yml';
}

export interface Inventory {
  repoRoot: string;
  generatedAtISO: string;
  config: AuditConfig;
  conventions: ConventionSource[];
  files: FileEntry[];
}

export const MAX_FILE_KB = 100;
