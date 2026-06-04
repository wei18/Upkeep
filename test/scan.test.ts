// test/scan.test.ts
import { describe, it, expect } from 'vitest';
import { listFiles, isLockfile } from '../src/scan.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

describe('scan', () => {
  it('lists tracked + untracked, respects .gitignore', () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, 'a.ts'), 'x');
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\nbuild/\n');
    writeFileSync(join(dir, 'ignored.txt'), 'x');
    mkdirSync(join(dir, 'build'));
    writeFileSync(join(dir, 'build/out.js'), 'x');
    const files = listFiles(dir).sort();
    expect(files).toContain('a.ts');
    expect(files).toContain('.gitignore');
    expect(files).not.toContain('ignored.txt');
    expect(files).not.toContain('build/out.js');
  });

  it('isLockfile detects common lockfiles', () => {
    expect(isLockfile('package-lock.json')).toBe(true);
    expect(isLockfile('ios/Podfile.lock')).toBe(true);
    expect(isLockfile('src/app.ts')).toBe(false);
  });
});
