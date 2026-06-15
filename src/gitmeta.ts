// src/gitmeta.ts
import { execFileSync } from 'node:child_process';

// 對每組路徑查最後 commit 的 committer ISO 時間；無記錄回 null。
// 單次 git log 走訪（reverse-chronological，與 scan.ts/discovery.ts 一致的批次風格）：
// 每個路徑第一次出現即為其最新 commit，避免 per-file 的 O(N) 子行程。
export function lastCommitTimes(repoRoot: string, paths: string[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const p of paths) m.set(p, null);
  if (paths.length === 0) return m;

  let out: string;
  try {
    out = execFileSync(
      'git',
      // core.quotePath=false 讓非 ASCII 路徑保持原樣，與 --name-only 輸出可比對。
      // `-- ...paths` 把 --name-only 輸出限縮在這批路徑內，不會冒出多餘 key。
      // --diff-merges=first-parent：讓 merge commit 也列出檔案（對 first parent 的 diff），
      //   保留舊版 per-file `git log -1` 對 merge-only 變更的歸屬，不致漏判。
      // 不用 --follow：git 不支援多路徑 + --follow，且舊版 per-file 行為同樣不追 rename。
      ['-c', 'core.quotePath=false', 'log', '--diff-merges=first-parent',
        '--format=\x1e%cI', '--name-only', '--', ...paths],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return m; // git 失敗時全部維持 null
  }

  let cur: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('\x1e')) {
      cur = line.slice(1).trim() || null;
    } else if (line.length > 0 && cur !== null && m.get(line) === null) {
      // 第一次出現 = 最新 commit；後續較舊的出現不覆蓋。
      m.set(line, cur);
    }
  }
  return m;
}
