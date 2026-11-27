// ADR-104：签字复查要认「门禁跑的是不是本片」—— 收窄门禁的证据闭环
//
// 病灶（ADR-097 落地后暴露，ZD-030 剩余问题②）：
//
//   ADR-097 让门禁能按写集**收窄**跑哪些用例（实测：v2-ice 从 2387 个
//   用例降到 ~200 个），收窄的证据**已经在事件里**
//   （`scoped` / `scopeLabels` / `scopeTestCount` / `scopeTotalTestCount`）。
//
//   但**签字判据没认这些字段** —— `evaluateAcceptanceCheck` 只看
//   `acceptanceRan` / `acceptancePassed`，**看不出这轮跑的是不是本片
//   相关的用例**。
//
//   于是出现一种「看似合理、实则没闭环」的状态：
//     - 门禁按写集收窄，只跑了 200 个与本片相关的用例，全绿；
//     - 签字复查四项确认全过，显示「验收通过 200/200」；
//     - 但**没有任何一处证据说明「这 200 个就是本片该验的那些」**。
//
//   这不是「判定错了」，是**判定对了但说不清** ——
//   而「说不清」在签字这一环有实际后果：
//
//   `gate.scope` 的规则是**人配的**（在 `config.yaml` 里），
//   所以「规则配窄了 → 本片该验的用例没被验」是一个**真实存在的**失败模式，
//   而现在签字复查**没有任何一处能看出规则配得对不对**。
//   人签字时看到「验收通过」，看不到「验的是哪 200 个」
//   = 人在**不知情**的情况下批准。
//
// 本 ADR 做的（决策一~三）：
//   1. 事实层加 `scope` 段（只采**事件里已有**的字段，不改 schema）；
//   2. 第②项确认的**佐证文案**带上作用域（**判据不变**）；
//   3. 呈现层让人**看得见**收窄。
//
// **判据为什么不变**（ADR-104 §2.3 / 决策二）：
//   收窄的 fail closed **已经在门禁侧**承担了（ADR-097 决策三：
//   标签一个都没匹配到 → 门禁判失败，不是「跑 0 个用例判通过」）。
//   签字侧再判一次是**重复**，而且会让**老事件**签名失败
//   （老事件必然是全量跑的，没有作用域字段）—— 全量当然完整。
//
//   这一项要做的是**让证据可见**，不是**更严**。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { collectSignReviewFacts } from '../src/core/sign-review/collect.js';
import { describeScope, evaluateSignChecks } from '../src/core/sign-review/evaluate.js';
import { renderSignReview } from '../src/cli/sign-review/render.js';
import type { SignReviewSource } from '../src/core/sign-review/collect.js';
import type { GateScopeFacts, SignReviewFacts } from '../src/core/sign-review/types.js';
import type { SliceData } from '../src/core/slice/store.js';
import type { EventEnvelope } from '../src/core/events/stream.js';

// ─── 夹具 ──────────────────────────────────────────────────────────────────

/** 默认作用域事实 —— 老事件的样子（没收窄）。 */
function noScope(): GateScopeFacts {
  return {
    scoped: false,
    labels: [],
    testCount: null,
    totalTestCount: null,
    source: 'no-config',
    reason: '',
  };
}

/** 收窄的作用域事实。 */
function scopedScope(overrides: Partial<GateScopeFacts> = {}): GateScopeFacts {
  return {
    scoped: true,
    labels: ['ice', 'sdp'],
    testCount: 42,
    totalTestCount: 2387,
    source: 'config',
    reason: '',
    ...overrides,
  };
}

/** 一份「通过」的签字复查事实。 */
function facts(overrides: Partial<SignReviewFacts> = {}): SignReviewFacts {
  return {
    sliceId: 'v2-ice',
    sliceState: 'completed',
    trace: { requirements: ['R1'], contracts: [], tests: [] },
    gate: {
      acceptanceRan: true,
      acceptancePassed: true,
      passCount: 42,
      totalCount: 42,
      scope: noScope(),
    },
    diff: {
      baseRef: 'abc1234',
      baseNote: '切片冻结时的基点 abc1234',
      filesChanged: 3,
      addedLines: 100,
      deletedLines: 10,
      files: [],
    },
    cost: { totalUsd: 0.12 },
    stall: { stalled: false, stallClass: null },
    writeSetAudit: { violations: [] },
    artifact: { status: 'not-in-trunk', path: null, hash: null, note: null },
    ...overrides,
  };
}

/** 第②项确认（验收真跑过本片）。 */
function acceptanceCheck(f: SignReviewFacts) {
  return evaluateSignChecks(f).find((c) => c.label === '验收真跑过本片')!;
}

/** 造一条 `gate.result` 事件。 */
function gateResultEvent(payload: Record<string, unknown>): {
  ts: string;
  runSeq: number;
  slice: string;
  run: null;
  type: 'gate.result';
  actor: string;
  payload: Record<string, unknown>;
} {
  return {
    ts: '2026-11-24T01:00:00.000Z',
    runSeq: 1,
    slice: 'v2-ice',
    run: null,
    type: 'gate.result',
    actor: 'zelto',
    payload,
  };
}

/** 收集层的假 source —— 只读，不碰文件。 */
const source: SignReviewSource = {
  readSlice: async () =>
    ({
      id: 'v2-ice',
      title: 'ICE',
      state: 'completed',
      trace: { requirements: ['R1'], contracts: [], tests: [] },
      traceWaiver: null,
      baseline: false,
      writes: ['src/modules/ice/**'],
      acceptance: null,
      spec: { path: 'specs/slices/v2-ice.md' },
      baseCommit: null,
      drift: { detected: false, reason: null, at: null },
      runs: [],
      stall: { class: null, autoResolved: 0, gateRetries: 0 },
      createdAt: '2026-11-24T00:00:00.000Z',
      updatedAt: '2026-11-24T00:00:00.000Z',
    }) as unknown as SliceData,
  readEvents: async () => [] as unknown as EventEnvelope[],
  worktreePath: () => null,
  repoRoot: process.cwd(),
};

// ─── 收集层 ────────────────────────────────────────────────────────────────

describe('ADR-104：事实层采集门禁作用域', () => {
  it('从 gate.result 事件里采出作用域字段', async () => {
    const events = [
      gateResultEvent({
        passed: true,
        acceptance: { status: 'passed' },
        scoped: true,
        scopeLabels: ['ice', 'sdp'],
        scopeSource: 'config',
        scopeTestCount: 42,
        scopeTotalTestCount: 2387,
      }),
    ];
    const f = await collectSignReviewFacts('v2-ice', { ...source, readEvents: async () => events });
    assert.equal(f.gate.scope.scoped, true);
    assert.deepEqual(f.gate.scope.labels, ['ice', 'sdp']);
    assert.equal(f.gate.scope.testCount, 42);
    assert.equal(f.gate.scope.totalTestCount, 2387);
    assert.equal(f.gate.scope.source, 'config');
  });

  it('老事件（无作用域字段）按「没收窄」降级 —— 且这个降级是准确的', async () => {
    // ADR-104 决策一：老事件是**收窄功能上线之前**写的，
    // 那时的门禁**必然跑的是全量** —— 全量永远覆盖本片。
    // 所以「没收窄」这个描述对老事件是**准确**的，不是「查不到」。
    const events = [gateResultEvent({ passed: true, acceptance: { status: 'passed' } })];
    const f = await collectSignReviewFacts('v2-ice', { ...source, readEvents: async () => events });
    assert.equal(f.gate.scope.scoped, false);
    assert.equal(f.gate.scope.source, 'no-config');
    assert.deepEqual(f.gate.scope.labels, []);
    assert.equal(f.gate.scope.testCount, null);
    assert.equal(f.gate.scope.totalTestCount, null);
  });

  it('没有 gate.result 事件时也不崩，作用域按「没收窄」', async () => {
    const f = await collectSignReviewFacts('v2-ice', source);
    assert.equal(f.gate.acceptanceRan, false);
    assert.equal(f.gate.scope.scoped, false);
  });

  it('回退路径（无 acceptance.status）也带作用域', async () => {
    const events = [
      gateResultEvent({
        passed: true,
        scoped: true,
        scopeLabels: ['ice'],
        scopeSource: 'config',
        scopeTestCount: 10,
        scopeTotalTestCount: 100,
        results: [{ command: 'acceptance-cli', passed: true, stdout: 'ℹ pass 5\nℹ tests 5\n' }],
      }),
    ];
    const f = await collectSignReviewFacts('v2-ice', { ...source, readEvents: async () => events });
    assert.equal(f.gate.acceptanceRan, true, '回退路径应判 ran');
    assert.equal(f.gate.scope.scoped, true, '回退路径也要带作用域');
    assert.equal(f.gate.scope.testCount, 10);
  });

  it('标签去重且排序 —— 呈现要稳定（规则顺序会变）', async () => {
    const events = [
      gateResultEvent({
        passed: true,
        acceptance: { status: 'passed' },
        scoped: true,
        scopeLabels: ['sdp', 'ice', 'sdp'],
        scopeSource: 'config',
      }),
    ];
    const f = await collectSignReviewFacts('v2-ice', { ...source, readEvents: async () => events });
    assert.deepEqual(f.gate.scope.labels, ['ice', 'sdp'], '应去重并排序');
  });
});

// ─── 判定层：文案带作用域，判据不变 ───────────────────────────────────────

describe('ADR-104：第②项确认的佐证文案带作用域', () => {
  it('收窄时佐证里带标签与计数', () => {
    const f = facts();
    f.gate.scope = scopedScope();
    const check = acceptanceCheck(f);
    assert.ok(
      check.evidence.includes('按写集收窄跑的'),
      `收窄时应说明收窄了，实际：${check.evidence}`,
    );
    assert.ok(check.evidence.includes('ice、sdp'), `应带标签，实际：${check.evidence}`);
    assert.ok(
      check.evidence.includes('全量 2387 个里选了 42 个'),
      `应带计数对比，实际：${check.evidence}`,
    );
  });

  it('判据不变：收窄了但验收通过 → 仍然通过', () => {
    const f = facts();
    f.gate.scope = scopedScope();
    assert.equal(acceptanceCheck(f).ok, true, '收窄不该让验收项失败（门禁侧已 fail closed）');
  });

  it('判据不变：验收没过 → 仍然不过（收窄与否无关）', () => {
    const f = facts();
    f.gate.acceptancePassed = false;
    f.gate.scope = scopedScope();
    assert.equal(acceptanceCheck(f).ok, false);
  });

  it('判据不变：老事件（无 scope 字段）→ 验收项仍按原判据判', () => {
    const f = facts();
    // @ts-expect-error 模拟老夹具：没有 scope 字段
    delete f.gate.scope;
    const check = acceptanceCheck(f);
    assert.equal(check.ok, true, '老夹具不该因为缺 scope 而失败');
    assert.ok(check.evidence.includes('acceptance 通过'), '文案不该崩');
  });

  it('没收窄且没原因 → 文案里不出现作用域说明', () => {
    const f = facts();
    f.gate.scope = noScope();
    const evidence = acceptanceCheck(f).evidence;
    assert.ok(!evidence.includes('收窄'), `不该提收窄，实际：${evidence}`);
    assert.ok(!evidence.includes('全量'), `不该提全量，实际：${evidence}`);
  });

  it('没收窄但有原因 → 说明为什么跑的是全量', () => {
    const f = facts();
    f.gate.scope = {
      scoped: false,
      labels: [],
      testCount: null,
      totalTestCount: null,
      source: 'fallback-full',
      reason: '写集没命中任何规则',
    };
    const evidence = acceptanceCheck(f).evidence;
    assert.ok(evidence.includes('写集没命中任何规则'), `应说明原因，实际：${evidence}`);
  });
});

// ─── 措辞层 ────────────────────────────────────────────────────────────────

describe('ADR-104：describeScope 的三种句式', () => {
  it('收窄 + 两个数都在 → 「全量 N 个里选了 M 个」', () => {
    const note = describeScope(scopedScope());
    assert.ok(note.includes('全量 2387 个里选了 42 个'), `实际：${note}`);
  });

  it('收窄 + 只有一个数 → 不拼计数（不能拼出「全量 null 个」）', () => {
    const note = describeScope(scopedScope({ totalTestCount: null }));
    assert.ok(note.includes('按写集收窄跑的'), `实际：${note}`);
    assert.ok(!note.includes('null'), `不得出现 null，实际：${note}`);
  });

  it('收窄 + 没有标签 → 明说「无标签」而不是空括号', () => {
    const note = describeScope(scopedScope({ labels: [] }));
    assert.ok(note.includes('（无标签）'), `实际：${note}`);
  });

  it('没收窄 + 有原因 → 「门禁跑的是全量（原因）」', () => {
    const note = describeScope({
      scoped: false,
      labels: [],
      testCount: null,
      totalTestCount: null,
      source: 'fallback-full',
      reason: '没配 gate.scope',
    });
    assert.ok(note.includes('门禁跑的是全量'), `实际：${note}`);
    assert.ok(note.includes('没配 gate.scope'), `实际：${note}`);
  });

  it('没收窄 + 没原因 → 空串（调用方不拼）', () => {
    assert.equal(describeScope(noScope()), '');
  });

  it('没有 scope 字段（老夹具）→ 空串，不崩', () => {
    assert.equal(describeScope(undefined), '');
  });
});

// ─── 呈现层 ────────────────────────────────────────────────────────────────

describe('ADR-104：CLI 呈现让人看得见收窄', () => {
  /** 去 ANSI 的纯文本 */
  function plain(f: SignReviewFacts, width = 80): string {
    return renderSignReview(evaluateSignChecks(f), f, { width }).replace(/\x1b\[[0-9;]*m/g, '');
  }

  /** 找「验收（门禁②）」段的下一行 */
  function acceptanceLine(f: SignReviewFacts, width = 80): string {
    const lines = plain(f, width).split('\n');
    const idx = lines.findIndex((l) => l.includes('门禁②'));
    return lines[idx + 1] ?? '';
  }

  it('验收段里完整显示作用域说明（不被截断）', () => {
    const f = facts();
    f.gate.scope = scopedScope();
    const line = acceptanceLine(f, 80);
    assert.ok(
      line.includes('按写集收窄跑的（标签 ice、sdp）'),
      `验收段应显示标签，实际：${line}`,
    );
    assert.ok(
      line.includes('全量 2387 个里选了 42 个'),
      `验收段应显示计数对比，实际：${line}`,
    );
  });

  it('验收段在 100 列下也完整（不靠宽度侥幸）', () => {
    const f = facts();
    f.gate.scope = scopedScope();
    const line = acceptanceLine(f, 100);
    assert.ok(line.includes('全量 2387 个里选了 42 个'), `实际：${line}`);
  });

  it('没收窄时不提收窄（不制造噪音）', () => {
    const f = facts();
    f.gate.scope = noScope();
    const line = acceptanceLine(f, 80);
    assert.ok(!line.includes('收窄'), `不该提收窄，实际：${line}`);
  });

  it('没收窄但有原因 → 说明为什么跑的是全量', () => {
    const f = facts();
    f.gate.scope = {
      scoped: false,
      labels: [],
      testCount: null,
      totalTestCount: null,
      source: 'fallback-full',
      reason: '写集没命中任何规则',
    };
    const line = acceptanceLine(f, 80);
    assert.ok(line.includes('写集没命中任何规则'), `实际：${line}`);
  });

  it('老夹具（无 scope 字段）→ 渲染不崩', () => {
    const f = facts();
    // @ts-expect-error 模拟老夹具
    delete f.gate.scope;
    const text = plain(f, 80);
    assert.ok(text.includes('验收（门禁②）'), '应照常渲染');
    assert.ok(!text.includes('undefined'), `不该出现 undefined，实际：${text}`);
  });
});
