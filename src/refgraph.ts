// src/refgraph.ts
import { basename } from 'node:path';
import type { Modality } from './types.js';

interface RefInput { path: string; modality: Modality; content: Buffer; }

// TS source → its compiled specifier extension (ESM/NodeNext imports use the .js form).
const TS_TO_JS: Record<string, string> = { ts: 'js', tsx: 'jsx', mts: 'mjs', cts: 'cjs' };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Basenames to look for when detecting references to `path`: its own basename,
// plus the compiled `.js` specifier form for TS sources (so an import of
// './classify.js' counts as a reference to classify.ts).
function candidateBasenames(path: string): string[] {
  const base = basename(path);
  const out = [base];
  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    const ext = base.slice(dot + 1);
    if (ext in TS_TO_JS) out.push(`${base.slice(0, dot)}.${TS_TO_JS[ext]}`);
  }
  return out;
}

// True when `base` appears in `text` as a standalone path token — not as a
// substring of a longer filename (issue.ts inside find-issue.ts) and not as a
// shorter extension inside a longer one (.ts inside .tsx).
function mentionsToken(text: string, base: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_\\-.])${escapeRe(base)}(?![A-Za-z0-9])`).test(text);
}

// Only text-class files can "reference" others. Matching is path-token aware
// (word-boundaried basename) with TS→JS specifier equivalence — not a raw substring.
export function buildRefGraph(files: RefInput[]): Map<string, string[]> {
  const texts = files
    .filter((f) => f.modality === 'text' || f.modality === 'vector_diagram')
    .map((f) => ({ path: f.path, text: f.content.toString('utf8') }));

  const graph = new Map<string, string[]>();
  for (const target of files) {
    const bases = candidateBasenames(target.path);
    const refs: string[] = [];
    for (const src of texts) {
      if (src.path === target.path) continue;
      if (bases.some((b) => mentionsToken(src.text, b))) refs.push(src.path);
    }
    graph.set(target.path, refs);
  }
  return graph;
}
