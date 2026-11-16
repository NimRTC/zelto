// ADR-071：合并目标已含产物时的空操作合并
//
// 实测缺陷 D-32（第四轮端到端复验）：两个切片的产物由人直接提交到了
// `main`（从未跑过 agent），所以没有 `slice/<id>` 分支。
// `zelto merge` 硬性要求分支存在，直接拒绝 ——
// 而合并此时本该是**空操作**：产物已经在目标分支里了。
//
// 本测试守住三件事：
//   1. 产物已在目标分支 + 无分支 → 合并成功（空操作），退出码 0
//   2. 产物**不**在目标分支 + 无分支 → 仍然拒绝（不能放宽成「一律放行」）
//   3. 空操作合并仍写 `merge.completed` 事件（追溯链不断）
//
// 注意：合并路径要求 git 仓库。这里用最小 git 仓库 + 手工造的切片状态文件
// + 手工造的签字请求文件，绕开 agent 执行。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-merge-noop-test-${Date.now()}`);
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

/** 造一个切片状态文件（writes 可指定） */
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

/**
 * 读某个切片的事件流。
 *
 * 事件落在 `.zelto/events/<sliceId>/events.jsonl`，
 * 每行一个 JSON，标识字段叫 `slice`（不是 `sliceId`）。
 */
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

describe('zelto merge —— 空操作合并（ADR-071 / D-32）', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'locks'), { recursive: true });
    await mkdir(join(TEST_DIR, 'specs', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, 'policy'), { recursive: true });
    await mkdir(join(TEST_DIR, 'src'), { recursive: true });

    // 产物**已**在目标分支上（人工直接提交的典型形态）
    await writeFile(join(TEST_DIR, 'src', 'committed.ts'), 'export const y = 2;\n', 'utf-8');

    // `.zelto/` 不入库（zelto 的运行时状态不是代码）
    await writeFile(join(TEST_DIR, '.gitignore'), '.zelto/\n', 'utf-8');

    git('init', '-b', 'main');
    git('config', 'user.email', 'test@zelto.local');
    git('config', 'user.name', 'zelto test');
    git('add', '-A');
    git('commit', '-m', 'init with committed artifact');
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('产物已在目标分支 + 无 slice 分支 → 合并成功（空操作）', async () => {
    await writeSlice('noop-slice', ['src/committed.ts']);
    await writeApprovedSign('noop-slice');

    const { stdout, code } = await runCommand('merge', 'noop-slice');
    assert.equal(code, 0, `空操作合并应当成功，实际输出：${stdout}`);
    assert.ok(
      stdout.includes('空操作'),
      `应当明说这是空操作合并，实际输出：${stdout}`,
    );
    assert.ok(
      stdout.includes('Merge complete'),
      `应当报合并完成，实际输出：${stdout}`,
    );
  });

  it('空操作合并仍写 merge.completed 事件（追溯链不断）', async () => {
    await writeSlice('noop-event-slice', ['src/committed.ts']);
    await writeApprovedSign('noop-event-slice');

    const { code } = await runCommand('merge', 'noop-event-slice');
    assert.equal(code, 0, '空操作合并应当成功');

    const events = await readEvents('noop-event-slice');
    const completed = events.find((e) => e.type === 'merge.completed');
    assert.ok(completed, '空操作合并没有写 merge.completed 事件 —— 追溯链断了');

    const payload = completed.payload as Record<string, unknown>;
    assert.equal(payload.mode, 'noop', `事件应记 mode=noop，实际：${JSON.stringify(payload)}`);
    assert.ok(
      Array.isArray(payload.artifacts),
      '事件应记下核实的产物路径',
    );
  });

  it('产物不在目标分支 + 无 slice 分支 → 仍然拒绝（不能一律放行）', async () => {
    // 产物路径在目标分支上**根本不存在** —— 也没被删过（git log 里查不到）
    await writeSlice('not-in-target-slice', ['src/never-committed.ts']);
    await writeApprovedSign('not-in-target-slice');

    const { stdout, code } = await runCommand('merge', 'not-in-target-slice');
    assert.notEqual(code, 0, '产物不在目标分支时必须拒绝合并');
    assert.ok(
      stdout.includes('not-in-target-slice'),
      `错误信息应点名是哪一片，实际输出：${stdout}`,
    );
    assert.ok(
      stdout.includes('src/never-committed.ts'),
      `错误信息应列出尚未合入的产物，实际输出：${stdout}`,
    );
  });

  it('不带 id 的路径也认空操作切片（两条路径判据一致）', async () => {
    await writeSlice('noop-batch-slice', ['src/committed.ts']);
    await writeApprovedSign('noop-batch-slice');

    const { stdout, code } = await runCommand('merge', '--dry-run');
    // 批次里可能还有别的切片，这里只断言「它被列出来了」
    if (code === 0) {
      assert.ok(
        stdout.includes('noop-batch-slice'),
        `不带 id 时应列出空操作切片，实际输出：${stdout}`,
      );
    }
  });

  it('空操作合过一次的切片不再被重复列出（人不会以为它没合过）', async () => {
    await writeSlice('noop-once-slice', ['src/committed.ts']);
    await writeApprovedSign('noop-once-slice');

    const first = await runCommand('merge', 'noop-once-slice');
    assert.equal(first.code, 0, `首次空操作合并应当成功，实际输出：${first.stdout}`);

    // 产物还在目标分支上 —— 判据永远成立。
    // 如果不记「已空操作合过」，这个切片会被无限次列为待合并。
    const second = await runCommand('merge', '--dry-run');
    assert.ok(
      !second.stdout.includes('noop-once-slice'),
      `空操作合过的切片不该再被列为待合并，实际输出：${second.stdout}`,
    );
  });

  it('有 slice 分支的切片仍走正常合并路径（不被误伤）', async () => {
    // 造一个带分支的切片：产物在分支上，不在 main 上
    git('checkout', '-b', 'slice/branched-slice');
    await writeFile(join(TEST_DIR, 'src', 'branched.ts'), 'export const b = 4;\n', 'utf-8');
    git('add', '-A');
    git('commit', '-m', 'branched slice artifact');
    git('checkout', 'main');

    await writeSlice('branched-slice', ['src/branched.ts']);
    await writeApprovedSign('branched-slice');

    const { stdout, code } = await runCommand('merge', 'branched-slice');
    assert.equal(code, 0, `正常合并应当成功，实际输出：${stdout}`);
    assert.ok(
      !stdout.includes('空操作'),
      `有分支的切片不该走空操作路径，实际输出：${stdout}`,
    );

    // 产物应当已合入 main
    const inMain = git('ls-tree', '-r', '--name-only', 'main', '--', 'src/branched.ts');
    assert.ok(
      inMain.includes('src/branched.ts'),
      `产物应当已合入 main，实际：${inMain}`,
    );
  });
});
