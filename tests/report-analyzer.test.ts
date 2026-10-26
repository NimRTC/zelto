import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { SliceData } from '../src/core/slice/store.js';
import type { VersionPlan } from '../src/core/version/types.js';
import type { RequirementSummary } from '../src/core/requirements/types.js';
import type { DesignSummary } from '../src/core/design/types.js';
import type { EventEnvelope } from '../src/core/events/stream.js';
import { analyzeReport } from '../src/core/report/report-analyzer.js';

function makeSlice(overrides: Partial<Omit<SliceData, 'state'>> & { id: string; state: SliceData['state'] }): SliceData {
  const now = new Date().toISOString();
  return {
    title: 'test-slice',
    spec: { path: `specs/slices/${overrides.id}.md`, frozenHash: null, frozenAt: null },
    acceptance: { dir: `tests/acceptance/${overrides.id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: [], contracts: [], tests: [] },
    traceWaiver: null,
    writes: [],
    runs: [],
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EventEnvelope> & { type: string }): EventEnvelope {
  const base: EventEnvelope = {
    ts: new Date().toISOString(),
    runSeq: 1,
    slice: 'test',
    run: null,
    actor: 'test',
    payload: {},
    type: 'slice.state.changed',
  };
  return { ...base, ...overrides } as EventEnvelope;
}

describe('analyzeReport', () => {
  describe('slice status distribution', () => {
    it('counts slices by state', async () => {
      const slices: SliceData[] = [
        makeSlice({ id: 's1', state: 'draft' }),
        makeSlice({ id: 's2', state: 'draft' }),
        makeSlice({ id: 's3', state: 'frozen' }),
        makeSlice({ id: 's4', state: 'running' }),
        makeSlice({ id: 's5', state: 'completed' }),
        makeSlice({ id: 's6', state: 'completed' }),
        makeSlice({ id: 's7', state: 'abandoned' }),
        makeSlice({ id: 's8', state: 'clarifying' }),
      ];

      const result = await analyzeReport(slices, [], [], [], new Map());
      assert.equal(result.slices.total, 8);
      assert.equal(result.slices.draft, 2);
      assert.equal(result.slices.clarifying, 1);
      assert.equal(result.slices.frozen, 1);
      assert.equal(result.slices.running, 1);
      assert.equal(result.slices.completed, 2);
      assert.equal(result.slices.abandoned, 1);
    });

    it('returns zeros for empty slices', async () => {
      const result = await analyzeReport([], [], [], [], new Map());
      assert.equal(result.slices.total, 0);
      assert.equal(result.slices.draft, 0);
      assert.equal(result.slices.completed, 0);
    });
  });

  describe('version progress', () => {
    it('computes version progress from slice states', async () => {
      const slices: SliceData[] = [
        makeSlice({ id: 's1', state: 'completed' }),
        makeSlice({ id: 's2', state: 'running' }),
        makeSlice({ id: 's3', state: 'abandoned' }),
        makeSlice({ id: 's4', state: 'draft' }),
      ];

      const plans: VersionPlan[] = [
        {
          id: 'plan-1',
          designId: 'design-1',
          title: 'Plan One',
          versions: [
            {
              version: 'v1.0',
              dependsOn: [],
              description: 'First release',
              slices: [
                { id: 's1', module: 'core', title: 'S1', writes: [], specPath: 'specs/s1.md' },
                { id: 's2', module: 'core', title: 'S2', writes: [], specPath: 'specs/s2.md' },
              ],
              integrationTestDir: 'tests/integration/v1',
              status: 'in_progress',
            },
          ],
          status: 'confirmed',
          createdAt: new Date().toISOString(),
          confirmedAt: new Date().toISOString(),
        },
      ];

      const result = await analyzeReport(slices, plans, [], [], new Map());
      assert.equal(result.versions.length, 1);
      assert.equal(result.versions[0].version, 'v1.0');
      assert.equal(result.versions[0].totalSlices, 2);
      assert.equal(result.versions[0].completedSlices, 1); // s1 completed, s2 running
      assert.equal(result.versions[0].sliceStates['s1'], 'completed');
      assert.equal(result.versions[0].sliceStates['s2'], 'running');
    });

    it('handles abandoned slices as completed for progress', async () => {
      const slices: SliceData[] = [
        makeSlice({ id: 's1', state: 'abandoned' }),
        makeSlice({ id: 's2', state: 'completed' }),
      ];

      const plans: VersionPlan[] = [
        {
          id: 'plan-1',
          designId: 'design-1',
          title: 'Plan',
          versions: [
            {
              version: 'v1',
              dependsOn: [],
              description: 'Release',
              slices: [
                { id: 's1', module: 'core', title: 'S1', writes: [], specPath: 'specs/s1.md' },
                { id: 's2', module: 'core', title: 'S2', writes: [], specPath: 'specs/s2.md' },
              ],
              integrationTestDir: 'tests/integration/v1',
              status: 'in_progress',
            },
          ],
          status: 'confirmed',
          createdAt: new Date().toISOString(),
          confirmedAt: new Date().toISOString(),
        },
      ];

      const result = await analyzeReport(slices, plans, [], [], new Map());
      assert.equal(result.versions[0].completedSlices, 2);
    });

    it('handles missing slices gracefully', async () => {
      const slices: SliceData[] = [];
      const plans: VersionPlan[] = [
        {
          id: 'plan-1',
          designId: 'design-1',
          title: 'Plan',
          versions: [
            {
              version: 'v1',
              dependsOn: [],
              description: 'Release',
              slices: [
                { id: 's1', module: 'core', title: 'S1', writes: [], specPath: 'specs/s1.md' },
              ],
              integrationTestDir: 'tests/integration/v1',
              status: 'in_progress',
            },
          ],
          status: 'confirmed',
          createdAt: new Date().toISOString(),
          confirmedAt: new Date().toISOString(),
        },
      ];

      const result = await analyzeReport(slices, plans, [], [], new Map());
      assert.equal(result.versions.length, 1);
      assert.equal(result.versions[0].totalSlices, 1);
      assert.equal(result.versions[0].completedSlices, 0);
      assert.equal(result.versions[0].sliceStates['s1'], '—');
    });

    it('aggregates versions across multiple plans', async () => {
      const slices: SliceData[] = [
        makeSlice({ id: 's1', state: 'completed' }),
        makeSlice({ id: 's2', state: 'draft' }),
      ];

      const plans: VersionPlan[] = [
        {
          id: 'plan-1',
          designId: 'design-1',
          title: 'Plan One',
          versions: [
            {
              version: 'v1',
              dependsOn: [],
              description: 'First',
              slices: [
                { id: 's1', module: 'core', title: 'S1', writes: [], specPath: 'specs/s1.md' },
              ],
              integrationTestDir: 'tests/integration/v1',
              status: 'in_progress',
            },
          ],
          status: 'confirmed',
          createdAt: new Date().toISOString(),
          confirmedAt: new Date().toISOString(),
        },
        {
          id: 'plan-2',
          designId: 'design-2',
          title: 'Plan Two',
          versions: [
            {
              version: 'v2',
              dependsOn: [],
              description: 'Second',
              slices: [
                { id: 's2', module: 'core', title: 'S2', writes: [], specPath: 'specs/s2.md' },
              ],
              integrationTestDir: 'tests/integration/v2',
              status: 'planned',
            },
          ],
          status: 'draft',
          createdAt: new Date().toISOString(),
          confirmedAt: null,
        },
      ];

      const result = await analyzeReport(slices, plans, [], [], new Map());
      assert.equal(result.versions.length, 2);
      assert.equal(result.versions[0].version, 'v1');
      assert.equal(result.versions[1].version, 'v2');
    });
  });

  describe('gate stats', () => {
    it('counts passed and failed gate results from events', async () => {
      const events = new Map<string, EventEnvelope[]>([
        ['s1', [
          makeEvent({ type: 'gate.result', slice: 's1', payload: { passed: true } }),
          makeEvent({ type: 'gate.result', slice: 's1', payload: { passed: false } }),
        ]],
        ['s2', [
          makeEvent({ type: 'gate.result', slice: 's2', payload: { passed: true } }),
        ]],
      ]);

      const result = await analyzeReport([], [], [], [], events);
      assert.equal(result.gates.passed, 2);
      assert.equal(result.gates.failed, 1);
      assert.equal(result.gates.total, 3);
      assert.equal(result.gates.passRate, 2 / 3);
    });

    it('returns zero gate stats when no gate events', async () => {
      const events = new Map<string, EventEnvelope[]>([
        ['s1', [makeEvent({ type: 'slice.state.changed', slice: 's1' }) as EventEnvelope]],
      ]);

      const result = await analyzeReport([], [], [], [], events);
      assert.equal(result.gates.passed, 0);
      assert.equal(result.gates.failed, 0);
      assert.equal(result.gates.total, 0);
      assert.equal(result.gates.passRate, 0);
    });
  });

  describe('event stats', () => {
    it('counts events by type', async () => {
      const events = new Map<string, EventEnvelope[]>([
        ['s1', [
          makeEvent({ type: 'slice.state.changed', slice: 's1' }),
          makeEvent({ type: 'gate.result', slice: 's1', payload: { passed: true } }),
        ]],
        ['s2', [
          makeEvent({ type: 'slice.state.changed', slice: 's2' }),
          makeEvent({ type: 'slice.state.changed', slice: 's2' }),
        ]],
      ]);

      const result = await analyzeReport([], [], [], [], events);
      assert.equal(result.events.total, 4);
      assert.equal(result.events.byType['slice.state.changed'], 3);
      assert.equal(result.events.byType['gate.result'], 1);
    });

    it('returns recent events sorted by timestamp descending', async () => {
      const events = new Map<string, EventEnvelope[]>([
        ['s1', [
          makeEvent({ type: 'slice.state.changed', slice: 's1', ts: '2024-01-01T00:00:00.000Z' }),
          makeEvent({ type: 'gate.result', slice: 's1', ts: '2024-01-03T00:00:00.000Z', payload: { passed: true } }),
          makeEvent({ type: 'run.started', slice: 's1', ts: '2024-01-02T00:00:00.000Z' }),
        ]],
      ]);

      const result = await analyzeReport([], [], [], [], events);
      assert.equal(result.events.recent.length, 3);
      assert.equal(result.events.recent[0].type, 'gate.result');
      assert.equal(result.events.recent[1].type, 'run.started');
      assert.equal(result.events.recent[2].type, 'slice.state.changed');
    });
  });

  describe('anomalous slices', () => {
    it('detects slices with drift', async () => {
      const slices: SliceData[] = [
        makeSlice({ id: 's1', state: 'running', drift: { detected: true, reason: 'spec changed', at: new Date().toISOString() } }),
      ];

      const result = await analyzeReport(slices, [], [], [], new Map());
      assert.equal(result.anomalies.length, 1);
      assert.equal(result.anomalies[0].id, 's1');
      assert.equal(result.anomalies[0].reason, 'spec changed');
    });

    it('detects stalled slices', async () => {
      const slices: SliceData[] = [
        makeSlice({ id: 's1', state: 'running', stall: { class: 'context_exhaustion', autoResolved: 0, gateRetries: 0 } }),
      ];

      const result = await analyzeReport(slices, [], [], [], new Map());
      assert.equal(result.anomalies.length, 1);
      assert.equal(result.anomalies[0].reason, 'stalled: context_exhaustion');
    });

    it('detects frozen slices older than 24h', async () => {
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const slices: SliceData[] = [
        makeSlice({ id: 's1', state: 'frozen', updatedAt: oldDate }),
      ];

      const result = await analyzeReport(slices, [], [], [], new Map());
      assert.equal(result.anomalies.length, 1);
      assert.ok(result.anomalies[0].reason.startsWith('frozen for'));
    });

    it('does not flag recent frozen slices', async () => {
      const freshDate = new Date().toISOString();
      const slices: SliceData[] = [
        makeSlice({ id: 's1', state: 'frozen', updatedAt: freshDate }),
      ];

      const result = await analyzeReport(slices, [], [], [], new Map());
      assert.equal(result.anomalies.length, 0);
    });

    it('reports last event type for anomalous slices', async () => {
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const slices: SliceData[] = [
        makeSlice({ id: 's1', state: 'frozen', updatedAt: oldDate }),
      ];

      const events = new Map<string, EventEnvelope[]>([
        ['s1', [
          makeEvent({ type: 'slice.state.changed', slice: 's1' }),
          makeEvent({ type: 'gate.result', slice: 's1', payload: { passed: true } }),
        ]],
      ]);

      const result = await analyzeReport(slices, [], [], [], events);
      assert.equal(result.anomalies.length, 1);
      assert.equal(result.anomalies[0].lastEvent, 'gate.result');
    });

    it('returns empty anomalies when nothing is wrong', async () => {
      const slices: SliceData[] = [
        makeSlice({ id: 's1', state: 'completed' }),
        makeSlice({ id: 's2', state: 'running' }),
        makeSlice({ id: 's3', state: 'draft' }),
      ];

      const result = await analyzeReport(slices, [], [], [], new Map());
      assert.equal(result.anomalies.length, 0);
    });

    it('handles drift with null reason', async () => {
      const slices: SliceData[] = [
        makeSlice({ id: 's1', state: 'completed', drift: { detected: true, reason: null, at: new Date().toISOString() } }),
      ];

      const result = await analyzeReport(slices, [], [], [], new Map());
      assert.equal(result.anomalies.length, 1);
      assert.equal(result.anomalies[0].reason, 'drift detected');
    });
  });

  describe('requirements, designs, plans summary', () => {
    it('counts confirmed and draft requirements', async () => {
      const reqs: RequirementSummary[] = [
        { id: 'r1', title: 'R1', status: 'confirmed', createdAt: new Date().toISOString() },
        { id: 'r2', title: 'R2', status: 'draft', createdAt: new Date().toISOString() },
        { id: 'r3', title: 'R3', status: 'confirmed', createdAt: new Date().toISOString() },
      ];

      const result = await analyzeReport([], [], reqs, [], new Map());
      assert.equal(result.requirements.total, 3);
      assert.equal(result.requirements.confirmed, 2);
      assert.equal(result.requirements.draft, 1);
    });

    it('counts confirmed and draft designs', async () => {
      const designs: DesignSummary[] = [
        { id: 'd1', title: 'D1', requirementId: 'r1', status: 'confirmed', moduleCount: 2, createdAt: new Date().toISOString() },
        { id: 'd2', title: 'D2', requirementId: 'r1', status: 'draft', moduleCount: 1, createdAt: new Date().toISOString() },
      ];

      const result = await analyzeReport([], [], [], designs, new Map());
      assert.equal(result.designs.total, 2);
      assert.equal(result.designs.confirmed, 1);
      assert.equal(result.designs.draft, 1);
    });

    it('counts confirmed and draft plans', async () => {
      const plans: VersionPlan[] = [
        {
          id: 'p1', designId: 'd1', title: 'P1', versions: [], status: 'confirmed',
          createdAt: new Date().toISOString(), confirmedAt: new Date().toISOString(),
        },
        {
          id: 'p2', designId: 'd1', title: 'P2', versions: [], status: 'draft',
          createdAt: new Date().toISOString(), confirmedAt: null,
        },
      ];

      const result = await analyzeReport([], plans, [], [], new Map());
      assert.equal(result.plans.total, 2);
      assert.equal(result.plans.confirmed, 1);
      assert.equal(result.plans.draft, 1);
    });
  });

  describe('project metadata', () => {
    it('includes project name and generation timestamp', async () => {
      const result = await analyzeReport([], [], [], [], new Map());
      assert.equal(result.project.name, 'zelto');
      assert.ok(result.project.generatedAt);
      assert.doesNotThrow(() => new Date(result.project.generatedAt));
    });
  });
});
