// test/agent-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { defaultConfig, mergeConfig } from '../src/config.js';
import { resolveReviewerAgent, resolveSynthesisAgent } from '../src/agent-resolver.js';

describe('agent-resolver', () => {
  it('resolves an unset reviewer to the implicit claude default (zero-config path)', () => {
    const resolved = resolveReviewerAgent(defaultConfig(), 'docs_staleness');
    expect(resolved).toEqual({ id: 'default', type: 'claude' });
  });

  it('resolves synthesis to the implicit claude default when unset', () => {
    expect(resolveSynthesisAgent(defaultConfig())).toEqual({ id: 'default', type: 'claude' });
  });

  it('resolves a reviewer to its named agent, carrying model/max_turns/command through', () => {
    const config = mergeConfig(defaultConfig(), {
      agents: { fast: { type: 'command', command: 'x {prompt} {output} {target}', model: 'm', max_turns: 5 } },
      reviewers: { docs_staleness: { agent: 'fast' } },
    } as never);
    expect(resolveReviewerAgent(config, 'docs_staleness')).toEqual({
      id: 'fast', type: 'command', command: 'x {prompt} {output} {target}', model: 'm', max_turns: 5,
    });
  });

  it('resolves synthesis to a named agent via synthesis.agent', () => {
    const config = mergeConfig(defaultConfig(), {
      agents: { strong: { type: 'claude', model: 'claude-opus-4-8' } },
      synthesis: { agent: 'strong' },
    } as never);
    expect(resolveSynthesisAgent(config)).toEqual({ id: 'strong', type: 'claude', model: 'claude-opus-4-8' });
  });

  it('falls back to claude default (with an observable warning) when a reviewer points at an unknown agent id', () => {
    const config = mergeConfig(defaultConfig(), {
      reviewers: { docs_staleness: { agent: 'nonexistent' } },
    } as never);
    const resolved = resolveReviewerAgent(config, 'docs_staleness');
    expect(resolved.type).toBe('claude');
    expect(resolved.id).toBe('nonexistent');
    expect(resolved.warning).toMatch(/nonexistent/);
  });

  it('falls back to claude default (with an observable warning) when synthesis.agent is unknown', () => {
    const config = mergeConfig(defaultConfig(), { synthesis: { agent: 'ghost' } } as never);
    const resolved = resolveSynthesisAgent(config);
    expect(resolved.type).toBe('claude');
    expect(resolved.warning).toMatch(/ghost/);
  });
});
