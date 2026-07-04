// src/config.ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { AgentConfig, AuditConfig, ReviewerName, ReviewerConfig } from './types.js';
import { REVIEWER_NAMES } from './types.js';

export function defaultConfig(): AuditConfig {
  const reviewers = {} as Record<ReviewerName, ReviewerConfig>;
  for (const r of REVIEWER_NAMES) reviewers[r] = { enabled: r !== 'i18n' };
  return {
    version: 1,
    reviewers,
    report: { issueLabel: 'audit', minSeverity: 'low' },
    ignore: [],
    agents: { default: { type: 'claude' } },
    synthesis: { agent: 'default' },
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

// 解析單一 agents.<id> 條目，欄位級合併到既有條目（若有）之上 — 跟 reviewers.<n> 的 Object.assign
// 合併方式一致，而非整物件替換。`existing` 存在時（如 "default"）省略 `type` 一律保留既有 type；
// 全新 id 缺 type、或 command 型缺 command 字串，一律回傳 null 並丟棄（不 crash — 跟 finalize 的
// degradation 慣例一致，由 resolver 端在 reviewer/synthesis 指向缺失 id 時落回 claude default）。
function parseAgentEntry(existing: AgentConfig | undefined, raw: unknown): AgentConfig | null {
  if (!raw || typeof raw !== 'object') return existing ?? null;
  const a = raw as Record<string, unknown>;
  const type = a.type === 'claude' || a.type === 'command' ? a.type : existing?.type;
  if (type === undefined) return null; // 全新 id 又沒給合法 type -> 丟棄
  const entry: AgentConfig = { type };
  const model = typeof a.model === 'string' ? a.model : existing?.model;
  if (model !== undefined) entry.model = model;
  const maxTurns = typeof a.max_turns === 'number' ? a.max_turns : existing?.max_turns;
  if (maxTurns !== undefined) entry.max_turns = maxTurns;
  if (type === 'command') {
    const command = typeof a.command === 'string' && a.command.trim() ? a.command : existing?.command;
    if (!command) return existing ?? null; // command 型缺 command 字串 -> 保留舊值（若有）否則丟棄
    entry.command = command;
  }
  return entry;
}

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
  const agents = (over as { agents?: unknown }).agents;
  if (agents && typeof agents === 'object') {
    for (const [id, raw] of Object.entries(agents as Record<string, unknown>)) {
      const entry = parseAgentEntry(out.agents[id], raw);
      if (entry) out.agents[id] = entry;
    }
  }
  const synthesis = (over as { synthesis?: unknown }).synthesis;
  if (synthesis && typeof synthesis === 'object') {
    const agentId = (synthesis as Record<string, unknown>).agent;
    if (typeof agentId === 'string') out.synthesis.agent = agentId;
  }
  return out;
}

export function loadConfig(repoRoot: string): AuditConfig {
  const p = join(repoRoot, '.claude', 'audit.yml');
  if (!existsSync(p)) return defaultConfig();
  const parsed = parse(readFileSync(p, 'utf8')) ?? {};
  return mergeConfig(defaultConfig(), parsed as DeepPartial<AuditConfig>);
}
