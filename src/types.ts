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
  rubric?: string; // path relative to repo root
}

export interface AuditConfig {
  version: number;
  reviewers: Record<ReviewerName, ReviewerConfig>;
  report: { issueLabel: string; minSeverity: Severity };
  ignore: string[]; // glob paths dropped from the inventory entirely (all reviewers)
}

export interface FileEntry {
  path: string;          // relative to repo root, POSIX separators
  modality: Modality;
  category: Category;
  sizeBytes: number;
  hash: string;          // sha256 hex; computed for binary too
  oversizedText: boolean; // text-like and > MAX_FILE_KB
  lastCommitISO: string | null; // null when there's no git record
  referencedBy: string[];       // files whose body mentions this file's basename as a path token (word-boundary; TS sources also match a .js specifier)
}

export interface ConventionSource {
  path: string;          // discovered convention-source file
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
  file: string;            // primary file (cross-file issues go under the primary)
  related: string[];       // related files (may be an empty array)
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
  status: 'ok' | 'failed';  // findings must be empty when failed
  findings: Finding[];
}

export interface Theme {
  title: string;
  narrative: string;
  related_files: string[];   // file paths covered by this theme
  priority: Severity;
}

export interface SynthesisOutput {
  themes: Theme[];
  semantic_duplicates: string[][]; // each group is a set of "reviewer|file|category" keys
  executive_summary: string;
  status: 'ok' | 'failed';         // themes must be empty when failed
}

export interface ConsolidatedFinding extends Finding {
  // Inherited `reviewer` (singular) = the owner of the representative finding; display always uses `reviewers` (the union)
  reviewers: ReviewerName[];       // all reviewers that reported this file+category (union)
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
