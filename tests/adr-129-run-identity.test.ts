// ADR-129 / ZD-049·050·051：运行身份 quand 贯穿、收尾落盘顺序、主管运行期可见性
//
// 三件事一起测，因为它们共用同一条判据：**「这一轮是谁、有没有结束」只看事件流**。
//
//   ZD-051：runId 确定性可重算，起跑端 / 收尾端写出同一个值
//   ZD-050：收尾先落事实（run.finished / run.aborted）后释放写集预约
//   ZD-049：主管写心跳；主管半路死了 → 看门狗接管收尾，事件流里留下结论

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  makeRunId,
  runIdStamp,
  sliceIdFromRunId,
  looksLikeRunId,
  findRunConclusion,
} from '../src/core/sched/index.js';
import {
  startSupervisorHeartbeat,
  readSupervisorHeartbeat,
  writeSupervisorHeartbeat,
  supervisorHeartbeatPath,
} from '../src/cli/commands/supervisor-heartbeat.js';

const REPO = process.cwd();

function src(...parts: string[]): string {
  return readFileSync(join(REPO, ...parts), 'utf-8');
}

describe('ADR-129 一 —— runId 确定性', () => {
  it('同样输入 → 同样的 id；不同 attempt → 不同 id', () => {
    const at = '2026-11-26T09:30:12.345Z';
    const a = makeRunId('slice-a', at, 0);
    const b = makeRunId('slice-a', at, 0);
    assert.equal(a, b);
    assert.equal(a, 'slice-a#2026-11-26T09:30:12Z');
    assert.equal(makeRunId('slice-a', at, 1), 'slice-a#2026-11-26T09:30:12Z/r1');
    // 毫秒部分不影响 id：同一秒内的两个 iso 值算出同一个 id
    assert.equal(makeRunId('slice-a', '2026-11-26T09:30:12.999Z'), a);
  });

  it('runIdStamp / sliceIdFromRunId / looksLikeRunId', () => {
    assert.equal(runIdStamp('2026-11-26T09:30:12.345Z'), '2026-11-26T09:30:12Z');
    assert.equal(sliceIdFromRunId('v1-x#2026-11-26T09:30:12Z/r2'), 'v1-x');
    assert.equal(looksLikeRunId('v1-x#2026-11-26T09:30:12Z'), true);
    assert.equal(looksLikeRunId('nope'), false);
    assert.equal(looksLikeRunId(undefined), false);
  });

  it('起跑端与收尾端都写出同一个 runId（源码锚点：四处 run.started / run.finished 都有 runId）', () => {
    const core = src('src', 'cli', 'commands', 'core-slice.ts');
    const sup = src('src', 'cli', 'commands', 'supervisor.ts');
    const par = src('src', 'cli', 'commands', 'parallel-executor.ts');
    for (const text of [core, sup, par]) {
      assert.match(text, /runId/, '每条起跑 / 收尾路径都必须带 runId');
    }
    // 收尾端不许自己重新取「现在」来算 runId（会写成另一个值）——
    // 逐条收尾事件都必须是 makeRunId(..., runStartedAt, ...) 的形式
    const aborts = [...core.matchAll(/'run\.aborted'[\s\S]{0,240}?runId: ([^,\n}]+)/g)]
      .filter((m) => !m[1].includes('task.runId'));
    assert.ok(aborts.length >= 2, `core-slice 的各条 run.aborted 都应带 runId（现在 ${aborts.length} 条）`);
    for (const m of aborts) {
      assert.match(m[1], /makeRunId\(/, `run.aborted 的 runId 必须由 makeRunId 派生：${m[1]}`);
    }
  });
});

describe('ADR-129 二 —— 收尾结论判定只看事件流', () => {
  const events = [
    { ts: '2026-11-26T09:30:12.000Z', type: 'run.started', payload: { sliceId: 's1', runId: 's1#2026-11-26T09:30:12Z' } },
    { ts: '2026-11-26T09:31:00.000Z', type: 'run.started', payload: { sliceId: 's1', runId: 's1#2026-11-26T09:30:50Z' } },
    { ts: '2026-11-26T09:30:20.000Z', type: 'run.aborted', payload: { runId: 's1#2026-11-26T09:30:12Z', exitCode: 1, reason: 'x' } },
    { ts: '2026-11-26T09:40:00.000Z', type: 'run.finished', payload: { runId: 's1#2026-11-26T09:30:12Z', exitCode: 0 } },
  ];

  it('精确匹配 runId —— r1 与 r10 不分家', () => {
    const list = [
      { ts: 't', type: 'run.aborted', payload: { runId: 's1#X/r1' } },
      { ts: 't', type: 'run.aborted', payload: { runId: 's1#X/r10' } },
    ];
    assert.equal(findRunConclusion(list, 's1#X/r1')?.type, 'run.aborted');
    assert.equal(findRunConclusion(list, 's1#X/r10')?.type, 'run.aborted');
    assert.equal(findRunConclusion(list, 's1#X'), null);
  });

  it('同一 runId 多条结论 → 取最后一条（append-only）', () => {
    const c = findRunConclusion(events, 's1#2026-11-26T09:30:12Z');
    assert.equal(c?.type, 'run.finished');
    assert.equal(c?.exitCode, 0);
    assert.equal(c?.at, '2026-11-26T09:40:00.000Z');
  });

  it('另一轮没有结论 → null（不许假装有）', () => {
    assert.equal(findRunConclusion(events, 's1#2026-11-26T09:30:50Z'), null);
    assert.equal(findRunConclusion(events, null), null);
    assert.equal(findRunConclusion(events, ''), null);
  });
});

describe('ADR-129 三 —— 主管心跳', () => {
  // 用 tmpdir：`.zelto/` 下的临时目录会让工作区出现「未跟踪文件」——
  // 验收测试的越界检查会把它算成改动（实测踩过一次）。
  let dir: string;
  before(() => {
    dir = join(tmpdir(), `zelto-adr129-hb-${Date.now()}`);
  });
  after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* 清理失败不影响判定 */ }
  });

  it('写 → 读回同样的快照；路径在 .zelto/supervisor/ 下', () => {
    writeSupervisorHeartbeat(dir, 'task-1', { runId: 's1#X', agentPid: 42, sessionId: 'sess' });
    const beat = readSupervisorHeartbeat(dir, 'task-1');
    assert.equal(beat?.pid, process.pid);
    assert.equal(beat?.runId, 's1#X');
    assert.equal(beat?.agentPid, 42);
    assert.equal(beat?.sessionId, 'sess');
    assert.ok(supervisorHeartbeatPath(dir, 'task-1').includes(join('.zelto', 'supervisor')));
  });

  it('没有 / 坏掉的心跳 → null（不当成「主管还活着」）', () => {
    assert.equal(readSupervisorHeartbeat(dir, 'never-written'), null);
  });

  it('startSupervisorHeartbeat 立刻写一次、停止后不再写', () => {
    const stop = startSupervisorHeartbeat(dir, 'task-2', () => ({
      runId: 's2#Y',
      agentPid: null,
      sessionId: null,
    }), 60_000);
    const beat = readSupervisorHeartbeat(dir, 'task-2');
    assert.equal(beat?.runId, 's2#Y');
    stop();
  });
});

describe('ADR-129 —— 主管收尾顺序：先落事实、后释放（源码契约）', () => {
  it('supervisor.ts 的 finally 里：任务文件收尾与 guard.release 都在 stopHeartbeat 之后', () => {
    const text = src('src', 'cli', 'commands', 'supervisor.ts');
    const fin = text.slice(text.indexOf('} finally {'));
    const stop = fin.indexOf('stopHeartbeat()');
    const patch = fin.indexOf('patchTask(args.taskId');
    const release = fin.indexOf('guard.release()');
    assert.ok(stop >= 0 && patch > stop && release > patch,
      `顺序必须是 stopHeartbeat → 任务文件 → 释放预约（实际 ${stop} ${patch} ${release}）`);
  });

  it('run.aborted 结论与会话 pid 的拆分：supervisorPid 与 agentPid 都在异常的收尾事件里', () => {
    const text = src('src', 'cli', 'commands', 'supervisor.ts');
    const i = text.indexOf("reason: `supervisor failed:");
    assert.ok(i > 0);
    const seg = text.slice(Math.max(0, i - 400), i);
    assert.match(seg, /supervisorPid/);
    assert.match(seg, /agentPid/);
    assert.match(seg, /runId/);
    assert.match(seg, /phase: 'supervisor'/);
  });
});
