// ADR-130 · 运行身份从 CLI 一路走到 agent 环境
//
// hook 侧的三个形态已由 `adr-130-hook-run-id.test.ts` 钉住；本文件钉住
// 「**接线**」这一半 —— 只有真的把 runId 交到适配器手里，hook 才能看到它：
//
//   1. 适配器续跑（`resume` / `continueSession`）从会话文件读回同一个 runId，
//      并再次注入 `ZELTO_RUN_ID` —— 续跑仍属同一轮，追溯链不在这一段断掉；
//   2. `zelto answer` 的续跑身份判定：任务文件那轮「起跑过、停在提问上、
//      没有结论」才沿用；有结论 / 没有证据 → 不沿用（不冒充别轮）。

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClaudeAgentAdapter } from '../src/adapters/claude-agent/index.js';
import { makeRunId } from '../src/core/sched/run-id.js';
// 内部函数不在 public 接口上 —— 用动态 import 取模块命名空间的导出。
import * as questionMod from '../src/cli/commands/question.js';

const ROOT = join(tmpdir(), `zelto-adr130-wire-${process.pid}-${Date.now()}`);
const ORIG_CWD = process.cwd();

function printEnvCommand(): string {
  return `${JSON.stringify(process.execPath)} -e "console.log('RUN=' + (process.env.ZELTO_RUN_ID || 'MISSING'))"`;
}

before(() => {
  mkdirSync(ROOT, { recursive: true });
  // 适配器的会话文件落点是相对**进程 cwd** 的 `.zelto/sessions/` ——
  // 切进临时目录，免得把测试会话写进真仓库。
  process.chdir(ROOT);
});

after(() => {
  try { process.chdir(ORIG_CWD); } catch { /* ignore */ }
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

beforeEach(() => {
  delete process.env.ZELTO_RUN_ID;
});

describe('ADR-130 —— 适配器续跑沿用本轮的 runId', () => {
  it('resume() 从会话文件读回 runId 并再次注入 agent 环境', async () => {
    const adapter = new ClaudeAgentAdapter({
      agentCommand: printEnvCommand(),
      cwd: ROOT,
      timeoutMs: 30_000,
      env: {},
    });
    const runId = makeRunId('adr130-resume', '2026-11-26T10:00:00.000Z', 0);

    const first = await adapter.start({ sliceId: 'adr130-resume', prompt: 'bundle', runId });
    await adapter.waitForExit(first.sessionId);

    // 会话文件里记下了本轮身份（续跑的唯一来源）。
    // 落点相对**进程 cwd**（模块级常量），不是适配器的 `cwd` 选项 ——
    // 所以用例开始前把 cwd 切到 ROOT，文件才不会落进真的仓库。
    const sessionFile = join(ROOT, '.zelto', 'sessions', `${first.sessionId}.json`);
    const saved = JSON.parse(readFileSync(sessionFile, 'utf-8')) as { runId?: string; agentSessionId?: string };
    assert.equal(saved.runId, runId);

    // 续跑：不显式传 runId，适配器自己从会话读回
    const resumed = await adapter.resume(first.sessionId, 'answer');
    await adapter.waitForExit(resumed.sessionId);
    const out = adapter.getOutput(resumed.sessionId);
    assert.ok(out.includes(`RUN=${runId}`), `续跑仍应注入 ZELTO_RUN_ID=${runId}，实际输出：${out}`);
  });

  it('continueSession() 显式给了新 runId 就用新的', async () => {
    const adapter = new ClaudeAgentAdapter({
      agentCommand: printEnvCommand(),
      cwd: ROOT,
      timeoutMs: 30_000,
      env: {},
    });
    const runId1 = makeRunId('adr130-continue', '2026-11-26T10:00:00.000Z', 0);
    const runId2 = makeRunId('adr130-continue', '2026-11-26T10:30:00.000Z', 0);

    const first = await adapter.start({ sliceId: 'adr130-continue', prompt: 'bundle', runId: runId1 });
    await adapter.waitForExit(first.sessionId);

    const cont = await adapter.continueSession(first.sessionId, '接着做', { runId: runId2 });
    await adapter.waitForExit(cont.sessionId);
    const out = adapter.getOutput(cont.sessionId);
    assert.ok(out.includes(`RUN=${runId2}`), `显式 runId 应优先，实际输出：${out}`);
  });
});

describe('ADR-130 —— zelto answer 续跑身份的判定', () => {
  // 判定函数单独导出（只为可测；`zelto answer` 是它唯一的调用方）。
  const resolve = (questionMod as unknown as {
    resumeRunIdForAnswer?: (sliceId: string, stream: ReadonlyArray<unknown>) => string | null;
  }).resumeRunIdForAnswer;

  function seedTask(sliceId: string, runId: string, writtenAt: string): void {
    mkdirSync(join(ROOT, '.zelto', 'tasks'), { recursive: true });
    writeFileSync(
      join(ROOT, '.zelto', 'tasks', `task-${sliceId}-1.json`),
      JSON.stringify({
        taskId: `task-${sliceId}-1`,
        sliceId,
        sessionId: 'sess',
        agentName: 'claude',
        startedAt: new Date(Date.parse(writtenAt) - 1000).toISOString(),
        status: 'running',
        runId,
        writtenAt,
      }),
      'utf-8',
    );
  }

  before(() => {
    mkdirSync(join(ROOT, '.zelto'), { recursive: true });
  });

  beforeEach(() => {
    rmSync(join(ROOT, '.zelto', 'tasks'), { recursive: true, force: true });
  });

  const started = (runId: string) => ({ type: 'run.started', payload: { runId } });
  const asked = { type: 'stall.classified', payload: { class: 'agent_question' } };
  const finished = (runId: string) => ({ type: 'run.finished', payload: { runId, exitCode: 0 } });

  it('起跑过、停在提问上、没有结论 → 沿用任务文件的 runId', () => {
    assert.ok(resolve, 'resumeRunIdForAnswer 应存在（ADR-130 接线的一部分）');
    const runId = makeRunId('slice-a', '2026-11-26T10:00:00.000Z', 0);
    seedTask('slice-a', runId, '2026-11-26T10:05:00.000Z');
    assert.equal(resolve!('slice-a', [started(runId), asked]), runId);
  });

  it('那一轮已有结论（已结束）→ 不沿用', () => {
    const runId = makeRunId('slice-b', '2026-11-26T10:00:00.000Z', 0);
    seedTask('slice-b', runId, '2026-11-26T10:05:00.000Z');
    assert.equal(resolve!('slice-b', [started(runId), asked, finished(runId)]), null);
  });

  it('事件流里找不到它的 run.started → 不沿用（不拿可能属于别轮的 id 冒充）', () => {
    const runId = makeRunId('slice-c', '2026-11-26T10:00:00.000Z', 0);
    seedTask('slice-c', runId, '2026-11-26T10:05:00.000Z');
    assert.equal(resolve!('slice-c', [asked]), null);
  });

  it('没有任务文件 → 不沿用', () => {
    assert.equal(resolve!('slice-d', []), null);
  });

  it('任务文件属于别的切片 → 不沿用', () => {
    const runId = makeRunId('slice-e-1', '2026-11-26T10:00:00.000Z', 0);
    seedTask('slice-e-1', runId, '2026-11-26T10:05:00.000Z');
    assert.equal(resolve!('slice-e', [started(runId), asked]), null);
  });
});
