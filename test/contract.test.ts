// test/contract.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReviewerOutput } from '../src/findings.js';

const HERE = fileURLToPath(new URL('.', import.meta.url)); // .../test/
const sample = JSON.parse(
  readFileSync(join(HERE, 'contract/docs_staleness.sample.json'), 'utf8'),
);

describe('recorded findings contract', () => {
  it('recorded docs_staleness sample passes the validator', () => {
    const r = validateReviewerOutput(sample);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('a finding missing ssot_direction is rejected', () => {
    const broken = structuredClone(sample);
    delete broken.findings[0].ssot_direction;
    expect(validateReviewerOutput(broken).valid).toBe(false);
  });

  it('an out-of-domain enum value is rejected', () => {
    const broken = structuredClone(sample);
    broken.findings[1].category = 'totally_made_up';
    expect(validateReviewerOutput(broken).valid).toBe(false);
  });
});
