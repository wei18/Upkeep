// test/refgraph.test.ts
import { describe, it, expect } from 'vitest';
import { buildRefGraph } from '../src/refgraph.js';

describe('refgraph', () => {
  it('maps which text files mention a basename', () => {
    const files = [
      { path: 'README.md', modality: 'text' as const, content: Buffer.from('see logo.png here') },
      { path: 'assets/logo.png', modality: 'raster_image' as const, content: Buffer.from([0x89]) },
      { path: 'assets/orphan.png', modality: 'raster_image' as const, content: Buffer.from([0x89]) },
    ];
    const g = buildRefGraph(files);
    expect(g.get('assets/logo.png')).toEqual(['README.md']);
    expect(g.get('assets/orphan.png')).toEqual([]); // 孤兒
  });

  it('does not count a file referencing itself', () => {
    const files = [
      { path: 'a.md', modality: 'text' as const, content: Buffer.from('a.md title') },
    ];
    expect(buildRefGraph(files).get('a.md')).toEqual([]);
  });
});
