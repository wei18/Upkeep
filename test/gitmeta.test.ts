// test/gitmeta.test.ts
import { describe, it, expect } from 'vitest';
import { lastCommitTimes } from '../src/gitmeta.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function commitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gm-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'tracked.ts'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { cwd: dir, env });
  writeFileSync(join(dir, 'untracked.ts'), 'x');
  return dir;
}

describe('gitmeta', () => {
  it('returns ISO time for tracked, null for untracked', () => {
    const dir = commitRepo();
    const m = lastCommitTimes(dir, ['tracked.ts', 'untracked.ts']);
    expect(m.get('tracked.ts')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(m.get('untracked.ts')).toBeNull();
  });

  it('reports each file its own latest commit time in one pass', () => {
    const dir = commitRepo();
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    // Second, later commit touching only a new file (and not tracked.ts).
    writeFileSync(join(dir, 'later.ts'), 'y');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'commit.gpgsign=false',
      '-c', 'user.name=t', '-c', 'user.email=t@t',
      'commit', '-qm', 'second', '--date=2030-01-01T00:00:00'],
      { cwd: dir, env: { ...env, GIT_COMMITTER_DATE: '2030-01-01T00:00:00' } });
    const m = lastCommitTimes(dir, ['tracked.ts', 'later.ts']);
    expect(m.get('later.ts')).toMatch(/^2030-01-01T/);
    expect(m.get('tracked.ts')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(m.get('tracked.ts')).not.toMatch(/^2030-/);
  });
});
