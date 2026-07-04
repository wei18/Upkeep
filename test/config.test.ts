// test/config.test.ts
import { describe, it, expect } from 'vitest';
import { defaultConfig, mergeConfig, loadConfig } from '../src/config.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('config', () => {
  it('default enables 6 reviewers and disables i18n', () => {
    const c = defaultConfig();
    expect(c.reviewers.docs_staleness.enabled).toBe(true);
    expect(c.reviewers.i18n.enabled).toBe(false);
    expect(c.report.issueLabel).toBe('audit');
    expect(c.report.minSeverity).toBe('low');
  });

  it('partial yaml overrides only specified fields', () => {
    const merged = mergeConfig(defaultConfig(), {
      reviewers: { visual_icon: { enabled: false }, i18n: { enabled: true } },
      report: { issueLabel: 'health' },
    });
    expect(merged.reviewers.visual_icon.enabled).toBe(false);
    expect(merged.reviewers.i18n.enabled).toBe(true);
    expect(merged.reviewers.code_hygiene.enabled).toBe(true);
    expect(merged.report.issueLabel).toBe('health');
    expect(merged.report.minSeverity).toBe('low');
  });

  it('loadConfig returns defaults when file absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    expect(loadConfig(dir)).toEqual(defaultConfig());
  });

  it('loadConfig parses .claude/audit.yml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude/audit.yml'),
      'version: 1\nreviewers:\n  i18n:\n    enabled: true\n');
    expect(loadConfig(dir).reviewers.i18n.enabled).toBe(true);
  });

  it('default ignore is empty', () => {
    expect(defaultConfig().ignore).toEqual([]);
  });

  it('parses top-level ignore globs', () => {
    const merged = mergeConfig(defaultConfig(), { ignore: ['docs/*/plans/**'] } as never);
    expect(merged.ignore).toEqual(['docs/*/plans/**']);
  });

  it('maps snake_case report keys (issue_label, min_severity)', () => {
    const merged = mergeConfig(defaultConfig(),
      { report: { issue_label: 'health', min_severity: 'high' } } as never);
    expect(merged.report.issueLabel).toBe('health');
    expect(merged.report.minSeverity).toBe('high');
  });

  it('default agents registry is an implicit claude default; synthesis falls back to it', () => {
    const c = defaultConfig();
    expect(c.agents).toEqual({ default: { type: 'claude' } });
    expect(c.synthesis).toEqual({ agent: 'default' });
  });

  it('parses an agents registry with per-agent model/max_turns overrides', () => {
    const merged = mergeConfig(defaultConfig(), {
      agents: {
        default: { type: 'claude', model: 'claude-opus-4-8', max_turns: 30 },
        fast: { type: 'command', command: 'my-agent --prompt {prompt} --out {output} --repo {target}' },
      },
    } as never);
    expect(merged.agents.default).toEqual({ type: 'claude', model: 'claude-opus-4-8', max_turns: 30 });
    expect(merged.agents.fast).toEqual({
      type: 'command',
      command: 'my-agent --prompt {prompt} --out {output} --repo {target}',
    });
  });

  it('parses per-reviewer agent selector and synthesis.agent', () => {
    const merged = mergeConfig(defaultConfig(), {
      agents: { fast: { type: 'command', command: 'x {prompt} {output} {target}' } },
      reviewers: { docs_staleness: { agent: 'fast' } },
      synthesis: { agent: 'fast' },
    } as never);
    expect(merged.reviewers.docs_staleness.agent).toBe('fast');
    expect(merged.synthesis.agent).toBe('fast');
  });

  it('drops a malformed agents entry (unknown type) instead of crashing', () => {
    const merged = mergeConfig(defaultConfig(), {
      agents: { broken: { type: 'not-a-real-type' } },
    } as never);
    expect(merged.agents.broken).toBeUndefined();
    expect(merged.agents.default).toEqual({ type: 'claude' });
  });

  it('drops a command agent missing its command string', () => {
    const merged = mergeConfig(defaultConfig(), {
      agents: { byoa: { type: 'command' } },
    } as never);
    expect(merged.agents.byoa).toBeUndefined();
  });

  it('loadConfig with no agents: block behaves identically to defaultConfig (byte-identical runtime)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude/audit.yml'), 'version: 1\n');
    expect(loadConfig(dir)).toEqual(defaultConfig());
  });

  it('field-level merges an override onto an existing agent id, preserving its type when omitted', () => {
    const merged = mergeConfig(defaultConfig(), {
      agents: { default: { max_turns: 15 } }, // no `type` at all
    } as never);
    expect(merged.agents.default).toEqual({ type: 'claude', max_turns: 15 });
  });

  it('drops a brand-new agent id that has no type at all (not just an unknown one)', () => {
    const merged = mergeConfig(defaultConfig(), {
      agents: { ghost: { model: 'x' } },
    } as never);
    expect(merged.agents.ghost).toBeUndefined();
  });
});
