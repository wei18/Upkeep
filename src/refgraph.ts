// src/refgraph.ts
import { basename } from 'node:path';
import type { Modality } from './types.js';

interface RefInput { path: string; modality: Modality; content: Buffer; }

// 只有文字類檔能「引用」別人。以 basename 子字串比對（heuristic）。
export function buildRefGraph(files: RefInput[]): Map<string, string[]> {
  const texts = files
    .filter((f) => f.modality === 'text' || f.modality === 'vector_diagram')
    .map((f) => ({ path: f.path, text: f.content.toString('utf8') }));

  const graph = new Map<string, string[]>();
  for (const target of files) {
    const base = basename(target.path);
    const refs: string[] = [];
    for (const src of texts) {
      if (src.path === target.path) continue;
      if (src.text.includes(base)) refs.push(src.path);
    }
    graph.set(target.path, refs);
  }
  return graph;
}
