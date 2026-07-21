// test/action-pins.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

// actions/upload-artifact and actions/download-artifact are companion actions
// whose artifact storage format is tied to their major version (the v3->v4
// bump was a documented breaking change). This repo's discovery -> reviewer ->
// synthesis -> report pipeline crosses that boundary on every produce->consume
// hand-off, so upload and download majors must be pinned in lockstep.
//
// Verified compatible: v8 download-artifact release notes (ESM migration,
// digest-mismatch defaults to error, unzip decided by Content-Type) do not
// change the artifact format v7 upload-artifact produces, and the 2026-07-20
// self-audit run (github.com/wei18/Upkeep/actions/runs/29782318165) exercised
// upload@v7 + download@v8 across the full pipeline successfully.
//
// If Dependabot bumps one side without the other, re-verify compatibility via
// the target action's release notes before updating this constant.
const ALLOWED_PAIR = { upload: 'v7', download: 'v8' };

const ACTION_YML_FILES = [
  join(ROOT, 'action.yml'),
  join(ROOT, '.github/actions/discovery/action.yml'),
  join(ROOT, '.github/actions/reviewer/action.yml'),
  join(ROOT, '.github/actions/synthesis/action.yml'),
  join(ROOT, '.github/actions/report/action.yml'),
];

function collectSteps(actionYmlPath: string): any[] {
  const doc = parse(readFileSync(actionYmlPath, 'utf8'));
  return doc.runs?.steps ?? [];
}

function extractPins(prefix: 'actions/upload-artifact@' | 'actions/download-artifact@'): string[] {
  const pins: string[] = [];
  for (const file of ACTION_YML_FILES) {
    for (const step of collectSteps(file)) {
      if (typeof step.uses === 'string' && step.uses.startsWith(prefix)) {
        pins.push(step.uses.slice(prefix.length));
      }
    }
  }
  return pins;
}

describe('artifact action version pinning', () => {
  it('finds upload-artifact and download-artifact references to check', () => {
    // Guards against the scan silently finding nothing (e.g. a renamed action).
    expect(extractPins('actions/upload-artifact@').length).toBeGreaterThan(0);
    expect(extractPins('actions/download-artifact@').length).toBeGreaterThan(0);
  });

  it('pins actions/upload-artifact to the same version everywhere', () => {
    const versions = new Set(extractPins('actions/upload-artifact@'));
    expect(versions).toEqual(new Set([ALLOWED_PAIR.upload]));
  });

  it('pins actions/download-artifact to the same version everywhere', () => {
    const versions = new Set(extractPins('actions/download-artifact@'));
    expect(versions).toEqual(new Set([ALLOWED_PAIR.download]));
  });

  it('pairs upload/download versions to the verified-compatible combination', () => {
    const uploadVersions = new Set(extractPins('actions/upload-artifact@'));
    const downloadVersions = new Set(extractPins('actions/download-artifact@'));
    expect([...uploadVersions]).toEqual([ALLOWED_PAIR.upload]);
    expect([...downloadVersions]).toEqual([ALLOWED_PAIR.download]);
  });
});
