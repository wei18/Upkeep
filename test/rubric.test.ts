// test/rubric.test.ts
import { describe, it, expect } from 'vitest';
import { composeRubric } from '../src/rubric.js';
import { defaultConfig } from '../src/config.js';
import type { Inventory, FileEntry } from '../src/types.js';

function file(path: string, category: FileEntry['category']): FileEntry {
  return {
    path, category, modality: 'text', sizeBytes: 1, hash: 'x',
    oversizedText: false, lastCommitISO: null, referencedBy: [],
  };
}

function inv(files: FileEntry[], over: Partial<Inventory> = {}): Inventory {
  return {
    repoRoot: '/r', generatedAtISO: 't', config: defaultConfig(),
    conventions: [{ path: 'CLAUDE.md', kind: 'claude_md' }],
    files, ...over,
  };
}

describe('composeRubric', () => {
  it('selects target files by the reviewer category domain', () => {
    const i = inv([file('README.md', 'doc'), file('src/a.ts', 'code'), file('docs/g.md', 'doc')]);
    const b = composeRubric('docs_staleness', i, '/action');
    expect(b.targetFiles.sort()).toEqual(['README.md', 'docs/g.md']);
  });

  it('points builtinRubric at the action reviewers dir', () => {
    const b = composeRubric('docs_staleness', inv([]), '/action');
    expect(b.builtinRubric).toBe('/action/reviewers/docs_staleness.md');
  });

  it('carries repo convention sources', () => {
    const b = composeRubric('convention', inv([file('x.ts', 'code')]), '/action');
    expect(b.conventionSources).toEqual(['CLAUDE.md']);
  });

  it('passes through audit.yml explicit rubric override', () => {
    const cfg = defaultConfig();
    cfg.reviewers.docs_staleness.rubric = '.claude/audit/docs.md';
    const b = composeRubric('docs_staleness', inv([], { config: cfg }), '/action');
    expect(b.explicitRubric).toBe('.claude/audit/docs.md');
  });

  it('explicitRubric is null when not configured', () => {
    expect(composeRubric('docs_staleness', inv([]), '/action').explicitRubric).toBeNull();
  });

  it('whole-repo reviewers see all categories', () => {
    const i = inv([file('a.ts', 'code'), file('b.png', 'visual'), file('c.md', 'doc')]);
    expect(composeRubric('duplicate_orphan', i, '/action').targetFiles.length).toBe(3);
  });
});
