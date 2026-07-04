// src/agent-resolver.ts
// Deterministic reviewer/synthesis -> agent resolution. Pure, no LLM, no I/O beyond the
// already-loaded AuditConfig. CI (composite actions) and local-audit.sh both resolve through
// this so they cannot drift (docs/superpowers/specs/2026-07-04-pluggable-agent-engine.md §How.6).
import type { AgentType, AuditConfig, ReviewerName } from './types.js';
import { loadConfig } from './config.js';

export interface ResolvedAgent {
  id: string;
  type: AgentType;
  model?: string;
  max_turns?: number;
  command?: string;
  warning?: string; // set when the requested agent id was missing and we degraded to claude default
}

function resolveAgentId(config: AuditConfig, id: string): ResolvedAgent {
  const entry = config.agents[id];
  if (!entry) {
    return {
      id,
      type: 'claude',
      warning: `agent "${id}" not found in agents registry; falling back to claude default`,
    };
  }
  const resolved: ResolvedAgent = { id, type: entry.type };
  if (entry.model !== undefined) resolved.model = entry.model;
  if (entry.max_turns !== undefined) resolved.max_turns = entry.max_turns;
  if (entry.command !== undefined) resolved.command = entry.command;
  return resolved;
}

export function resolveReviewerAgent(config: AuditConfig, reviewer: ReviewerName): ResolvedAgent {
  const id = config.reviewers[reviewer]?.agent ?? 'default';
  return resolveAgentId(config, id);
}

export function resolveSynthesisAgent(config: AuditConfig): ResolvedAgent {
  const id = config.synthesis?.agent ?? 'default';
  return resolveAgentId(config, id);
}

// CLI: agent-resolver.ts <repoRoot> <reviewer|--synthesis>
if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = process.argv[2] ?? process.cwd();
  const target = process.argv[3];
  const config = loadConfig(repoRoot);
  const resolved = target === '--synthesis'
    ? resolveSynthesisAgent(config)
    : resolveReviewerAgent(config, target as ReviewerName);
  process.stdout.write(JSON.stringify(resolved) + '\n');
}
