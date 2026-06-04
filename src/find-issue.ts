// src/find-issue.ts
import { readFileSync } from 'node:fs';
import { findMarkedIssue } from './issue.js';
import { ISSUE_MARKER } from './report-issue.js';
import type { IssueRef } from './issue.js';

// CLI: find-issue.ts <issuesJsonFile>
// 檔內容為 `gh issue list --json number,body` 的 JSON 陣列；印出帶 marker 的 number（無則印空字串）
if (import.meta.url === `file://${process.argv[1]}`) {
  const issues = JSON.parse(readFileSync(process.argv[2], 'utf8')) as IssueRef[];
  const n = findMarkedIssue(issues, ISSUE_MARKER);
  process.stdout.write(n === null ? '' : String(n));
}
