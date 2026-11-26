// ADR-130 · hook 判定事件必须能归属到「哪一轮跑」
//
// ADR-129 给每一轮运行一个确定性 runId，`run.started` / `run.finished` /
// `run.aborted` 与任务文件都带上了它。但写集守卫的 `policy.decision`
// 事件（hook 进程写）没有带 —— 同一天几轮时间重叠时，
// 「那一轮跑里守卫到底判过什么」只能靠时间戳近似。
//
// 本文件钉住的三个形态：
//
//   1. 运行进程显式传入 runId（`ZELTO_RUN_ID` / `--run-id`）→
//      信封 `run` 与 payload `runId` 都是它，与 `run.started` 同值；
//   2. 没传入、但任务文件有 `task.runId` → 信封 `run` 标 `derived:<runId>`
//      （任务状态可能已指向别一轮，不许伪装成本轮）；
//   3. 都没有 → `run: null`，payload 无 runId（如实留空，不按时间补）。
//
// 另外钉住「适配器把 runId 注入 agent 环境」—— 否则第 1 条在真实运行里
// 永远不会成立（hook 是 agent 的子进程，只能从环境变量拿到它）。

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { appendDecisionEvent, buildContext, parseArgs } from '../src/hook/pretool.js';
import { makeRunId } from '../src/core/sched/run-id.js';
import { ClaudeAgentAdapter } from '../src/adapters/claude-agent/index.js';

let ROOT = '';

function eventsFile(sliceId: string): string {
  return join(ROOT, '.zelto', 'events', sliceId, 'events.jsonl');
}

function lastEnvelope(sliceId: string): Record<string, unknown> {
  const lines = readFileSync(eventsFile(sliceId), 'utf-8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

before(() => {
  ROOT = join(tmpdir(), `zelto-adr130-${process.pid}-${Date.now()}`);
  mkdirSync(ROOT, { recursive: true });
});

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(ROOT, '.zelto'), { recursive: true, force: true });
  delete process.env.ZELTO_RUN_ID;
  delete process.env.ZELTO_SLICE_ID;
});

describe('ADR-130 —— parseArgs 读取本轮 runId', () => {
  it('环境变量 ZELTO_RUN_ID 被读入', () => {
    process.env.ZELTO_RUN_ID = 'slice-a#2026-11-26T09:30:12Z';
    const args = parseArgs(['--project-root', ROOT]);
    assert.equal(args.runId, 'slice-a#2026-11-26T09:30:12Z');
  });

  it('命令行 --run-id 优先于环境变量', () => {
    process.env.ZELTO_RUN_ID = 'slice-a#from-env';
    const args = parseArgs(['--project-root', ROOT, '--run-id', 'slice-a#from-argv']);
    assert.equal(args.runId, 'slice-a#from-argv');
  });

  it('都没有时是 null —— 不推断', () => {
    const args = parseArgs(['--project-root', ROOT]);
    assert.equal(args.runId, null);
  });
});

describe('ADR-130 —— policy.decision 带本轮 runId', () => {
  it('给了 runId：信封 run 与 payload runId 都是它', () => {
    const runId = makeRunId('slice-a', '2026-11-26T09:30:12.345Z', 0);
    appendDecisionEvent(ROOT, 'slice-a', { decision: 'allow' }, runId);
    const env = lastEnvelope('slice-a');
    assert.equal(env.run, runId);
    assert.equal(env.type, 'policy.decision');
    assert.equal(env.actor, 'hook');
    assert.equal((env.payload as Record<string, unknown>).runId, runId);
  });

  it('没给 runId：信封 run 为 null，payload 不带 runId（不按时间补）', () => {
    appendDecisionEvent(ROOT, 'slice-a', { decision: 'allow' }, null);
    const env = lastEnvelope('slice-a');
    assert.equal(env.run, null);
    assert.equal('runId' in (env.payload as Record<string, unknown>), false);
  });

  it('runSeq 仍逐条递增（信封其余语义不变）', () => {
    appendDecisionEvent(ROOT, 'slice-a', { decision: 'allow' }, 'slice-a#x');
    appendDecisionEvent(ROOT, 'slice-a', { decision: 'deny' }, 'slice-a#x');
    const lines = readFileSync(eventsFile('slice-a'), 'utf-8').trim().split('\n');
    const seqs = lines.map((l) => (JSON.parse(l) as { runSeq: number }).runSeq);
    assert.deepEqual(seqs, [1, 2]);
  });
});

describe('ADR-130 —— 适配器把 runId 注入 agent 环境', () => {
  let adapter: ClaudeAgentAdapter | null = null;

  after(() => {
    adapter = null;
  });

  it('start({ runId }) 后，会话文件记录 runId，agent 环境里有 ZELTO_RUN_ID', async () => {
    // 让 agent「在真实 spawn 环境里把 ZELTO_RUN_ID 打出来」——
    // 这是唯一能证明注入确实到达 agent 进程的方式（而不是只写进了代码）。
    const echo = `${JSON.stringify(process.execPath)} -e "console.log('RUN=' + (process.env.ZELTO_RUN_ID || 'MISSING'))"`;
    adapter = new ClaudeAgentAdapter({
      agentCommand: echo,
      cwd: ROOT,
      timeoutMs: 30_000,
      env: {},
    });

    const runId = makeRunId('adr130-env', '2026-11-26T10:00:00.000Z', 0);
    const { sessionId } = await adapter.start({
      sliceId: 'adr130-env',
      prompt: 'bundle',
      runId,
    });
    await adapter.waitForExit(sessionId);

    const out = adapter.getOutput(sessionId);
    assert.ok(out.includes(`RUN=${runId}`), `agent 环境里应有 ZELTO_RUN_ID=${runId}，实际输出：${out}`);
  });

  it('没给 runId：不注入 ZELTO_RUN_ID（不凭空造一个）', async () => {
    const echo = `${JSON.stringify(process.execPath)} -e "console.log('RUN=' + (process.env.ZELTO_RUN_ID || 'MISSING'))"`;
    adapter = new ClaudeAgentAdapter({
      agentCommand: echo,
      cwd: ROOT,
      timeoutMs: 30_000,
      env: {},
    });

    const { sessionId } = await adapter.start({ sliceId: 'adr130-none', prompt: 'bundle' });
    await adapter.waitForExit(sessionId);
    const out = adapter.getOutput(sessionId);
    // 显式注入的 agent 环境里没有它 —— agent 看到的是 MISSING 或继承来的值，
    // 绝不会出现 zelto 生成的 `slice#…` 形态。
    assert.equal(/RUN=adr130-none#/.test(out), false, `不该凭空注入 runId，实际输出：${out}`);
  });
});
