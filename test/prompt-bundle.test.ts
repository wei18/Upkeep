// test/prompt-bundle.test.ts
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { buildReviewerPrompt, buildSynthesisPrompt } from '../src/prompt-bundle.js';
import { defaultConfig } from '../src/config.js';
import type { Inventory, FileEntry } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

function file(path: string, category: FileEntry['category']): FileEntry {
  return { path, category, modality: 'text', sizeBytes: 1, hash: 'x', oversizedText: false, lastCommitISO: null, referencedBy: [] };
}
const inv: Inventory = {
  repoRoot: '/r', generatedAtISO: 't', config: defaultConfig(),
  conventions: [{ path: 'CLAUDE.md', kind: 'claude_md' }],
  files: [file('README.md', 'doc'), file('src/a.ts', 'code')],
};

describe('buildReviewerPrompt', () => {
  it('embeds reviewer name, builtin rubric, convention source, and target files', () => {
    const p = buildReviewerPrompt('docs_staleness', inv, ROOT);
    expect(p).toContain('docs_staleness');
    expect(p).toMatch(/multi|多語/);
    expect(p).toContain('CLAUDE.md');
    expect(p).toContain('README.md');
    expect(p).not.toContain('src/a.ts');
    expect(p).toContain('findings/');
    expect(p).not.toContain('{{REVIEWER}}');
  });
});

describe('buildSynthesisPrompt', () => {
  it('returns the synthesis template', () => {
    expect(buildSynthesisPrompt(ROOT)).toContain('synthesis.json');
  });
});
