// ADR-047 · agent 失败不该把切片卡在 running
//
// 病灶（v0.5.0 源码核对）：
//
//   | 位置 | 现状 | 后果 |
//   |---|---|---|
//   | `run-support.ts` `handleAgentFailure()` | 写 `stall.class` 前不迁状态 | 切片停在 running + 停机分类 |
//   | `core-slice.ts` 后台监视器失败分支 | 同上 | 后台任务失败也卡 running |
//   | `engine.ts` `resume()` | 只清 `stall.class`，不迁状态 | resume 后仍 running，「可以重跑了」是假话 |
//   | `engine.ts` `admit()` | 写集冲突表收集所有 `state==='running'` 的切片 | 死切片持续阻塞别的切片 |
//   | `parallel-executor.ts` 最终失败 | 根本不写停机 | 并行批次里的失败片既不可见也不可重跑 |
//
// 修法不需要新增状态 —— 状态机本来就支持 `running --RUN_FINISH--> frozen`
// （`src/core/slice/state.ts`），与 ADR-037 的越界回退是同一条退路。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Scheduler } from '../src/core/sched/engine.js';
import { SliceStore } from '../src/core/slice/store.js';
import { EventStream } from '../src/core/events/stream.js';
import type { PolicyConfig } from '../src/core/policy/types.js';

const TEST_DIR = join(tmpdir(), `zelto-adr047-test-${Date.now()}`);
const SLICES_DIR = join(TEST_DIR, '.zelto', 'slices');
const EVENTS_DIR = join(TEST_DIR, '.zelto', 'events');

const samplePolicy: PolicyConfig = { rules: [], protected: [] };

/** 造一片正在跑（running）的切片。 */
function runningSlice(store: SliceStore, id: string, writes: string[]) {
  const slice = store.create(id, `Slice ${id}`, {
    writes,
    trace: { requirements: [`R: ${id} 的需求出处`], contracts: [], tests: [] },
  });
  slice.state = 'frozen';
  slice.spec.frozenHash = `sha256:${id}`;
  slice.spec.frozenAt = new Date().toISOString();
  return slice;
}

// ─── resume：状态必须一并迁走 ─────────────────────────────────────────────

describe('ADR-047 · resume 把 running 迁回 frozen', () => {
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

  it('resume 后切片回到可重跑的 frozen', async () => {
    const slice = runningSlice(store, 'resume-state', ['src/a/**']);
    slice.stall.class = 'environment_failure';
    await store.write(slice);
    await store.transit('resume-state', 'RUN_START');
    assert.equal((await store.read('resume-state')).state, 'running');

    await scheduler.resume('resume-state', {});

    const after = await store.read('resume-state');
    assert.equal(after.stall.class, null, '停机分类应当清掉');
    assert.equal(after.state, 'frozen', '状态必须一并迁到 frozen —— 留在 running 就再也跑不了');
  });

  it('resume 留下 slice.state.changed 事件（追溯链上看得见这次迁移）', async () => {
    const slice = runningSlice(store, 'resume-event', ['src/b/**']);
    slice.stall.class = 'cognitive_stuck';
    await store.write(slice);
    await store.transit('resume-event', 'RUN_START');

    await scheduler.resume('resume-event', {});

    const evts = await events.read('resume-event');
    const changed = evts.find((e) => e.type === 'slice.state.changed');
    assert.ok(changed, '应当留下 slice.state.changed 事件');
    assert.equal((changed?.payload as Record<string, unknown>).to, 'frozen');
  });

  it('resume 不把已经 frozen 的切片弄坏', async () => {
    const slice = runningSlice(store, 'resume-frozen', ['src/c/**']);
    slice.stall.class = 'permission_prompt';
    await store.write(slice);

    await scheduler.resume('resume-frozen', {});

    const after = await store.read('resume-frozen');
    assert.equal(after.state, 'frozen', '本来就在 frozen，不该被改动');
    assert.equal(after.stall.class, null);
  });

  it('--abandon 仍然直接作废（不受本次修复影响）', async () => {
    const slice = runningSlice(store, 'resume-abandon', ['src/d/**']);
    slice.stall.class = 'plan_gate';
    await store.write(slice);
    await store.transit('resume-abandon', 'RUN_START');

    await scheduler.resume('resume-abandon', { abandon: true });

    assert.equal((await store.read('resume-abandon')).state, 'abandoned');
  });
});

// ─── admit：死切片不该阻塞别的切片 ────────────────────────────────────────

describe('ADR-047 · admit 的写集冲突表排除死切片', () => {
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

  it('停机切片不再占着写集 —— 别的切片能被准入', async () => {
    // 死切片：running + 带停机分类（修复前留下的状态）。
    const dead = runningSlice(store, 'dead-slice', ['src/shared/**']);
    dead.stall.class = 'environment_failure';
    await store.write(dead);
    await store.transit('dead-slice', 'RUN_START');

    const candidate = runningSlice(store, 'live-candidate', ['src/shared/component.ts']);
    await store.write(candidate);

    const result = await scheduler.admit('live-candidate');
    assert.equal(result.decision, 'admitted', `死切片不该阻塞别人：${result.reason}`);
    assert.equal(result.blockedBy.length, 0);
  });

  it('真正在跑的切片仍然占着写集（这条不能被放松）', async () => {
    const live = runningSlice(store, 'live-slice', ['src/other/**']);
    await store.write(live);
    await store.transit('live-slice', 'RUN_START');

    const candidate = runningSlice(store, 'blocked-candidate', ['src/other/x.ts']);
    await store.write(candidate);

    const result = await scheduler.admit('blocked-candidate');
    assert.equal(result.decision, 'blocked');
    assert.ok(result.blockedBy.includes('live-slice'));
  });

  it('提问回路的切片仍然占着写集（agent 还活着，答完原地续跑）', async () => {
    // agent_question 不是「跑挂了」：agent 停下来等人数码，答完在原地续跑
    // （ADR-013）。它的会话仍会写文件 —— 排除掉它 = 两个 agent 同时改同一批文件。
    const asking = runningSlice(store, 'asking-slice', ['src/asking/**']);
    asking.stall.class = 'agent_question';
    await store.write(asking);
    await store.transit('asking-slice', 'RUN_START');

    const candidate = runningSlice(store, 'asking-candidate', ['src/asking/x.ts']);
    await store.write(candidate);

    const result = await scheduler.admit('asking-candidate');
    assert.equal(result.decision, 'blocked', '提问回路的切片仍在占着写集');
    assert.ok(result.blockedBy.includes('asking-slice'));
  });

  it('卡在 running 的停机切片 —— 准入给出「先 resume」的出路，而不是干巴巴的状态名', async () => {
    const stuck = runningSlice(store, 'stuck-slice', ['src/stuck/**']);
    stuck.stall.class = 'cognitive_stuck';
    await store.write(stuck);
    await store.transit('stuck-slice', 'RUN_START');

    const result = await scheduler.admit('stuck-slice');
    assert.equal(result.decision, 'blocked');
    assert.ok(
      result.reason?.includes('resume'),
      `理由里应当指出出路（resume），实际是：${result.reason}`,
    );
    assert.ok(result.reason?.includes('cognitive_stuck'), '理由里应当带上停机分类');
  });
});
