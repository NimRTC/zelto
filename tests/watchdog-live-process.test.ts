// 活进程看门狗（ADR-074）—— 判据与世代挑选
//
// 这一组用例守的是三件事：
//   1. 「上一代的尸体」不得被当成本轮现场（否则刚起跑就秒收）
//   2. 「pid 没了」是最硬的证据，当场收走；「没心跳」只是可疑，不动
//   3. 收走次数用尽 → 上报而不是继续自动恢复
//
// 纯函数用例 —— 判据在 core/sched/watchdog-policy.ts（C3），不碰进程表、
// 不碰网络；进程死活由注入的 isProcessAlive 给出（与生产同一条注入路径）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SPAWN_GRACE_MS,
  decideRunWatchdog,
  selectGenerationRecords,
} from '../src/core/sched/watchdog-policy.js';
import type { LivenessRecord } from '../src/core/activity/liveness.js';

const T0 = Date.parse('2026-11-17T06:00:00.000Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function record(overrides: Partial<LivenessRecord>): LivenessRecord {
  return {
    status: 'running',
    startedAt: iso(0),
    lastActivityAt: iso(0),
    pid: 4242,
    ...overrides,
  };
}

describe('ADR-074 世代挑选：上一代的尸体不算本轮现场', () => {
  it('只保留本轮起跑之后的记录', () => {
    const old = record({ startedAt: iso(-3_600_000) });
    const fresh = record({ startedAt: iso(5_000) });
    const picked = selectGenerationRecords([old, fresh], iso(0));
    assert.equal(picked.generationKnown, true);
    assert.deepEqual(picked.records, [fresh]);
  });

  it('没有 run.started 时刻时不过滤，但标记 generationKnown=false', () => {
    const picked = selectGenerationRecords([record({})], null);
    assert.equal(picked.generationKnown, false);
    assert.equal(picked.records.length, 1);
  });
});

describe('ADR-074 判定：本轮进程已死 → 当场收走', () => {
  it('pid 不在 → reap，并说清是哪个 pid', () => {
    const action = decideRunWatchdog({
      sliceId: 's1',
      sliceState: 'running',
      stallClass: null,
      runStartedAt: iso(0),
      records: [record({ startedAt: iso(1_000), lastActivityAt: iso(2_000), pid: 999 })],
      recoveries: 0,
      now: T0 + 10_000,
      isProcessAlive: () => false,
    });
    assert.equal(action.action, 'reap');
    if (action.action === 'reap') {
      assert.match(action.reason, /进程 999 已经不在了/);
    }
  });

  it('agentPid 优先于包装 pid（ADR-055 同判据）', () => {
    const alive = new Set([1111]);
    const action = decideRunWatchdog({
      sliceId: 's1',
      sliceState: 'running',
      stallClass: null,
      runStartedAt: iso(0),
      records: [record({ startedAt: iso(1_000), pid: 2222, agentPid: 1111 })],
      recoveries: 0,
      now: T0 + 10_000,
      isProcessAlive: (pid) => alive.has(pid),
    });
    assert.equal(action.action, 'none', '包装进程死了但 agent 活着 —— 不能判死');
  });

  it('进程在、但早已无心跳 → 只是可疑，不动（长构建不能被杀）', () => {
    const action = decideRunWatchdog({
      sliceId: 's1',
      sliceState: 'running',
      stallClass: null,
      runStartedAt: iso(0),
      records: [record({ startedAt: iso(1_000), lastActivityAt: iso(2_000) })],
      recoveries: 0,
      now: T0 + 10 * 60_000,
      isProcessAlive: () => true,
    });
    assert.equal(action.action, 'none');
  });
});

describe('ADR-074 判定：上一代尸体不能被当成本轮现场', () => {
  it('本轮记录还没落盘（宽限内）→ none', () => {
    const action = decideRunWatchdog({
      sliceId: 's1',
      sliceState: 'running',
      stallClass: null,
      runStartedAt: iso(0),
      records: [record({ startedAt: iso(-3_600_000), pid: 999 })],
      recoveries: 0,
      now: T0 + 10_000,
      isProcessAlive: () => false, // 尸体确实死了 —— 但不是本轮的
    });
    // 上一代记录被世代过滤掉 → 本轮无记录、宽限内 → none
    assert.equal(action.action, 'none');
    if (action.action === 'none') assert.match(action.reason, /宽限/);
  });

  it('宽限都过了还没有本轮记录 → reap（这一轮从没真正开跑）', () => {
    const action = decideRunWatchdog({
      sliceId: 's1',
      sliceState: 'running',
      stallClass: null,
      runStartedAt: iso(0),
      records: [],
      recoveries: 0,
      now: T0 + SPAWN_GRACE_MS + 1_000,
      isProcessAlive: () => false,
    });
    assert.equal(action.action, 'reap');
  });
});

// ── D-47 / D-48：看门狗不得收走活着的 agent ────────────────────────────
//
// 病灶（实测于 nimrtc-zelto v2-input-binder，2026-11-17）：
//
//   本轮起跑 30 分钟后，看门狗判「仍无任何运行记录」→ reap，
//   把切片退成 frozen 并写下 `environment_failure`。
//   **可 agent 一直活着** —— 它还在改文件、还在发 `policy.decision`。
//
//   根因是**世代过滤与状态字段互相打架**：
//     - 会话文件的 `status` 在超时时被写成 `timeout`（不是 `running`）；
//     - `readSliceLivenessRecords` 只收 `status === 'running'` 的记录 → 被滤掉；
//     - 剩下上一代的记录 `startedAt` 早于本轮起跑 → 也被滤掉；
//     - 结果 records 为空 → 判「从没真正开跑」→ 误 reap 一个活着的 agent。
//
// 「没有记录」从来不是「没有进程」的证据。所以 reap 之前必须问一次进程表。
describe('D-48：没有记录 ≠ 没有进程 —— 活着的 agent 不得被收走', () => {
  it('本轮无记录但 agent 进程还活着 → none（不收）', () => {
    const action = decideRunWatchdog({
      sliceId: 's1',
      sliceState: 'running',
      stallClass: null,
      runStartedAt: iso(0),
      records: [],
      recoveries: 0,
      now: T0 + SPAWN_GRACE_MS + 1_000,
      isProcessAlive: () => false,
      isAgentAlive: () => true,
    });
    assert.equal(action.action, 'none', 'agent 还活着 —— 收走它就是杀掉正在干活的 agent');
    if (action.action === 'none') assert.match(action.reason, /进程还活着/);
  });

  it('本轮无记录且 agent 进程确实不在 → 仍然 reap', () => {
    const action = decideRunWatchdog({
      sliceId: 's1',
      sliceState: 'running',
      stallClass: null,
      runStartedAt: iso(0),
      records: [],
      recoveries: 0,
      now: T0 + SPAWN_GRACE_MS + 1_000,
      isProcessAlive: () => false,
      isAgentAlive: () => false,
    });
    assert.equal(action.action, 'reap');
  });

  it('没给 isAgentAlive 时行为不变（向后兼容）', () => {
    const action = decideRunWatchdog({
      sliceId: 's1',
      sliceState: 'running',
      stallClass: null,
      runStartedAt: iso(0),
      records: [],
      recoveries: 0,
      now: T0 + SPAWN_GRACE_MS + 1_000,
      isProcessAlive: () => false,
    });
    assert.equal(action.action, 'reap');
  });
});

describe('ADR-074 判定：已经在处理 / 不该处理的都不动', () => {
  const base = {
    sliceId: 's1',
    runStartedAt: iso(0),
    records: [record({ startedAt: iso(1_000), pid: 999 })],
    now: T0 + 10_000,
    isProcessAlive: () => false,
    recoveries: 0,
  };
  it('切片不在 running → none', () => {
    assert.equal(decideRunWatchdog({ ...base, sliceState: 'frozen', stallClass: null }).action, 'none');
  });

  it('提问回路（agent_question）→ none：agent 在等人回答', () => {
    assert.equal(decideRunWatchdog({ ...base, sliceState: 'running', stallClass: 'agent_question', recoveries: 0 }).action, 'none');
  });

  it('已有停机分类 → none：等 resume / run', () => {
    assert.equal(decideRunWatchdog({ ...base, sliceState: 'running', stallClass: 'test_failure', recoveries: 0 }).action, 'none');
  });

  it('本轮记录已收尾（status=failed）→ none：停机由正常路径处理', () => {
    const action = decideRunWatchdog({
      sliceId: 's1',
      runStartedAt: iso(0),
      now: T0 + 10_000,
      isProcessAlive: () => false,
      sliceState: 'running',
      stallClass: null,
      recoveries: 0,
      records: [record({ startedAt: iso(1_000), status: 'failed', pid: 999 })],
    });
    assert.equal(action.action, 'none');
  });

  it('自动恢复次数用尽 → escalate，不再假装自动恢复', () => {
    const action = decideRunWatchdog({ ...base, sliceState: 'running', stallClass: null, recoveries: 3 });
    assert.equal(action.action, 'escalate');
  });
});

// ── D-49：看门狗把「本轮刚结束」误当成「本轮从没开跑」 ──────────────────────
//
// 病灶（实测于 nimrtc-zelto v2-input-binder，2026-11-17）：
//   agent 跑了 30 分钟撞上 `agent.timeout: 1800` → 适配器把会话文件的
//   `status` 写成 `timeout` → `readSliceLivenessRecords` 只收
//   `status === 'running'` 的记录 → 这份被滤掉；上一代的记录又因为
//   世代过滤被滤掉 → records 为空 → 看门狗判「这一轮从没真正开跑」
//   → reap：切片退 frozen、写 `environment_failure`。
//
//   代价有两层：
//     1. **抢在正常路径前面**把 ADR-055 的续跑掐死了 —— 正常路径本该
//        接手超时、续同一个 agent 会话（工作区里已经有 98 行改动和
//        11.8KB 的真断言验收测试），现在全被扔掉重来。
//     2. **理由是假的**。它不是「从没开跑」，它是「跑完了但记录被滤掉」。
//        一句假的理由写进事件流，人在事故现场会被带偏。
//
// 修法：读记录时**不按 status 过滤**，只按世代过滤；status 的解释权
// 交给看门狗策略 —— 那里本来就有一档「本轮记录已收尾 → none」。
describe('D-49：本轮记录已收尾 ≠ 本轮从未开跑', () => {
  it('status=timeout 的本轮记录 → none（停机交给正常路径，别抢）', () => {
    const action = decideRunWatchdog({
      sliceId: 's1',
      sliceState: 'running',
      stallClass: null,
      runStartedAt: iso(0),
      records: [record({ startedAt: iso(1_000), status: 'timeout', pid: 999 })],
      recoveries: 0,
      now: T0 + 30 * 60_000,
      isProcessAlive: () => false,
      isAgentAlive: () => false,
    });
    assert.equal(
      action.action,
      'none',
      '本轮跑完了（timeout）—— 收走它就等于掐死 ADR-055 的续跑路径',
    );
    if (action.action === 'none') assert.match(action.reason, /已收尾/);
  });

  it('status=completed 的本轮记录 → none', () => {
    const action = decideRunWatchdog({
      sliceId: 's1',
      sliceState: 'running',
      stallClass: null,
      runStartedAt: iso(0),
      records: [record({ startedAt: iso(1_000), status: 'completed', pid: 999 })],
      recoveries: 0,
      now: T0 + 30 * 60_000,
      isProcessAlive: () => false,
    });
    assert.equal(action.action, 'none');
  });

  it('status=running 但 pid 已死 → 仍然 reap（硬证据优先）', () => {
    const action = decideRunWatchdog({
      sliceId: 's1',
      sliceState: 'running',
      stallClass: null,
      runStartedAt: iso(0),
      records: [record({ startedAt: iso(1_000), status: 'running', pid: 999 })],
      recoveries: 0,
      now: T0 + 30 * 60_000,
      isProcessAlive: () => false,
    });
    assert.equal(action.action, 'reap');
  });
});
