// src/finalize.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { validateReviewerOutput } from './findings.js';
import { validateSynthesisOutput } from './synthesis.js';
import type { ReviewerOutput, SynthesisOutput, ReviewerName } from './types.js';

export function finalizeReviewerOutput(raw: unknown, reviewer: ReviewerName): ReviewerOutput {
  if (validateReviewerOutput(raw).valid && (raw as ReviewerOutput).reviewer === reviewer) {
    return raw as ReviewerOutput;
  }
  return { reviewer, status: 'failed', findings: [] };
}

export function finalizeSynthesis(raw: unknown): SynthesisOutput {
  if (validateSynthesisOutput(raw).valid) return raw as SynthesisOutput;
  return { themes: [], semantic_duplicates: [], executive_summary: '', status: 'failed' };
}

function readJsonOrNull(path: string): unknown {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// CLI: finalize.ts reviewer <reviewer> <file>   |   finalize.ts synthesis <file>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [kind, a, b] = process.argv.slice(2);
  if (kind === 'reviewer') {
    writeFileSync(b, JSON.stringify(finalizeReviewerOutput(readJsonOrNull(b), a as ReviewerName), null, 2));
  } else if (kind === 'synthesis') {
    writeFileSync(a, JSON.stringify(finalizeSynthesis(readJsonOrNull(a)), null, 2));
  } else {
    process.stderr.write('Usage: finalize.ts reviewer <reviewer> <file> | synthesis <file>\n');
    process.exit(1);
  }
}
