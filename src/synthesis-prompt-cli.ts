// src/synthesis-prompt-cli.ts
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSynthesisPrompt } from './prompt-bundle.js';

// CLI: synthesis-prompt-cli.ts <outFile>
if (import.meta.url === `file://${process.argv[1]}`) {
  const actionRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
  writeFileSync(process.argv[2], buildSynthesisPrompt(actionRoot));
}
