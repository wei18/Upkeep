// src/gitmeta.ts
import { execFileSync } from 'node:child_process';

// Looks up each path's last-commit committer ISO time; null when there's no record.
// A single git log traversal (reverse-chronological, matching the batch style of
// scan.ts/discovery.ts): a path's first occurrence is its most recent commit,
// avoiding an O(N) per-file subprocess.
export function lastCommitTimes(repoRoot: string, paths: string[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const p of paths) m.set(p, null);
  if (paths.length === 0) return m;

  let out: string;
  try {
    out = execFileSync(
      'git',
      // core.quotePath=false keeps non-ASCII paths as-is, so they match the --name-only output.
      // `-- ...paths` limits the --name-only output to this batch of paths, avoiding stray keys.
      // --diff-merges=first-parent: makes merge commits list their files too (diff against the
      //   first parent), preserving the old per-file `git log -1` attribution for merge-only
      //   changes so nothing is missed.
      // No --follow: git doesn't support multiple paths + --follow, and the old per-file
      // behavior didn't track renames either.
      ['-c', 'core.quotePath=false', 'log', '--diff-merges=first-parent',
        '--format=\x1e%cI', '--name-only', '--', ...paths],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return m; // leave everything null if git fails
  }

  let cur: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('\x1e')) {
      cur = line.slice(1).trim() || null;
    } else if (line.length > 0 && cur !== null && m.get(line) === null) {
      // First occurrence = most recent commit; later (older) occurrences don't overwrite it.
      m.set(line, cur);
    }
  }
  return m;
}
