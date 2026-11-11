// ADR-052 · 自动重试预算的重置必须是显式动作
//
// 病灶（ADR-047 修复后才暴露出来）：
//
//   `stall.autoResolved` 是切片级计数，只在自动重试时 +1。
//   `resume()` 不清它，`startRun()` 也不清它。
//
//   于是：一片因 environment_failure 自动重试耗尽而停机 → 人修好环境 →
//   `resume` + `run` 重跑 → 计数器还停在 maxRetries → **第一次失败就直接停机**。
//
//   这在 ADR-047 之前根本触发不了 —— 那时切片卡在 running，压根跑不了第二次。
//
// 决策：重置是**显式动作**（`zelto resume <id> --reset-retry`）。
// 悄悄清 = 「重跑一次预算就无限」，那才是真问题。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Scheduler } from '../src/core/sched/engine.js';
import { SliceStore } from '../src/core/slice/store.js';
import { EventStream } from '../src/core/events/stream.js';
import type { PolicyConfig } from '../src/core/policy/types.js';

const TEST_DIR = join(tmpdir(), `zelto-adr048-test-${Date.now()}`);
const SLICES_DIR = join(TEST_DIR, '.zelto', 'slices');
const EVENTS_DIR = join(TEST_DIR, '.zelto', 'events');

const samplePolicy: PolicyConfig = { rules: [], protected: [] };

/**
 * 造一片停机的切片，带上已经用掉的自动重试预算。
 *
 * 模拟的现场：环境故障 → 自动重试耗尽 → 停机 → 人修好环境 → 准备重跑。
 */
function stalledSliceWithBudget(store: SliceStore, id: string, autoResolved: number) {
  const slice = store.create(id, `Slice ${id}`, {
    writes: [`src/${id}/**`],
    trace: { requirements: [`R: ${id} 的需求出处`], contracts: [], tests: [] },
  });
  slice.state = 'frozen';
  slice.spec.frozenHash = `sha256:${id}`;
  slice.spec.frozenAt = new Date().toISOString();
  slice.stall.class = 'environment_failure';
  slice.stall.autoResolved = autoResolved;
  return slice;
}

describe('ADR-052 · 自动重试预算的显式重置', () => {
  let store: SliceStore;
  let events: EventStream;
  let scheduler: Scheduler;

  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });
    store = new SliceStore(SLICES_DIR);
    events = new EventStream(EVENTS_DIR);
    scheduler = new Scheduler(store, events, samplePolicy);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('resume --reset-retry 把自动重试预算清零', async () => {
    await store.write(stalledSliceWithBudget(store, 'budget-reset', 2));

    const result = await scheduler.resume('budget-reset', { resetRetry: true });

    const after = await store.read('budget-reset');
    assert.equal(after.stall.autoResolved, 0, '预算应当被清零');
    assert.equal(after.stall.class, null, '停机分类照清');
    assert.equal(result.retryBudgetReset, true);
  });

  it('默认 resume 不清预算 —— 语义不变（回归锁）', async () => {
    // 悄悄清 = 「重跑一次预算就无限」。默认语义必须是不清。
    await store.write(stalledSliceWithBudget(store, 'budget-keep', 2));

    const result = await scheduler.resume('budget-keep', {});

    const after = await store.read('budget-keep');
    assert.equal(
      after.stall.autoResolved,
      2,
      '默认 resume 不得清预算 —— 只有显式 --reset-retry 才清',
    );
    assert.equal(result.retryBudgetReset, false);
  });

  it('预算本来就是 0 时不报错，也不写多余的重置事件', async () => {
    await store.write(stalledSliceWithBudget(store, 'budget-zero', 0));

    const result = await scheduler.resume('budget-zero', { resetRetry: true });

    assert.equal(result.retryBudgetReset, false, '没有可重置的就不该报「已重置」');
    const evts = await events.read('budget-zero');
    const resets = evts.filter(
      (e) => (e.payload as Record<string, unknown>).resolution === 'retry_budget_reset',
    );
    assert.equal(resets.length, 0, '预算为 0 时不该写重置事件');
  });

  it('重置留下 run.resumed 事件（人做过的决定要留痕，C4）', async () => {
    await store.write(stalledSliceWithBudget(store, 'budget-trace', 2));

    await scheduler.resume('budget-trace', { resetRetry: true });

    const evts = await events.read('budget-trace');
    const reset = evts.find(
      (e) => (e.payload as Record<string, unknown>).resolution === 'retry_budget_reset',
    );
    assert.ok(reset, '重置预算必须留痕');
    assert.equal((reset?.payload as Record<string, unknown>).previousAutoResolved, 2);
  });

  it('--abandon 不受重置影响（直接作废，预算清零无意义）', async () => {
    await store.write(stalledSliceWithBudget(store, 'budget-abandon', 2));

    const result = await scheduler.resume('budget-abandon', {
      abandon: true,
      resetRetry: true,
    });

    const after = await store.read('budget-abandon');
    assert.equal(after.state, 'abandoned');
    assert.equal(result.retryBudgetReset, false, '作废时不重置预算');
  });

  it('resume 之后仍能重置预算（警告里给的那条命令必须走得通）', async () => {
    // 现场：人看到「重跑后第一次失败就停机」的警告时，切片**已经 resume 过了**，
    // 停机分类已经清掉。这时候再跑 `resume --reset-retry` 若撞上
    // 「not stalled」，那给出的建议就是一条走不通的命令。
    await store.write(stalledSliceWithBudget(store, 'budget-late', 2));

    await scheduler.resume('budget-late', {});
    const afterResume = await store.read('budget-late');
    assert.equal(afterResume.stall.class, null, '先 resume 完，分类已经清掉');

    const result = await scheduler.resume('budget-late', { resetRetry: true });
    assert.equal(result.retryBudgetReset, true, '没有停机也应当能重置预算');
    assert.equal((await store.read('budget-late')).stall.autoResolved, 0);
  });

  it('纯重置预算不动切片状态（不该有副作用）', async () => {
    // 这片没有停机分类（人已经 resume 过了），只是在跑 —— 预算重置
    // 不该把正在跑的切片退成 frozen。
    const slice = stalledSliceWithBudget(store, 'budget-state', 2);
    slice.stall.class = null;
    slice.state = 'running';
    await store.write(slice);

    await scheduler.resume('budget-state', { resetRetry: true });

    const after = await store.read('budget-state');
    assert.equal(after.state, 'running', '只是重置预算，不该把正在跑的切片退成 frozen');
  });

  it('没有停机又没有预算可重置时报「not stalled」（不假装做了什么）', async () => {
    await store.write(stalledSliceWithBudget(store, 'budget-none', 0));
    await scheduler.resume('budget-none', {});

    await assert.rejects(
      () => scheduler.resume('budget-none', {}),
      /not stalled/,
      '既没停机又没要求重置预算，就该照实说「没停机」',
    );
  });
});
