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

describe('ADR-074 世代过滤 —— 上一代被收走的会话文件不算本轮现场', () => {
  it('readSliceLivenessRecord(after=...) 跳过上一代的尸体', async () => {
    const dir = join(tmpdir(), `zelto-gen-test-${Date.now()}`);
    const sessions = join(dir, '.zelto', 'sessions');
    await mkdir(sessions, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    try {
      // 上一代：06:01 起跑，pid 早已没了，status 仍是 running（进程死时没人写 failed）
      await writeFile(join(sessions, 'old.json'), JSON.stringify({
        sessionId: 'old', sliceId: 's1', status: 'running', pid: 48092,
        startedAt: '2026-11-17T06:01:50.000Z', lastActivityAt: '2026-11-17T06:01:50.000Z',
      }));
      // 本轮：07:00 起跑
      await writeFile(join(sessions, 'new.json'), JSON.stringify({
        sessionId: 'new', sliceId: 's1', status: 'running', pid: 12345,
        startedAt: '2026-11-17T07:00:00.000Z', lastActivityAt: '2026-11-17T07:00:05.000Z',
      }));

      const { readSliceLivenessRecord } = await import('../src/core/activity/liveness.js');
      // 不传世代：取 lastActivity 最新的那份 —— 本轮
      const anyGen = readSliceLivenessRecord(dir, 's1');
      assert.equal(anyGen?.pid, 12345);

      // 传本轮起跑时刻：上一代被过滤，即使它更「新」也不会被当成现场
      const fresh = readSliceLivenessRecord(dir, 's1', '2026-11-17T07:00:00.000Z');
      assert.equal(fresh?.pid, 12345);

      // 本轮记录还不存在（起跑 07:30 之后）：只有上一代的尸体 → 返回 null，
      // 而不是把尸体交出去让调用方判「死了」
      const beforeGen = readSliceLivenessRecord(dir, 's1', '2026-11-17T07:30:00.000Z');
      assert.equal(beforeGen, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── D-49：读记录时不能按 status 过滤 ─────────────────────────────────────────
//
// 病灶（实测于 nimrtc-zelto v2-input-binder，2026-11-17）：
//   agent 跑满 `agent.timeout` 被杀 → 适配器把会话 `status` 写成 `timeout`
//   → `readSliceLivenessRecords` 只收 `status === 'running'` 的记录
//   → 本轮记录被滤掉 → 看门狗看到「本轮没有任何记录」→ 判「从没开跑」
//   → reap，抢在正常路径前面掐死 ADR-055 的续跑。
//
// 修法：只做世代过滤；status 的解释权交给看门狗策略。
describe('D-49：readSliceLivenessRecords 不按 status 过滤', () => {
  it('本轮记录 status=timeout —— 仍要被读出来（否则看门狗误判「从没开跑」）', async () => {
    const dir = join(tmpdir(), `zelto-d49-test-${Date.now()}`);
    const sessions = join(dir, '.zelto', 'sessions');
    await mkdir(sessions, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    try {
      await writeFile(join(sessions, 'timed-out.json'), JSON.stringify({
        sessionId: 'timed-out', sliceId: 's1', status: 'timeout', pid: 12345,
        startedAt: '2026-11-17T11:04:49.802Z', lastActivityAt: '2026-11-17T11:34:45.951Z',
      }));

      const { readSliceLivenessRecords } = await import('../src/core/activity/liveness.js');
      const recs = readSliceLivenessRecords(dir, 's1', '2026-11-17T11:04:49.829Z');

      assert.equal(recs.length, 1, '本轮的 timeout 记录必须读得到');
      assert.equal(recs[0]?.status, 'timeout');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('上一代的 timeout 记录仍被世代过滤掉', async () => {
    const dir = join(tmpdir(), `zelto-d49-gen-${Date.now()}`);
    const sessions = join(dir, '.zelto', 'sessions');
    await mkdir(sessions, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    try {
      await writeFile(join(sessions, 'old.json'), JSON.stringify({
        sessionId: 'old', sliceId: 's1', status: 'timeout', pid: 48092,
        startedAt: '2026-11-17T06:01:50.000Z', lastActivityAt: '2026-11-17T06:31:50.000Z',
      }));

      const { readSliceLivenessRecords } = await import('../src/core/activity/liveness.js');
      const recs = readSliceLivenessRecords(dir, 's1', '2026-11-17T07:00:00.000Z');

      assert.equal(recs.length, 0, '上一代的记录不算本轮现场');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('别的切片的记录不混进来', async () => {
    const dir = join(tmpdir(), `zelto-d49-other-${Date.now()}`);
    const sessions = join(dir, '.zelto', 'sessions');
    await mkdir(sessions, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    try {
      await writeFile(join(sessions, 'other.json'), JSON.stringify({
        sessionId: 'other', sliceId: 's2', status: 'timeout', pid: 1,
        startedAt: '2026-11-17T11:04:49.802Z',
      }));

      const { readSliceLivenessRecords } = await import('../src/core/activity/liveness.js');
      const recs = readSliceLivenessRecords(dir, 's1', '2026-11-17T11:00:00.000Z');

      assert.equal(recs.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
