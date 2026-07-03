// test/ci-workflow-structure.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const wf = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'));

describe('ci workflow structure', () => {
  it('triggers on pull_request and push to main', () => {
    expect(wf.on).toHaveProperty('pull_request');
    expect(wf.on.push.branches).toContain('main');
  });
  it('declares read-only contents permission', () => {
    expect(wf.permissions.contents).toBe('read');
  });
  it('installs deps, builds, and runs the test suite', () => {
    const steps = Object.values(wf.jobs).flatMap((job: any) => job.steps ?? []);
    const runLines = steps.map((s: any) => s.run).filter(Boolean).join('\n');
    expect(runLines).toContain('npm ci');
    expect(runLines).toContain('npm run build');
    expect(runLines).toContain('npm test');
  });
});
