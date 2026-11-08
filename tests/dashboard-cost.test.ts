// 看板的成本与 token 汇总 —— 口径必须锁住
//
// 这些数字是「钱和 token 花在哪了」的唯一来源。三处渲染（TTY / JSON / HTML）
// 都从 dashboard-cost.ts 出，所以这里的测试守的是那一份口径：
//
//   - agent 干活（source: 'agent'）与规划期草稿（无 source）必须分得开
//   - 「测到 0」与「没测到」必须分得开（ADR-035 §3.5）
//   - token 汇总不能把 input/output 弄丢
//   - 待签字队列的真源是 `.zelto/locks/sign-*.json`，不是别的地方

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aggregateByModel,
  collectCosts,
  fmtCost,
  fmtLimit,
  fmtTokens,
  readPendingSigns,
  sumCosts,
  topSlicesByTokens,
} from '../src/cli/commands/dashboard-cost.js';

let workdir: string;
let cwd: string;

function writeEvents(sliceId: string, events: Array<Record<string, unknown>>): void {
  const dir = join(workdir, '.zelto', 'events', sliceId);
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e, i) =>
    JSON.stringify({
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      runSeq: i + 1,
      slice: sliceId,
      run: null,
      type: e.type,
      actor: e.actor ?? 'zelto',
      payload: e.payload ?? {},
    }),
  );
  writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

beforeEach(() => {
  cwd = process.cwd();
  workdir = mkdtempSync(join(tmpdir(), 'zelto-dashboard-cost-'));
  process.chdir(workdir);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(workdir, { recursive: true, force: true });
});

describe('成本与 token 汇总', () => {
  it('agent 花费与规划期 LLM 花费分得开', () => {
    writeEvents('slice-a', [
      {
        type: 'budget.spent',
        payload: {
          amount: 0.5,
          source: 'agent',
          adapter: 'claude-agent',
          inputTokens: 1000,
          outputTokens: 200,
        },
      },
      { type: 'budget.spent', payload: { amount: 0.02, reason: 'llm:deepseek-chat' } },
      {
        type: 'llm.called',
        payload: { model: 'deepseek-chat', promptTokens: 500, completionTokens: 100, totalTokens: 600 },
      },
    ]);

    const costs = collectCosts();
    const a = costs.get('slice-a');
    assert.ok(a, 'slice-a 应该出现在成本表里');
    assert.equal(a.agentCost, 0.5);
    assert.equal(a.llmCost, 0.02);
    assert.equal(a.totalCost, 0.52);
    assert.equal(a.agentCalls, 1);
    assert.equal(a.llmCalls, 1);
  });

  it('agent 侧 token 汇总正确，input 与 output 不混', () => {
    writeEvents('slice-b', [
      {
        type: 'budget.spent',
        payload: { amount: 0.25, source: 'agent', inputTokens: 8000, outputTokens: 1500 },
      },
    ]);

    const a = collectCosts().get('slice-b')!;
    assert.equal(a.agentInputTokens, 8000);
    assert.equal(a.agentOutputTokens, 1500);
    assert.equal(a.agentTokens, 9500);
    assert.equal(a.totalTokens, 9500);
  });

  it('「测到 0」与「没测到」分得开：0 是有效数据', () => {
    // 适配器上报了花费 0 —— 这是有效数据，不能当成没测到
    writeEvents('slice-zero', [
      { type: 'budget.spent', payload: { amount: 0, source: 'agent', inputTokens: 0, outputTokens: 0 } },
    ]);
    // 这一片从来没有成本事件 —— 才是「没测到」
    writeEvents('slice-none', [
      { type: 'run.started', payload: {} },
    ]);

    const costs = collectCosts();
    const zero = costs.get('slice-zero');
    assert.ok(zero, '测到 0 的切片必须在成本表里');
    assert.equal(zero.totalCost, 0);
    assert.equal(zero.measured, true);
    assert.equal(zero.agentCalls, 1);
    assert.equal(costs.has('slice-none'), false, '没测到用量的切片不进成本表');
  });

  it('totalTokens 缺失时回退到 input + output', () => {
    writeEvents('slice-c', [
      {
        type: 'llm.called',
        payload: { model: 'm', promptTokens: 300, completionTokens: 200 },
      },
    ]);

    const c = collectCosts().get('slice-c')!;
    assert.equal(c.llmTokens, 500);
    assert.equal(c.llmPromptTokens, 300);
    assert.equal(c.llmCompletionTokens, 200);
  });

  it('汇总把每一片加总，并区分测到与没测到', () => {
    writeEvents('s1', [
      { type: 'budget.spent', payload: { amount: 0.1, source: 'agent', inputTokens: 100, outputTokens: 10 } },
    ]);
    writeEvents('s2', [
      { type: 'budget.spent', payload: { amount: 0.2, source: 'agent', inputTokens: 200, outputTokens: 20 } },
    ]);
    writeEvents('s3', [{ type: 'run.started', payload: {} }]);

    const costs = collectCosts();
    const totals = sumCosts(costs, 3);
    // 金额用浮点累加，断言按近似 —— 看板不改求和口径（collector 那边也不四舍五入，
    // 两边若一个 round 一个不 round，就会出现「看板说没超、闸门却关了」的错位）
    assert.ok(Math.abs(totals.agentCost - 0.3) < 1e-9);
    assert.equal(totals.agentTokens, 330);
    assert.equal(totals.agentCalls, 2);
    assert.equal(totals.measuredSlices, 2);
    assert.equal(totals.unmeasuredSlices, 1);
  });

  it('按 token 排 Top —— 回答「花在哪了」', () => {
    writeEvents('small', [
      { type: 'budget.spent', payload: { amount: 0.01, source: 'agent', inputTokens: 10, outputTokens: 1 } },
    ]);
    writeEvents('big', [
      { type: 'budget.spent', payload: { amount: 0.9, source: 'agent', inputTokens: 9000, outputTokens: 900 } },
    ]);

    const top = topSlicesByTokens(collectCosts(), 5);
    assert.equal(top.length, 2);
    assert.equal(top[0].sliceId, 'big');
    assert.equal(top[0].cost.totalTokens, 9900);
  });
});

describe('按模型聚合', () => {
  it('同一个模型的花费与 token 合到一行', () => {
    writeEvents('m1', [
      {
        type: 'budget.spent',
        payload: { amount: 0.5, source: 'agent', model: 'claude-sonnet', inputTokens: 1000, outputTokens: 200 },
      },
      {
        type: 'budget.spent',
        payload: { amount: 0.25, source: 'agent', model: 'claude-sonnet', inputTokens: 300, outputTokens: 50 },
      },
    ]);

    const byModel = aggregateByModel(collectCosts());
    assert.equal(byModel.length, 1);
    assert.equal(byModel[0].model, 'claude-sonnet');
    assert.equal(byModel[0].costUsd, 0.75);
    assert.equal(byModel[0].inputTokens, 1300);
    assert.equal(byModel[0].outputTokens, 250);
    assert.equal(byModel[0].tokens, 1550);
    assert.equal(byModel[0].calls, 2);
    assert.equal(byModel[0].llmCalls, 0);
  });

  it('规划期 LLM 的模型名从 reason 里取，与 llm.called 对上', () => {
    writeEvents('m2', [
      { type: 'budget.spent', payload: { amount: 0.02, reason: 'llm:deepseek-chat' } },
      {
        type: 'llm.called',
        payload: { model: 'deepseek-chat', promptTokens: 500, completionTokens: 100, totalTokens: 600 },
      },
    ]);

    const byModel = aggregateByModel(collectCosts());
    assert.equal(byModel.length, 1);
    assert.equal(byModel[0].model, 'deepseek-chat');
    // 钱来自 budget.spent，token 来自 llm.called —— 两笔账合到同一行
    assert.equal(byModel[0].costUsd, 0.02);
    assert.equal(byModel[0].tokens, 600);
    assert.equal(byModel[0].llmCalls, 1);
  });

  it('没标模型的归到「未标注模型」，不丢账', () => {
    writeEvents('m3', [
      { type: 'budget.spent', payload: { amount: 0.1, source: 'agent', inputTokens: 10, outputTokens: 1 } },
    ]);

    const byModel = aggregateByModel(collectCosts());
    assert.equal(byModel.length, 1);
    assert.equal(byModel[0].model, '未标注模型');
    assert.equal(byModel[0].costUsd, 0.1);
  });

  it('按 token 从多到少排 —— 先看到消耗最大的那个模型', () => {
    writeEvents('small-model', [
      {
        type: 'budget.spent',
        payload: { amount: 0.01, source: 'agent', model: 'cheap', inputTokens: 10, outputTokens: 1 },
      },
    ]);
    writeEvents('big-model', [
      {
        type: 'budget.spent',
        payload: { amount: 0.9, source: 'agent', model: 'pricey', inputTokens: 9000, outputTokens: 900 },
      },
    ]);

    const byModel = aggregateByModel(collectCosts());
    assert.equal(byModel.length, 2);
    assert.equal(byModel[0].model, 'pricey');
    assert.equal(byModel[1].model, 'cheap');
  });
});

describe('格式化的口径', () => {
  it('token 数按量级缩写', () => {
    assert.equal(fmtTokens(0), '0');
    assert.equal(fmtTokens(999), '999');
    assert.equal(fmtTokens(1500), '1.5K');
    assert.equal(fmtTokens(2_500_000), '2.5M');
    assert.equal(fmtTokens(3_000_000_000), '3.0B');
  });

  it('花费按量级取舍小数位', () => {
    assert.equal(fmtCost(0), '$0');
    assert.equal(fmtCost(0.0012), '$0.0012');
    assert.equal(fmtCost(0.1234), '$0.123');
    assert.equal(fmtCost(12.345), '$12.35');
  });

  it('不限的预算显示成「不限」', () => {
    assert.equal(fmtLimit(Number.POSITIVE_INFINITY), '不限');
    assert.equal(fmtLimit(1), '$1.00');
  });
});

describe('待签字队列', () => {
  it('只认 locks 下的 sign-*.json，且只看 pending', () => {
    const locks = join(workdir, '.zelto', 'locks');
    mkdirSync(locks, { recursive: true });
    // 待签字
    writeFileSync(
      join(locks, 'sign-slice-a-1.json'),
      JSON.stringify({ id: 'sign-slice-a-1', sliceId: 'slice-a', requestedAt: '2026-01-01T00:00:00Z', status: 'pending' }),
    );
    // 已签字 —— 不该进队列
    writeFileSync(
      join(locks, 'sign-slice-b-2.json'),
      JSON.stringify({ id: 'sign-slice-b-2', sliceId: 'slice-b', requestedAt: '2026-01-02T00:00:00Z', status: 'approved' }),
    );
    // 写集预约 —— 不是签字请求
    writeFileSync(join(locks, 'slice-a.json'), JSON.stringify({ sliceId: 'slice-a', paths: [] }));

    const pending = readPendingSigns();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].sliceId, 'slice-a');
  });

  it('排队最久的排在最前', () => {
    const locks = join(workdir, '.zelto', 'locks');
    mkdirSync(locks, { recursive: true });
    writeFileSync(
      join(locks, 'sign-new.json'),
      JSON.stringify({ id: 'sign-new', sliceId: 'new', requestedAt: '2026-02-01T00:00:00Z', status: 'pending' }),
    );
    writeFileSync(
      join(locks, 'sign-old.json'),
      JSON.stringify({ id: 'sign-old', sliceId: 'old', requestedAt: '2026-01-01T00:00:00Z', status: 'pending' }),
    );

    const pending = readPendingSigns();
    assert.deepEqual(
      pending.map((p) => p.sliceId),
      ['old', 'new'],
    );
  });
});
