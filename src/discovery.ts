// src/discovery.ts
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { classify } from './classify.js';
import { listFiles, isLockfile } from './scan.js';
import { sha256 } from './hash.js';
import { lastCommitTimes } from './gitmeta.js';
import { buildRefGraph } from './refgraph.js';
import { MAX_FILE_KB } from './types.js';
import type { Inventory, FileEntry, ConventionSource } from './types.js';

function discoverConventions(repoRoot: string): ConventionSource[] {
  const out: ConventionSource[] = [];
  const add = (rel: string, kind: ConventionSource['kind']) => {
    if (existsSync(join(repoRoot, rel))) out.push({ path: rel, kind });
  };
  add('CLAUDE.md', 'claude_md');
  add('.claude/audit.yml', 'audit_yml');
  // 目錄型來源用 git ls-files 前綴過濾
  for (const f of listFiles(repoRoot)) {
    if (f.startsWith('.claude/skills/')) out.push({ path: f, kind: 'skill' });
    else if (f.startsWith('.claude/workflows/')) out.push({ path: f, kind: 'workflow' });
    else if (f.startsWith('.github/workflows/')) out.push({ path: f, kind: 'gha_workflow' });
  }
  return out;
}

export function discover(repoRoot: string): Inventory {
  const config = loadConfig(repoRoot);
  const paths = listFiles(repoRoot);
  const times = lastCommitTimes(repoRoot, paths);

  const raw = paths.map((p) => {
    const content = readFileSync(join(repoRoot, p));
    const { modality, category } = classify(p, content);
    return { path: p, content, modality, category };
  });

  const graph = buildRefGraph(raw.map((r) => ({ path: r.path, modality: r.modality, content: r.content })));

  const files: FileEntry[] = raw.map((r) => {
    const sizeBytes = statSync(join(repoRoot, r.path)).size;
    const oversizedText =
      (r.modality === 'text' || r.modality === 'vector_diagram') &&
      sizeBytes > MAX_FILE_KB * 1024;
    return {
      path: r.path,
      modality: r.modality,
      category: isLockfile(r.path) ? 'other' : r.category,
      sizeBytes,
      hash: sha256(r.content),
      oversizedText,
      lastCommitISO: times.get(r.path) ?? null,
      referencedBy: graph.get(r.path) ?? [],
    };
  });

  return {
    repoRoot,
    generatedAtISO: new Date().toISOString(),
    config,
    conventions: discoverConventions(repoRoot),
    files,
  };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = process.argv[2] ?? process.cwd();
  const json = JSON.stringify(discover(repoRoot), null, 2);
  const outPath = process.argv[3];
  if (outPath) writeFileSync(outPath, json + '\n');
  else process.stdout.write(json + '\n');
}
