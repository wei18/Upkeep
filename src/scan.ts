// src/scan.ts
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'podfile.lock', 'cargo.lock', 'gemfile.lock', 'composer.lock',
  'package.resolved',
]);

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(basename(path).toLowerCase());
}

export function listFiles(repoRoot: string): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\0').filter((p) => p.length > 0);
}
