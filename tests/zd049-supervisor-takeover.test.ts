// ADR-129 / ZD-049：主管半路死了 → 看门狗接管收尾，事件流里一定有一条结论
//
// 这是「接管收尾」那条判据的**集成**用例：直接调 `maybeRecoverDeadTask`
// （`zelto task list` / 驾驶舱各自的单步处置都走它），断言：
//
//   1. 没有收尾事件 + 主管不在 → 写 run.aborted（watchdog、phase=supervisor、
//      带 runId 与 supervisorPid），且切片退回 frozen；
//   2. 已经有结论的一轮 → **不**再写第二条结论（结论是事实，不重复执行）；
//   3. 主管还活着（但活儿暂时没动静）→ 不接管。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { maybeRecoverDeadTask } from '../src/cli/commands/task-watchdog.js';
import { loadTask, saveTask } from '../src/cli/commands/task-store.js';
import { SliceStore } from '../src/core/slice/store.js';
import { EventStream } from '../src/core/events/stream.js';

const ROOT = join(tmpdir(), `zelto-zd049-${Date.now()}`);
const ORIG_CWD = process.cwd();

function resetDirs(): void {
  // Windows 上「当前工作目录正被本进程占着」时删不掉 —— 先退回原目录再删
  // （实测：EPERM），删完再进去。
  try { process.chdir(ORIG_CWD); } catch { /* 原目录没了就继续 */ }
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  mkdirSync(join(ROOT, '.zelto', 'tasks'), { recursive: true });
  mkdirSync(join(ROOT, '.zelto', 'slices'), { recursive: true });
  mkdirSync(join(ROOT, '.zelto', 'events'), { recursive: true });
  process.chdir(ROOT);
}

const OLD = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3 小时前

function makeTask(taskId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    taskId,
    sliceId: 'slice-x',
    // 会话文件不存在（older task）—— 活性判定直接看任务文件里的 pid。
    // 固定一个**不存在的 pid**：进程表查询跳过 → 不能秒判 dead，
    // 三小时没动 → 判 dead。用本进程 pid 会被「主进程秒起秒清」挡掉（实测）。
    sessionId: 'sess-not-found',
    pid: 999_998,
    agentName: 'claude',
    startedAt: OLD,
    status: 'running' as const,
    ...overrides,
  };
}

async function seedSliceAndStarted(store: SliceStore, events: EventStream, sliceId: string, runId: string) {
  const slice = store.create(sliceId, 'x');
  slice.state = 'running';
  await store.write(slice);
  await events.append(sliceId, 'run.started', 'zelto', { sliceId, runId });
}

describe('ZD-049 —— 看门狗接管「主管半路死了」的收尾', () => {
  before(() => {
    resetDirs();
    process.chdir(ROOT);
  });
  after(() => {
    try { process.chdir(ORIG_CWD); } catch { /* 原目录没了 */ }
    rmSync(ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('没有结论 + 主管不在 → 写 run.aborted 并退回 frozen', async () => {
    resetDirs();
    const store = new SliceStore(join(ROOT, '.zelto', 'slices'));
    const events = new EventStream(join(ROOT, '.zelto', 'events'));
    const runId = 'slice-x#2026-11-26T09:00:00Z';
    await seedSliceAndStarted(store, events, 'slice-x', runId);

    // ① 主管还活着 → 不接管。用一片**新鲜的**切片（只有 run.started、没有结论），
    //    证明「主管在」本身就是不接管的条件（而不是「那边恰好已经有结论」）。
    const keptRunId = 'slice-kept#2026-11-26T09:00:00Z';
    await seedSliceAndStarted(store, events, 'slice-kept', keptRunId);
    saveTask(makeTask('task-k', { sliceId: 'slice-kept', runId: keptRunId, supervisorPid: process.pid }));
    await maybeRecoverDeadTask(loadTask('task-k')!);
    const keptStream = await events.read('slice-kept');
    assert.equal(
      keptStream.filter((e) => (e.payload as Record<string, unknown>).phase === 'supervisor').length,
      0,
      '主管还活着时不许接管',
    );

    // ② 主管死了（pid 999999 不存在）→ 必须接管
    // 主管死了（pid 999999 不存在）—— 换一份新的 running 任务，重新走到「第一次处置」
    saveTask(makeTask('task-a', { runId, supervisorPid: 999999, lastActivityAt: OLD }));
    await maybeRecoverDeadTask(loadTask('task-a')!);

    const stream = await events.read('slice-x');
    const aborts = stream.filter((e) => e.type === 'run.aborted');
    const byTakeover = aborts.filter((e) => (e.payload as Record<string, unknown>).phase === 'supervisor');
    assert.equal(byTakeover.length, 1, '接管收尾必须写一条带 phase=supervisor 的结论（自动恢复那条不算）');
    const payload = byTakeover[0].payload as Record<string, unknown>;
    assert.equal(payload.runId, runId);
    assert.equal(payload.supervisorPid, 999999);
    assert.equal(byTakeover[0].actor, 'watchdog');
    // 「主管半路死了」这条结论**先于**自动恢复那条落盘（先落事实）。
    // 比较的必须是**本用例写的**那条（第一次「主管活着」的处置可能已写过一条恢复）。
    const autoRecover = aborts.find(
      (e) => e !== byTakeover[0] && (e.payload as Record<string, unknown>).reason?.toString().startsWith('看门狗自动恢复'),
    );
    if (autoRecover) {
      assert.ok(stream.indexOf(byTakeover[0]) < stream.indexOf(autoRecover), '接管结论先于自动恢复落盘');
    }

    const slice = await store.read('slice-x');
    // 第一次（主管活着）那次处置可能已把切片退回 frozen；第二次写入的 running
    // 是测试自己随手设的，再处置一次 → 仍应是 frozen（可重跑）。
    assert.equal(slice.state, 'frozen', '接管之后切片必须退回可重跑');
  });

  it('已经有结论的一轮 → 不再写第二条结论', async () => {
    resetDirs();
    const store = new SliceStore(join(ROOT, '.zelto', 'slices'));
    const events = new EventStream(join(ROOT, '.zelto', 'events'));
    const runId = 'slice-y#2026-11-26T09:00:00Z';
    await seedSliceAndStarted(store, events, 'slice-y', runId);
    await events.append('slice-y', 'run.aborted', 'zelto', { sliceId: 'slice-y', runId, exitCode: 1 });

    saveTask({
      ...makeTask('task-b', { sliceId: 'slice-y', runId, supervisorPid: 999999, lastActivityAt: OLD }),
    });
    await maybeRecoverDeadTask(loadTask('task-b')!);

    const stream = await events.read('slice-y');
    // 预置的那条结论 + 自动恢复那条 = 2；接管收尾**不应**再写第三条（phase=supervisor）
    const takeover = stream.filter(
      (e) => e.type === 'run.aborted' && (e.payload as Record<string, unknown>).phase === 'supervisor',
    );
    assert.equal(takeover.length, 0, '结论是事实，不重复执行');
  });

  // ── 回归：旧 dist 写的 run.started **不带 runId**（实测 nimrtc-v14 A3，2026-11-26）
  //
  // 病灶：14:05 那轮的 `run.started` payload 只有 `{sliceId, agent}` —— 没有 runId。
  // 于是 `findTaskRunConclusion` 第一行 `if (!task.runId) return {hasRun:false}`
  // 直接短路，**接管收尾永远不会触发**。结果：任务卡 running、切片卡 running、
  // 预约不释放，三处同时说谎，直到人手工回退。
  //
  // 判据：没有 runId 的旧任务照样要能被收走 —— 不能因为「缺 runId」就让
  // 整个看门狗失明。退路是 D-30 的自动恢复（dead → running→frozen + run.aborted）。
  it('旧 dist 的 run.started 不带 runId → 看门狗仍要收走（不得卡在 running）', async () => {
    resetDirs();
    const store = new SliceStore(join(ROOT, '.zelto', 'slices'));
    const events = new EventStream(join(ROOT, '.zelto', 'events'));
    // 旧 dist 的写法：有 run.started，但 payload 里没有 runId
    const slice = store.create('slice-legacy', 'x');
    slice.state = 'running';
    await store.write(slice);
    await events.append('slice-legacy', 'run.started', 'zelto', {
      sliceId: 'slice-legacy',
      agent: 'npx @anthropic-ai/claude-code',
    });
    // 旧任务文件：没有 runId 字段（旧 dist 不写它）
    saveTask(
      makeTask('task-legacy', {
        sliceId: 'slice-legacy',
        supervisorPid: 999_997,
        lastActivityAt: OLD,
      }),
    );

    await maybeRecoverDeadTask(loadTask('task-legacy')!);

    const after = await store.read('slice-legacy');
    assert.equal(after.state, 'frozen', '缺 runId 也不能让切片永远卡在 running');
    const stream = await events.read('slice-legacy');
    assert.ok(
      stream.some((e) => e.type === 'run.aborted'),
      '必须留下一条结论（run.aborted），三处状态不许同时说「在跑」',
    );
    const task = loadTask('task-legacy');
    assert.equal(task?.status, 'failed', '任务文件也要收尾，不能停在 running');
  });
});
