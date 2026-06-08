// test/discovery.test.ts
import { describe, it, expect } from 'vitest';
import { discover } from '../src/discovery.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'disc-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# proj\nuses logo.png');
  writeFileSync(join(dir, 'CLAUDE.md'), 'rules');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets/logo.png'), Buffer.from([0x89, 0x50]));
  writeFileSync(join(dir, 'assets/orphan.png'), Buffer.from([0x89, 0x50]));
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { cwd: dir, env });
  return dir;
}

describe('discover', () => {
  it('produces a complete inventory', () => {
    const inv = discover(repo());
    const byPath = Object.fromEntries(inv.files.map((f) => [f.path, f]));

    expect(inv.files.length).toBe(4);
    expect(byPath['assets/logo.png'].modality).toBe('raster_image');
    expect(byPath['assets/logo.png'].referencedBy).toEqual(['README.md']);
    expect(byPath['assets/orphan.png'].referencedBy).toEqual([]);
    expect(byPath['README.md'].lastCommitISO).toMatch(/^\d{4}-/);
    expect(byPath['README.md'].hash).toMatch(/^[0-9a-f]{64}$/);

    expect(inv.config.reviewers.i18n.enabled).toBe(false);
    expect(inv.conventions.some((c) => c.kind === 'claude_md')).toBe(true);
  });

  it('drops files matching .claude/audit.yml ignore globs from the inventory', () => {
    const dir = repo();
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude/audit.yml'), 'ignore:\n  - "assets/**"\n');
    const inv = discover(dir);
    expect(inv.files.some((f) => f.path.startsWith('assets/'))).toBe(false);
    expect(inv.files.some((f) => f.path === 'README.md')).toBe(true);
  });

  it('flags oversized text files', () => {
    const dir = repo();
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(101 * 1024));
    const inv = discover(dir);
    const big = inv.files.find((f) => f.path === 'big.md')!;
    expect(big.oversizedText).toBe(true);
  });

  it('skips submodule/gitlink directory entries without crashing', () => {
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const dir = mkdtempSync(join(tmpdir(), 'sub-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, 'a.ts'), 'x');
    // nested git repo added as a gitlink (submodule) — appears in git ls-files as a directory path
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    execFileSync('git', ['init', '-q'], { cwd: sub });
    writeFileSync(join(sub, 'x.txt'), 'y');
    execFileSync('git', ['add', '-A'], { cwd: sub });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 's'], { cwd: sub, env });
    execFileSync('git', ['add', 'a.ts', 'sub'], { cwd: dir });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { cwd: dir, env });

    const inv = discover(dir);
    expect(inv.files.some((f) => f.path === 'a.ts')).toBe(true);
    expect(inv.files.some((f) => f.path === 'sub')).toBe(false);
  });
});
