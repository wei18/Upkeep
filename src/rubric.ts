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
    targetFiles: inventory.files.filter((f) => cats.has(f.category)).map((f) => f.path),
  };
}
