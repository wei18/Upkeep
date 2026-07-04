// src/types.ts
export const SEVERITIES = ['low', 'medium', 'high'] as const;
export type Severity = typeof SEVERITIES[number];

/** Ordinal rank per severity (low=0 … high=2); also valid for Confidence (same domain). */
export const SEVERITY_RANK: Record<Severity, number> =
  Object.fromEntries(SEVERITIES.map((s, i) => [s, i])) as Record<Severity, number>;

/** Membership set for validating severity/confidence/priority values (shared by findings/synthesis validators). */
export const SEVERITY_LEVELS = new Set<string>(SEVERITIES);

export const REVIEWER_NAMES = [
  'docs_staleness', 'code_hygiene', 'spec_flow',
  'visual_icon', 'duplicate_orphan', 'convention', 'i18n',
] as const;
export type ReviewerName = typeof REVIEWER_NAMES[number];

export type Modality = 'text' | 'vector_diagram' | 'raster_image' | 'binary';

export type Category =
  | 'code' | 'doc' | 'spec' | 'visual' | 'flow' | 'icon' | 'config' | 'other';

export interface ReviewerConfig {
  enabled: boolean;
  paths?: string[];
  rubric?: string; // repo 內相對路徑
  agent?: string; // agents registry 中的 id；未設定 → "default"
}

/** built-in adapter id. Phase 1 只出 claude（既有路徑）與 command（generic escape hatch）。 */
export type AgentType = 'claude' | 'command';

export interface AgentConfig {
  type: AgentType;
  model?: string;     // 未設定 → 落回 workflow 的 `model` input
  max_turns?: number; // 未設定 → 落回 workflow 的 `max_turns` input
  command?: string;   // type: command 專用；{prompt}/{output}/{target} 為唯一 placeholder token
}

export interface AuditConfig {
  version: number;
  reviewers: Record<ReviewerName, ReviewerConfig>;
  report: { issueLabel: string; minSeverity: Severity };
  ignore: string[]; // glob paths dropped from the inventory entirely (all reviewers)
  agents: Record<string, AgentConfig>; // 至少含 "default"；無 `agents:` 區塊 → 隱含 { default: { type: 'claude' } }
  synthesis: { agent: string };        // synthesis 使用的 agent id；預設 "default"
}

export interface FileEntry {
  path: string;          // 相對 repo root，POSIX 分隔
  modality: Modality;
  category: Category;
  sizeBytes: number;
  hash: string;          // sha256 hex；binary 也算
  oversizedText: boolean; // 文字類且 > MAX_FILE_KB
  lastCommitISO: string | null; // 無 git 記錄為 null
  referencedBy: string[];       // 哪些檔在內文以路徑 token 提及此檔 basename（word-boundary；TS 源也認 .js specifier）
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

export type Confidence = Severity; // same domain: low | medium | high

export const FINDING_CATEGORIES = [
  'staleness', 'duplicate', 'orphan', 'convention', 'inconsistency', 'i18n_sync', 'other',
] as const;
export type FindingCategory = typeof FINDING_CATEGORIES[number];

export const SSOT_DIRECTIONS = ['stale_a', 'stale_b', 'uncertain', 'n/a'] as const;
export type SsotDirection = typeof SSOT_DIRECTIONS[number];

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
  // 繼承的 `reviewer`（單數）= 代表 finding 的擁有者；顯示一律用 `reviewers`（聯集）
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
