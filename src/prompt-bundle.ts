// src/prompt-bundle.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeRubric } from './rubric.js';
import type { Inventory, ReviewerName } from './types.js';

export function buildReviewerPrompt(reviewer: ReviewerName, inventory: Inventory, actionRoot: string): string {
  const bundle = composeRubric(reviewer, inventory, actionRoot);
  const template = readFileSync(join(actionRoot, 'reviewers', '_reviewer-prompt.md'), 'utf8')
    .replaceAll('{{REVIEWER}}', reviewer);
  const builtin = readFileSync(bundle.builtinRubric, 'utf8');

  const parts = [
    template,
    '\n\n## 你的內建 rubric\n',
    builtin,
    '\n\n## repo 規範來源（請讀；衝突時優先於內建）\n',
    bundle.conventionSources.length ? bundle.conventionSources.map((p) => `- ${p}`).join('\n') : '（無）',
  ];
  if (bundle.explicitRubric) {
    parts.push('\n\n## audit.yml 覆蓋 rubric（最高優先，請讀）\n', `- ${bundle.explicitRubric}`);
  }
  parts.push(
    '\n\n## 你的 target 檔（只審這些）\n',
    bundle.targetFiles.length ? bundle.targetFiles.map((p) => `- ${p}`).join('\n') : '（無；輸出 status:"ok", findings:[]）',
  );
  return parts.join('');
}

export function buildSynthesisPrompt(actionRoot: string): string {
  return readFileSync(join(actionRoot, 'reviewers', '_synthesis-prompt.md'), 'utf8');
}

// CLI: prompt-bundle.ts <reviewer> <inventoryJson> <outFile>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [reviewer, invPath, outFile] = process.argv.slice(2);
  const inventory = JSON.parse(readFileSync(invPath, 'utf8')) as Inventory;
  const actionRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
  writeFileSync(outFile, buildReviewerPrompt(reviewer as ReviewerName, inventory, actionRoot));
}
