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
/** Markdown file names in a directory, sorted (ignores `.DS_Store` and other strays). */
const markdownFiles = (rel: string) => readdirSync(join(ROOT, rel)).filter((f) => f.endsWith('.md')).sort();
const sorted = (xs: readonly string[]) => [...xs].sort();

const isFence = (line: string) => line.trimStart().startsWith('```');

/** Each line of a markdown file with whether it is inside a fenced block; fence lines count as inside. */
function withFenceState(md: string): Array<{ line: string; fence: boolean; inFence: boolean }> {
  let open = false;
  const out = md.split('\n').map((line) => {
    const fence = isFence(line);
    const inFence = open || fence;
    if (fence) open = !open;
    return { line, fence, inFence };
  });
  if (open) throw new Error('unterminated fenced code block');
  return out;
}

/** Fenced code blocks of a markdown file, each as its full text (fence lines included). */
function fencedBlocks(md: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const { line, fence, inFence } of withFenceState(md)) {
    if (!inFence) continue;
    if (current === null) { current = [line]; continue; }
    current.push(line);
    if (fence) { blocks.push(current.join('\n')); current = null; }
  }
  return blocks;
}

/** One structural token per line; text inside a fenced block counts as "code". */
function lineShape(md: string): string[] {
  return withFenceState(md).map(({ line, fence, inFence }) => {
    if (fence) return 'fence';
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

/** Backticked tokens of each line outside fenced blocks, sorted per line (word order differs between languages). */
function codeTokensPerLine(md: string): string[][] {
  return withFenceState(md).map(({ line, inFence }) => (inFence ? [] : sorted(line.match(/`[^`]*`/g) ?? [])));
}

/** The first ```json block of a prompt file, parsed. */
function jsonContract(md: string): unknown {
  const block = fencedBlocks(md).find((b) => b.startsWith('```json'));
  if (!block) throw new Error('no ```json block');
  return JSON.parse(block.split('\n').slice(1, -1).join('\n'));
}

// Contract fields whose value is a closed set in src/types.ts (ReviewerName, status, FindingCategory,
// Severity, Confidence, SsotDirection, Theme.priority). Every other string in the examples is free text.
const ENUM_KEYS = new Set(['reviewer', 'status', 'category', 'severity', 'confidence', 'ssot_direction', 'priority']);

/** Same JSON with every free-text string blanked, so only keys and enum values are compared. */
function contractSkeleton(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => contractSkeleton(v, key));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, contractSkeleton(v, k)]));
  }
  return ENUM_KEYS.has(key) ? value : '';
}

/**
 * The enum tables of the reviewer prompt: field name -> values in the first column.
 * A table belongs to the nearest preceding line that starts with a backticked field name.
 */
function enumTables(md: string): Record<string, string[]> {
  const tables: Record<string, string[]> = {};
  let field: string | null = null;
  for (const { line, inFence } of withFenceState(md)) {
    if (inFence) continue;
    const intro = /^`([a-z_]+)`/.exec(line);
    if (intro) { field = intro[1]; continue; }
    const row = /^\| `([^`]+)` \|/.exec(line);
    if (row && field) (tables[field] ??= []).push(row[1]);
  }
  return tables;
}

/** Category values a rubric names: the backticked tokens that follow the word "category" on a line. */
function rubricCategories(md: string): string[] {
  return withFenceState(md).flatMap(({ line, inFence }) => {
    const at = inFence ? -1 : line.toLowerCase().lastIndexOf('category');
    if (at < 0) return [];
    return (line.slice(at).match(/`[^`]*`/g) ?? []).map((t) => t.slice(1, -1));
  });
}

describe('reviewer prompts: en <-> zh-TW parity', () => {
  const BASE = 'en';
  const OTHER = 'zh-TW';
  const LOCALES = [BASE, OTHER];
  const files = markdownFiles(`reviewers/${BASE}`);
  const rubrics = files.filter((f) => !f.startsWith('_'));

  it('both locales hold the same files', () => {
    expect(markdownFiles(`reviewers/${OTHER}`)).toEqual(files);
  });

  it.each(files)('%s has the same structure, line for line', (f) => {
    expect(lineShape(read(`reviewers/${OTHER}/${f}`))).toEqual(lineShape(read(`reviewers/${BASE}/${f}`)));
  });

  it.each(files)('%s names the same code tokens on every line', (f) => {
    expect(codeTokensPerLine(read(`reviewers/${OTHER}/${f}`))).toEqual(codeTokensPerLine(read(`reviewers/${BASE}/${f}`)));
  });

  it.each(['_reviewer-prompt.md', '_synthesis-prompt.md'])('%s: the JSON contract example has the same keys and enum values', (f) => {
    expect(contractSkeleton(jsonContract(read(`reviewers/${OTHER}/${f}`))))
      .toEqual(contractSkeleton(jsonContract(read(`reviewers/${BASE}/${f}`))));
  });

  it.each(LOCALES)('%s: the contract examples pass the validators the pipeline uses', (locale) => {
    const reviewer = read(`reviewers/${locale}/_reviewer-prompt.md`).replaceAll('{{REVIEWER}}', 'docs_staleness');
    expect(validateReviewerOutput(jsonContract(reviewer)).errors).toEqual([]);
    expect(validateSynthesisOutput(jsonContract(read(`reviewers/${locale}/_synthesis-prompt.md`))).errors).toEqual([]);
  });

  it.each(LOCALES)('%s: each enum table lists exactly the values in src/types.ts', (locale) => {
    const tables = enumTables(read(`reviewers/${locale}/_reviewer-prompt.md`));
    expect(Object.fromEntries(Object.entries(tables).map(([field, values]) => [field, sorted(values)]))).toEqual({
      category: sorted(FINDING_CATEGORIES),
      severity: sorted(SEVERITIES),
      confidence: sorted(SEVERITIES), // Confidence shares Severity's domain (src/types.ts)
      ssot_direction: sorted(SSOT_DIRECTIONS),
    });
  });

  it.each(LOCALES.flatMap((locale) => rubrics.map((f) => `${locale}/${f}`)))('%s names only categories from src/types.ts', (rel) => {
    const named = rubricCategories(read(`reviewers/${rel}`));
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((c) => !(FINDING_CATEGORIES as readonly string[]).includes(c))).toEqual([]);
  });
});

describe('docs: locale file sets and fenced code blocks', () => {
  const LOCALES = ['zh-TW', 'zh-CN', 'ja', 'ko'];
  const ROOT_README = 'README.md'; // the English base of README lives at the repo root, not in docs/en
  const baseDocs = markdownFiles('docs/en');
  const pairs: Array<[name: string, base: string]> = [
    [ROOT_README, ROOT_README],
    ...baseDocs.map((name): [string, string] => [name, `docs/en/${name}`]),
  ];

  it('docs/en holds no README (the root README.md is the base)', () => {
    expect(baseDocs).not.toContain(ROOT_README);
  });

  it.each(LOCALES)('docs/%s holds the same documents as the English base', (locale) => {
    expect(markdownFiles(`docs/${locale}`)).toEqual(sorted([...baseDocs, ROOT_README]));
  });

  describe.each(pairs)('%s', (name, base) => {
    it.each(LOCALES)('%s: fenced code blocks are byte-identical to the base', (locale) => {
      expect(fencedBlocks(read(`docs/${locale}/${name}`))).toEqual(fencedBlocks(read(base)));
    });
  });
});
