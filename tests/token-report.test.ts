// token-report 脚本的口径测试 —— 开销对比的结论必须可复算。
//
// 这个脚本是「钱和 token 花在哪了」的分析入口，它的输出会被人直接拿去
// 判断 zelto 值不值。所以口径必须锁死：
//
//   - 失败重试烧的 token 不在事件流里，只能估算，且必须在输出里标成估算
//   - 旧格式切片（只有 run.finished.costUsd、没有 budget.spent）不能被当成「零花费」
//   - BOM 文件（Windows PowerShell 写出来的 UTF-8）必须能解析
//   - 规划期 LLM 的 token 只算一次（llm.called 与 budget.spent 是同一笔账的两面）

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'token-report.mjs');

let workdir: string;

function writeEvents(
  sliceId: string,
  events: Array<Record<string, unknown>>,
  options: { bom?: boolean } = {},
): void {
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
  const body = lines.join('\n') + '\n';
  writeFileSync(join(dir, 'events.jsonl'), options.bom ? `\uFEFF${body}` : body, 'utf-8');
}

function writeBundle(sliceId: string, instructions: string): void {
  const dir = join(workdir, '.zelto');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sliceId}-bundle.json`),
    `\uFEFF${JSON.stringify({ sliceId, instructions, writes: [] })}`,
    'utf-8',
  );
}

interface Report {
  eventLines: number;
  malformed: number;
  agent: {
    sessions: number;
    tokens: number;
    costUsd: number;
    runsStarted: number;
    failedSessions: number;
    failedTokensEst: number;
    failedCostEst: number;
    costOnlySessions: number;
    costOnlyUsd: number;
  };
  planningLlm: { calls: number; tokens: number; costUsd: number };
  bundleOverhead: { tokens: number; slices: number };
  comparison: {
    zeltoTotalTokens: number;
    directTokens: number;
    deltaTokens: number;
    deltaPct: number | null;
  };
  perSlice: Array<{
    id: string;
    agentSessions: number;
    agentTokens: number;
    agentCost: number;
    costOnlySessions: number;
    llmTokens: number;
  }>;
}

function run(extraArgs: string[] = []): Report {
  const out = execFileSync(process.execPath, [SCRIPT, workdir, '--json', ...extraArgs], {
    encoding: 'utf-8',
  });
  return JSON.parse(out) as Report;
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'zelto-token-report-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('token-report 口径', () => {
  it('agent 会话与规划期 LLM 的 token 分得开', () => {
    writeEvents('s1', [
      {
        type: 'budget.spent',
        payload: { amount: 0.5, source: 'agent', inputTokens: 100000, outputTokens: 20000 },
      },
      {
        type: 'llm.called',
        payload: { model: 'deepseek', promptTokens: 5000, completionTokens: 1000, totalTokens: 6000 },
      },
      { type: 'budget.spent', payload: { amount: 0.002, reason: 'llm:deepseek' } },
    ]);

    const r = run();
    assert.equal(r.agent.sessions, 1);
    assert.equal(r.agent.tokens, 120000);
    assert.equal(r.agent.costUsd, 0.5);
    assert.equal(r.planningLlm.calls, 1);
    assert.equal(r.planningLlm.tokens, 6000);
    assert.equal(r.planningLlm.costUsd, 0.002);
  });

  it('失败会话不在账上，按成功会话均值估算并单列', () => {
    writeEvents('s1', [
      { type: 'run.started', payload: { sliceId: 's1' } },
      { type: 'run.aborted', payload: { sliceId: 's1', exitCode: 1 } },
      { type: 'run.started', payload: { sliceId: 's1' } },
      { type: 'run.finished', payload: { sliceId: 's1', exitCode: 0 } },
      {
        type: 'budget.spent',
        payload: { amount: 0.5, source: 'agent', inputTokens: 100000, outputTokens: 20000 },
      },
    ]);

    const r = run();
    assert.equal(r.agent.runsStarted, 2);
    assert.equal(r.agent.sessions, 1);
    assert.equal(r.agent.failedSessions, 1);
    assert.equal(r.agent.failedTokensEst, 120000);
    assert.equal(r.agent.failedCostEst, 0.5);
  });

  it('旧格式切片（无 budget.spent）算「花了钱但没测到」，不算零', () => {
    writeEvents('s2', [
      { type: 'run.started', payload: { sliceId: 's2' } },
      { type: 'run.finished', payload: { sliceId: 's2', exitCode: 0, costUsd: 0.25 } },
    ]);

    const r = run();
    assert.equal(r.agent.costOnlySessions, 1);
    assert.equal(r.agent.costOnlyUsd, 0.25);
    assert.equal(r.agent.tokens, 0);
    assert.equal(r.perSlice[0].costOnlySessions, 1);
  });

  it('带 BOM 的事件流与 bundle 都能解析', () => {
    writeEvents(
      's1',
      [
        {
          type: 'budget.spent',
          payload: { amount: 0.5, source: 'agent', inputTokens: 100000, outputTokens: 20000 },
        },
      ],
      { bom: true },
    );
    writeBundle('s1', 'x'.repeat(400));

    const r = run();
    assert.equal(r.malformed, 0);
    assert.equal(r.eventLines, 1);
    assert.equal(r.agent.tokens, 120000);
    // 400 个 ASCII 字符 ≈ 100 token，每次会话读一遍
    assert.equal(r.bundleOverhead.tokens, 100);
    assert.equal(r.bundleOverhead.slices, 1);
  });

  it('--no-estimate 时不估算账外支出', () => {
    writeEvents('s1', [
      { type: 'run.started', payload: { sliceId: 's1' } },
      { type: 'run.aborted', payload: { sliceId: 's1', exitCode: 1 } },
      { type: 'run.started', payload: { sliceId: 's1' } },
      { type: 'run.finished', payload: { sliceId: 's1', exitCode: 0 } },
      {
        type: 'budget.spent',
        payload: { amount: 0.5, source: 'agent', inputTokens: 100000, outputTokens: 20000 },
      },
    ]);

    const r = run(['--no-estimate']);
    assert.equal(r.agent.failedSessions, 1);
    assert.equal(r.agent.failedTokensEst, 0);
    assert.equal(r.agent.failedCostEst, 0);
  });

  it('没有事件目录时报错退出，不静默给出 0', () => {
    assert.throws(() => run(), /找不到事件目录/);
  });
});
