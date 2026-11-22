// 单元测试：PR body 的确定性渲染（ADR-094 §6.2 / §6.3）
//
// body 里的追溯块是**契约的一部分** —— 工具要解析它。
// 所以格式漂了就等于契约破坏，这里守着的正是这个。

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildForgeTraceFacts,
  buildTraceBlock,
  findLatestApproval,
  renderPrBody,
  renderPrTitle,
  TRACE_BLOCK_SCHEMA,
  type ForgeTraceFacts,
} from '../../../src/core/forge/index.js';
import type { EventEnvelope } from '../../../src/core/events/stream.js';
import type { SliceData } from '../../../src/core/slice/store.js';
import type { SignReviewFacts } from '../../../src/core/sign-review/types.js';

function makeSlice(overrides: Partial<SliceData> = {}): SliceData {
  return {
    id: 'v1-demo',
    title: '演示切片',
    state: 'completed',
    spec: {
      path: 'specs/slices/v1-demo.md',
      frozenHash: 'sha256:abc123',
      frozenAt: '2026-11-22T00:00:00.000Z',
      boundaryHash: 'sha256:def456',
    },
    acceptance: { dir: 'tests/acceptance/v1-demo/', frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: [], contracts: [], tests: [] },
    traceWaiver: null,
    baseline: false,
    writes: ['src/demo.ts'],
    runs: [],
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: '2026-11-22T00:00:00.000Z',
    updatedAt: '2026-11-22T00:00:00.000Z',
    ...overrides,
  } as SliceData;
}

function makeReview(overrides: Partial<SignReviewFacts> = {}): SignReviewFacts {
  return {
    sliceId: 'v1-demo',
    sliceState: 'completed',
    trace: { requirements: ['r1', 'r2', 'r3'], contracts: ['c1'], tests: ['t1'] },
    gate: { acceptanceRan: true, acceptancePassed: true, passCount: 5, totalCount: 5 },
    diff: { filesChanged: 3, addedLines: 100, deletedLines: 10 },
    cost: { totalUsd: 0.12 },
    stall: { stalled: false, stallClass: null },
    writeSetAudit: { violations: [] },
    artifact: { status: 'not-in-trunk', path: null, hash: null, note: null },
    ...overrides,
  };
}

function makeEvent(
  type: EventEnvelope['type'],
  payload: Record<string, unknown> = {},
  actor = 'human',
): EventEnvelope {
  return {
    ts: '2026-11-22T01:00:00.000Z',
    runSeq: 1,
    slice: 'v1-demo',
    run: null,
    type,
    actor,
    payload,
  };
}

function makeFacts(overrides: Partial<ForgeTraceFacts> = {}): ForgeTraceFacts {
  return {
    sliceId: 'v1-demo',
    title: '演示切片',
    specPath: 'specs/slices/v1-demo.md',
    frozenHash: 'sha256:abc123',
    boundaryHash: 'sha256:def456',
    signId: 'sign-v1-demo-1',
    approvedBy: 'human',
    approvedAt: '2026-11-22T01:00:00.000Z',
    headBranch: 'slice/v1-demo',
    baseBranch: 'main',
    review: makeReview(),
    ...overrides,
  };
}

describe('findLatestApproval', () => {
  it('returns nulls when there is no approval event', () => {
    const found = findLatestApproval([makeEvent('sign.requested')]);
    assert.equal(found.signId, null);
    assert.equal(found.approvedBy, null);
  });

  it('finds the latest approval', () => {
    const found = findLatestApproval([
      makeEvent('sign.approved', { signId: 'sign-old' }),
      makeEvent('sign.revoked', { signId: 'sign-old' }),
      makeEvent('sign.approved', { signId: 'sign-new' }),
    ]);
    assert.equal(found.signId, 'sign-new');
  });
});

describe('buildForgeTraceFacts', () => {
  it('pulls the approval out of the event stream', () => {
    const facts = buildForgeTraceFacts(
      makeSlice(),
      makeReview(),
      [makeEvent('sign.approved', { signId: 'sign-v1-demo-9' })],
      { head: 'slice/v1-demo', base: 'version/v1' },
    );
    assert.equal(facts.signId, 'sign-v1-demo-9');
    assert.equal(facts.approvedBy, 'human');
    assert.equal(facts.baseBranch, 'version/v1');
    assert.equal(facts.headBranch, 'slice/v1-demo');
  });
});

describe('buildTraceBlock', () => {
  it('carries the schema version', () => {
    const block = buildTraceBlock(makeFacts(), '2026-11-22T02:00:00.000Z');
    assert.equal(block.schema, TRACE_BLOCK_SCHEMA);
  });

  it('counts the trace items', () => {
    const block = buildTraceBlock(makeFacts(), '2026-11-22T02:00:00.000Z');
    assert.equal(block.trace.requirements, 3);
    assert.equal(block.trace.contracts, 1);
    assert.equal(block.trace.tests, 1);
  });

  it('carries the gate facts verbatim', () => {
    const block = buildTraceBlock(makeFacts(), '2026-11-22T02:00:00.000Z');
    assert.equal(block.gate.acceptanceRan, true);
    assert.equal(block.gate.acceptancePassed, true);
    assert.equal(block.gate.passCount, 5);
    assert.equal(block.gate.totalCount, 5);
  });

  it('carries the write-set violations', () => {
    const block = buildTraceBlock(
      makeFacts({
        review: makeReview({
          writeSetAudit: { violations: ['src/other.ts'] },
        }),
      }),
      '2026-11-22T02:00:00.000Z',
    );
    assert.deepEqual(block.writeSetViolations, ['src/other.ts']);
  });

  it('is deterministic — same facts, same block', () => {
    const now = '2026-11-22T02:00:00.000Z';
    const a = buildTraceBlock(makeFacts(), now);
    const b = buildTraceBlock(makeFacts(), now);
    assert.deepEqual(a, b);
  });
});

describe('renderPrTitle', () => {
  it('prefixes with [zelto] so the origin is obvious in the PR list', () => {
    assert.equal(renderPrTitle(makeFacts()), '[zelto] 演示切片');
  });
});

describe('renderPrBody', () => {
  it('embeds a machine-readable trace block in an HTML comment', () => {
    const rendered = renderPrBody(makeFacts(), '2026-11-22T02:00:00.000Z');

    assert.ok(rendered.body.includes('<!-- zelto-trace'));
    assert.ok(rendered.body.includes('-->'));

    // 抽出 JSON 块并解析 —— 这是工具将来的读法
    const match = /<!-- zelto-trace\n([\s\S]*?)\n-->/.exec(rendered.body);
    assert.ok(match, 'trace block must be extractable');
    const parsed = JSON.parse(match![1]) as Record<string, unknown>;
    assert.equal(parsed['schema'], TRACE_BLOCK_SCHEMA);
    assert.equal(parsed['sliceId'], 'v1-demo');
  });

  it('says that merging happens in zelto, not on GitHub', () => {
    const rendered = renderPrBody(makeFacts(), '2026-11-22T02:00:00.000Z');
    assert.ok(
      rendered.body.includes('zelto merge v1-demo'),
      'body must point at the explicit merge command',
    );
    assert.ok(
      rendered.body.includes('批准权在 zelto 里'),
      'body must say where the approval authority lives',
    );
  });

  it('shows the human-readable summary table', () => {
    const rendered = renderPrBody(makeFacts(), '2026-11-22T02:00:00.000Z');
    assert.ok(rendered.body.includes('## 追溯链'));
    assert.ok(rendered.body.includes('需求 3'));
    assert.ok(rendered.body.includes('5/5'));
  });

  it('reports write-set violations in the summary', () => {
    const rendered = renderPrBody(
      makeFacts({
        review: makeReview({ writeSetAudit: { violations: ['src/x.ts', 'src/y.ts'] } }),
      }),
      '2026-11-22T02:00:00.000Z',
    );
    assert.ok(rendered.body.includes('2 处'));
  });

  it('shows the frozen hash so a reviewer can verify the spec', () => {
    const rendered = renderPrBody(makeFacts(), '2026-11-22T02:00:00.000Z');
    assert.ok(rendered.body.includes('sha256:abc123'));
  });

  it('is deterministic — same facts and same now give the same body', () => {
    const now = '2026-11-22T02:00:00.000Z';
    const a = renderPrBody(makeFacts(), now);
    const b = renderPrBody(makeFacts(), now);
    assert.equal(a.body, b.body);
    assert.equal(a.title, b.title);
  });
});
