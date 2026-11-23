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

  // ─── 回归：验收过了却被写成「门禁② ❌ 未通过」─────────────────────────
  //
  // 病灶（实测 nimrtc-v14 v3-n4-d6-connectivity，2026-11-23）：
  //   追溯块里写着「门禁② ❌ 未通过」，而事实是**验收确实过了**
  //   （gate.result 的 acceptance.status = 'passed'，exitCode = 0）。
  //
  // 根因：`buildTraceBlock` 用了 `passCount > 0 && acceptancePassed`。
  // 而**门禁根本没把验收 stdout 存进事件** ——
  // `AcceptanceOutcome` 只留 status / exitCode / durationMs / reason。
  // 于是 `passCount` 对所有走「显式验收配置」路径的片**恒为 0**，
  // `passCount > 0` 这个条件**永远不成立**。
  //
  // 后果：追溯链说假话。PR body 是给远端 reviewer 看的追溯凭据，
  // 它说「门禁没过」，远端就会以为这片有问题而拒绝 ——
  // **追溯链说假话，比没有追溯链更糟。**
  describe('验收通过了但用例数拿不到', () => {
    const factsWithoutCounts = () =>
      makeFacts({
        review: makeReview({
          gate: { acceptanceRan: true, acceptancePassed: true, passCount: 0, totalCount: 0 },
        }),
      });

    it('追溯块必须说门禁通过了', () => {
      const block = buildTraceBlock(factsWithoutCounts(), '2026-11-22T02:00:00.000Z');
      assert.equal(
        block.gate.passed,
        true,
        '验收跑过且通过了 —— 门禁就该是通过，哪怕用例数拿不到',
      );
    });

    it('摘要表必须说「门禁② ✅ 通过」', () => {
      const rendered = renderPrBody(factsWithoutCounts(), '2026-11-22T02:00:00.000Z');
      assert.ok(
        rendered.body.includes('| 门禁② | ✅ 通过 |'),
        `body 必须说门禁通过了，实际：\n${rendered.body}`,
      );
      assert.ok(
        !rendered.body.includes('门禁② | ❌'),
        `body 不得说门禁没通过，实际：\n${rendered.body}`,
      );
    });

    it('不得显示「✅ 0/0」这种自相矛盾的说法', () => {
      const rendered = renderPrBody(factsWithoutCounts(), '2026-11-22T02:00:00.000Z');
      assert.ok(
        !rendered.body.includes('0/0'),
        `用例数拿不到就不该显示数字，实际：\n${rendered.body}`,
      );
      assert.ok(
        rendered.body.includes('用例数未记录'),
        `要说清「没记录」而不是假装有数字，实际：\n${rendered.body}`,
      );
    });
  });

  it('验收没通过时仍然要报未通过', () => {
    const facts = makeFacts({
      review: makeReview({
        gate: { acceptanceRan: true, acceptancePassed: false, passCount: 0, totalCount: 0 },
      }),
    });
    const block = buildTraceBlock(facts, '2026-11-22T02:00:00.000Z');
    assert.equal(block.gate.passed, false);
  });

  it('验收没跑过时不能算门禁通过', () => {
    const facts = makeFacts({
      review: makeReview({
        gate: { acceptanceRan: false, acceptancePassed: false, passCount: 0, totalCount: 0 },
      }),
    });
    const block = buildTraceBlock(facts, '2026-11-22T02:00:00.000Z');
    assert.equal(block.gate.passed, false);
  });
});
