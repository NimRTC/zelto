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
