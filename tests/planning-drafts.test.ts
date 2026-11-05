// Tests for planning-drafts — read-only draft collection for next/suggest

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RequirementStore } from '../src/core/requirements/store.js';
import type { RequirementDoc } from '../src/core/requirements/types.js';
import { DesignStore } from '../src/core/design/store.js';
import type { DesignDoc } from '../src/core/design/types.js';
import { VersionStore } from '../src/core/version/store.js';
import type { VersionPlan } from '../src/core/version/types.js';
import {
  collectPlanningDrafts,
  draftConfirmCommand,
  draftShowCommand,
} from '../src/cli/commands/planning-drafts.js';

const TEST_DIR = join(tmpdir(), `zelto-planning-drafts-test-${Date.now()}`);

function makeReq(id: string, status: RequirementDoc['status']): RequirementDoc {
  return {
    id,
    title: `Req ${id}`,
    userInput: 'input',
    spec: '# spec',
    status,
    supersedes: null,
    acceptanceCriteria: ['a'],
    createdAt: new Date().toISOString(),
    confirmedAt: null,
  };
}

function makeDesign(id: string, status: DesignDoc['status']): DesignDoc {
  return {
    id,
    requirementId: 'req-1',
    title: `Design ${id}`,
    body: '# body',
    modules: [{ name: 'M', description: 'd', filePatterns: ['src/**'], dependencies: [] }],
    status,
    supersedes: null,
    createdAt: new Date().toISOString(),
    confirmedAt: null,
  };
}

function makePlan(id: string, status: VersionPlan['status']): VersionPlan {
  return {
    id,
    designId: 'dsg-1',
    title: `Plan ${id}`,
    versions: [],
    status,
    createdAt: new Date().toISOString(),
    confirmedAt: null,
  };
}

describe('planning-drafts', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    const reqStore = new RequirementStore(TEST_DIR);
    await reqStore.save(makeReq('req-draft', 'draft'));
    await reqStore.save(makeReq('req-done', 'confirmed'));

    const designStore = new DesignStore(TEST_DIR);
    await designStore.save(makeDesign('dsg-draft', 'draft'));

    const versionStore = new VersionStore(TEST_DIR);
    await versionStore.save(makePlan('plan-draft', 'draft'));
    await versionStore.save(makePlan('plan-done', 'confirmed'));
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('collects only drafts in require → design → plan order', async () => {
    const drafts = await collectPlanningDrafts(TEST_DIR);
    assert.deepEqual(
      drafts.map((d) => `${d.kind}:${d.id}`),
      ['require:req-draft', 'design:dsg-draft', 'plan:plan-draft'],
    );
  });

  it('builds show → confirm commands with the same entry', async () => {
    const drafts = await collectPlanningDrafts(TEST_DIR);
    assert.ok(drafts.length > 0);
    const first = drafts[0];
    assert.equal(draftShowCommand(first), `zelto ${first.kind} show ${first.id}`);
    assert.equal(draftConfirmCommand(first), `zelto ${first.kind} confirm ${first.id}`);
  });

  it('returns empty list when nothing is readable', async () => {
    const drafts = await collectPlanningDrafts(join(TEST_DIR, 'does-not-exist'));
    assert.deepEqual(drafts, []);
  });
});
