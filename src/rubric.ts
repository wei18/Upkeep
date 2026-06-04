// src/rubric.ts
import { join } from 'node:path';
import type { Inventory, ReviewerName, Category } from './types.js';

const ALL: Category[] = ['code', 'doc', 'spec', 'visual', 'flow', 'icon', 'config', 'other'];

// 每個 reviewer 負責的 file 類別（target 選擇用）
const DOMAINS: Record<ReviewerName, Category[]> = {
  docs_staleness: ['doc'],
  code_hygiene: ['code'],
  spec_flow: ['spec', 'flow'],
  visual_icon: ['visual', 'icon'],
  duplicate_orphan: ALL,
  convention: ALL,
  i18n: ['doc'], // v1：多語 doc；code 層在地化字串待 Plan 4
};

export interface RubricBundle {
  reviewer: ReviewerName;
  builtinRubric: string;         // action 內建 rubric 檔絕對路徑
  conventionSources: string[];   // repo 規範來源（相對路徑）
  explicitRubric: string | null; // audit.yml reviewers.<name>.rubric 或 null
  targetFiles: string[];         // 此 reviewer 要看的檔（相對路徑）
}

function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        // `**/` 應錨在路徑區段邊界（含零段），避免 `**/README.md` 誤中 `xREADME.md`
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

function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegex(g).test(path));
}

export function composeRubric(
  reviewer: ReviewerName,
  inventory: Inventory,
  actionRoot: string,
): RubricBundle {
  const cats = new Set<Category>(DOMAINS[reviewer]);
  const cfg = inventory.config.reviewers[reviewer];
  return {
    reviewer,
    builtinRubric: join(actionRoot, 'reviewers', `${reviewer}.md`),
    conventionSources: inventory.conventions.map((c) => c.path),
    explicitRubric: cfg?.rubric ?? null,
    targetFiles: inventory.files
      .filter((f) => (cfg?.paths && cfg.paths.length > 0 ? matchesAny(f.path, cfg.paths) : cats.has(f.category)))
      .map((f) => f.path),
  };
}
