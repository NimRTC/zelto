// ADR-055 · 超时要杀干净，而且要接着跑
//
// 病灶（2026-11-11，nimrtc-zelto 的 v1-remb-parse-and-trust 实测）：
//
//   agent 跑了 34 分钟，zelto 在 30 分钟的 `agent.timeout` 上判超时。
//   但 zelto 在 Windows 上用 `shell: true` 起 agent，拿到的是 `cmd.exe`
//   的 pid —— `child.kill('SIGTERM')` 只杀了 cmd.exe，**agent 本身
//   （npx → node → claude）变成孤儿继续跑**。
//
//   于是同时发生了三件事：
//     1. agent 又活了 10 分钟，交出一份「全部通过」的报告；
//     2. zelto 把这次运行记成 failed，自动重试 —— 在孤儿正在写的
//        工作区上再起一个 agent，两个 agent 抢同一批文件；
//     3. 第一个 agent 的成果被丢弃，切片白跑了一遍。
//
// 三个决策：
//
//   A. **杀干净**（`src/adapters/process-tree.ts`）。超时/停止时杀的是
//      **整棵进程树**，不是 shell 包装：Windows 用 `taskkill /T`，POSIX
//      用独立进程组 + `kill(-pgid)`。
//
//   B. **超时是超时，不是失败**。原来被信号杀掉时 exitCode 是 null，
//      会话状态一律写成 failed，把「跑超时了」和「agent 报错退出」
//      混成同一件事。现在超时保留 `timeout` 状态。
//
//   C. **重试要接着跑**。超时被杀时 agent 已经做掉的工作都留在
//      worktree 里了，从头再跑等于把那些工作重做一遍，还把 agent 的
//      上下文清零。重试改为续跑同一个 agent 会话（`continueSession`）。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';

import { killProcessTree, killProcessTreeGracefully } from '../src/adapters/process-tree.js';
import { ClaudeAgentAdapter } from '../src/adapters/claude-agent/index.js';
import { readSessionLiveness } from '../src/core/activity/liveness.js';

const TEST_DIR = join(tmpdir(), `zelto-adr055-test-${Date.now()}`);

/**
 * 删临时目录（Windows 上可能要重试）。
 *
 * 被杀的 agent 可能还短暂持有 cwd 句柄 → `rm` 报 EBUSY。
 * 那是**清理时机**问题，不是测试失败 —— 重试几次，失败也只记一笔。
 */
async function rmTestDir(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** 起一个会自己退出的子进程，返回 pid 与 child 句柄。 */
async function spawnSleeping(seconds: number): Promise<{ pid: number; child: import('node:child_process').ChildProcess }> {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', `setTimeout(()=>{}, ${seconds * 1000})`], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  return { pid: child.pid ?? 0, child };
}

/**
 * 等子进程真的退出。
 *
 * 不能只轮询 pid：Windows 上被杀的进程在被 Node 回收之前，
 * `process.kill(pid, 0)` 仍然报「活着」。等 'exit' 事件才是确据。
 */
function waitForExit(child: import('node:child_process').ChildProcess, timeoutMs = 5000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** pid 还活着吗？（只作辅助判据） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('ADR-055 · 杀干净进程树', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  after(async () => {
    await rmTestDir();
  });

  it('无效 pid 不抛异常（终止失败不该把调用方带崩）', async () => {
    await assert.doesNotReject(() => killProcessTree(0));
    await assert.doesNotReject(() => killProcessTree(undefined));
    await assert.doesNotReject(() => killProcessTree(-1));
  });

  it('杀掉的进程真的死了', async () => {
    const { pid, child } = await spawnSleeping(30);
    assert.ok(isAlive(pid), '进程应该还活着');

    await killProcessTree(pid, { force: true });
    const exited = await waitForExit(child);

    assert.equal(exited, true, '进程必须被杀掉');
  });

  it('优雅终止也能杀掉进程（不传 force）', async () => {
    const { pid, child } = await spawnSleeping(30);

    killProcessTreeGracefully(pid, 200);
    const exited = await waitForExit(child, 8000);

    assert.equal(exited, true, '宽限期后进程必须被杀掉');
  });
});

describe('ADR-055 · 超时保留 timeout 状态，不写成 failed', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('超时被杀 → 会话状态是 timeout，不是 failed', async () => {
    // 一个永远不结束的 agent —— 超时后必须被杀掉。
    // 路径带空格，必须加引号：shell 里不加引号会解析成两条命令。
    const node = `"${process.execPath}"`;
    const adapter = new ClaudeAgentAdapter({
      agentCommand: `${node} -e "setTimeout(()=>{}, 60000)"`,
      cwd: TEST_DIR,
      timeoutMs: 800,
    });

    const { sessionId } = await adapter.start({ sliceId: 'adr055-timeout', prompt: 'bundle' });
    const exitCode = await adapter.waitForExit(sessionId);

    assert.notEqual(exitCode, 0, '超时的退出码不该是 0');

    const status = adapter.getSessionStatus(sessionId);
    assert.ok(status);
    assert.equal(
      status.status,
      'timeout',
      '超时必须保留 timeout 状态 —— 不能与「agent 报错退出」混成同一件事',
    );
  });

  it('正常退出 → 会话状态是 completed', async () => {
    const adapter = new ClaudeAgentAdapter({
      agentCommand: 'echo done',
      cwd: TEST_DIR,
      timeoutMs: 30_000,
    });

    const { sessionId } = await adapter.start({ sliceId: 'adr055-ok', prompt: 'bundle' });
    await adapter.waitForExit(sessionId);

    const status = adapter.getSessionStatus(sessionId);
    assert.ok(status);
    assert.equal(status.status, 'completed');
  });
});

// ── D-48：包装 pid 与 agent 本人 pid 都必须被杀 ────────────────────────
//
// 病灶（实测于 nimrtc-zelto v2-input-binder，2026-11-17）：
//
//   超时点 `taskkill /pid <包装pid> /T` **没杀掉真正的 agent**。
//   包装 cmd.exe 早就退出了（`/T` 按它当时的子进程树算，
//   而 agent 是它的孙进程），于是 taskkill 找不到人。
//   真正的 agent（pid 28072）继续跑：继续改文件、继续发 policy.decision，
//   而 zelto 已经把它判成 timeout 并准备重试 —— 两个 agent 抢同一批文件。
//
// 所以杀的时候必须**两个 pid 都杀**：包装 pid（杀管道与后代）
// 与 `agentPid`（杀 agent 本人）。
describe('D-48 · 超时要把包装 pid 与 agent 本人 pid 都杀掉', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  after(async () => {
    await rmTestDir();
  });

  it('agent 本人 pid 与包装 pid 是两个不同的进程，都要被杀掉', async () => {
    // 模拟真实形态：包装进程很快退出，agent（孙进程）继续活着。
    // 用 shell 起一个「先退出包装、留下真 agent」的组合：
    //   cmd.exe → node（真 agent）
    // 包装 pid 退出后，taskkill /T 已经找不到 agent 了 ——
    // 这正是「只杀包装 pid」漏掉 agent 的原因。
    const node = `"${process.execPath}"`;
    const adapter = new ClaudeAgentAdapter({
      agentCommand: `${node} -e "setTimeout(()=>{}, 60000)"`,
      cwd: TEST_DIR,
      timeoutMs: 800,
    });

    // 会话文件写在**进程 cwd** 下（`saveSession` 用相对路径 '.zelto/sessions'）。
    // chdir 进临时目录，免得把测试会话文件落进仓库里。
    const cwd = process.cwd();
    process.chdir(TEST_DIR);
    let rec: ReturnType<typeof readSessionLiveness>;
    try {
      const { sessionId } = await adapter.start({ sliceId: 'd48-double-kill', prompt: 'bundle' });
      await adapter.waitForExit(sessionId);

      // 超时之后 agent 本人必须不在了。
      const status = adapter.getSessionStatus(sessionId);
      assert.ok(status);
      assert.equal(status.status, 'timeout');

      rec = readSessionLiveness(TEST_DIR, sessionId);
    } finally {
      process.chdir(cwd);
    }
    assert.ok(rec, '会话文件应该存在');
    const agentPid = rec.agentPid;
    if (agentPid !== undefined) {
      // 宽限期后再判 —— 优雅终止 → 强杀是异步的。
      await new Promise((r) => setTimeout(r, 5000));
      assert.equal(isAlive(agentPid), false, `agent 本人 pid ${agentPid} 必须被杀掉`);
    }
  });
});

describe('ADR-055 · 重试接着同一个 agent 会话跑', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('continueSession 复用同一个 agent 会话 id', async () => {
    const adapter = new ClaudeAgentAdapter({
      agentCommand: 'echo done',
      cwd: TEST_DIR,
    });

    const { sessionId } = await adapter.start({ sliceId: 'adr055-continue', prompt: 'bundle' });
    await adapter.waitForExit(sessionId);

    const agentSessionId = adapter.getAgentSessionId(sessionId);
    assert.ok(agentSessionId, '第一次运行应该产生 agent 会话 id');

    const { sessionId: continuedId } = await adapter.continueSession(
      sessionId,
      '继续完成这个切片。',
    );
    assert.notEqual(continuedId, sessionId, '续跑应该起一个新的 zelto 会话');
    assert.equal(
      adapter.getAgentSessionId(continuedId),
      agentSessionId,
      '续跑必须复用同一个 agent 会话 id —— 这才是「接着跑」而不是「重跑」',
    );

    await adapter.waitForExit(continuedId);
  });

  it('续跑沿用同一个工作目录（写集预约不受影响）', async () => {
    const adapter = new ClaudeAgentAdapter({
      agentCommand: 'echo done',
      cwd: TEST_DIR,
    });

    const { sessionId } = await adapter.start({ sliceId: 'adr055-cwd', prompt: 'bundle' });
    await adapter.waitForExit(sessionId);

    const { sessionId: continuedId } = await adapter.continueSession(sessionId, '继续');
    assert.equal(
      adapter.getSessionStatus(continuedId)?.cwd,
      TEST_DIR,
      '续跑必须在同一个工作目录里 —— 换目录等于换了个任务',
    );

    await adapter.waitForExit(continuedId);
  });

  it('对不存在的会话续跑会抛错（不静默换成新会话）', async () => {
    const adapter = new ClaudeAgentAdapter({ agentCommand: 'echo done', cwd: TEST_DIR });
    await assert.rejects(
      () => adapter.continueSession('nonexistent-session', '继续'),
      /not found/,
    );
  });
});

// ─── D-25：超时的重试不许在适配器内部「从头再来」────────────────────────────
//
// 病灶（2026-11-16，nimrtc-zelto 的 v1-rtcpprocessor 实测）：
//
//   agent 跑了 30 分钟被超时杀掉 → 适配器**内部**用原始 bundle +
//   **新的 agentSessionId** 重启 → agent 的上下文被清零，
//   它已经摸清的东西（改到一半的代码、跑了一半的测试）全部作废。
//
//   这正是 ADR-055 决策 C 要避免的事，而且它把 CLI 层的续跑逻辑
//   （`continueSession`）**短路**了 —— 适配器内部已经把重试链走完。
//
// 判据：**超时的退出码是 null，被杀掉的进程不该触发内部重试**。
// 内部重试留给「agent 自己报错退出」（非零退出码）—— 那通常是逻辑崩了。

describe('D-25 · 超时不触发适配器内部的从头重试', () => {
  const TEST_DIR_2 = join(tmpdir(), `zelto-d025-test-${Date.now()}`);

  before(async () => {
    await mkdir(TEST_DIR_2, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR_2, { recursive: true, force: true });
  });

  it('超时的退出码不是 0（退出码分不出超时 —— 判据得用 status）', async () => {
    const node = `"${process.execPath}"`;
    const adapter = new ClaudeAgentAdapter({
      agentCommand: `${node} -e "setTimeout(()=>{}, 60000)"`,
      cwd: TEST_DIR_2,
      timeoutMs: 800,
      maxRetries: 2,
    });

    const { sessionId } = await adapter.start({ sliceId: 'd025-exitcode', prompt: 'bundle' });
    const exitCode = await adapter.waitForExit(sessionId);

    // Windows 上 `taskkill` 杀进程树后，shell 包装返回的是**非零码**（1），
    // 不是 null —— 所以「退出码是 null 就算超时」这条路走不通。
    // 这正是 D-25 的病灶：适配器把超时当成了「agent 报错退出」，内部重试。
    assert.notEqual(exitCode, 0, '超时的退出码不该是 0');

    const status = adapter.getSessionStatus(sessionId);
    assert.equal(status?.status, 'timeout', '会话状态必须是 timeout —— 这是唯一可靠的超时信号');
  });

  it('超时后适配器没有偷偷起第二个 agent（会话数不变）', async () => {
    const node = `"${process.execPath}"`;
    // sliceId 带时间戳 —— 会话文件是累积的，不能拿绝对数量做判据
    const sliceId = `d025-nohidden-${Date.now()}`;
    const adapter = new ClaudeAgentAdapter({
      agentCommand: `${node} -e "setTimeout(()=>{}, 60000)"`,
      cwd: TEST_DIR_2,
      timeoutMs: 800,
      maxRetries: 2,
    });

    const before = adapter.listSliceSessions(sliceId).length;

    const { sessionId } = await adapter.start({ sliceId, prompt: 'bundle' });
    await adapter.waitForExit(sessionId);

    // 内部重试会起一个 `-retry-N` 后缀的新会话。
    // 断言这个切片只留下**一个**会话 —— 超时不该在适配器内部起新 agent。
    const sessions = adapter.listSliceSessions(sliceId);
    assert.equal(
      sessions.length - before,
      1,
      `超时后只应有一个会话（内部重试会起第二个：${JSON.stringify(sessions.map((s) => s.sessionId))}）`,
    );
  });

  it('agent 报错退出（failed）仍会起内部重试 —— 与超时的行为必须不同', async () => {
    const node = `"${process.execPath}"`;
    const sliceId = `d025-internal-retry-${Date.now()}`;
    const adapter = new ClaudeAgentAdapter({
      agentCommand: `${node} -e "process.exit(1)"`,
      cwd: TEST_DIR_2,
      timeoutMs: 30_000,
      maxRetries: 1,
    });

    const before = adapter.listSliceSessions(sliceId).length;

    const { sessionId } = await adapter.start({ sliceId, prompt: 'bundle' });
    await adapter.waitForExit(sessionId);

    const sessions = adapter.listSliceSessions(sliceId);
    assert.equal(
      sessions.length - before,
      2,
      `agent 报错退出应该起内部重试（1 次重试 = 2 个会话）：${JSON.stringify(sessions.map((s) => s.sessionId))}`,
    );
  });

  it('超时后 CLI 层能续同一个 agent 会话（ADR-055 决策 C 真的生效）', async () => {
    const node = `"${process.execPath}"`;
    const sliceId = 'd025-continue';
    const adapter = new ClaudeAgentAdapter({
      agentCommand: `${node} -e "setTimeout(()=>{}, 60000)"`,
      cwd: TEST_DIR_2,
      timeoutMs: 800,
      maxRetries: 2,
    });

    const { sessionId } = await adapter.start({ sliceId, prompt: 'bundle' });
    await adapter.waitForExit(sessionId);

    const agentSessionId = adapter.getAgentSessionId(sessionId);
    assert.ok(agentSessionId, '超时前应该已经产生了 agent 会话 id');

    // 续跑：复用同一个 agent 会话 id —— 这才是「接着跑」而不是「重跑」
    const { sessionId: continuedId } = await adapter.continueSession(sessionId, '继续完成这个切片。');
    assert.equal(
      adapter.getAgentSessionId(continuedId),
      agentSessionId,
      '续跑必须复用同一个 agent 会话 id',
    );
    await adapter.waitForExit(continuedId);
  });

  it('非零退出码仍然走内部重试（agent 逻辑崩了，重来一遍合理）', async () => {
    // 退出码 1 —— 与超时的区别在于会话状态是 failed 而不是 timeout
    const node = `"${process.execPath}"`;
    const sliceId = 'd025-nonzero';
    const adapter = new ClaudeAgentAdapter({
      agentCommand: `${node} -e "process.exit(1)"`,
      cwd: TEST_DIR_2,
      timeoutMs: 30_000,
      maxRetries: 1,
    });

    const { sessionId } = await adapter.start({ sliceId, prompt: 'bundle' });
    const exitCode = await adapter.waitForExit(sessionId);

    assert.notEqual(exitCode, null, '非零退出码不该是 null');
    assert.notEqual(exitCode, 0, '非零退出码不该是 0');

    const status = adapter.getSessionStatus(sessionId);
    assert.equal(status?.status, 'failed', 'agent 报错退出的状态是 failed，不是 timeout');
  });
});
