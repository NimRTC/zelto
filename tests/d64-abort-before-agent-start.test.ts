// D-64：「agent 还没开跑就中止了」的切片被留在 running，而没人能救它
//
// 病灶（实测于 nimrtc-zelto v4-ai-teammate，2026-11-18）：
//
//   `zelto version start v4` → 并行执行器先 `startRun`（切片 → `running`），
//   再建 worktree、再装写集守卫。
//
//   装守卫时取 worktree 基线快照，`git status` 超时（spawnSync ETIMEDOUT），
//   执行器按 C9 fail closed —— 整批 abort。**这是对的**（拿不到基线就分不清
//   「这个文件本来就脏」与「agent 越界改了它」）。
//
//   但切片被留在了 `running`：
//
//     $ zelto slice-status v4-ai-teammate
//     ... state=running，事件流最后一条是 worktree.created
//
//   而这个状态**没有任何出路**：
//   - `zelto run` 拒绝跑 —— 准入只认 frozen / completed
//   - `zelto merge` 不收它 —— 没签字
//   - `zelto stall --reap` **看不见它** ——
//     `findOrphanShells` 按会话/任务文件里的活性记录判定，
//     而这片**连会话文件都没写**（agent 根本没起），
//     `classifyLiveness(null)` 返回 `finished`（不是 stale/dead）→ 不算空壳
//   - 唯一出路是 `zelto abandon` —— 整个切片作废，规格得重写
//
// 也就是「环境抖一下（git 慢了一秒），切片就废了」。这不是设计意图：
// 拿不到预约是**环境问题**，重跑就行。
//
// 这一组用例守的是：
//   1. 装守卫失败 → 切片退回 `frozen`（不是留在 running）；
//   2. 并行批次里，**前面几片**（已 startRun 但 agent 还没起）也一起退回；
//   3. `findOrphanShells` 能看见「running 且没有任何运行记录」的切片
//      —— 兜底网，防止别的路径再漏下这种壳子；
//   4. 退回**不写停机分类** —— agent 没跑过，不是「跑挂了」，
//      写分类会让 `zelto next` 把人往一片没开工的切片上引。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findOrphanShells } from '../src/core/stall/reap.js';
import type { SliceData } from '../src/core/slice/store.js';

function makeSlice(overrides: Partial<SliceData> = {}): SliceData {
  return {
    id: 'v4-ai-teammate',
    title: 'AI 队友',
    state: 'running',
    spec: { path: 'specs/slices/v4-ai-teammate.md', frozenHash: 'sha256:x', frozenAt: null },
    acceptance: { dir: 'tests/acceptance/v4-ai-teammate/', frozenHash: null, oracleSrc: null },
    baseCommit: 'abc123',
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: [], contracts: [], tests: [] },
    traceWaiver: null,
    baseline: false,
    writes: ['examples/demo-agent-realtime/**'],
    runs: [],
    clarifyRounds: 0,
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: '2026-11-17T20:06:11.000Z',
    updatedAt: '2026-11-17T20:07:22.000Z',
    ...overrides,
  };
}

describe('D-64：agent 未开跑就中止的切片不能留在 running', () => {
  it('running 且没有任何运行记录的切片算空壳（能被 reap 看见）', () => {
    const root = mkdtempSync(join(tmpdir(), 'zelto-d64-shell-'));
    try {
      // 没有任何会话/任务文件 —— agent 从未开跑
      const shells = findOrphanShells([makeSlice()], root, () => false);

      assert.equal(shells.length, 1, '「running 且无任何运行记录」的切片应被识别为空壳');
      assert.equal(shells[0].sliceId, 'v4-ai-teammate');
      assert.equal(shells[0].liveness.state, 'dead');
      assert.match(shells[0].liveness.reason, /没有任何运行记录/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('有会话文件但已结束的 running 切片不算空壳（别误伤正常收尾）', () => {
    const root = mkdtempSync(join(tmpdir(), 'zelto-d64-shell-'));
    try {
      const sessionsDir = join(root, '.zelto', 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        join(sessionsDir, 'v4-ai-teammate.json'),
        JSON.stringify({
          sessionId: 'v4-ai-teammate-1',
          sliceId: 'v4-ai-teammate',
          status: 'completed',
          startedAt: '2026-11-17T20:07:30.000Z',
          lastActivityAt: '2026-11-17T20:20:00.000Z',
        }),
        'utf-8',
      );

      const shells = findOrphanShells([makeSlice()], root, () => false);
      assert.equal(shells.length, 0, '有已收尾记录的切片不该被当成空壳');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('非 running 的切片不报空壳', () => {
    const root = mkdtempSync(join(tmpdir(), 'zelto-d64-shell-'));
    try {
      const shells = findOrphanShells([makeSlice({ state: 'frozen' })], root, () => false);
      assert.equal(shells.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('D-64：中止路径必须把切片退回 frozen', () => {
  const SRC = join(process.cwd(), 'src', 'cli', 'commands');

  it('并行执行器在装守卫失败时调用退回助手', () => {
    const src = readFileSync(join(SRC, 'parallel-executor.ts'), 'utf-8');
    // 装守卫失败的分支里必须有退回动作
    const guardFail = src.indexOf('无法取得写集预约: ${msg}');
    assert.ok(guardFail > 0, '并行执行器里找不到「无法取得写集预约」的失败分支');
    const window = src.slice(Math.max(0, guardFail - 600), guardFail + 400);
    assert.match(
      window,
      /revertStartedRound\(|revertRunAbortedBeforeStart\(/,
      '装守卫失败时切片没有退回 frozen —— 它会卡死在 running（D-64）',
    );
  });

  it('并行执行器在建 worktree 失败时也退回', () => {
    const src = readFileSync(join(SRC, 'parallel-executor.ts'), 'utf-8');
    const wtFail = src.indexOf('无法创建隔离 worktree: ${msg}');
    assert.ok(wtFail > 0, '并行执行器里找不到「无法创建隔离 worktree」的失败分支');
    const window = src.slice(Math.max(0, wtFail - 600), wtFail + 400);
    assert.match(
      window,
      /revertStartedRound\(|revertRunAbortedBeforeStart\(/,
      '建 worktree 失败时切片没有退回 frozen（D-64）',
    );
  });

  it('单切片路径在装守卫失败时也退回', () => {
    const src = readFileSync(join(SRC, 'core-slice.ts'), 'utf-8');
    const guardFail = src.indexOf('无法取得写集预约: ${msg}');
    assert.ok(guardFail > 0, '单切片路径里找不到「无法取得写集预约」的失败分支');
    const window = src.slice(Math.max(0, guardFail - 700), guardFail + 400);
    assert.match(
      window,
      /revertRunAbortedBeforeStart\(/,
      '单切片路径装守卫失败时切片没有退回 frozen（D-64）',
    );
  });

  it('退回助手存在且不写停机分类（agent 没跑过 ≠ 跑挂了）', () => {
    const src = readFileSync(join(SRC, 'run-support.ts'), 'utf-8');
    assert.match(src, /export async function revertRunAbortedBeforeStart/, '缺少退回助手');

    const start = src.indexOf('export async function revertRunAbortedBeforeStart');
    const body = src.slice(start, start + 4000);
    // 助手只走 rollbackStalledSlice（退状态），不走 markSliceStalled（写分类）
    assert.match(body, /rollbackStalledSlice\(/, '退回助手应复用 rollbackStalledSlice');
    assert.doesNotMatch(
      body,
      /markSliceStalled\(/,
      '退回助手不该写停机分类 —— agent 压根没跑过',
    );
  });

  it('退回助手写了 run.aborted 事件且标明 agentStarted=false', () => {
    const src = readFileSync(join(SRC, 'run-support.ts'), 'utf-8');
    const start = src.indexOf('export async function revertRunAbortedBeforeStart');
    const body = src.slice(start, start + 4000);
    assert.match(body, /'run\.aborted'/, '退回助手应写 run.aborted 事件');
    assert.match(body, /agentStarted:\s*false/, '事件应标明 agent 压根没起');
  });
});
