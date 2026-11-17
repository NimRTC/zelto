// 后台监督进程（--detach 的真正实现）
//
// 病灶（D-50，实测于 nimrtc-zelto v2-input-binder，2026-11-17）：
//
//   `zelto run <id> --detach` 的「后台监视器」是**同一个进程里一个没 await 的
//   Promise**（`monitorTaskInBackground(...)`，见 core-slice.ts）。CLI 主进程
//   跑完就 `process.exit(exitCode)` —— 于是：
//
//   - 监视器被 `process.exit()` 一起杀掉 → **没人等 agent 结束**；
//   - agent 子进程变孤儿：它还活着，还在改文件、还在烧 token；
//   - 任务文件永远停在 `status: "running"`，会话文件的心跳停在起跑那一刻；
//   - 没人跑写集审计 → 越界写入不会被发现；
//   - 没人跑门禁 → 没有签字请求 → 切片永远卡在 frozen；
//   - 没人释放写集预约 → 下一片撞写集冲突。
//
// 人看到的是「切片在跑」，实际是**一个没人管的孤儿 agent**。
// 界面显示 `running` 而实际无主 —— 这比直接报错更危险：
// 它让人以为 agent 还在干活，而现场其实已经没人管了。
//
// 证据（同一台机器、同一条命令，差别只在有没有 --detach）：
//   前台跑：会话文件 `lastActivityAt` 一直推进 → 状态可信；
//   --detach：会话文件 `lastActivityAt` 永远等于 `startedAt` → 监视器已死。
//
// 修法：**整个运行都得搬进独立进程**，不只是「等 agent 结束」这一段。
//
//   主进程（zelto run --detach）
//     ├─ 准入 / 写集解析 / 建 worktree / 装守卫  ← 这些要快，别让 agent 等
//     ├─ 起**独立监督进程**（detached）← 它接管后面的一切
//     └─ 立刻退出
//
//   独立监督进程
//     ├─ **起 agent**（适配器 spawn）—— 适配器住在这里，退出码才拿得到
//     ├─ 等 agent 退出
//     ├─ 写收尾（记账 / 审计 / 门禁 / 签字请求 / 切片状态）
//     └─ 释放写集预约 + 撤钩子
//
// **为什么 agent 也得搬进去**（这是这一版的关键）：适配器负责写
// 会话文件的 `exitCode` 与 `status` —— 那段代码住在主进程里。
// 主进程一退，agent 退出的那一刻就没人记录了：
//   - 退出码永远拿不到 → 「成功」与「失败」无法区分；
//   - 会话文件永远停在 `status: "running"` → 活性判定永远说「还在跑」。
//
// C1: 状态只落在文件里
// C4: 每个动作写 append-only 事件

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTask, patchTask, saveTask, type TaskInfo } from './task-store.js';

/** 监督进程日志的目录（相对项目根）。 */
export const SUPERVISOR_LOG_DIR = join('.zelto', 'supervisor');

/**
 * 监督进程日志文件（相对项目根）。
 *
 * 为什么要落盘（而不是只打 stdout）：监督进程是 detached 的，
 * 它的 stdout 没人接 —— 不落盘就等于「跑完了但没人知道」，
 * 排查时连一行线索都没有。
 */
export function supervisorLogPath(projectRoot: string, taskId: string): string {
  return join(projectRoot, SUPERVISOR_LOG_DIR, `${taskId}.log`);
}

/** 监督进程自己的命令行参数。 */
export interface SupervisorArgs {
  /** 项目根（绝对路径）—— 状态文件都在这里 */
  projectRoot: string;
  /** 任务 id */
  taskId: string;
  /** 切片 id */
  sliceId: string;
  /** agent 会话 id（主进程起的那一轮；监督进程会起自己的新一轮） */
  sessionId: string;
  /** agent 命令（配置里的原文） */
  agentCommand: string;
  /** agent 工作目录（worktree） */
  workDir: string;
  /** agent 超时（毫秒） */
  timeoutMs: number;
  /** 是否是 hotfix（跳过门禁②并直接签字） */
  isHotfix: boolean;
  /**
   * 日志文件路径（绝对路径）—— 监督进程自己往这里写。
   *
   * 为什么由监督进程自己写、而不是主进程用管道接：
   * 管道的一头在主进程身上，主进程 `process.exit()` 后管道就断了 ——
   * 子进程再写就 EPIPE，日志只剩半截。
   */
  logFile?: string;
  /**
   * 适配器类型（`claude-agent` / `claude-agent-sdk`）。
   * 监督进程要**用同一个适配器**起 agent —— 换适配器就换了行为。
   */
  adapterType?: string;
}

/**
 * 拉起监督进程的结果。
 *
 * `ok: false` 时**必须**告诉人为什么 —— 否则就是「显示在跑，其实没跑」
 * （D-53 的根因：监督进程参数解析失败、秒退，主进程照样报「已在后台跑」）。
 */
export type SupervisorLaunch =
  | { ok: true; pid: number }
  | { ok: false; reason: string };

/**
 * 拉起一个**独立**的监督进程。
 *
 * 为什么必须是独立进程（而不是主进程里的 Promise）：
 * 见本文件头的 D-50 说明 —— 主进程 `process.exit()` 会把同进程里
 * 没 await 的 Promise 一起带走。
 *
 * `detached: true` 让它脱离父进程：
 *   - POSIX：独立进程组，父进程退出不影响它；
 *   - Windows：独立进程，父进程退出不影响它（实测已验证）。
 *
 * **为什么还要做「启动存活确认」（D-53）**：
 * `spawn()` 成功只说明「进程被创建了」，不说明「它活下来了」。
 * 监督进程如果参数不全、入口找不到、模块加载失败，会在**一秒内**退出 ——
 * 而主进程这时已经打印了「已在后台跑」。人就得到一个假象：
 * 界面显示 running，实际**一个 agent 都没起**。
 * 所以这里起完之后**等一下、查进程表**：死了就把日志尾巴读出来，
 * 连同原因一起交回给人。
 *
 * @returns 监督进程 pid；拉不起来/秒退返回 `ok: false`（调用方据此告知人：没在后台跑）
 */
export async function spawnSupervisor(args: SupervisorArgs): Promise<SupervisorLaunch> {
  const entry = supervisorEntryPath();
  if (!existsSync(entry)) {
    return { ok: false, reason: `监督进程入口不存在：${entry}` };
  }

  const projectRoot = resolve(args.projectRoot);
  const logPath = supervisorLogPath(projectRoot, args.taskId);
  mkdirSync(dirname(logPath), { recursive: true });
  // 先把日志文件建出来 —— 监督进程万一秒退，现场也留得下一行。
  try {
    appendFileSync(logPath, '', 'utf-8');
  } catch {
    /* 建不出来就算了 */
  }

  const argv = [
    entry,
    '--project-root', projectRoot,
    '--task-id', args.taskId,
    '--slice-id', args.sliceId,
    '--session-id', args.sessionId,
    '--agent-command', args.agentCommand,
    '--work-dir', resolve(args.workDir),
    '--timeout-ms', String(args.timeoutMs),
    '--log-file', logPath,
  ];
  if (args.isHotfix) argv.push('--hotfix');
  if (args.adapterType) argv.push('--adapter-type', args.adapterType);

  let childPid: number | null = null;
  try {
    const child = spawn(process.execPath, argv, {
      cwd: projectRoot,
      detached: true,
      windowsHide: true,
      // stdout/stderr **不用管道** —— 管道的一头在这个主进程身上，
      // 主进程一退出，管道就断了：子进程写日志会 EPIPE，日志只剩半截。
      // 所以让监督进程**自己**往日志文件写（--log-file），这里直接 ignore。
      stdio: 'ignore',
      env: { ...process.env },
    });

    // 不等它退出 —— 主进程马上就退。
    child.unref();
    childPid = child.pid ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `监督进程启动失败：${message}` };
  }

  if (childPid === null) {
    return { ok: false, reason: '监督进程启动失败：拿不到 pid' };
  }

  // ── 启动存活确认 ────────────────────────────────────────────────────────
  //
  // 给它一点时间把日志头写出来（哪怕它下一秒就死），再查一次进程表。
  // 1.2s 是实测值：参数解析失败是**同步**的（进程一起来就退），
  // 正常的监督进程启动后要几十毫秒才走到「起 agent」，不会在这段时间里退。
  await sleep(1200);

  const { isProcessAlive } = await import('../../core/sched/index.js');
  if (!isProcessAlive(childPid)) {
    const tail = readLogTail(logPath, 12);
    return {
      ok: false,
      reason: tail
        ? `监督进程启动后立刻退出（pid ${childPid}）。日志：\n${tail}`
        : `监督进程启动后立刻退出（pid ${childPid}），且日志为空`,
    };
  }

  return { ok: true, pid: childPid };
}

/** 读日志文件的最后几行（给「启动后立刻退出」这类场景留现场）。 */
function readLogTail(logPath: string, lines: number): string {
  try {
    const text = readFileSync(logPath, 'utf-8');
    const all = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return all.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * 监督进程的可执行入口（dist/cli/commands/supervisor-entry.js）。
 *
 * 从当前模块位置推导：dist/cli/commands → dist/cli/commands/supervisor-entry.js。
 * 找不到就退回 <cwd>/dist/cli/commands/supervisor-entry.js。
 */
export function supervisorEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, 'supervisor-entry.js'),
    resolve(process.cwd(), 'dist', 'cli', 'commands', 'supervisor-entry.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1];
}

/** 解析监督进程的命令行参数。 */
export function parseSupervisorArgs(argv: string[]): SupervisorArgs | null {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const projectRoot = get('--project-root');
  const taskId = get('--task-id');
  const sliceId = get('--slice-id');
  // `--session-id` **可以为空**（D-53）：detach 模式下主进程不起 agent，
  // 会话 id 是监督进程起 agent 之后才有的。之前这里用 `!sessionId` 判空，
  // 空串被判成「参数不完整」→ 监督进程打印一行就退出（退出码 2）→
  // 主进程却已经报「已在后台跑」→ **一个 agent 都没起，却显示 running**。
  // 空串是合法值（占位），只有「参数根本没给」才是错误。
  const sessionId = get('--session-id');
  const agentCommand = get('--agent-command');
  const workDir = get('--work-dir');
  const timeoutMs = get('--timeout-ms');
  if (!projectRoot || !taskId || !sliceId || sessionId === undefined ||
      !agentCommand || !workDir) {
    return null;
  }
  return {
    projectRoot: resolve(projectRoot),
    taskId,
    sliceId,
    sessionId,
    agentCommand,
    workDir: resolve(workDir),
    timeoutMs: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 1_800_000,
    isHotfix: argv.includes('--hotfix'),
    logFile: get('--log-file'),
    adapterType: get('--adapter-type'),
  };
}

// ─── 监督进程的运行时 ────────────────────────────────────────────────────────

/**
 * 监督进程的主体。
 *
 * 三段：
 *   1. **起 agent**（适配器住在这里 → 退出码拿得到）
 *   2. **等 agent 退出**
 *   3. **写收尾**（共用 run-finish.ts 的流水线 —— 与前台跑同一条路）
 *
 * @returns 进程退出码（0 = agent 成功）
 */
export async function runSupervisor(args: SupervisorArgs): Promise<number> {
  const log = makeLogger(args.logFile);
  const startedAt = Date.now();

  log(`监督进程启动 pid=${process.pid} task=${args.taskId} slice=${args.sliceId}`);

  // ── 1. 起 agent ────────────────────────────────────────────────────────
  //
  // 适配器必须住在这个进程里：它负责写会话文件的 `exitCode` 与 `status`。
  // 主进程一退就没人记录了（见文件头的说明）。
  const { createExecutorAdapter, store, events } = await import('./shared.js');
  const adapter = createExecutorAdapter(
    args.adapterType,
    args.agentCommand,
    Math.floor(args.timeoutMs / 1000),
    args.workDir,
  );

  let sessionId = args.sessionId;
  let exitCode: number | null = null;
  let guard: import('./runtime-guard.js').RuntimeGuard | null = null;

  try {
    // 写集预约 + PreToolUse 钩子（C9）
    //
    // 预约与钩子装在这里（而不是主进程）：守卫要在 agent 跑的那段时间里
    // 一直有效，而释放它的是这个进程 —— 谁装谁放，才不会漏。
    const { installRuntimeGuard } = await import('./runtime-guard.js');
    const slice = await store.read(args.sliceId).catch(() => null);
    const bundlePath = join(args.projectRoot, '.zelto', `${args.sliceId}-bundle.json`);
    guard = await installRuntimeGuard({
      sliceId: args.sliceId,
      writes: slice?.writes ?? [],
      worktree: args.workDir === args.projectRoot ? null : args.workDir,
      projectRoot: args.projectRoot,
      baseCommit: slice?.baseCommit ?? null,
    });
    log(`写集预约已取得：${(slice?.writes ?? []).join(', ') || '(空)'}`);

    // 起 agent
    const started = await adapter.start({ sliceId: args.sliceId, prompt: bundlePath });
    sessionId = started.sessionId;
    log(`agent 已启动 session=${sessionId}`);

    // 把会话 id 写回任务文件 —— 界面上的「Session」这一栏要能看到真的那一个，
    // 否则人看到的还是主进程留的空占位（D-53）。
    //
    // 用 `patchTask` 而不是 `saveTask`：主进程在存活确认之后还会 saveTask 一次
    // （它手里那份还没有 sessionId），整份覆盖会把这里写的值冲掉（D-53）。
    try {
      patchTask(args.taskId, {
        sessionId,
        lastActivityAt: new Date().toISOString(),
      });
    } catch { /* 写不回去不影响运行 */ }

    await events.append(args.sliceId, 'run.started', 'zelto', {
      sliceId: args.sliceId,
      agent: args.agentCommand,
      bundlePath,
      writes: slice?.writes ?? [],
      worktree: args.workDir,
      supervisor: true,
    });

    // ── 2. 等 agent 退出（带重试/续跑回路，D-54）─────────────────────────
    //
    // 为什么监督进程也要有重试回路（前台路径本来就有）：
    //
    //   实测（nimrtc-zelto v2-qoe-feed，2026-11-17）：agent 跑了满 1800s
    //   超时被砍，但**超时前 30 秒还在改文件** —— 也就是说它不是「做不完」，
    //   是「做得完但没做完」。前台路径遇到这种情况会：
    //     1. 自动重试一次（`handleAgentFailure`）；
    //     2. 用 `--resume` **续上同一个 agent 会话**，让它接着做
    //        （`resumeForRetry`）—— 不从头重做已经做完的事。
    //
    //   监督进程原先**没有**这两步 —— agent 一挂就直接收尾停机。
    //   后果：detach 路径比前台路径更容易失败（一个环境抖动就废掉一轮
    //   半小时的 agent 工作），而且「能续就续」的策略在 detach 下完全失效。
    //
    // 所以这里补上前台路径同款的回路。两边的重试预算读的是同一个地方
    // （切片文件的 `stall.autoResolved`），不会各自算各自的。
    // 重试预算与前台路径同口径（`handleAgentFailure` 默认 2 次）。
    // 它读的是切片文件的 `stall.autoResolved` —— 两条路径共用一份账，
    // 不会各自算各自的。
    const maxRetries = 2;
    let attempt = 0;
    let alreadyStalled = false;

    for (;;) {
      exitCode = await waitForAgentExit(args, sessionId, log);
      if (exitCode === 0) break;

      // 只有「可自动恢复」的停机类别才值得重试（环境抖动、上下文超限…）。
      // agent 主动报错、预算耗尽这类重试也白搭。
      const { classifyStall, isAutoResolvable } = await import('../../core/stall/classifier.js');
      const { handleAgentFailure } = await import('./run-support.js');
      const stallClass = classifyStall({
        type: exitCode === null ? 'build_failure' : 'test_failure',
        message: `Agent exited with code ${exitCode ?? 'signal'}`,
        attempts: 1,
      });

      if (attempt >= maxRetries || !isAutoResolvable(stallClass)) {
        // 重试预算用尽 / 不可自动恢复 → 交回给人（收尾里会停机）
        break;
      }

      attempt += 1;
      const failure = await handleAgentFailure(args.sliceId, exitCode, { maxRetries });
      if (failure.action !== 'retry') {
        // `handleAgentFailure` 已经停机了（重试预算耗尽）——
        // 收尾时不要再停一次（ADR-047 §2.1.1）
        alreadyStalled = true;
        break;
      }
      log(`第 ${attempt} 次重试（上一轮退出码 ${exitCode}，类别 ${stallClass}）`);

      // 续跑优先：同一个 agent 会话接着做，不从头再来（ADR-055）
      const resumed = await resumeAgentSession(adapter, sessionId, args.sliceId, log);
      if (resumed) {
        sessionId = resumed;
      } else {
        const started = await adapter.start({
          sliceId: args.sliceId,
          prompt: bundlePath,
        });
        sessionId = started.sessionId;
        log(`agent 重新启动 session=${sessionId}`);
      }
      patchTask(args.taskId, { sessionId, lastActivityAt: new Date().toISOString() });
    }

    // ── 3. 写收尾 ─────────────────────────────────────────────────────────
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    const { finishRun } = await import('./run-finish.js');
    const result = await finishRun({
      sliceId: args.sliceId,
      sessionId,
      exitCode,
      elapsedSec,
      guard,
      adapter,
      isHotfix: args.isHotfix,
      alreadyStalled,
      write: log,
    });
    log(`收尾完成：ok=${result.ok} state=${result.state} violated=${result.violated}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`监督进程异常：${message}`);
    try {
      await events.append(args.sliceId, 'run.aborted', 'zelto', {
        sliceId: args.sliceId,
        reason: `supervisor failed: ${message}`,
        supervisor: true,
      });
    } catch { /* 连事件都写不上就算了 */ }
  } finally {
    // ── 释放写集预约 + 撤钩子 ────────────────────────────────────────────
    //
    // 预约不释放 → 下一片撞写集冲突 → 整个队列卡住。
    // 钩子也要摘掉：留在 worktree 里的话，agent 原样再起时会被一个
    // 指向死进程的钩子挡住每一次写。
    if (guard) {
      try {
        await guard.release();
        log('写集预约已释放');
      } catch {
        /* 释放失败不阻断 —— 残留的预约会被 `zelto reservation reap` 清理 */
      }
    }

    // 任务文件收尾 —— 这是界面上最先看到的那条事实
    //
    // 用 `patchTask`：主进程与监督进程共享同一个任务文件（D-53），
    // 整份覆盖会互相冲掉对方写的字段。
    const completedAt = new Date().toISOString();
    patchTask(args.taskId, {
      status: exitCode === 0 ? 'completed' : 'failed',
      exitCode: exitCode ?? undefined,
      elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
      completedAt,
      lastActivityAt: completedAt,
    });
  }

  log(`监督进程退出，agent 退出码 ${exitCode ?? 'signal'}`);
  return exitCode === 0 ? 0 : 1;
}

/**
 * 等 agent 进程退出，返回它的退出码。
 *
 * 判据：**进程表**（不是会话文件）。
 *
 * 为什么不能只看会话文件：会话文件里的 `status` 是适配器写的。
 * 适配器在这个进程里，所以它写得到 —— 但**写与不写之间有竞态**：
 * 进程刚退出时状态可能还没落盘。所以这里以进程表为主判据，
 * 落盘的状态只用来取退出码。
 *
 * 退出码怎么拿：适配器 `handleExit` 会把退出码写进会话文件。
 * 这里等它落盘（给宽限），拿不到就报 `null`（= 非正常退出），
 * 让人知道「结果不明」，而不是编一个 0 或 1 出来。
 */
async function waitForAgentExit(
  args: SupervisorArgs,
  sessionId: string,
  log: (line: string) => void,
): Promise<number | null> {
  const { readSessionLiveness } = await import('../../core/activity/index.js');
  const { isProcessAlive, isProcessTreeAlive } = await import('../../core/sched/index.js');

  const deadline = Date.now() + args.timeoutMs + 60_000;
  let goneSince: number | null = null;

  while (Date.now() < deadline) {
    const rec = readSessionLiveness(args.projectRoot, sessionId);
    const pids = [
      rec?.agentPid,
      rec?.pid,
    ].filter((p): p is number => typeof p === 'number' && p > 0);

    let alive = false;
    for (const pid of pids) {
      if (isProcessAlive(pid)) {
        alive = true;
        break;
      }
      // 包装进程没了但树里还有活着的后代 → agent 还在跑
      if (await isProcessTreeAlive(pid)) {
        alive = true;
        break;
      }
    }

    if (alive) {
      goneSince = null;
      await sleep(3000);
      continue;
    }

    if (pids.length === 0) {
      // 连 pid 都没有 —— 会话文件还没落盘（或已被清掉）。
      await sleep(2000);
      continue;
    }

    // 进程确实没了。给一点宽限（会话文件落盘有延迟），再判一次。
    if (goneSince === null) {
      goneSince = Date.now();
      await sleep(3000);
      continue;
    }
    if (Date.now() - goneSince >= 3000) break;
  }

  // 退出码：从会话文件取（适配器写的）
  const rec = readSessionLiveness(args.projectRoot, sessionId);
  if (rec && (rec.status === 'completed' || rec.status === 'failed' || rec.status === 'timeout')) {
    log(`agent 已退出，退出码 ${rec.exitCode ?? 'null'}（会话状态 ${rec.status}）`);
    return typeof rec.exitCode === 'number' ? rec.exitCode : null;
  }
  log('agent 已退出，但会话文件里没有退出码 —— 结果不明，按失败处理');
  return null;
}

/**
 * 续上同一个 agent 会话（ADR-055）。
 *
 * **能续就续**：agent 跑超时被杀掉时，它做掉的工作都留在 worktree 里了 ——
 * 代码改了一半、上下文摸清了一半。从头再跑等于把这些工作重做一遍，
 * 还把 agent 的上下文清零，让它重新摸索已经摸清的东西。
 *
 * 续不了（适配器不支持 resume / 没有会话 id）返回 null —— 调用方退回从头跑。
 */
async function resumeAgentSession(
  adapter: import('../../core/ports/executor.js').ExecutorAdapter,
  previousSessionId: string,
  sliceId: string,
  log: (line: string) => void,
): Promise<string | null> {
  if (!adapter.metadata.capabilities.resume) return null;
  if (typeof adapter.continueSession !== 'function') return null;
  if (!previousSessionId) return null;

  try {
    const { sessionId } = await adapter.continueSession(
      previousSessionId,
      '继续完成这个切片。上一次运行超时被中止了，' +
      '工作区里已经有你之前做出的改动 —— 先检查当前状态，' +
      '补完没做完的部分，不要从头重做已经做完的事。',
    );
    log(`↻ 续上同一个 agent 会话（${sliceId}）session=${sessionId}`);
    return sessionId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`续跑失败（${message}）—— 退回从头跑`);
    return null;
  }
}

/** 往日志文件追加一行（失败静默 —— 少了日志只是排查变难）。 */
function makeLogger(logFile?: string): (line: string) => void {
  return (line: string) => {
    if (!logFile) return;
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`, 'utf-8');
    } catch {
      /* 日志落不了盘就算了 */
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 监督进程的任务文件类型（供外部引用，避免重复定义）。 */
export type { TaskInfo };
