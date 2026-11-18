// D-74：已交付的切片被列为「待合并」
//
// 病灶（实测 nimrtc-zelto，2026-11-18）：
//
//   $ zelto merge --list
//   待合并的已批准切片：v4-voice-agent, v4-ai-teammate, v3-weaknet-verdict,
//                      v3-chrome-waterfall, v2-qoe-feed, v2-input-binder,
//                      v1-game-source, v1-video-processing
//   ❌ 这批切片归属不同的合并目标，不能一次合：
//      - v4-voice-agent → version/v4
//      - ...
//
// 而这 8 个切片**全部已经交付**（v1 / v2 / v3 / v4 的版本都已 ship）。
//
// ── 根因 ──────────────────────────────────────────────────────
//
// `collectMergeCandidates()` 判断「这个切片还合不合并」时，
// 对「没有 slice 分支」的切片用 ADR-071 的空操作判据：
// **产物在不在目标 ref 上**。
//
// 这条判据有个致命漏洞：**产物一旦在目标上，就永远在**。
//
// 而且它比的目标和切片合入的目标**不是同一个**：
//   - 切片合进的是 `version/v1` / `version/v2` …（版本分支）
//   - 收集候选时默认按主仓 HEAD（= `main`）判
//
// 流程于是变成：
//   1. v1-game-source 合进 `version/v1`；
//   2. `version/v1` ship 进 main（产物也就在 main 上了）；
//   3. 收集候选时按 **main** 判「产物在不在」→ 在 → 判成「还没合」；
//   4. 但它明明已经合进版本分支、而且版本已经交付了。
//
// 精确对应关系（实测）：
//
// | 切片的 merge.completed mode | 是否被列为待合并 |
// |---------------------------|----------------|
// | `merged`（合进版本分支）    | **是** ❌        |
// | `noop`（产物已在目标上）     | 否 ✅            |
// | 无事件（从没合过）           | 否 ✅            |
//
// 规律精确到「有没有 noop 事件」——
// 因为 `hasNoopMergeEvent` 恰好把 noop 的排除了，merged 的没排除。
//
// ── 危害 ──────────────────────────────────────────────────────
//
// 「假待办」比「假完成」更隐蔽：它不会让人以为活干完了，
// 而是让人以为**还有活没干** —— 人会去翻、去合、去排查，
// 浪费一轮；更坏的情况是它把人引到「这些切片没合进主干」的错误结论上，
// 而实际上它们**早就合进去了**（追溯链在这里说了假话）。
//
// ── 修法 ──────────────────────────────────────────────────────
//
// 判据从「产物在不在目标上」改成「**这个切片合过没有**」——
// 事件流里有 `merge.completed` 就算合过（ADR-071 §3 D3：
// 空操作也写事件，追溯链不因为「这次没搬东西」而断）。
//
// 目标要一起对齐：合进 `version/v1` ≠ 合进 `main`。
// `merge.completed` 事件补记 `target` 字段。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-d74-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: TEST_DIR,
    encoding: 'utf-8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runCommand(...args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: TEST_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => resolve({ stdout: stdout || stderr, code: code ?? 1 }));
    child.on('error', reject);
  });
}

/** 造一个切片状态文件 */
async function writeSlice(id: string, writes: string[]): Promise<void> {
  const now = new Date().toISOString();
  const slice = {
    id,
    title: `Slice ${id}`,
    state: 'completed',
    spec: { path: `specs/slices/${id}.md`, frozenHash: 'hash', frozenAt: now },
    acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: [], contracts: [], tests: [] },
    traceWaiver: null,
    baseline: false,
    writes,
    runs: [],
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(
    join(TEST_DIR, '.zelto', 'slices', `${id}.json`),
    JSON.stringify(slice, null, 2),
    'utf-8',
  );
}

/** 造一个已批准的签字请求 */
async function writeApprovedSign(sliceId: string): Promise<void> {
  const now = new Date().toISOString();
  const req = {
    id: `sign-${sliceId}-${Date.now()}`,
    sliceId,
    requestedAt: now,
    requestedBy: 'human',
    status: 'approved',
    decidedAt: now,
    decidedBy: 'human',
    comment: null,
  };
  await writeFile(
    join(TEST_DIR, '.zelto', 'locks', `${req.id}.json`),
    JSON.stringify(req, null, 2),
    'utf-8',
  );
}

/** 造一个版本计划（决定切片的归属 → 决定它的合并目标） */
async function writeVersionPlan(
  versions: Array<{ version: string; slices: string[] }>,
): Promise<void> {
  const plan = {
    id: 'plan-test-1',
    designId: 'dsg-test-1',
    title: 'Test plan',
    versions: versions.map((v) => ({
      version: v.version,
      dependsOn: [],
      description: `version ${v.version}`,
      slices: v.slices.map((id) => ({
        id,
        module: 'test',
        title: `Slice ${id}`,
        writes: [],
        specPath: `specs/slices/${id}.md`,
        state: 'draft',
      })),
      status: 'in_progress',
    })),
    status: 'confirmed',
    createdAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
  };
  await writeFile(
    join(TEST_DIR, '.zelto', 'versions', 'plan-test-1.json'),
    JSON.stringify(plan, null, 2),
    'utf-8',
  );
}

/** 直接往事件流里塞一条 merge.completed（模拟「历史上合过」） */
async function writeMergeCompleted(
  sliceId: string,
  payload: { target?: string; mode?: string },
): Promise<void> {
  const dir = join(TEST_DIR, '.zelto', 'events', sliceId);
  await mkdir(dir, { recursive: true });
  const event = {
    ts: new Date().toISOString(),
    runSeq: 1,
    slice: sliceId,
    run: null,
    type: 'merge.completed',
    actor: 'zelto',
    payload: {
      sliceId,
      slices: [sliceId],
      strategy: 'sequential_ff',
      phases: 1,
      mergeCommit: 'deadbeef',
      mode: 'merged',
      ...payload,
    },
  };
  await writeFile(
    join(dir, 'events.jsonl'),
    JSON.stringify(event) + '\n',
    'utf-8',
  );
}

/** 读某个切片的事件流 */
async function readEvents(sliceId: string): Promise<Array<Record<string, unknown>>> {
  const file = join(TEST_DIR, '.zelto', 'events', sliceId, 'events.jsonl');
  let content: string;
  try {
    content = await readFile(file, 'utf-8');
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

describe('D-74：已合过的切片不该再被列为「待合并」', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'locks'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'versions'), { recursive: true });
    await mkdir(join(TEST_DIR, 'specs', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, 'policy'), { recursive: true });
    await mkdir(join(TEST_DIR, 'src'), { recursive: true });

    await writeFile(join(TEST_DIR, 'src', 'delivered.ts'), 'export const d = 1;\n', 'utf-8');
    await writeFile(join(TEST_DIR, '.gitignore'), '.zelto/\n', 'utf-8');

    git('init', '-b', 'main');
    git('config', 'user.email', 'test@zelto.local');
    git('config', 'user.name', 'zelto test');
    git('add', '-A');
    git('commit', '-m', 'init with delivered artifact');
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('已合进版本分支、且产物也在 main 上的切片，不再被列为待合并', async () => {
    // 复刻 nimrtc-zelto 的现场：
    //   产物在 main 上（ship 带过去的），切片分支已删（cleanup 过），
    //   事件流里有 merge.completed（mode=merged, target=version/v1）。
    //
    // 关键：版本计划里这个切片归属 v1 → 它的合并目标是 `version/v1`，
    // 而它**确实合进了 version/v1** → 合完了 → 不该再被列。
    await writeVersionPlan([{ version: 'v1', slices: ['delivered-slice'] }]);
    await writeSlice('delivered-slice', ['src/delivered.ts']);
    await writeApprovedSign('delivered-slice');
    await writeMergeCompleted('delivered-slice', { target: 'version/v1', mode: 'merged' });

    const { stdout } = await runCommand('merge', '--dry-run');
    assert.ok(
      !stdout.includes('delivered-slice'),
      `已交付的切片不该再被列为待合并，实际输出：${stdout}`,
    );
  });

  it('合到**别的**目标、且自身归属是主干的切片，仍然要合', async () => {
    // 合进 version/v1，但它自己的归属是主干（不在任何版本计划里），
    // 而且现在要合进 main → 对 main 来说仍然算「没合到」→ 仍要列。
    await writeSlice('other-target-slice', ['src/delivered.ts']);
    await writeApprovedSign('other-target-slice');
    await writeMergeCompleted('other-target-slice', { target: 'version/v1', mode: 'merged' });

    const { stdout } = await runCommand('merge', '--dry-run');
    assert.ok(
      stdout.includes('other-target-slice'),
      `合到别的目标的切片，对 main 来说仍然要合 —— 不该被排除，实际输出：${stdout}`,
    );
  });

  it('从没合过的切片仍然被列为待合并（不能误伤）', async () => {
    await writeSlice('never-merged-slice', ['src/delivered.ts']);
    await writeApprovedSign('never-merged-slice');

    const { stdout } = await runCommand('merge', '--dry-run');
    assert.ok(
      stdout.includes('never-merged-slice'),
      `从没合过的切片应当被列为待合并，实际输出：${stdout}`,
    );
  });

  it('merge.completed 事件补记 target 字段（判据要对齐目标）', async () => {
    await writeSlice('target-field-slice', ['src/delivered.ts']);
    await writeApprovedSign('target-field-slice');

    const { code, stdout } = await runCommand('merge', 'target-field-slice');
    assert.equal(code, 0, `合并应当成功，实际输出：${stdout}`);

    const events = await readEvents('target-field-slice');
    const completed = events.find((e) => e.type === 'merge.completed');
    assert.ok(completed, '合并没有写 merge.completed 事件');

    const payload = completed.payload as Record<string, unknown>;
    assert.ok(
      typeof payload.target === 'string',
      `merge.completed 必须记 target —— 没有它就分不清「合进版本分支」与「合进主干」，实际：${JSON.stringify(payload)}`,
    );
  });

  it('空操作合并的事件也记 target', async () => {
    await writeSlice('noop-target-slice', ['src/delivered.ts']);
    await writeApprovedSign('noop-target-slice');

    const { code, stdout } = await runCommand('merge', 'noop-target-slice');
    assert.equal(code, 0, `空操作合并应当成功，实际输出：${stdout}`);

    const events = await readEvents('noop-target-slice');
    const completed = events.find((e) => e.type === 'merge.completed');
    assert.ok(completed, '空操作合并没有写 merge.completed 事件');

    const payload = completed.payload as Record<string, unknown>;
    assert.equal(payload.mode, 'noop');
    assert.ok(
      typeof payload.target === 'string',
      `空操作的 merge.completed 也必须记 target，实际：${JSON.stringify(payload)}`,
    );
  });
});
