// src/rubric.ts
import { join } from 'node:path';
import type { Inventory, ReviewerName, Category } from './types.js';

const ALL: Category[] = ['code', 'doc', 'spec', 'visual', 'flow', 'icon', 'config', 'other'];

// File categories each reviewer is responsible for (used for target selection)
const DOMAINS: Record<ReviewerName, Category[]> = {
  docs_staleness: ['doc'],
  code_hygiene: ['code'],
  spec_flow: ['spec', 'flow'],
  visual_icon: ['visual', 'icon'],
  duplicate_orphan: ALL,
  convention: ALL,
  i18n: [], // i18n only covers code-level localization strings (design §2/§2.1), with no corresponding file category; targets are decided by the DEFAULT_PATHS globs and don't overlap docs_staleness's multi-language doc scope
};

// Default target globs for reviewers with no category mapping (audit.yml's reviewers.<name>.paths takes precedence)
const DEFAULT_PATHS: Partial<Record<ReviewerName, string[]>> = {
  i18n: ['**/*.lproj/**', '**/*.strings', '**/*.stringsdict', '**/*.xcstrings', '**/locales/**', '**/i18n/**'],
};

export interface RubricBundle {
  builtinRubric: string;         // absolute path to the action's built-in rubric file
  conventionSources: string[];   // repo convention-source files (relative paths)
  explicitRubric: string | null; // audit.yml reviewers.<name>.rubric, or null
  targetFiles: string[];         // files this reviewer should look at (relative paths)
}

function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        // `**/` should anchor on a path-segment boundary (including zero segments), so `**/README.md` doesn't wrongly match `xREADME.md`
        if (glob[i + 1] === '/') { re += '(?:.*/)?'; i++; }
        else re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegex(g).test(path));
}

export function composeRubric(
  reviewer: ReviewerName,
  inventory: Inventory,
  actionRoot: string,
  rubricLang = 'en',
): RubricBundle {
  const cats = new Set<Category>(DOMAINS[reviewer]);
  const cfg = inventory.config.reviewers[reviewer];
  const fallbackGlobs = DEFAULT_PATHS[reviewer];
  return {
    builtinRubric: join(actionRoot, 'reviewers', rubricLang, `${reviewer}.md`),
    conventionSources: inventory.conventions.map((c) => c.path),
    explicitRubric: cfg?.rubric ?? null,
    targetFiles: inventory.files
      .filter((f) => (cfg?.paths && cfg.paths.length > 0
        ? matchesAny(f.path, cfg.paths)
        : fallbackGlobs
          ? matchesAny(f.path, fallbackGlobs)
          : cats.has(f.category)))
      .map((f) => f.path),
  };
}
