// 拉闸回退的判定测试
//
// 拉闸把人喊停之后，被打断的切片必须还能继续跑 ——
// 这是「人被交还控制权」这句话的技术含义：
// 人处理完现场，切片还要能接着走，而不是只能 abandon 重来。
//
// C1: 状态只在文件里（切片文件 + 事件流）
// C3: 判定确定 —— 只看状态机、预约的持有进程生死，没有模型参与
// C4: 每个动作写 append-only 事件

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStream } from '../../../src/core/events/stream.js';
import { SliceStore } from '../../../src/core/slice/store.js';
import {
  findStuckRunningSlices,
  rollbackHaltedSlice,
  rollbackHaltedSlices,
} from '../../../src/core/halt/index.js';
import type { WriteReservation } from '../../../src/core/sched/reservation.js';

function reservation(sliceId: string, pid: number, releasedAt: string | null = null): WriteReservation {
  return {
    sliceId,
    writes: ['src/**'],
    worktree: null,
    projectRoot: 'C:/proj',
    acquiredAt: new Date().toISOString(),
    releasedAt,
    pid,
  };
}

describe('拉闸回退 —— 被喊停的切片还能继续跑', () => {
  let dir: string;
  let store: SliceStore;
  let events: EventStream;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-halt-rollback-'));
    store = new SliceStore(join(dir, 'slices'));
    events = new EventStream(join(dir, 'events'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('running → frozen，且标记 human_halt', async () => {
    const slice = store.create('s1', '第一个切片');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'abc';
    await store.write(slice);
    await store.transit('s1', 'RUN_START');
    assert.equal((await store.read('s1')).state, 'running');

    const result = await rollbackHaltedSlice(store, events, 's1', { reason: '跑偏了' });

    assert.equal(result.reverted, true);
    assert.equal(result.from, 'running');
    assert.equal(result.to, 'frozen');

    const after = await store.read('s1');
    assert.equal(after.state, 'frozen', '回退后切片应当可以再跑（准入只认 frozen）');
    assert.equal(after.stall.class, 'human_halt', '应当标记为人工拉闸停机');
  });

  it('回退写一条 stall.classified 事件，带上 human_halt', async () => {
    const slice = store.create('s1', '切片');
    slice.state = 'frozen';
    await store.write(slice);
    await store.transit('s1', 'RUN_START');

    await rollbackHaltedSlice(store, events, 's1', { reason: '人工拉闸', scope: 'all' });

    const evts = await events.read('s1');
    const stall = evts.find((e) => e.type === 'stall.classified');
    assert.ok(stall, '应当留下停机事件');
    assert.equal(stall?.payload.class, 'human_halt');
    assert.equal(stall?.payload.reason, '人工拉闸');
    assert.equal(stall?.payload.halted, true);
  });

  it('幂等：已经是 frozen 的切片不会被再次迁移，但仍标记 human_halt', async () => {
    const slice = store.create('s1', '切片');
    slice.state = 'frozen';
    await store.write(slice);

    const result = await rollbackHaltedSlice(store, events, 's1', { reason: '人工拉闸' });

    assert.equal(result.reverted, false);
    assert.equal(result.from, 'frozen');
    assert.equal((await store.read('s1')).stall.class, 'human_halt');
  });

  it('completed 的切片不被标记停机 —— 它没在等人处理', async () => {
    const slice = store.create('s1', '切片');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'abc';
    await store.write(slice);
    await store.transit('s1', 'RUN_START');
    await store.transit('s1', 'RUN_FINISH');
    await store.transit('s1', 'GATE_PASS');
    assert.equal((await store.read('s1')).state, 'completed');

    await rollbackHaltedSlice(store, events, 's1', { reason: '人工拉闸' });

    const after = await store.read('s1');
    assert.equal(after.state, 'completed');
    assert.equal(after.stall.class, null);
  });

  it('切片不存在时返回 reverted=false，不抛异常', async () => {
    const result = await rollbackHaltedSlice(store, events, 'nope', { reason: 'x' });
    assert.equal(result.reverted, false);
    assert.equal(result.from, 'unknown');
  });

  it('批量回退：逐片处理，单片失败不影响其它片', async () => {
    for (const id of ['a', 'b']) {
      const slice = store.create(id, id);
      slice.state = 'frozen';
      await store.write(slice);
      await store.transit(id, 'RUN_START');
    }

    const results = await rollbackHaltedSlices(store, events, ['a', 'missing', 'b'], {
      reason: '人工拉闸',
    });

    // 不存在的切片也返回一条结果（reverted=false），但不影响其它片
    assert.equal(results.length, 3);
    assert.equal(results.find((r) => r.sliceId === 'missing')?.reverted, false);
    assert.equal((await store.read('a')).state, 'frozen');
    assert.equal((await store.read('b')).state, 'frozen');
  });
});

describe('卡死切片判定 —— 批次死了切片还卡在 running', () => {
  let dir: string;
  let store: SliceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-halt-stuck-'));
    store = new SliceStore(join(dir, 'slices'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeRunning(id: string): Promise<void> {
    const slice = store.create(id, id);
    slice.state = 'frozen';
    await store.write(slice);
    await store.transit(id, 'RUN_START');
  }

  it('批次还活着时不算卡住 —— 不能跟正在跑的批次抢切片', async () => {
    await makeRunning('s1');

    const stuck = await findStuckRunningSlices(store, [reservation('s1', process.pid)]);

    assert.equal(stuck.length, 0, '活进程持有的切片不该被判定为卡死');
  });

  it('持有预约的进程死了 → 卡住', async () => {
    await makeRunning('s1');

    // pid 999999 几乎肯定不存在 —— 判定只看进程生死
    const stuck = await findStuckRunningSlices(store, [reservation('s1', 999999)]);

    assert.deepEqual(stuck, ['s1']);
  });

  it('没有预约的 running 切片 → 卡住（批次崩在取预约之前）', async () => {
    await makeRunning('s1');

    const stuck = await findStuckRunningSlices(store, []);

    assert.deepEqual(stuck, ['s1']);
  });

  it('已释放的预约不算持有', async () => {
    await makeRunning('s1');

    const stuck = await findStuckRunningSlices(store, [
      reservation('s1', process.pid, new Date().toISOString()),
    ]);

    assert.deepEqual(stuck, ['s1'], '释放了的预约不再约束人，切片才算卡住');
  });

  it('非 running 状态的切片不算卡住', async () => {
    const slice = store.create('s1', 's1');
    slice.state = 'frozen';
    await store.write(slice);

    const stuck = await findStuckRunningSlices(store, []);

    assert.deepEqual(stuck, []);
  });

  it('混合场景：只挑出真正卡住的那几个', async () => {
    await makeRunning('alive');
    await makeRunning('dead');

    const stuck = await findStuckRunningSlices(store, [
      reservation('alive', process.pid),
      reservation('dead', 999999),
    ]);

    assert.deepEqual(stuck, ['dead']);
  });
});
