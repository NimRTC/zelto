// D-30 · 被动活性 + 看门狗预算（单测）
//
// 判据只有一份（core/activity），CLI 与 Web 都是调它 ——
// 这里把判据锁死：active / stale / dead / finished 的边界，
// 以及「同一切片最多自愈 3 次，超了就上报」的预算。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  classifyLiveness,
  formatIdle,
  lastActivityOf,
  lastOutputLine,
  DEFAULT_STALE_THRESHOLD_MS,
} from '../src/core/activity/liveness.js';
import {
  decideRecovery,
  readRecoveries,
  recordRecovery,
  recordEscalation,
  MAX_AUTO_RECOVERIES,
} from '../src/core/activity/watchdog.js';

const NOW = Date.now();

describe('D-30 · classifyLiveness', () => {
  it('非 running 直接 finished —— 不假装它还活着', () => {
    const live = classifyLiveness({ status: 'completed' });
    assert.equal(live.state, 'finished');
  });

  it('刚起跑没有心跳 —— active 但说清还不知道', () => {
    const live = classifyLiveness(
      { status: 'running', startedAt: new Date(NOW).toISOString(), pid: 4242 },
      { now: NOW, isProcessAlive: () => true },
    );
    assert.equal(live.state, 'active');
  });

  it('近期有动静 —— active', () => {
    const live = classifyLiveness(
      { status: 'running', lastActivityAt: new Date(NOW - 10_000).toISOString() },
      { now: NOW },
    );
    assert.equal(live.state, 'active');
    assert.ok((live.idleMs ?? 0) >= 9_000);
  });

  it('超过阈值没动静 —— stale（可疑，不是宣判死刑）', () => {
    const live = classifyLiveness(
      {
        status: 'running',
        lastActivityAt: new Date(NOW - DEFAULT_STALE_THRESHOLD_MS - 1_000).toISOString(),
        pid: 999999,
      },
      { now: NOW, isProcessAlive: () => true },
    );
    assert.equal(live.state, 'stale');
  });

  it('pid 没了 —— dead（最硬的证据，先于一切超时）', () => {
    const live = classifyLiveness(
      { status: 'running', lastActivityAt: new Date(NOW - 1_000).toISOString(), pid: 123456 },
      { now: NOW, isProcessAlive: () => false },
    );
    assert.equal(live.state, 'dead');
  });

  it('没有 pid 的老文件、没有任何心跳 —— 不能当成「刚起跑」，判 stale', () => {
    // 实测于 nimrtc 演练：修复前写的会话文件既无 pid 也无心跳，
    // 跑挂后永远停在 running。按「刚起跑」处理会让它永远 active。
    const live = classifyLiveness({ status: 'running', sliceId: 'legacy' }, { now: NOW });
    assert.equal(live.state, 'stale');
    assert.match(live.reason, /没有 pid/);
  });

  it('有 pid 但还没有心跳 —— 出生即活着，判 active', () => {
    const live = classifyLiveness({ status: 'running', pid: 4321 }, { now: NOW });
    assert.equal(live.state, 'active');
  });

  it('无 pid 且启动时间已远超阈值 —— stale（老文件的时间戳就是唯一证据）', () => {
    const live = classifyLiveness(
      { status: 'running', startedAt: new Date(NOW - DEFAULT_STALE_THRESHOLD_MS * 10).toISOString() },
      { now: NOW },
    );
    assert.equal(live.state, 'stale');
    assert.ok((live.idleMs ?? 0) > DEFAULT_STALE_THRESHOLD_MS);
  });

  it('心跳优先于输出时间 —— 长构建不出字也不误判', () => {
    const t = lastActivityOf({
      lastActivityAt: new Date(NOW - 5_000).toISOString(),
      lastOutputAt: new Date(NOW - 500_000).toISOString(),
      startedAt: new Date(NOW - 900_000).toISOString(),
    });
    assert.equal(t, NOW - 5_000);
  });

  it('formatIdle 说人话', () => {
    assert.equal(formatIdle(45_000), '45 秒');
    assert.equal(formatIdle(125_000), '2 分 5 秒');
  });

  it('lastOutputLine 取最后一条有内容的行 —— 分块末尾的空行不能吞掉进度', () => {
    // 输出是按 chunk 追加的，最后一块常常只是半行或换行；
    // 取到换行等于界面上什么都不显示 —— 人就以为页面死了。
    assert.equal(lastOutputLine({ output: ['第一行\n', '第二行\n'] }), '第二行');
    assert.equal(lastOutputLine({ output: ['第一行\n', '第二行\n', '\n'] }), '第二行');
    // 半行也是有效输出（agent 正在打）
    assert.equal(lastOutputLine({ output: ['跑测试', '…'] }), '跑测试…');
    assert.equal(lastOutputLine({ output: [] }), null);
    assert.equal(lastOutputLine(null), null);
    // 单行过长要截断 —— 界面只有一行位置
    const long = 'x'.repeat(500);
    const line = lastOutputLine({ output: [long] });
    assert.ok(line && line.length <= 301, '超长行必须截断');
  });
});

describe('D-30 · 看门狗预算（3 次上限）', () => {
  it('没救过 —— recover', () => {
    assert.deepEqual(decideRecovery(null), { action: 'recover', recoveries: 0 });
    assert.deepEqual(decideRecovery({ sliceId: 'x', count: 2, lastRecoveredAt: null, lastReason: null, escalated: false }), {
      action: 'recover',
      recoveries: 2,
    });
  });

  it(`救过 ${MAX_AUTO_RECOVERIES} 次 —— escalate，不再默默恢复`, () => {
    assert.deepEqual(
      decideRecovery({ sliceId: 'x', count: MAX_AUTO_RECOVERIES, lastRecoveredAt: null, lastReason: null, escalated: false }),
      { action: 'escalate', recoveries: MAX_AUTO_RECOVERIES },
    );
  });

  it('计数落盘 —— recordRecovery +1，recordEscalation 只打标不刷屏', async () => {
    const dir = join(tmpdir(), `zelto-watchdog-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      const first = readRecoveries(dir, 's1');
      assert.equal(first.count, 0);
      const afterOne = recordRecovery(dir, 's1', '进程 123 已经不在了');
      assert.equal(afterOne.count, 1);
      assert.equal(readRecoveries(dir, 's1').count, 1);
      const esc = recordEscalation(dir, 's1');
      assert.equal(esc.escalated, true);
      assert.equal(readRecoveries(dir, 's1').count, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
