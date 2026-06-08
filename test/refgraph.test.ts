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

  it('matches the .js specifier of a TS source (ESM/NodeNext imports), so it is not a false orphan', () => {
    const files = [
      { path: 'src/discovery.ts', modality: 'text' as const, content: Buffer.from("import { classify } from './classify.js';") },
      { path: 'src/classify.ts', modality: 'text' as const, content: Buffer.from('export const classify = 1;') },
    ];
    expect(buildRefGraph(files).get('src/classify.ts')).toEqual(['src/discovery.ts']);
  });

  it('does not match a basename embedded in a longer filename (substring false positive)', () => {
    const files = [
      { path: 'docs/x.md', modality: 'text' as const, content: Buffer.from('see report-issue.ts and find-issue.ts') },
      { path: 'src/issue.ts', modality: 'text' as const, content: Buffer.from('export const issue = 1;') },
      { path: 'src/report-issue.ts', modality: 'text' as const, content: Buffer.from('// report issue') },
    ];
    const g = buildRefGraph(files);
    expect(g.get('src/issue.ts')).toEqual([]); // report-issue.ts is not a reference to issue.ts
    expect(g.get('src/report-issue.ts')).toEqual(['docs/x.md']);
  });
});
