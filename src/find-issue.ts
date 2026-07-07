// src/find-issue.ts
import { findMarkedIssue } from './issue.js';
import { readJsonOrNull } from './finalize.js';
import { ISSUE_MARKER } from './report-issue.js';
import type { IssueRef } from './issue.js';

// 畸形輸入（缺檔、壞 JSON、非陣列）一律降級為「找不到」→ 空字串
export function findIssueNumber(input: unknown): string {
  if (!Array.isArray(input)) return '';
  const n = findMarkedIssue(input as IssueRef[], ISSUE_MARKER);
  return n === null ? '' : String(n);
}

// CLI: find-issue.ts <issuesJsonFile>
// 檔內容為 `gh issue list --json number,body` 的 JSON 陣列；印出帶 marker 的 number（無則印空字串）
if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(findIssueNumber(readJsonOrNull(process.argv[2])));
}
