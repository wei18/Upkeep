// test/classify.test.ts
import { describe, it, expect } from 'vitest';
import { classify } from '../src/classify.js';

const txt = (s: string) => Buffer.from(s, 'utf8');

describe('classify', () => {
  it('source code', () => {
    expect(classify('src/App.swift', txt('struct A {}')))
      .toEqual({ modality: 'text', category: 'code' });
  });

  it('ESM/CJS TypeScript variants are code (consistent with refgraph TS_TO_JS)', () => {
    for (const p of ['src/a.mts', 'src/a.cts', 'src/a.mjs', 'src/a.cjs']) {
      expect(classify(p, txt('export {}')).category).toBe('code');
    }
  });
  it('markdown doc', () => {
    expect(classify('README.md', txt('# hi')).category).toBe('doc');
  });
  it('spec path', () => {
    expect(classify('docs/spec/flow.md', txt('x')).category).toBe('spec');
  });
  it('raster image is not byte-capped as text', () => {
    expect(classify('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])))
      .toEqual({ modality: 'raster_image', category: 'visual' });
  });
  it('icon by name', () => {
    expect(classify('Assets.xcassets/AppIcon.appiconset/icon.png', txt('')).category)
      .toBe('icon');
  });
  it('vector diagram is text-modality', () => {
    expect(classify('docs/flow.mmd', txt('graph TD; A-->B')))
      .toEqual({ modality: 'vector_diagram', category: 'flow' });
  });
  it('a generic .svg is a design asset (visual), not a flowchart (design §2)', () => {
    expect(classify('assets/logo.svg', txt('<svg/>')))
      .toEqual({ modality: 'vector_diagram', category: 'visual' });
  });
  it('a flow-named .svg stays a flowchart', () => {
    expect(classify('docs/auth-flow.svg', txt('<svg/>')).category).toBe('flow');
  });
  it('diagram-language vectors (.dot/.puml) remain flow', () => {
    expect(classify('docs/graph.dot', txt('digraph{}')).category).toBe('flow');
    expect(classify('docs/seq.puml', txt('@startuml')).category).toBe('flow');
  });
  it('binary content with NUL byte', () => {
    expect(classify('data.bin', Buffer.from([1, 0, 2])).modality).toBe('binary');
  });
  it('test file with .spec. suffix is code, not spec', () => {
    expect(classify('src/auth.spec.ts', txt('test()')).category).toBe('code');
  });
  it('"flow" as a word-internal substring is not flow category', () => {
    expect(classify('src/overflow.ts', txt('x')).category).toBe('code');
    expect(classify('docs/workflow.md', txt('x')).category).toBe('doc');
  });
  it('"icon" in a directory name does not make a file an icon', () => {
    expect(classify('src/iconography/util.ts', txt('x')).category).toBe('code');
  });
});
