// test/agent-action-structure.test.ts
// Locks the Phase 1 pluggable-agent-engine contract for the composite actions:
// existing claude-code-action step untouched + if:-gated by agent_type, generic
// `command` escape hatch added, claude stays the default (zero behavior change).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

function loadAction(rel: string) {
  return parse(readFileSync(join(ROOT, rel), 'utf8'));
}

describe.each([
  ['reviewer', '.github/actions/reviewer/action.yml'],
  ['synthesis', '.github/actions/synthesis/action.yml'],
])('%s composite action agent branching', (_name, rel) => {
  const action = loadAction(rel);

  it('declares agent_type defaulting to claude and an optional agent_command', () => {
    expect(action.inputs.agent_type.default).toBe('claude');
    expect(action.inputs.agent_command).toBeDefined();
    expect(action.inputs.agent_command.required).toBeFalsy();
  });

  it('still requires claude_code_oauth_token (unchanged contract)', () => {
    expect(action.inputs.claude_code_oauth_token.required).toBe(true);
  });

  it('gates the existing claude-code-action step on agent_type == claude, verbatim otherwise', () => {
    const claudeStep = action.runs.steps.find((s: any) => s.uses === 'anthropics/claude-code-action@v1');
    expect(claudeStep).toBeDefined();
    expect(String(claudeStep.if)).toContain('claude');
    expect(claudeStep['continue-on-error']).toBe(true);
  });

  it('adds a generic command step gated on agent_type == command', () => {
    const cmdStep = action.runs.steps.find((s: any) => String(s.if ?? '').includes("'command'"));
    expect(cmdStep).toBeDefined();
    expect(cmdStep.shell).toBe('bash');
    expect(cmdStep.run).toMatch(/\\?\{prompt\\?\}/);
    expect(cmdStep.run).toMatch(/\\?\{output\\?\}/);
    expect(cmdStep.run).toMatch(/\\?\{target\\?\}/);
  });

  it('passes agent_command through env: rather than interpolating it directly into the run: script (GHA script-injection mitigation)', () => {
    const cmdStep = action.runs.steps.find((s: any) => String(s.if ?? '').includes("'command'"));
    expect(cmdStep.run).not.toContain('inputs.agent_command');
    expect(cmdStep.env).toBeDefined();
    expect(String(cmdStep.env.AGENT_COMMAND)).toContain('inputs.agent_command');
  });

  it('keeps the finalize step unconditional (always) after either branch', () => {
    const finalizeStep = action.runs.steps.find((s: any) => String(s.run ?? '').includes('finalize.ts'));
    expect(finalizeStep).toBeDefined();
    expect(String(finalizeStep.if)).toContain('always');
  });
});
