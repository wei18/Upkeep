// test/locale-parity.test.ts
// Guards the two sync rules in CLAUDE.md: reviewer prompts (en <-> zh-TW) and docs code blocks (5 locales).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReviewerOutput } from '../src/findings.js';
import { validateSynthesisOutput } from '../src/synthesis.js';
import { FINDING_CATEGORIES, SEVERITIES, SSOT_DIRECTIONS } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Fenced code blocks of a markdown file, each as its full text (fence lines included). */
function fencedBlocks(md: string): string[] {
  const blocks: string[] = [];
  let open: string[] | null = null;
  for (const line of md.split('\n')) {
    const isFence = line.trimStart().startsWith('```');
    if (open) {
      open.push(line);
      if (isFence) { blocks.push(open.join('\n')); open = null; }
    } else if (isFence) {
      open = [line];
    }
  }
  return blocks;
}

/** One structural token per line; text inside a fenced block counts as "code". */
function lineShape(md: string): string[] {
  let inFence = false;
  return md.split('\n').map((line) => {
    const isFence = line.trimStart().startsWith('```');
    if (isFence) { inFence = !inFence; return 'fence'; }
    if (inFence) return 'code';
    const heading = /^(#+) /.exec(line);
    if (heading) return `h${heading[1].length}`;
    if (/^\s*- /.test(line)) return `bullet@${line.length - line.trimStart().length}`;
    if (/^\s*\d+\. /.test(line)) return 'numbered';
    if (line.startsWith('|')) return 'table-row';
    if (line.startsWith('>')) return 'quote';
    return line.trim() === '' ? 'blank' : 'text';
  });
}

/** The first ```json block of a prompt file, parsed. */
function jsonContract(md: string): unknown {
  const block = fencedBlocks(md).find((b) => b.startsWith('```json'));
  if (!block) throw new Error('no ```json block');
  return JSON.parse(block.split('\n').slice(1, -1).join('\n'));
}

/** Same JSON with every free-text string blanked, so only keys and enum values are compared. */
function contractSkeleton(value: unknown, enumKeys: Set<string>, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => contractSkeleton(v, enumKeys, key));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, contractSkeleton(v, enumKeys, k)]));
  }
  return enumKeys.has(key) ? value : '';
}

describe('reviewer prompts: en <-> zh-TW parity', () => {
  const BASE = 'en';
  const OTHER = 'zh-TW';
  const files = readdirSync(join(ROOT, 'reviewers', BASE)).sort();

  it('both locales hold the same files', () => {
    expect(readdirSync(join(ROOT, 'reviewers', OTHER)).sort()).toEqual(files);
  });

  it('every file has the same structure, line for line', () => {
    for (const f of files) {
      expect(lineShape(read(`reviewers/${OTHER}/${f}`)), f).toEqual(lineShape(read(`reviewers/${BASE}/${f}`)));
    }
  });

  it('the JSON contract examples have the same keys and enum values', () => {
    const enumKeys = new Set(['reviewer', 'status', 'category', 'severity', 'confidence', 'ssot_direction', 'priority']);
    for (const f of ['_reviewer-prompt.md', '_synthesis-prompt.md']) {
      expect(contractSkeleton(jsonContract(read(`reviewers/${OTHER}/${f}`)), enumKeys), f)
        .toEqual(contractSkeleton(jsonContract(read(`reviewers/${BASE}/${f}`)), enumKeys));
    }
  });

  it('the contract examples pass the validators the pipeline uses', () => {
    for (const locale of [BASE, OTHER]) {
      const reviewer = read(`reviewers/${locale}/_reviewer-prompt.md`).replaceAll('{{REVIEWER}}', 'docs_staleness');
      expect(validateReviewerOutput(jsonContract(reviewer)).errors, locale).toEqual([]);
      expect(validateSynthesisOutput(jsonContract(read(`reviewers/${locale}/_synthesis-prompt.md`))).errors, locale).toEqual([]);
    }
  });

  it('the reviewer prompt defines every allowed enum value', () => {
    for (const locale of [BASE, OTHER]) {
      const text = read(`reviewers/${locale}/_reviewer-prompt.md`);
      for (const value of [...FINDING_CATEGORIES, ...SEVERITIES, ...SSOT_DIRECTIONS]) {
        expect(text, `${locale}: ${value}`).toContain(`| \`${value}\` |`);
      }
    }
  });
});

describe('docs: fenced code blocks are byte-identical across locales', () => {
  const LOCALES = ['zh-TW', 'zh-CN', 'ja', 'ko'];
  const DOCS: Array<[base: string, name: string]> = [
    ['README.md', 'README.md'],
    ['docs/en/overview.md', 'overview.md'],
    ['docs/en/design.md', 'design.md'],
    ['docs/en/why-reusable-workflow.md', 'why-reusable-workflow.md'],
  ];

  it.each(DOCS)('%s', (base, name) => {
    const expected = fencedBlocks(read(base));
    for (const locale of LOCALES) {
      expect(fencedBlocks(read(`docs/${locale}/${name}`)), `docs/${locale}/${name}`).toEqual(expected);
    }
  });
});
