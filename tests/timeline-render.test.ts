// Tests for the timeline render module
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TraceData } from '../src/cli/commands/trace/model.js';
import {
  renderTimeline,
  renderTimelineSummary,
  renderCompactTimeline,
} from '../src/cli/commands/trace/timeline_render.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSampleTraceData(): TraceData {
  return {
    requirement: {
      id: 'req-1',
      title: 'User authentication',
      status: 'confirmed',
      acceptanceCriteria: ['Users can log in', 'Users can log out'],
    },
    designs: [
      {
        id: 'dsg-1',
        title: 'Auth system design',
        status: 'confirmed',
        modules: [
          { name: 'auth', description: 'Authentication module', dependencies: [] },
          { name: 'session', description: 'Session management', dependencies: [] },
        ],
        plans: [
          {
            id: 'plan-1',
            title: 'Auth implementation plan',
            status: 'confirmed',
            versions: [
              {
                version: 'v1',
                status: 'integrated',
                description: 'Basic auth flow',
                slices: [
                  { id: 'v1-auth-login', title: 'Login endpoint', module: 'auth', state: 'completed' },
                  { id: 'v1-auth-logout', title: 'Logout endpoint', module: 'auth', state: 'completed' },
                ],
              },
              {
                version: 'v2',
                status: 'planned',
                description: 'OAuth support',
                slices: [
                  { id: 'v2-auth-oauth', title: 'OAuth integration', module: 'auth', state: 'draft' },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function makeEmptyTraceData(): TraceData {
  return {
    requirement: {
      id: 'req-empty',
      title: 'Empty requirement',
      status: 'draft',
      acceptanceCriteria: [],
    },
    designs: [],
  };
}

function makeNoPlansTraceData(): TraceData {
  return {
    requirement: {
      id: 'req-noplans',
      title: 'No plans',
      status: 'draft',
      acceptanceCriteria: [],
    },
    designs: [
      {
        id: 'dsg-noplans',
        title: 'Design without plans',
        status: 'draft',
        modules: [],
        plans: [],
      },
    ],
  };
}

function makeMixedStateTraceData(): TraceData {
  return {
    requirement: {
      id: 'req-mixed',
      title: 'Mixed states',
      status: 'confirmed',
      acceptanceCriteria: [],
    },
    designs: [
      {
        id: 'dsg-mixed',
        title: 'Mixed design',
        status: 'confirmed',
        modules: [],
        plans: [
          {
            id: 'plan-mixed',
            title: 'Mixed plan',
            status: 'in_progress',
            versions: [
              {
                version: 'v1',
                status: 'integrated',
                description: 'First version',
                slices: [
                  { id: 's1', title: 'Slice one', module: 'mod1', state: 'completed' },
                  { id: 's2', title: 'Slice two', module: 'mod1', state: 'abandoned' },
                  { id: 's3', title: 'Slice three', module: 'mod2', state: 'running' },
                ],
              },
              {
                version: 'v2',
                status: 'planned',
                description: 'Second version',
                slices: [
                  { id: 's4', title: 'Slice four', module: 'mod2', state: 'draft' },
                  { id: 's5', title: 'Slice five', module: 'mod1', state: 'clarifying' },
                  { id: 's6', title: 'Slice six', module: 'mod2', state: 'frozen' },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

// ─── renderTimeline ──────────────────────────────────────────────────────────

describe('renderTimeline', () => {
  it('renders a complete timeline with versions and slices', () => {
    const data = makeSampleTraceData();
    const output = renderTimeline(data);

    // Header
    assert.ok(output.includes('Timeline:'));
    assert.ok(output.includes('req-1'));
    assert.ok(output.includes('User authentication'));

    // Plan header
    assert.ok(output.includes('Auth implementation plan'));

    // Version headers
    assert.ok(output.includes('v1'));
    assert.ok(output.includes('v2'));

    // Slice items
    assert.ok(output.includes('v1-auth-login'));
    assert.ok(output.includes('v1-auth-logout'));
    assert.ok(output.includes('v2-auth-oauth'));

    // State badges
    assert.ok(output.includes('[completed]'));
    assert.ok(output.includes('[draft]'));

    // Module references
    assert.ok(output.includes('[auth]'));
  });

  it('handles empty designs array', () => {
    const data = makeEmptyTraceData();
    const output = renderTimeline(data);

    assert.ok(output.includes('Timeline:'));
    assert.ok(output.includes('req-empty'));
    assert.ok(output.includes('No designs trace to this requirement.'));
  });

  it('handles designs with no plans', () => {
    const data = makeNoPlansTraceData();
    const output = renderTimeline(data);

    assert.ok(output.includes('No plan traces to this design.'));
  });

  it('handles mixed slice states', () => {
    const data = makeMixedStateTraceData();
    const output = renderTimeline(data);

    // All slice IDs should appear
    assert.ok(output.includes('s1'));
    assert.ok(output.includes('s2'));
    assert.ok(output.includes('s3'));
    assert.ok(output.includes('s4'));
    assert.ok(output.includes('s5'));
    assert.ok(output.includes('s6'));

    // All states
    assert.ok(output.includes('[completed]'));
    assert.ok(output.includes('[abandoned]'));
    assert.ok(output.includes('[running]'));
    assert.ok(output.includes('[draft]'));
    assert.ok(output.includes('[clarifying]'));
    assert.ok(output.includes('[frozen]'));
  });

  it('uses Unicode box-drawing characters', () => {
    const data = makeSampleTraceData();
    const output = renderTimeline(data);

    assert.ok(output.includes('──'));
    assert.ok(output.includes('├──'));
    assert.ok(output.includes('└──'));
    assert.ok(output.includes('│'));
  });

  it('returns a non-empty string for valid data', () => {
    const data = makeSampleTraceData();
    const output = renderTimeline(data);

    assert.ok(typeof output === 'string');
    assert.ok(output.length > 0);
  });

  it('renders status icons in the header', () => {
    const data = makeSampleTraceData();
    const output = renderTimeline(data);

    // confirmed status gets ✅
    assert.ok(output.includes('✅'));
  });
});

// ─── renderTimelineSummary ───────────────────────────────────────────────────

describe('renderTimelineSummary', () => {
  it('renders a compact summary with per-version progress', () => {
    const data = makeSampleTraceData();
    const output = renderTimelineSummary(data);

    assert.ok(output.includes('Timeline:'));
    assert.ok(output.includes('req-1'));
    assert.ok(output.includes('v1'));
    assert.ok(output.includes('v2'));
    assert.ok(output.includes('100%'));
    assert.ok(output.includes('0%'));
  });

  it('handles empty designs', () => {
    const data = makeEmptyTraceData();
    const output = renderTimelineSummary(data);

    assert.ok(output.includes('Timeline:'));
    assert.ok(output.includes('req-empty'));
  });

  it('shows completion percentages', () => {
    const data = makeMixedStateTraceData();
    const output = renderTimelineSummary(data);

    // v1: 2/3 = 67%
    assert.ok(output.includes('67%'));
    // v2: 0/3 = 0%
    assert.ok(output.includes('0%'));
  });
});

// ─── renderCompactTimeline ───────────────────────────────────────────────────

describe('renderCompactTimeline', () => {
  it('renders a dense per-slice view', () => {
    const data = makeSampleTraceData();
    const output = renderCompactTimeline(data);

    assert.ok(output.includes('Timeline:'));
    assert.ok(output.includes('req-1'));
    assert.ok(output.includes('User authentication'));

    // Version labels
    assert.ok(output.includes('v1'));
    assert.ok(output.includes('v2'));

    // All slices
    assert.ok(output.includes('v1-auth-login'));
    assert.ok(output.includes('v1-auth-logout'));
    assert.ok(output.includes('v2-auth-oauth'));

    // State badges
    assert.ok(output.includes('[completed]'));
    assert.ok(output.includes('[draft]'));
  });

  it('handles empty designs', () => {
    const data = makeEmptyTraceData();
    const output = renderCompactTimeline(data);

    assert.ok(output.includes('Timeline:'));
    assert.ok(output.includes('req-empty'));
  });

  it('renders all slice states correctly', () => {
    const data = makeMixedStateTraceData();
    const output = renderCompactTimeline(data);

    assert.ok(output.includes('[completed]'));
    assert.ok(output.includes('[abandoned]'));
    assert.ok(output.includes('[running]'));
    assert.ok(output.includes('[draft]'));
    assert.ok(output.includes('[clarifying]'));
    assert.ok(output.includes('[frozen]'));
  });

  it('shows module tags on each slice', () => {
    const data = makeSampleTraceData();
    const output = renderCompactTimeline(data);

    assert.ok(output.includes('[auth]'));
  });
});
