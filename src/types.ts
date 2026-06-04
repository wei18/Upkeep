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

export type Confidence = 'low' | 'medium' | 'high';

export type FindingCategory =
  | 'staleness'
  | 'duplicate'
  | 'orphan'
  | 'convention'
  | 'inconsistency'
  | 'i18n_sync'
  | 'other';

export type SsotDirection = 'stale_a' | 'stale_b' | 'uncertain' | 'n/a';

export interface Finding {
  file: string;            // 主體檔（跨檔問題放主檔）
  related: string[];       // 關聯檔（可空陣列）
  reviewer: ReviewerName;
  category: FindingCategory;
  problem: string;
  evidence: string;
  suggestion: string;
  severity: Severity;
  confidence: Confidence;
  ssot_direction: SsotDirection;
}

export interface ReviewerOutput {
  reviewer: ReviewerName;
  status: 'ok' | 'failed';  // failed 時 findings 必為空
  findings: Finding[];
}

export interface Theme {
  title: string;
  narrative: string;
  related_files: string[];   // 此主題涵蓋的檔路徑
  priority: Severity;
}

export interface SynthesisOutput {
  themes: Theme[];
  semantic_duplicates: string[][]; // 每組為 "reviewer|file|category" 鍵
  executive_summary: string;
  status: 'ok' | 'failed';         // failed 時 themes 必為空
}

export interface ConsolidatedFinding extends Finding {
  reviewers: ReviewerName[];       // 回報此 file+category 的所有 reviewer（聯集）
}

export interface ReportStats {
  total: number;
  bySeverity: Record<Severity, number>;
  byReviewer: Partial<Record<ReviewerName, number>>;
  failedReviewers: ReviewerName[];
}

export interface ConsolidatedReport {
  generatedAtISO: string;
  findings: ConsolidatedFinding[];
  themes: Theme[];
  executiveSummary: string;
  synthesisStatus: 'ok' | 'failed' | 'absent';
  stats: ReportStats;
}
