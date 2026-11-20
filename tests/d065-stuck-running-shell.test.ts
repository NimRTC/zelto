// D-65 · 卡在 running 但没人能救的切片
//
// 病灶（实测于 nimrtc-v14 v1-n5-turn-server，2026-11-20）：
//
//   时间线：
//     09:56  `zelto run` → agent 跑了 40 分钟 → 跑完超预算（$5.86 > $1）
//            → 收尾提前 return，切片停在 `running`
//     11:03  人手工跑 `zelto gate --retry` → 门禁过了（**没配验收**）
//            → GATE_PASS 推到 `completed` → 发签字请求
//     11:23  人修好验收配置，重跑 `zelto run`
//            → `startRun` 把切片推到 `running`（completed → running 合法）
//            → **重复 agent 守卫命中**（上一轮的会话文件还在盘上）
//            → 直接 `return 1`，**没退状态**
//     12:18  人手工跑 `zelto gate --retry` → 验收失败（0x113）
//
//   结果：切片卡在 `running`，而四条路全堵死：
//     - `zelto run` 拒绝跑（准入只认 frozen / completed）
//     - `zelto merge` 不收它（没签字）
//     - `zelto stall --reap` 看不见它（判据只认「一条记录都没有」，
//       而这里有记录 —— 只是全是 `status: completed`）
//     - `zelto resume` 说它没停机（stall.class 是 null）
//
//   唯一出路是 `zelto abandon` —— 整个切片作废，规格得重写。
//
// 也就是说「撞上一个假活记录」= 切片作废。这不是设计意图。
//
// 修法分两半：
//   1. `zelto run` 的守卫拒绝路径必须**退回 frozen**（别制造空壳）
//   2. `stall --reap` 的空壳判据要认「记录都收尾了但切片还在 running」
//      （万一还有别的路径制造了空壳，得能救回来）

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SliceStore } from '../src/core/slice/store.js';
import { EventStream } from '../src/core/events/stream.js';
import {
  findOrphanShells,
  reapDeadSlices,
  classifyOrphanShell,
} from '../src/core/stall/index.js';

const ROOT = join(tmpdir(), `zelto-d065-test-${Date.now()}`);
const SESSIONS = join(ROOT, '.zelto', 'sessions');

let store: SliceStore;
let events: EventStream;

function makeSlice(id: string, state: 'running' | 'frozen' | 'completed') {
  const slice = store.create(id, `Slice ${id}`, {
    writes: [`src/${id}/**`],
    trace: { requirements: [`R: ${id}`], contracts: [], tests: [] },
  });
  slice.state = state;
  slice.spec.frozenHash = `sha256:${id}`;
  slice.spec.frozenAt = new Date().toISOString();
  return slice;
}

/** 写一条会话记录 */
async function writeSession(id: string, data: Record<string, unknown>) {
  await writeFile(join(SESSIONS, `claude-agent-${id}.json`), JSON.stringify(data), 'utf-8');
}

before(async () => {
  await mkdir(join(ROOT, '.zelto', 'slices'), { recursive: true });
  await mkdir(join(ROOT, '.zelto', 'events'), { recursive: true });
  await mkdir(SESSIONS, { recursive: true });
  store = new SliceStore(join(ROOT, '.zelto', 'slices'));
  events = new EventStream(join(ROOT, '.zelto', 'events'));
});

after(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

// ─── 判据：卡在 running 但没人管的切片 ───────────────────────────────────

describe('D-65 · 空壳判据：没有 running 记录 = 没人管这一轮', () => {
  it('会话记录全是 completed（上一轮留下的）→ 算空壳', async () => {
    // 这就是实战里那片卡住的样子：上一轮跑完了、记录收尾了，
    // 但切片还停在 running。
    const slice = makeSlice('d065-finished-record', 'running');
    await store.write(slice);
    await writeSession('d065-finished-record', {
      sliceId: 'd065-finished-record',
      status: 'completed',
      exitCode: 0,
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });

    const shells = findOrphanShells([slice], ROOT, () => false);
    assert.equal(shells.length, 1, '记录都收尾了但切片还停在 running = 空壳');
    assert.equal(shells[0].liveness.state, 'dead');
    assert.ok(
      shells[0].liveness.reason.includes('没人再管这一轮'),
      `理由要说清「没人管」，实际是：${shells[0].liveness.reason}`,
    );
  });

  it('会话记录是 failed（上一轮跑挂了）→ 也算空壳', async () => {
    const slice = makeSlice('d065-failed-record', 'running');
    await store.write(slice);
    await writeSession('d065-failed-record', {
      sliceId: 'd065-failed-record',
      status: 'failed',
      exitCode: 1,
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });

    assert.equal(findOrphanShells([slice], ROOT, () => false).length, 1);
  });

  it('有一条 running 记录 → 不算空壳（agent 可能还活着）', async () => {
    // 这是最关键的一条：**绝不能**把活着的 agent 判成尸体。
    // 那会导致「reap 收走 → 人重跑 → 同一 worktree 上起第二个 agent」。
    const slice = makeSlice('d065-live', 'running');
    await store.write(slice);
    await writeSession('d065-live', {
      sliceId: 'd065-live',
      status: 'running',
      pid: 4242,
      lastActivityAt: new Date().toISOString(),
    });

    assert.equal(findOrphanShells([slice], ROOT, () => true).length, 0);
    assert.equal(classifyOrphanShell(ROOT, 'd065-live', () => true)?.state, 'active');
  });

  it('running 记录 + completed 记录混在一起 → 仍算活着的（看 running 那条）', async () => {
    const slice = makeSlice('d065-mixed', 'running');
    await store.write(slice);
    await writeSession('d065-mixed-old', {
      sliceId: 'd065-mixed', status: 'completed', exitCode: 0,
    });
    await writeSession('d065-mixed', {
      sliceId: 'd065-mixed', status: 'running', pid: 4242,
      lastActivityAt: new Date().toISOString(),
    });

    assert.equal(findOrphanShells([slice], ROOT, () => true).length, 0);
  });

  it('压根没有任何记录 → 算空壳（D-64 原有的那条）', async () => {
    const slice = makeSlice('d065-norecord', 'running');
    await store.write(slice);

    const shells = findOrphanShells([slice], ROOT, () => false);
    assert.equal(shells.length, 1);
    assert.ok(shells[0].liveness.reason.includes('从未开跑'));
  });
});

// ─── 清理：救得回来 ───────────────────────────────────────────────────────

describe('D-65 · 空壳能救回来', () => {
  it('opt-in 清理：记录都收尾了的切片退回 frozen', async () => {
    await store.write(makeSlice('d065-reap', 'running'));
    await writeSession('d065-reap', {
      sliceId: 'd065-reap', status: 'completed', exitCode: 0,
    });

    const results = await reapDeadSlices(store, events, ['d065-reap'], {
      includeOrphans: { projectRoot: ROOT, isProcessAlive: () => false },
    });

    assert.equal(results.length, 1, '这类切片必须救得回来');
    assert.equal(results[0].reverted, true);
    assert.equal(results[0].from, 'running');
    assert.equal(results[0].to, 'frozen');
    assert.equal((await store.read('d065-reap')).state, 'frozen');
  });

  it('救回来之后能重跑 —— 状态是 frozen，准入认它', async () => {
    await store.write(makeSlice('d065-rerun', 'running'));
    await writeSession('d065-rerun', { sliceId: 'd065-rerun', status: 'completed' });

    await reapDeadSlices(store, events, ['d065-rerun'], {
      includeOrphans: { projectRoot: ROOT, isProcessAlive: () => false },
    });

    const after = await store.read('d065-rerun');
    assert.equal(after.state, 'frozen');
    // frozen → running 是合法转换（准入只认 frozen / completed）
    const running = await store.transit('d065-rerun', 'RUN_START');
    assert.equal(running.state, 'running');
  });

  it('清理写 slice.state.changed 事件，标 orphanShell（C4）', async () => {
    await store.write(makeSlice('d065-trace', 'running'));
    await writeSession('d065-trace', { sliceId: 'd065-trace', status: 'completed' });

    await reapDeadSlices(store, events, ['d065-trace'], {
      includeOrphans: { projectRoot: ROOT, isProcessAlive: () => false },
    });

    const evt = (await events.read('d065-trace')).find(
      (e) =>
        e.type === 'slice.state.changed' &&
        (e.payload as Record<string, unknown>).orphanShell === true,
    );
    assert.ok(evt, '空壳清理必须留痕');
    const payload = evt?.payload as Record<string, unknown>;
    assert.equal(payload.from, 'running');
    assert.equal(payload.to, 'frozen');
  });

  it('不传 opt-in 时不动它 —— 清理是显式的', async () => {
    await store.write(makeSlice('d065-noopt', 'running'));
    await writeSession('d065-noopt', { sliceId: 'd065-noopt', status: 'completed' });

    const results = await reapDeadSlices(store, events, ['d065-noopt']);
    assert.equal(results.length, 0);
    assert.equal((await store.read('d065-noopt')).state, 'running');
  });

  it('绝不误伤活着的切片 —— 列表与清理用的是同一份判据', async () => {
    await store.write(makeSlice('d065-safe', 'running'));
    await writeSession('d065-safe', {
      sliceId: 'd065-safe', status: 'running', pid: 4242,
      lastActivityAt: new Date().toISOString(),
    });

    // 列表里看不见 → 清理时也不该动
    assert.equal(findOrphanShells([await store.read('d065-safe')], ROOT, () => true).length, 0);

    const results = await reapDeadSlices(store, events, ['d065-safe'], {
      includeOrphans: { projectRoot: ROOT, isProcessAlive: () => true },
    });
    assert.equal(results.length, 0);
    assert.equal((await store.read('d065-safe')).state, 'running');
  });
});
