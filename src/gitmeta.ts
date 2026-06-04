// src/gitmeta.ts
import { execFileSync } from 'node:child_process';

// 對每個路徑查最後 commit 的 committer ISO 時間；無記錄回 null。
export function lastCommitTimes(repoRoot: string, paths: string[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const p of paths) {
    try {
      const out = execFileSync(
        'git', ['log', '-1', '--format=%cI', '--', p],
        { cwd: repoRoot, encoding: 'utf8' },
      ).trim();
      m.set(p, out.length > 0 ? out : null);
    } catch {
      m.set(p, null);
    }
  }
  return m;
}
