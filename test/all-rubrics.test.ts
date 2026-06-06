// test/all-rubrics.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeRubric } from '../src/rubric.js';
import { defaultConfig } from '../src/config.js';
import { REVIEWER_NAMES } from '../src/types.js';
import type { Inventory } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const inv: Inventory = { repoRoot: '/r', generatedAtISO: 't', config: defaultConfig(), conventions: [], files: [] };
const ALL = REVIEWER_NAMES;

describe('all reviewer rubrics exist', () => {
  it('every reviewer has a builtin rubric file at the composed path', () => {
    for (const r of ALL) {
      expect(existsSync(composeRubric(r, inv, ROOT).builtinRubric), r).toBe(true);
    }
  });
  it('each rubric states the no-edit + SSOT discipline', () => {
    for (const r of ALL) {
      const text = readFileSync(join(ROOT, 'reviewers/en', `${r}.md`), 'utf8');
      expect(text, r).toMatch(/report[- ]only|only report|do not (edit|delete|modif)|never (edit|delet)/i);
      expect(text, r).toMatch(/ssot_direction|SSOT|divergen/i);
    }
  });
  it('convention rubric references repo self-standards; i18n references localization', () => {
    expect(readFileSync(join(ROOT, 'reviewers/en/convention.md'), 'utf8')).toMatch(/CLAUDE\.md|skills|workflows/);
    expect(readFileSync(join(ROOT, 'reviewers/en/i18n.md'), 'utf8')).toMatch(/Localizable|\.lproj|i18n|localiz/i);
  });
});
