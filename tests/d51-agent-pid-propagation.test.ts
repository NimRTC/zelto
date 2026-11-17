// D-51：任务文件的活性记录必须带上 `agentPid`
//
// 病灶（实测于 nimrtc-zelto v2-input-binder，2026-11-17）：
//
//   会话文件里有两个 pid：
//     - `pid`      —— 包装进程（Windows 上是 `cmd.exe`）
//     - `agentPid` —— 真正的 agent 进程（`node.exe` / `claude.exe`）
//
//   包装进程在 agent 起来之后就退了（它不常驻，只是转发信号）。
//   所以「包装进程没了」**不等于**「agent 死了」。
//
//   `taskLiveRecord` 在把会话记录合并进任务记录时**只搬了 `pid`，没搬 `agentPid`** ——
//   于是活性判定退化成「看那个已经退了的 cmd.exe」：
//   一个**活着的 agent** 被判成 dead，然后被 `stall --reap` 收走
//   （切片退回 frozen），而那个 agent 还在改文件。
//
//   后果：人重跑 `zelto run` → 同一个 worktree 上起第二个 agent
//   → 两个 agent 互相覆盖产出 → worktree 被打坏。
//
// 这一组用例守的是：合并时必须把 `agentPid` 一起搬过来，
// 且活性判据用的是 `agentPid ?? pid`。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyLiveness } from '../src/core/activity/liveness.js';
import { mergeSessionLiveness, type TaskInfo } from '../src/cli/commands/task-store.js';

const T0 = Date.parse('2026-11-17T06:00:00.000Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function task(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    taskId: 'task-s1-1',
    sliceId: 's1',
    sessionId: 'sess-1',
    agentName: 'agent',
    startedAt: iso(0),
    status: 'running',
    ...overrides,
  };
}

describe('D-51 合并时 agentPid 必须一起搬过来', () => {
  it('会话记录里的 agentPid 被搬进合并结果', () => {
    const merged = mergeSessionLiveness(task(), {
      status: 'running',
      startedAt: iso(0),
      lastActivityAt: iso(1000),
      pid: 1111,
      agentPid: 2222,
    });
    assert.equal(merged.agentPid, 2222);
  });

  it('会话记录里没有 agentPid 时不凭空造一个', () => {
    const merged = mergeSessionLiveness(task(), {
      status: 'running',
      startedAt: iso(0),
      lastActivityAt: iso(1000),
      pid: 1111,
    });
    assert.equal(merged.agentPid, undefined);
  });

  it('会话记录缺失时只用任务文件本身', () => {
    const merged = mergeSessionLiveness(task({ pid: 3333 }), null);
    assert.equal(merged.pid, 3333);
    assert.equal(merged.agentPid, undefined);
  });
});

describe('D-51 活性判据：agentPid ?? pid', () => {
  it('包装进程死了但 agent 活着 → 不是 dead', () => {
    const merged = mergeSessionLiveness(task(), {
      status: 'running',
      startedAt: iso(0),
      lastActivityAt: iso(1000),
      pid: 1111,
      agentPid: 2222,
    });
    const result = classifyLiveness(merged, {
      now: T0 + 2000,
      isProcessAlive: (pid: number) => pid === 2222,
      isProcessTreeAlive: () => false,
    });
    assert.equal(result.state, 'active');
  });

  it('包装进程与 agent 都没了 → dead', () => {
    const merged = mergeSessionLiveness(task(), {
      status: 'running',
      startedAt: iso(0),
      lastActivityAt: iso(1000),
      pid: 1111,
      agentPid: 2222,
    });
    const result = classifyLiveness(merged, {
      now: T0 + 2000,
      isProcessAlive: () => false,
      isProcessTreeAlive: () => false,
    });
    assert.equal(result.state, 'dead');
  });

  it('漏掉 agentPid 时会误判 —— 这正是 D-51 的病灶', () => {
    // 复现旧行为：只有 pid（包装进程已退），agentPid 丢失
    const result = classifyLiveness(
      {
        status: 'running',
        startedAt: iso(0),
        lastActivityAt: iso(1000),
        pid: 1111,
      },
      {
        now: T0 + 2000,
        isProcessAlive: () => false,
        isProcessTreeAlive: () => false,
      },
    );
    assert.equal(result.state, 'dead', '没带 agentPid 就会误判成死');
  });
});
