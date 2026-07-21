// src/issue.ts
export interface IssueRef {
  number: number;
  body: string;
}

// Returns the number of the first issue whose body contains the marker; null if none.
export function findMarkedIssue(issues: IssueRef[], marker: string): number | null {
  const hit = issues.find((i) => typeof i.body === 'string' && i.body.includes(marker));
  return hit ? hit.number : null;
}
