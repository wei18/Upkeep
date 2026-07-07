// test/find-issue.test.ts
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findIssueNumber } from '../src/find-issue.js';
import { readJsonOrNull } from '../src/finalize.js';
import { ISSUE_MARKER } from '../src/report-issue.js';

describe('findIssueNumber', () => {
  it('returns the marked issue number as a string', () => {
    expect(findIssueNumber([{ number: 7, body: `x\n${ISSUE_MARKER}` }, { number: 1, body: 'y' }])).toBe('7');
  });
  it('returns empty string when no issue carries the marker', () => {
    expect(findIssueNumber([{ number: 1, body: 'x' }])).toBe('');
  });
  it('degrades to empty string on null input (missing/malformed file)', () => {
    expect(findIssueNumber(null)).toBe('');
  });
  it('degrades to empty string on non-array JSON', () => {
    expect(findIssueNumber({ number: 7, body: ISSUE_MARKER })).toBe('');
  });
  it('degrades instead of throwing when fed a malformed JSON file via readJsonOrNull', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'find-issue-')), 'issues.json');
    writeFileSync(file, '{not json');
    expect(findIssueNumber(readJsonOrNull(file))).toBe('');
  });
});
