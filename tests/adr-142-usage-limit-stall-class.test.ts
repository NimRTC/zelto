// 配额耗尽是独立停机类（ADR-142）
//
// 这个文件钉住 ADR-142 的核心主张：
//
//   1. **识别靠输出文本** —— 退出码说不了这件事；
//   2. **识别出来 → 分类为 `usage_limit`**；
//   3. **`usage_limit` 不可自动恢复** —— 配额墙不会因为重试而恢复；
//   4. **端到端**：`handleAgentFailure` 拿到配额输出时**不自动重试**，
//      直接停机；
//   5. **停机时说清「等配额」**并给出 reset time；
//   6. **reset time 取不到时如实留空** —— 不编；
//   7. **不传输出时行为不变** —— 既有调用点不受影响；
//   8. **认不出时不误判** —— 普通失败不能被当成配额。
//
// ## 为什么这条规则重要
//
// 配额耗尽的退出码与普通失败**一模一样**。不单独分类的话，它会落进
// `environment_failure` → **可自动恢复** → 自动重试 → 每次重试再撞
// 一次同样的墙，还要重新起一个 agent 会话重新烧 token，
// 并把重试预算烧光（真需要重试的机会也没了）。

import { describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';

import { classifyStall, isAutoResolvable } from '../src/core/stall/classifier.js';
import { detectUsageLimit } from '../src/core/stall/usage-limit.js';
import { store, events } from '../src/cli/commands/shared.js';
import { handleAgentFailure } from '../src/cli/commands/run-support.js';

// ─── 识别（纯函数）─────────────────────────────────────────────────────────

describe('配额识别（ADR-142 决策二）', () => {
  it('认得出 rate limit', () => {
    const r = detectUsageLimit('Error: Rate limit exceeded for requests');
    assert.equal(r.isUsageLimit, true);
    assert.ok(r.matched, '要说清命中了什么');
  });

  it('认得出 429', () => {
    assert.equal(detectUsageLimit('HTTP 429 Too Many Requests').isUsageLimit, true);
  });

  it('认得出 usage limit', () => {
    assert.equal(detectUsageLimit('Your usage limit has been reached').isUsageLimit, true);
  });

  it('认得出 quota', () => {
    assert.equal(detectUsageLimit('Error: insufficient_quota').isUsageLimit, true);
  });

  it('认得出 too many requests', () => {
    assert.equal(detectUsageLimit('Too Many Requests, please slow down').isUsageLimit, true);
  });

  it('认得出 credit balance is too low', () => {
    assert.equal(detectUsageLimit('Credit balance is too low').isUsageLimit, true);
  });

  it('认得出 overloaded', () => {
    assert.equal(detectUsageLimit('The server is overloaded').isUsageLimit, true);
  });

  it('普通失败**不**被误判成配额', () => {
    // 认不出配额错误只是「不优化重试」，**不影响安全** ——
    // 所以宁可漏认，不可误认（误认 = 真环境抖动也不重试了）。
    const r = detectUsageLimit('Error: cannot find module "./foo"');
    assert.equal(r.isUsageLimit, false);
    assert.equal(r.resetAt, null);
    assert.equal(r.retryAfterSec, null);
  });

  it('空输出 / null / undefined 都不是配额', () => {
    assert.equal(detectUsageLimit('').isUsageLimit, false);
    assert.equal(detectUsageLimit(null).isUsageLimit, false);
    assert.equal(detectUsageLimit(undefined).isUsageLimit, false);
  });

  it('只看**末尾** 8000 字符（配额错误通常在末尾）', () => {
    const long = `${'x'.repeat(20_000)}\nError: rate limit exceeded`;
    assert.equal(detectUsageLimit(long).isUsageLimit, true);
  });
});

// ─── reset time ───────────────────────────────────────────────────────────

describe('reset time 提取（ADR-142 决策四）', () => {
  it('绝对时间 → resetAt', () => {
    const r = detectUsageLimit(
      'Usage limit reached. Your limit resets at 2026-11-28T17:30:00Z',
    );
    assert.equal(r.isUsageLimit, true);
    assert.equal(r.resetAt, '2026-11-28T17:30:00Z');
  });

  it('绝对时间（空格分隔）→ 规范化成 T + Z', () => {
    const r = detectUsageLimit('rate limit exceeded, resets at 2026-11-28 17:30:00 UTC');
    assert.equal(r.resetAt, '2026-11-28T17:30:00Z');
  });

  it('相对秒数 → retryAfterSec（**不换算成绝对时间**）', () => {
    const r = detectUsageLimit('Rate limit exceeded. Please try again in 3600s.');
    assert.equal(r.isUsageLimit, true);
    assert.equal(r.retryAfterSec, 3600);
    assert.equal(r.resetAt, null, '给不出绝对时间就**不编**');
  });

  it('相对分钟 → 换算成秒', () => {
    const r = detectUsageLimit('Rate limit exceeded. Please try again in 30 minutes.');
    assert.equal(r.retryAfterSec, 1800);
  });

  it('两种都取不到 → 如实留空', () => {
    const r = detectUsageLimit('Error: 429 rate limit reached');
    assert.equal(r.isUsageLimit, true);
    assert.equal(r.resetAt, null);
    assert.equal(r.retryAfterSec, null);
  });
});

// ─── 分类 ──────────────────────────────────────────────────────────────────

describe('分类（ADR-142 决策一 / 决策六）', () => {
  it('usage_limit → 分类为 usage_limit', () => {
    assert.equal(
      classifyStall({ type: 'usage_limit', message: 'rate limit', attempts: 1 }),
      'usage_limit',
    );
  });

  it('usage_limit **不可自动恢复**（这是本 ADR 的核心）', () => {
    // 判成 true = 配额墙面前自动重试 = 纯浪费 + 烧掉重试预算。
    assert.equal(isAutoResolvable('usage_limit'), false);
  });

  it('usage_limit 的分类**不吃**「重试次数够了」的兜底规则', () => {
    // attempts=5 时，若规则顺序错了会落进 cognitive_stuck。
    assert.equal(
      classifyStall({ type: 'usage_limit', message: 'x', attempts: 5 }),
      'usage_limit',
    );
  });

  it('既有分类的行为不变', () => {
    assert.equal(
      classifyStall({ type: 'build_failure', message: 'x', attempts: 1 }),
      'environment_failure',
    );
    assert.equal(
      classifyStall({ type: 'budget_exhausted', message: 'x', attempts: 1 }),
      'budget_exhausted',
    );
    assert.equal(
      classifyStall({ type: 'agent_question', message: 'x', attempts: 1 }),
      'agent_question',
    );
    assert.equal(
      classifyStall({ type: 'test_failure', message: 'x', attempts: 1 }),
      'environment_failure',
    );
  });
});

// ─── 端到端处置 ────────────────────────────────────────────────────────────

function makeSliceData(id: string, autoResolved = 0) {
  const now = new Date().toISOString();
  return {
    id,
    title: 'test-slice',
    state: 'running' as const,
    spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
    acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: [], contracts: [], tests: [] },
    traceWaiver: null,
    baseline: false,
    type: 'feature' as const,
    writes: [],
    runs: [],
    stall: { class: null, autoResolved, gateRetries: 0 },
    createdAt: now,
    updatedAt: now,
  };
}

describe('处置：识别 → 分类 → 不重试（ADR-142 验收 5）', () => {
  it('配额输出 → 直接停机，**不自动重试**', async () => {
    const appendMock = mock.method(events, 'append', async () => {});
    const readMock = mock.method(store, 'read', async () => makeSliceData('quota-slice', 0));
    const writeMock = mock.method(store, 'write', async () => {});

    const result = await handleAgentFailure('quota-slice', 1, {
      maxRetries: 2,
      agentOutput: 'Error: Rate limit exceeded for requests',
    });

    assert.equal(result.action, 'stall', '配额耗尽不可自动恢复 → 直接停机');

    // **没有**走重试分支 —— 重试预算不能被烧掉。
    const stallEvent = appendMock.mock.calls.find(
      (c) => c.arguments[1] === 'stall.classified',
    );
    assert.ok(stallEvent, '要写停机分类事件');
    const payload = stallEvent.arguments[3] as Record<string, unknown>;
    assert.equal(payload.class, 'usage_limit');
    assert.equal(
      payload.autoRetry,
      undefined,
      '配额耗尽**不自动重试** —— 事件里不能有 autoRetry',
    );

    appendMock.mock.restore();
    readMock.mock.restore();
    writeMock.mock.restore();
  });

  it('停机事件里带 resetAt（ADR-142 验收 6 / 7）', async () => {
    const appendMock = mock.method(events, 'append', async () => {});
    const readMock = mock.method(store, 'read', async () => makeSliceData('quota-slice-2', 0));
    const writeMock = mock.method(store, 'write', async () => {});

    await handleAgentFailure('quota-slice-2', 1, {
      maxRetries: 2,
      agentOutput: 'Usage limit reached. Your limit resets at 2026-11-28T17:30:00Z',
    });

    const stallEvent = appendMock.mock.calls.find(
      (c) => c.arguments[1] === 'stall.classified',
    );
    assert.ok(stallEvent);
    const payload = stallEvent.arguments[3] as Record<string, unknown>;
    assert.equal(payload.resetAt, '2026-11-28T17:30:00Z');

    appendMock.mock.restore();
    readMock.mock.restore();
    writeMock.mock.restore();
  });

  it('reset time 取不到 → **null**（不是编一个）（ADR-142 验收 7）', async () => {
    const appendMock = mock.method(events, 'append', async () => {});
    const readMock = mock.method(store, 'read', async () => makeSliceData('quota-slice-3', 0));
    const writeMock = mock.method(store, 'write', async () => {});

    await handleAgentFailure('quota-slice-3', 1, {
      maxRetries: 2,
      agentOutput: 'Error: 429 rate limit reached',
    });

    const stallEvent = appendMock.mock.calls.find(
      (c) => c.arguments[1] === 'stall.classified',
    );
    assert.ok(stallEvent);
    const payload = stallEvent.arguments[3] as Record<string, unknown>;
    assert.equal(payload.resetAt, null);
    assert.equal(payload.retryAfterSec, null);

    appendMock.mock.restore();
    readMock.mock.restore();
    writeMock.mock.restore();
  });

  it('不传输出 → 行为与改动前一致（仍然自动重试）（ADR-142 验收 9）', async () => {
    const appendMock = mock.method(events, 'append', async () => {});
    const readMock = mock.method(store, 'read', async () => makeSliceData('plain-slice', 0));
    const writeMock = mock.method(store, 'write', async () => {});

    const result = await handleAgentFailure('plain-slice', 139, { maxRetries: 2 });

    assert.equal(result.action, 'retry');
    assert.equal(result.retryCount, 1);

    appendMock.mock.restore();
    readMock.mock.restore();
    writeMock.mock.restore();
  });

  it('普通失败输出 → 仍然自动重试（不被误判成配额）', async () => {
    const appendMock = mock.method(events, 'append', async () => {});
    const readMock = mock.method(store, 'read', async () => makeSliceData('plain-slice-2', 0));
    const writeMock = mock.method(store, 'write', async () => {});

    const result = await handleAgentFailure('plain-slice-2', 139, {
      maxRetries: 2,
      agentOutput: 'Error: cannot find module "./missing"',
    });

    assert.equal(result.action, 'retry', '普通失败仍然走自动重试');

    appendMock.mock.restore();
    readMock.mock.restore();
    writeMock.mock.restore();
  });
});
