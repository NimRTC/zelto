// Tests for the trace command modules
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTraceArgs, printTraceHelp } from '../src/cli/commands/trace/args.js';
import { renderJsonTrace } from '../src/cli/commands/trace/json_render.js';
import type { TraceData, TraceRequirement, TraceDesign } from '../src/cli/commands/trace/model.js';

// ─── Helper: build a sample TraceData object ───────────────────────────────

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
          { name: 'auth', description: 'Authentication module' },
          { name: 'session', description: 'Session management' },
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

// ─── args.ts tests ──────────────────────────────────────────────────────────

describe('trace args', () => {
  it('parses requirement ID', () => {
    const result = parseTraceArgs(['req-1']);
    assert.equal(result.reqId, 'req-1');
    assert.equal(result.format, 'text');
    assert.equal(result.help, false);
  });

  it('parses --json flag', () => {
    const result = parseTraceArgs(['req-1', '--json']);
    assert.equal(result.reqId, 'req-1');
    assert.equal(result.format, 'json');
    assert.equal(result.help, false);
  });

  it('detects --help flag', () => {
    const result = parseTraceArgs(['--help']);
    assert.equal(result.help, true);
    assert.equal(result.reqId, '');
  });

  it('detects -h flag', () => {
    const result = parseTraceArgs(['-h']);
    assert.equal(result.help, true);
    assert.equal(result.reqId, '');
  });

  it('handles empty args as help', () => {
    const result = parseTraceArgs([]);
    assert.equal(result.help, true);
    assert.equal(result.reqId, '');
  });

  it('handles help with reqId', () => {
    const result = parseTraceArgs(['req-1', '--help']);
    assert.equal(result.help, true);
  });

  it('handles --json after reqId', () => {
    const result = parseTraceArgs(['req-1', '--json']);
    assert.equal(result.reqId, 'req-1');
    assert.equal(result.format, 'json');
  });
});

// ─── json_render.ts tests ───────────────────────────────────────────────────

describe('trace json_render', () => {
  it('renders complete trace data as JSON', () => {
    const data = makeSampleTraceData();
    const json = renderJsonTrace(data);
    const parsed = JSON.parse(json);
    assert.equal(parsed.requirement.id, 'req-1');
    assert.equal(parsed.designs.length, 1);
    assert.equal(parsed.designs[0].plans.length, 1);
    assert.equal(parsed.designs[0].plans[0].versions.length, 2);
  });

  it('includes all trace chain levels', () => {
    const data = makeSampleTraceData();
    const json = renderJsonTrace(data);
    const parsed = JSON.parse(json);

    const version = parsed.designs[0].plans[0].versions[0];
    assert.equal(version.version, 'v1');
    assert.equal(version.slices.length, 2);
    assert.equal(version.slices[0].id, 'v1-auth-login');
    assert.equal(version.slices[0].state, 'completed');
  });

  it('renders empty designs array', () => {
    const data: TraceData = {
      requirement: { id: 'req-empty', title: 'Empty', status: 'draft', acceptanceCriteria: [] },
      designs: [],
    };
    const json = renderJsonTrace(data);
    const parsed = JSON.parse(json);
    assert.equal(parsed.designs.length, 0);
  });

  it('renders empty plans array', () => {
    const data: TraceData = {
      requirement: { id: 'req-2', title: 'Test', status: 'draft', acceptanceCriteria: [] },
      designs: [{
        id: 'dsg-2',
        title: 'Test design',
        status: 'draft',
        modules: [],
        plans: [],
      }],
    };
    const json = renderJsonTrace(data);
    const parsed = JSON.parse(json);
    assert.equal(parsed.designs[0].plans.length, 0);
  });

  it('output is valid, parseable JSON', () => {
    const data = makeSampleTraceData();
    const json = renderJsonTrace(data);
    assert.doesNotThrow(() => JSON.parse(json));
  });
});

// ─── model.ts type integrity ────────────────────────────────────────────────

describe('trace model types', () => {
  it('TraceRequirement shape is correct', () => {
    const req: TraceRequirement = {
      id: 'test',
      title: 'Test',
      status: 'draft',
      acceptanceCriteria: ['AC1'],
    };
    assert.equal(typeof req.id, 'string');
    assert.equal(typeof req.title, 'string');
    assert.equal(typeof req.status, 'string');
    assert.ok(Array.isArray(req.acceptanceCriteria));
  });

  it('TraceDesign shape is correct', () => {
    const design: TraceDesign = {
      id: 'dsg-1',
      title: 'Test',
      status: 'draft',
      modules: [],
      plans: [],
    };
    assert.equal(typeof design.id, 'string');
    assert.ok(Array.isArray(design.modules));
    assert.ok(Array.isArray(design.plans));
  });
});
