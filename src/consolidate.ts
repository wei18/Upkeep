// src/consolidate.ts
import type {
  ReviewerOutput, Finding, ReviewerName, Severity, Theme,
  SynthesisOutput, ConsolidatedFinding, ConsolidatedReport, ReportStats,
} from './types.js';
import { SEVERITY_RANK, REVIEWER_NAMES } from './types.js';

// Reviewer enumeration order — the stable tiebreak for picking a group's
// representative finding (design §4), independent of file/findings load order.
const REVIEWER_RANK: Record<ReviewerName, number> =
  Object.fromEntries(REVIEWER_NAMES.map((r, i) => [r, i])) as Record<ReviewerName, number>;

function cmp(a: Finding, b: Finding): number {
  return (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    || (SEVERITY_RANK[b.confidence] - SEVERITY_RANK[a.confidence]);
}
function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function consolidate(
  outputs: ReviewerOutput[],
  synthesis: SynthesisOutput | null,
  opts: { generatedAtISO: string },
): ConsolidatedReport {
  const failedReviewers: ReviewerName[] = [];
  const flat: Finding[] = [];
  for (const o of outputs) {
    if (o.status === 'failed') { failedReviewers.push(o.reviewer); continue; }
    for (const fnd of o.findings) flat.push(fnd);
  }

  // group by file|category
  const groups = new Map<string, Finding[]>();
  for (const fnd of flat) {
    const key = `${fnd.file}|${fnd.category}`;
    const arr = groups.get(key);
    if (arr) arr.push(fnd); else groups.set(key, [fnd]);
  }

  // synthesis 判定的語意重複（鍵格式 "reviewer|file|category"）再合併一輪；
  // 去掉 reviewer 前綴即得本層的 file|category 群組鍵，查無對應群組的鍵忽略
  if (synthesis !== null && synthesis.status === 'ok') {
    for (const dup of synthesis.semantic_duplicates) {
      const keys = uniq(dup.map((k) => k.slice(k.indexOf('|') + 1))).filter((k) => groups.has(k));
      if (keys.length < 2) continue;
      const target = groups.get(keys[0])!;
      for (const k of keys.slice(1)) { target.push(...groups.get(k)!); groups.delete(k); }
    }
  }

  const merged: ConsolidatedFinding[] = [];
  for (const group of groups.values()) {
    // 代表：severity×confidence 最高；同分時依 reviewer 列舉序（design §4），不靠載入順序
    const rep = [...group].sort((a, b) => cmp(a, b) || (REVIEWER_RANK[a.reviewer] - REVIEWER_RANK[b.reviewer]))[0];
    merged.push({
      ...rep,
      reviewers: uniq(group.map((g) => g.reviewer)).sort() as ReviewerName[],
      related: uniq(group.flatMap((g) => g.related)).sort(),
    });
  }
  merged.sort((a, b) => cmp(a, b) || a.file.localeCompare(b.file));

  // synthesis 只在 status === 'ok' 才採用；用 if 讓 TS 正確 narrow synthesis 非空
  let themes: Theme[] = [];
  let executiveSummary = '';
  if (synthesis !== null && synthesis.status === 'ok') {
    themes = synthesis.themes;
    executiveSummary = synthesis.executive_summary;
  }

  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  const byReviewer: Partial<Record<ReviewerName, number>> = {};
  for (const m of merged) {
    bySeverity[m.severity] += 1;
    for (const r of m.reviewers) byReviewer[r] = (byReviewer[r] ?? 0) + 1;
  }
  const stats: ReportStats = { total: merged.length, bySeverity, byReviewer, failedReviewers };

  return {
    generatedAtISO: opts.generatedAtISO,
    findings: merged,
    themes,
    executiveSummary,
    synthesisStatus: synthesis === null ? 'absent' : synthesis.status,
    stats,
  };
}
