// src/config.ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { AuditConfig, ReviewerName, ReviewerConfig } from './types.js';
import { REVIEWER_NAMES } from './types.js';

export function defaultConfig(): AuditConfig {
  const reviewers = {} as Record<ReviewerName, ReviewerConfig>;
  for (const r of REVIEWER_NAMES) reviewers[r] = { enabled: r !== 'i18n' };
  return { version: 1, reviewers, report: { issueLabel: 'audit', minSeverity: 'low' }, ignore: [] };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function mergeConfig(base: AuditConfig, over: DeepPartial<AuditConfig>): AuditConfig {
  const out: AuditConfig = structuredClone(base);
  if (over.version !== undefined) out.version = over.version;
  const ig = (over as { ignore?: unknown }).ignore;
  if (Array.isArray(ig)) out.ignore = ig.map(String);
  if (over.report) {
    const r = over.report as Record<string, unknown>;
    const label = r.issueLabel ?? r.issue_label;
    const minSev = r.minSeverity ?? r.min_severity;
    if (label !== undefined) out.report.issueLabel = String(label);
    if (minSev !== undefined) out.report.minSeverity = minSev as AuditConfig['report']['minSeverity'];
  }
  if (over.reviewers) {
    for (const [name, cfg] of Object.entries(over.reviewers)) {
      const key = name as ReviewerName;
      if (out.reviewers[key]) Object.assign(out.reviewers[key], cfg);
    }
  }
  return out;
}

export function loadConfig(repoRoot: string): AuditConfig {
  const p = join(repoRoot, '.claude', 'audit.yml');
  if (!existsSync(p)) return defaultConfig();
  const parsed = parse(readFileSync(p, 'utf8')) ?? {};
  return mergeConfig(defaultConfig(), parsed as DeepPartial<AuditConfig>);
}
