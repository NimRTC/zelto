// ADR-053 · 死切片的批量清理
//
// 病灶（ADR-047 修复后剩下的一半）：
//
//   ADR-047 让死切片不再阻塞别人，但它们仍然占着 `zelto status` 的
//   「running」计数，人得逐片 `zelto resume` 才能清掉。
//
//   `zelto halt --rollback` 扫不到它们 —— 那扫的是「持有预约的进程已死」
//   （批次崩了），而死切片**没有预约**（agent 挂了，预约已释放）。
//
// 决策：显式命令 `zelto stall --reap`，批量把死切片退回 `frozen`。
//   - 提问回路（agent_question）不算死切片 —— 那个 agent 还活着，只是等人数码
//   - 停机分类**保留** —— 停机这件事本身仍然成立，人还没看过现场

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SliceStore } from '../src/core/slice/store.js';
import { EventStream } from '../src/core/events/stream.js';
import { findDeadSlices, reapDeadSlices } from '../src/core/stall/index.js';

const TEST_DIR = join(tmpdir(), `zelto-adr053-test-${Date.now()}`);
const SLICES_DIR = join(TEST_DIR, '.zelto', 'slices');
const EVENTS_DIR = join(TEST_DIR, '.zelto', 'events');

/** 造一片处于指定状态、带指定停机分类的切片 */
function makeSlice(
  store: SliceStore,
  id: string,
  state: 'running' | 'frozen' | 'completed',
  stallClass: string | null,
) {
  const slice = store.create(id, `Slice ${id}`, {
    writes: [`src/${id}/**`],
    trace: { requirements: [`R: ${id} 的需求出处`], contracts: [], tests: [] },
  });
  slice.state = state;
  slice.spec.frozenHash = `sha256:${id}`;
  slice.spec.frozenAt = new Date().toISOString();
  slice.stall.class = stallClass as never;
  return slice;
}

describe('ADR-053 · 死切片的批量清理', () => {
  let store: SliceStore;
  let events: EventStream;

  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });
    store = new SliceStore(SLICES_DIR);
    events = new EventStream(EVENTS_DIR);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  // ─── 判据：谁是死切片 ────────────────────────────────────────────────────

  it('running + 带停机分类 = 死切片', () => {
    const slice = makeSlice(store, 'dead-1', 'running', 'environment_failure');
    const dead = findDeadSlices([slice]);
    assert.equal(dead.length, 1);
    assert.equal(dead[0].sliceId, 'dead-1');
    assert.equal(dead[0].stallClass, 'environment_failure');
  });

  it('提问回路不算死切片 —— 那个 agent 还活着，只是等人数码', () => {
    // ADR-013 §3.5：agent 停下来等答复，答完在原地续跑。
    // 把它判成尸体 = 把一个还在等答复的会话判死。
    const slice = makeSlice(store, 'question-1', 'running', 'agent_question');
    const dead = findDeadSlices([slice]);
    assert.equal(dead.length, 0, '提问回路必须被排除');
  });

  it('没有停机分类的 running 切片不算死切片（它可能真在跑）', () => {
    const slice = makeSlice(store, 'alive-1', 'running', null);
    assert.equal(findDeadSlices([slice]).length, 0);
  });

  it('停机但已经退回 frozen 的切片不算死切片', () => {
    // ADR-047 修好之后，正常停机的切片就已经在 frozen 了 ——
    // 只有「卡在 running」的才是残留。
    const slice = makeSlice(store, 'stalled-frozen', 'frozen', 'environment_failure');
    assert.equal(findDeadSlices([slice]).length, 0);
  });

  it('completed 的切片永远不算死切片', () => {
    const slice = makeSlice(store, 'done-1', 'completed', 'environment_failure');
    assert.equal(findDeadSlices([slice]).length, 0);
  });

  // ─── 清理动作 ────────────────────────────────────────────────────────────

  it('清理把死切片从 running 退回 frozen', async () => {
    await store.write(makeSlice(store, 'reap-1', 'running', 'environment_failure'));

    const results = await reapDeadSlices(store, events, ['reap-1']);

    assert.equal(results.length, 1);
    assert.equal(results[0].reverted, true);
    assert.equal(results[0].from, 'running');
    assert.equal(results[0].to, 'frozen');
    assert.equal((await store.read('reap-1')).state, 'frozen');
  });

  it('清理**保留**停机分类 —— 停机这件事仍然成立', async () => {
    // 与 ADR-047 的 resume() 不同：resume 是「人确认处理完了」，
    // 清理只是「把状态掰回可跑的样子」。清掉分类 = 宣称已经处理好了。
    await store.write(makeSlice(store, 'reap-keep', 'running', 'environment_failure'));

    await reapDeadSlices(store, events, ['reap-keep']);

    const after = await store.read('reap-keep');
    assert.equal(after.state, 'frozen');
    assert.equal(after.stall.class, 'environment_failure', '分类必须保留');
  });

  it('清理写 slice.state.changed 事件，带 reaped 标记（C4）', async () => {
    await store.write(makeSlice(store, 'reap-trace', 'running', 'permission_prompt'));

    await reapDeadSlices(store, events, ['reap-trace']);

    const evts = await events.read('reap-trace');
    const changed = evts.find(
      (e) => e.type === 'slice.state.changed' && (e.payload as Record<string, unknown>).reaped === true,
    );
    assert.ok(changed, '批量清理必须留痕');
    const payload = changed?.payload as Record<string, unknown>;
    assert.equal(payload.from, 'running');
    assert.equal(payload.to, 'frozen');
    assert.equal(payload.previousStallClass, 'permission_prompt');
  });

  it('批量清理：一次处理多片，互不影响', async () => {
    await store.write(makeSlice(store, 'reap-a', 'running', 'environment_failure'));
    await store.write(makeSlice(store, 'reap-b', 'running', 'context_exhaustion'));

    const results = await reapDeadSlices(store, events, ['reap-a', 'reap-b']);

    assert.equal(results.length, 2);
    assert.equal((await store.read('reap-a')).state, 'frozen');
    assert.equal((await store.read('reap-b')).state, 'frozen');
  });

  it('不会误伤正在跑的切片和提问回路', async () => {
    await store.write(makeSlice(store, 'safe-running', 'running', null));
    await store.write(makeSlice(store, 'safe-question', 'running', 'agent_question'));

    const results = await reapDeadSlices(store, events, ['safe-running', 'safe-question']);

    assert.equal(results.length, 0, '这两个都不该被动');
    assert.equal((await store.read('safe-running')).state, 'running');
    assert.equal((await store.read('safe-question')).state, 'running');
  });

  it('找不到的切片跳过，不阻断整批', async () => {
    await store.write(makeSlice(store, 'reap-ok', 'running', 'environment_failure'));

    const results = await reapDeadSlices(store, events, ['reap-ok', 'does-not-exist']);

    assert.equal(results.length, 1, '不存在的切片被跳过，其余照常');
    assert.equal((await store.read('reap-ok')).state, 'frozen');
  });

  it('已完成的切片在批量里也不会被改回 frozen（终态不可逆）', async () => {
    await store.write(makeSlice(store, 'reap-done', 'completed', null));

    const results = await reapDeadSlices(store, events, ['reap-done']);

    assert.equal(results.length, 0);
    assert.equal((await store.read('reap-done')).state, 'completed');
  });
});
