// src/find-issue.ts
import { findMarkedIssue } from './issue.js';
import { readJsonOrNull } from './finalize.js';
import { ISSUE_MARKER } from './report-issue.js';
import type { IssueRef } from './issue.js';

// Malformed input (missing file, bad JSON, non-array) always degrades to "not found" -> empty string
export function findIssueNumber(input: unknown): string {
  if (!Array.isArray(input)) return '';
  const n = findMarkedIssue(input as IssueRef[], ISSUE_MARKER);
  return n === null ? '' : String(n);
}

// CLI: find-issue.ts <issuesJsonFile>
// File content is the JSON array from `gh issue list --json number,body`; prints the number carrying the marker (empty string if none)
if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(findIssueNumber(readJsonOrNull(process.argv[2])));
}
