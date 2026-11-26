// Gate executor — runs configured commands and records results
// See docs/zelto-技术架构.md §6.1
// C3: deterministic only — no model calls, no network

import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { GateConfig, GateCommand, GateResult, GateReport, GateScopeFacts, SliceType, AcceptanceOutcome } from './types.js';
import { detectSliceType, orderGateCommands } from './types.js';
import {
  extractGateFailures,
  narrowCtestCommandByFile,
  resolveCtestManifestPlacement,
  verifyNarrowedTestsRan,
  writeCtestManifestFile,
  GATE_NARROWING_MANIFEST_PREFIX,
  sanitizeForFilename,
} from './diagnostics.js';
import {
  buildCtestEnumerateCommand,
  buildScopeManifestContent,
  matchScopeLabels,
  resolveScope,
  scopeManifestFile,
  selectScopedTestNames,
  type ScopeConfig,
  type ScopeMatch,
} from './scope.js';

// 路径匹配走 core/pathspec 的单一实现（与 sched 准入层、arch 层同源），
// 不再经 sched —— gate 不依赖调度器。
import { pathMatches } from '../pathspec/index.js';
import {
  DEFAULT_ACCEPTANCE_BUILD_DIR,
  DEFAULT_ACCEPTANCE_COMMAND,
  buildAcceptanceCommand,
  classifyAcceptanceFailure,
  missingTargetOutcome,
  parseTestRunnerStats,
  resolveAcceptance,
  verifyAcceptanceRanTests,
} from './acceptance.js';
import type { SliceData, SliceStore } from '../slice/store.js';
import type { EventStream, EventType } from '../events/stream.js';

/**
 * 把清单文件写到**它该在的地方**，必要时先建出那个目录。
 *
 * 落点由 `resolveCtestManifestPlacement` 决定（跟着 `--test-dir` 走）——
 * 见该函数的注释：ctest 是相对 `--test-dir` 解析 `--tests-from-file` 的。
 *
 * 实现放在 `diagnostics.ts` —— 与 `lifecycle/gate.ts` 共用**同一份**，
 * 不两处各写一份（ADR-106 §5 的教训：同一个问题两处判定，必然走偏）。
 */
async function writeManifestFile(
  absolutePath: string,
  content: string,
): Promise<boolean> {
  return writeCtestManifestFile(absolutePath, content);
}

/**
 * 跑一条命令。
 *
 * `stripTestContext` 用来防止「假绿」：当这段代码自己跑在 `node --test`
 * 里面时，`NODE_TEST_CONTEXT=child-v8` 会被子进程继承。子进程看到它就认为
 * 「我已经是测试子进程了」，于是**跳过所有用例直接 exit 0** ——
 * 门禁于是把「一个测试都没跑」当成「测试全过」（ADR-033）。
 *
 * 验收命令必须真跑，所以这个变量要摘掉。
 */
/**
 * 杀掉门禁的整棵命令树（超时用）。
 *
 * 病灶（实测 2026-11-26，`npm test` 全量里偶发，一次 `EPERM` 一次「57s 才报错」）：
 * 门禁命令是 `shell: true` 拉起的 —— 超时后只杀外壳，里面的 `node --test ...`
 * **继续跑**：
 *
 *   - 占着临时目录里的文件 → 紧接着的 `rmSync` 变成 `EPERM`；
 *   - 自己的结果继续写出来 → 混进**本轮**的测试报告（实测冒出一行 `?? tests 3xxx`）；
 *   - 外壳一死，内层就成了孤儿 —— 按「父进程树」找它已经找不到了。
 *
 * Windows：`taskkill /T /F` 按父子树杀。这一步必须赶在 `abort()` 之前 ——
 * abort 先打内层，内层一死外壳跟着退，树就散了。
 *
 * POSIX：spawn 时 `detached: true` 自成一个进程组，`kill(-pid)` 整组带走；
 * 组已不存在就退回单杀。
 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32') {
    if (child.pid === undefined) return;
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 15_000,
      });
    } catch {
      /* 树已经没了 */
    }
    return;
  }
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, 'SIGKILL');
      return;
    }
  } catch {
    /* 组已经不在了 */
  }
  child.kill('SIGKILL');
}

/**
 * `taskkill /T /F` 返回之后，树**还可能没死透**（ZD-062 第二次实测）。
 *
 * 病灶（2026-11-26，一次后台 `npm test` 全量，386 秒后红在 `after` 钩子）：
 * 超时杀树、命令 close 都发生了，用例的 `after` 在 `rmSync` 上照样 `EPERM`
 * ——「孙子已死」的断言过不了，宽限 15 秒也一样。
 *
 * 成因不止一种可能（杀树落空 / `taskkill` 对外壳报了错但内层还在 / 句柄
 * 晚于进程退出才松开），所以这里不再猜「是哪一种」，而是加一道**幂等兜底**：
 *
 * 1. 有孙子 pid（命令自己落盘的）→ 再按树强杀一次；
 * 2. 外壳还没 close → 再补一次 `taskkill /T`；
 * 3. **等命令真的 close 再 abort** —— 调用方 `close` 处理完、用例拿到
 *    结果时，进程树已经不在写盘了。
 *
 * 孙子 pid 从 `grandchildPidFile`（`GateConfig.grandchildPidFile`）读：
 * 这是给**测试**验 ZD-062 用的口子 —— 生产配置不写它，行为零变化。
 */
function hardenTreeKill(child: ChildProcess, grandchildPidFile?: string): Promise<void> {
  return new Promise((resolvePromise) => {
    let grandchild = 0;
    if (grandchildPidFile) {
      try {
        grandchild = Number(readFileSync(grandchildPidFile, 'utf-8').trim());
      } catch {
        /* 命令还没写，或压根没这个文件 */
      }
    }
    if (grandchild > 0) {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/pid', String(grandchild), '/T', '/F'], {
            stdio: 'ignore',
            timeout: 15_000,
          });
        } else {
          process.kill(grandchild, 'SIGKILL');
        }
      } catch {
        /* 已经没了 */
      }
    }

    // 外壳还没 close → 补一次按树杀（此时它已经带着子进程树；没配
    // 孙子 pid 时为**唯一**的兜底）。
    if (
      child.exitCode === null &&
      child.signalCode === null &&
      child.pid !== undefined &&
      process.platform === 'win32'
    ) {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          timeout: 15_000,
        });
      } catch {
        /* 外壳早没了 */
      }
    }

    // 等命令真的 close（exitCode / signalCode 落定）。只等「死透」，
    // 不重复处理输出 —— 输出仍由 close / error 处理。
    const deadline = Date.now() + 30_000;
    const poll = (): void => {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        resolvePromise();
        return;
      }
      if (Date.now() >= deadline) {
        resolvePromise();
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}


function runCommand(
  cmd: GateCommand,
  timeoutSec: number,
  cwd: string,
  options: { stripTestContext?: boolean; grandchildPidFile?: string } = {},
): Promise<GateResult> {
  return new Promise((resolvePromise) => {
    const start = performance.now();
    // Use shell: true with the full command as a single string
    // to avoid the deprecation warning about args with shell
    const ac = new AbortController();
    const env = { ...process.env };
    if (options.stripTestContext) {
      delete env.NODE_TEST_CONTEXT;
    }
    const child = spawn(cmd.run || cmd.name, [], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      signal: ac.signal,
      env,
      // POSIX：自成一个进程组，超时才能按组杀（内层孤儿一起带走）。
      // Windows 不用这个字段（`taskkill /T` 按父子树杀）。
      detached: process.platform !== 'win32',
    });

    const timer = setTimeout(() => {
      // 先按树杀，再 abort —— 顺序反了，内层先死、外壳跟着退，
      // `taskkill /T` 就只看到「进程不存在」，内层成了孤儿（实测）。
      killTree(child);
      // 杀树之后还要兜底：确认孙子真的死了、命令真的 close，再 abort。
      void hardenTreeKill(child, options.grandchildPidFile).then(() => ac.abort());
    }, timeoutSec * 1000);

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const durationMs = performance.now() - start;
      resolvePromise({
        command: cmd.name,
        passed: exitCode === 0,
        exitCode,
        stdout,
        stderr,
        durationMs,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const durationMs = performance.now() - start;
      resolvePromise({
        command: cmd.name,
        passed: false,
        exitCode: null,
        stdout,
        stderr: err.message,
        durationMs,
      });
    });
  });
}

/**
 * 给一条**失败**的 GateResult 补上失败用例摘要（ZD-027）。
 *
 * 不改变 passed / exitCode / durationMs —— 只加诊断字段 `failures` /
 * `reportedFailureCount` / `runner`，供事件留痕与反馈呈现使用。
 * 纯计算（读 stdout+stderr 字符串），判定确定性不受影响（C3）。
 */
function enrichFailureDiagnostics(result: GateResult): GateResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  const extraction = extractGateFailures(combined);
  return {
    ...result,
    failures: extraction.failures,
    reportedFailureCount: extraction.reportedFailureCount,
    runner: extraction.runner,
  };
}

export class GateExecutor {
  private readonly store: SliceStore;
  private readonly events: EventStream;
  private readonly config: GateConfig;
  private readonly projectRoot: string;

  constructor(
    store: SliceStore,
    events: EventStream,
    config: GateConfig,
    projectRoot: string = process.cwd(),
  ) {
    this.store = store;
    this.events = events;
    this.config = config;
    this.projectRoot = projectRoot;
  }

  /**
   * 跑门禁命令。
   *
   * @param sliceId 切片 id
   * @param actor 谁触发的（判定产物一律用 'zelto'）
   * @param options.via 在哪儿触发的（'cli' / 'web'）——
   *   记进 `gate.executed` / `gate.result` 的 payload，
   *   让追溯链能回答「这次门禁是从哪儿点的」。
   *
   *   **为什么是同一条事件的一个维度，而不是另写一条**：
   *   `rework_rate` 的算法是「`gate.retry` 条数 ÷ `gate.executed` 条数」
   *   —— 多写一条 `gate.executed` 会把这个比值直接砍半，
   *   度量从此失真（ADR-086 §6）。
   */
  async execute(
    sliceId: string,
    actor: string = 'zelto',
    options: { via?: string } = {},
  ): Promise<GateReport> {
    const slice = await this.store.read(sliceId);
    const via = options.via;
    const totalStart = performance.now();
    const results: GateResult[] = [];
    let passed = true;
    let totalRetries = 0;

    // Select gate commands based on slice type
    const sliceType: SliceType = slice.type ?? detectSliceType(slice.writes);
    // 本片专属命令优先（ADR-051）：不同模块的测试目标名不同，
    // 项目级命令去构建别的模块的目标，既不验本片产物又白等一次构建。
    const sliceCommands = slice.spec?.gateCommands;
    const selected = sliceCommands && sliceCommands.length > 0
      ? sliceCommands
      : this.selectCommands(sliceType);
    // 按阶段排序（ZD-009）：configure → build → test。
    //
    // 排序是**稳定**的，且没写 `phase` 的命令全落在 `default` 阶段
    // —— 所以老配置的顺序**完全不变**（零行为变化）。
    const commands = orderGateCommands(selected);

    // ── 门禁作用域（ADR-097）────────────────────────────────────────
    //
    // 按切片的**写集**收窄「跑哪些用例」：写集命中 `gate.scope` 的规则时，
    // 只跑带对应 CTest 标签的用例。
    //
    // **收窄不可用时一律退回全量** —— 宁可慢，不漏验：
    // - 没配 `gate.scope` → 全量（老行为，零变化）；
    // - 写集没命中任何规则 → 全量；
    // - 认不出 ctest 命令 / 枚举失败 / 标签没匹配到用例 → 全量。
    //
    // **假绿是这里最危险的失败模式**：ctest 在「没匹配到用例」时退出码是
    // 0（ADR-096 实测）—— 所以「标签没匹配到用例」必须**判失败**而不是
    // 判通过。收窄跑完后还要用 `verifyNarrowedTestsRan` 验真。
    const scope = await this.resolveScope(slice);
    const scoped = await this.applyScope(slice, commands, scope);
    const scopedCommands = scoped.commands;
    const scopeManifestPaths = scoped.manifestPaths;

    // Log profile selection
    await this.appendEvent(sliceId, 'gate.executed', actor, {
      sliceId,
      sliceType,
      commandCount: scopedCommands.length,
      // 比较的是 `selected`（排序**前**的数组）—— 排序后 commands 一定是
      // 一个新数组，拿它跟 `this.config.commands` 比永远不相等。
      profile: sliceCommands && sliceCommands.length > 0
        ? 'slice-specific'
        : selected === this.config.commands ? 'default' : sliceType,
      // 作用域留痕（ADR-097 决策五）—— 门禁过了到底意味着什么，
      // 人必须看得见。缺了这几条，收窄就成了「悄悄降级的门禁」。
      ...(scope.source === 'config'
        ? {
            scoped: true,
            scopeLabels: scope.labels,
            scopeSource: scope.source,
          }
        : {
            scoped: false,
            scopeSource: scope.source,
            scopeReason: scope.reason,
          }),
      ...(scoped.testCount !== null ? { scopeTestCount: scoped.testCount } : {}),
      ...(scoped.totalTestCount !== null ? { scopeTotalTestCount: scoped.totalTestCount } : {}),
      ...(via ? { via } : {}),
    });

    // Check for uninitialized git submodules before running commands
    //
    // `gate.submoduleCheck: false` 可以关掉这道预检 —— 它只检查「目录为空」，
    // 而「子模块 pin 被本地改动弄脏」这类环境噪声也会让 `git status` 报警，
    // 在那些项目里预检拦下的是噪声而不是问题（构建本身会发现真缺的头文件）。
    const submoduleIssue =
      this.config.submoduleCheck === false ? null : await this.checkSubmodules();
    if (submoduleIssue) {
      // Log as gate failure with a synthetic result
      results.push({
        command: 'submodule-check',
        passed: false,
        exitCode: 1,
        stdout: '',
        stderr: submoduleIssue,
        durationMs: 0,
      });
      passed = false;

      await this.appendEvent(sliceId, 'gate.result', actor, {
        sliceId,
        passed: false,
        results: [{ command: 'submodule-check', passed: false, exitCode: 1, stderr: submoduleIssue }],
        retryCount: 0,
        totalDurationMs: 0,
        ...(via ? { via } : {}),
      });

      return {
        sliceId,
        passed: false,
        results,
        retryCount: 0,
        totalDurationMs: 0,
      };
    }

    try {
      // 作用域收窄失败（标签一个都没匹配到）→ 那条 ctest 命令**不跑**，
      // 门禁直接判失败。
      //
      // 为什么「不跑」而不是「跑完再看」：跑 0 个用例的 ctest 退出码是 **0** ——
      // 那是假绿。跑它等于白跑一趟还拿到一个假的「通过」。
      if (scoped.scopeFailure) {
        results.push({
          command: scoped.scopeFailure.command,
          passed: false,
          exitCode: 1,
          stdout: '',
          stderr: scoped.scopeFailure.reason,
          durationMs: 0,
        });
        passed = false;
      } else {
        for (const cmd of scopedCommands) {
          const { result, retries } = await this.runWithRetry(
            cmd,
            slice,
            actor,
            scoped.expectedTests,
          );
          results.push(result);
          totalRetries += retries;
          if (!result.passed) {
            passed = false;
          }
        }
      }
    } finally {
      // 作用域清单跑完就删 —— **不管走哪条出口**都要删（不留垃圾）。
      // 与 ADR-096 的重试清单同理：清单文件是工作目录里的临时产物。
      //
      // 删的是**实际落点**（可能在 `--test-dir` 指向的目录里），
      // 不是想当然的工作目录根 —— 2026-11-25 nimrtc 实测踩过这个坑。
      await Promise.all(
        scopeManifestPaths.map((p) => rm(p, { force: true }).catch(() => {})),
      );
    }

    // ── 切片级验收（ADR-033）────────────────────────────────────────
    // 这一步回答的是「这片东西自己有没有被验证过」，与全项目命令是两件事。
    // 没配 gate.acceptance 时显式记为 skipped（不是静默跳过）。
    // 配了之后 fail closed：跑不起来就是 failed，不是 skipped
    // （除非显式声明 required:false）。
    const acceptance = await this.runAcceptance(slice, actor);
    if (acceptance.status === 'failed') {
      passed = false;
    }

    const totalDurationMs = performance.now() - totalStart;

    await this.appendEvent(sliceId, 'gate.result', actor, {
      sliceId,
      passed,
      results: results.map((r) => ({
        command: r.command,
        passed: r.passed,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        stderr: r.stderr ? r.stderr.slice(0, 2000) : null, // Include stderr (truncated) for failure detail
        // ZD-027：stdout 只截**头** 500 字符会丢掉失败用例（它们在中间段）。
        // 失败时改存**尾部**（断言通常在末尾），通过的命令仍存头部（有上下文）。
        // 结构化的失败清单另存 `failures`，比裸 stdout 更精准。
        stdout: r.stdout
          ? (r.passed ? r.stdout.slice(0, 500) : r.stdout.slice(-2000))
          : null,
        // 失败用例摘要（只有失败命令才有；通过的命令为 undefined —— 不占事件体积）
        ...(r.failures && r.failures.length > 0 ? { failures: r.failures } : {}),
        ...(r.reportedFailureCount !== undefined ? { reportedFailureCount: r.reportedFailureCount } : {}),
        ...(r.runner ? { runner: r.runner } : {}),
      })),
      retryCount: totalRetries,
      totalDurationMs,
      acceptance,
      // 作用域留痕（ADR-097 决策五）—— 与 gate.executed 同一口径。
      ...(scope.source === 'config'
        ? {
            scoped: true,
            scopeLabels: scope.labels,
            scopeSource: scope.source,
          }
        : {
            scoped: false,
            scopeSource: scope.source,
            scopeReason: scope.reason,
          }),
      ...(scoped.testCount !== null ? { scopeTestCount: scoped.testCount } : {}),
      ...(scoped.totalTestCount !== null ? { scopeTotalTestCount: scoped.totalTestCount } : {}),
      ...(via ? { via } : {}),
    });

    const scopeFacts: GateScopeFacts = {
      scoped: scope.source === 'config',
      labels: scope.labels,
      source: scope.source,
      reason: scope.reason,
      testCount: scoped.testCount,
      totalTestCount: scoped.totalTestCount,
    };

    return {
      sliceId,
      passed,
      results,
      retryCount: totalRetries,
      totalDurationMs,
      acceptance,
      scope: scopeFacts,
    };
  }

  /**
   * 跑本片的验收测试（ADR-033）。
   *
   * 判定完全确定：只看「目标找没找到」「命令跑没跑成功」，不看内容语义。
   *
   * 三种结论：
   * - `skipped`：没配 `gate.acceptance`（人还没决定要用切片级验收），
   *   或者配了但声明 `required: false` 且本片没有验收目标；
   * - `failed`：配了验收但没有验收目标、命令跑不起来、命令跑了但失败；
   * - `passed`：命令跑成功。
   *
   * 「没配」不等于「没问题」—— 所以它会被显式记下来，不会静默跳过。
   */
  private async runAcceptance(slice: SliceData, actor: string): Promise<AcceptanceOutcome> {
    const cfg = this.config.acceptance;

    // 没配切片级验收：显式记 skipped，不影响门禁结论。
    if (!cfg) {
      return {
        status: 'skipped',
        path: null,
        command: null,
        reason: '未配置切片级验收（config.yaml 的 gate.acceptance 段）',
        exitCode: null,
        durationMs: 0,
      };
    }

    const commandTemplate = cfg.command.trim() || DEFAULT_ACCEPTANCE_COMMAND;
    const required = cfg.required ?? true;
    const buildDir = cfg.buildDir ?? DEFAULT_ACCEPTANCE_BUILD_DIR;

    const resolution = resolveAcceptance(slice.acceptance?.dir, this.projectRoot, buildDir);

    if (!resolution.target) {
      const reason = resolution.reason ?? '本片没有登记验收目标';
      const outcome = missingTargetOutcome(required, reason, commandTemplate);
      await this.appendEvent(slice.id, 'gate.result', actor, {
        sliceId: slice.id,
        passed: false,
        acceptance: outcome,
        note: '切片级验收未执行',
      });
      return outcome;
    }

    const target = resolution.target;
    const command = buildAcceptanceCommand(commandTemplate, target.files);
    const timeoutSec = cfg?.timeoutSec ?? this.config.timeoutSec;
    const result = await runCommand(
      { name: 'acceptance', run: command },
      timeoutSec,
      this.projectRoot,
      // 验收命令必须是一个**真正跑测试**的进程，不能继承测试运行器的环境标记。
      // `NODE_TEST_CONTEXT=child-v8` 会被 node --test 继承成「我是测试子进程」，
      // 于是它跳过所有用例直接 exit 0 —— 门禁于是「假绿」（ADR-033）。
      { stripTestContext: true },
    );

    const outcome: AcceptanceOutcome = {
      status: result.passed ? 'passed' : 'failed',
      path: target.path,
      command,
      ...(result.passed ? {} : { reason: result.stderr.slice(0, 2000) || result.stdout.slice(0, 2000) || '验收命令失败' }),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      files: target.files,
    };

    // 退出码 0 不等于「验收通过」：全是 todo/skip 的验收文件也会退出 0
    // （ADR-034 的验收骨架就是这么写的）。这里补一层「真跑过用例」的判定。
    const stats = parseTestRunnerStats(`${result.stdout}\n${result.stderr}`);
    if (outcome.status === 'passed') {
      const verdict = verifyAcceptanceRanTests(stats);
      if (!verdict.ok && verdict.reason) {
        outcome.status = 'failed';
        // D-8：把失败类别写进 reason —— 「没写断言」与「断言写错了」
        // 的修法完全不同（前者要写测试，后者要改实现）。
        const label =
          verdict.kind === 'no-assertions'
            ? '验收文件里全是 test.todo 占位符 —— 一条断言都没写'
            : verdict.kind === 'all-skipped'
              ? '验收用例全部被跳过 —— 一条断言都没执行'
              : '验收文件是空的 —— 一条断言都没有';
        outcome.reason = `【${label}】\n${verdict.reason}`;
      }
    } else {
      // D-8：命令失败也要分类 —— 「断言不成立」与「命令跑不起来」
      // 指向完全不同的排查方向。
      const failure = classifyAcceptanceFailure(stats);
      const detail = outcome.reason ?? '';
      outcome.reason = `【${failure.label}】\n${detail}`;
    }

    await this.appendEvent(slice.id, 'gate.result', actor, {
      sliceId: slice.id,
      passed: outcome.status === 'passed',
      acceptance: outcome,
      ...(outcome.reason ? { stderr: outcome.reason.slice(0, 2000) } : {}),
    });

    return outcome;
  }

  /**
   * Select gate commands based on slice type.
   * Looks up the type in config.profiles, falls back to default commands.
   */
  private selectCommands(sliceType: SliceType): GateCommand[] {
    if (this.config.profiles && this.config.profiles[sliceType]) {
      return this.config.profiles[sliceType];
    }
    return this.config.commands;
  }

  /**
   * 判定这轮门禁的**作用域**（ADR-097）。
   *
   * 三种结果：
   * - `no-config`：没配 `gate.scope` → 跑全量（老行为）；
   * - `fallback-full`：配了规则但写集没命中 → 跑全量；
   * - `config`：写集命中 → 按标签收窄。
   *
   * **人显式说「这轮跑全量」时**（`config.scoped === false`）→ 全量，
   * 且理由说清楚是**人要求的**，不是「配错了」。
   */
  private resolveScope(slice: SliceData): ScopeMatch {
    return resolveScope(slice.writes, this.config.scope, pathMatches, this.config.scoped === false);
  }

  /**
   * 按作用域**收窄**门禁命令（ADR-097）。
   *
   * 流程：
   * 1. 作用域不是 `config` → 原样返回（全量）；
   * 2. 找出命令里的 ctest 命令 —— 认不出 → 原样返回（全量）；
   * 3. 用 `ctest --show-only=json-v1` 枚举全部用例 + 标签；
   * 4. 按标签精确筛出用例名 → 写清单文件；
   * 5. 把 ctest 命令改写成 `ctest --tests-from-file <清单>`。
   *
   * **每一步失败都退回全量**（宁可慢，不漏验）。唯一**不**退回的是
   * 第 4 步筛出**空清单**的情形 —— 那说明「标签匹配不到任何用例」，
   * 此时跑收窄命令就是**跑 0 个用例**（ctest 退出码 0 = 假绿）。
   * 这种情况**判失败**并说清楚，而不是退回全量（退回全量会掩盖
   * 「项目根本没给用例打标签」这个配置问题 —— 而那正是要让人知道的事）。
   *
   * 返回 `testCount` / `totalTestCount` 供事件留痕
   * （ADR-097 决策五：门禁过了意味着什么，人必须看得见）。
   *
   * 返回 `scopeFailure` 时，那条命令**不会真跑** —— 门禁直接判失败。
   * 用「返回失败事实」而不是「改命令加 `&& exit /b 1`」：后者是
   * Windows 专属语法，在 POSIX 上会变成一条莫名其妙的命令，
   * 而且门禁报出来的错是「命令执行失败」而不是「标签没匹配到用例」。
   */
  private async applyScope(
    slice: SliceData,
    commands: GateCommand[],
    scope: ScopeMatch,
  ): Promise<{
    commands: GateCommand[];
    /** 清单的**实际落点**（绝对路径）—— 跑完按这个删。 */
    manifestPaths: string[];
    testCount: number | null;
    totalTestCount: number | null;
    /** 收窄失败的事实（非空 = 那条命令不跑，门禁判失败）。 */
    scopeFailure: { command: string; reason: string } | null;
    /** 期望跑到的用例名 —— 供假绿验真。 */
    expectedTests?: string[];
  }> {
    const unchanged = {
      commands,
      manifestPaths: [] as string[],
      testCount: null as number | null,
      totalTestCount: null as number | null,
      scopeFailure: null as { command: string; reason: string } | null,
      expectedTests: undefined as string[] | undefined,
    };

    if (scope.source !== 'config' || scope.labels.length === 0) return unchanged;

    // 找出第一条 ctest 命令 —— 认不出就退回全量。
    const ctestCmd = commands.find((c) => buildCtestEnumerateCommand(c.run) !== null);
    if (!ctestCmd) return unchanged;

    // 枚举全部用例 + 标签。
    const enumerateCmd = buildCtestEnumerateCommand(ctestCmd.run);
    if (!enumerateCmd) return unchanged;

    const enumResult = await runCommand(
      { name: 'scope-enumerate', run: enumerateCmd },
      Math.min(this.config.timeoutSec, 120),
      this.projectRoot,
    );
    if (!enumResult.passed) return unchanged;

    // **只解析 stdout** —— ctest 的 stderr 里有 "Could not find executable"
    // 之类的噪声，混进去 JSON 解析就废了。
    const selected = selectScopedTestNames(enumResult.stdout, scope.labels);
    if (!selected) return unchanged;

    const totalTestCount = selected.total;

    // 标签没匹配到任何用例 → **判失败**（不是退回全量）。
    //
    // 为什么不是退回全量：这种情况几乎总是「项目没给用例打标签」
    // 或「规则里的标签名写错了」。退回全量会让门禁**看起来通过**，
    // 而实际上项目侧从来没启用过这个能力 —— 人会以为「作用域在生效」。
    //
    // 判失败是诚实的：门禁没跑成它该跑的东西，就是没跑成。
    if (selected.names.length === 0) {
      return {
        ...unchanged,
        testCount: 0,
        totalTestCount,
        scopeFailure: {
          command: ctestCmd.name,
          reason:
            `作用域标签（${scope.labels.join('、')}）在 ${totalTestCount} 个用例里` +
            `**一个都没匹配到** —— 项目可能没给用例打 CTest 标签，或规则里的标签名写错了。` +
            `门禁拒绝在这种情况下判通过（跑 0 个用例 = 假绿）。`,
        },
      };
    }

    // 写清单文件（相对路径 —— 避开 Windows 绝对路径的空格/引号）。
    const manifestFile = scopeManifestFile(slice.id, 0);
    // 落点必须与 ctest 解析相对路径的基准一致 ——
    // `ctest --test-dir build` 是相对 `build/` 解析 `--tests-from-file` 的
    // （2026-11-25 nimrtc 实测：清单写在工作目录根 → exit 8「找不到清单」）。
    const placement = resolveCtestManifestPlacement(ctestCmd.run, this.projectRoot, manifestFile);
    const written = await writeManifestFile(
      placement.absolutePath,
      buildScopeManifestContent(selected.names),
    );
    if (!written) {
      // 清单写不出来 → 退回全量。
      return unchanged;
    }

    // 改写 ctest 命令：加 `--tests-from-file <清单>`。
    // 引用用 `placement.relativeRef` —— 与落点自洽（真 ctest 与替身都认）。
    const rewritten = narrowCtestCommandByFile(ctestCmd.run, placement.relativeRef);
    if (!rewritten) {
      // 命令里已经带了过滤参数 → 不叠加（尊重人显式写的过滤）。
      await rm(placement.absolutePath, { force: true }).catch(() => {});
      return unchanged;
    }

    return {
      commands: commands.map((c) => (c === ctestCmd ? { ...c, run: rewritten } : c)),
      manifestPaths: [placement.absolutePath],
      testCount: selected.names.length,
      totalTestCount,
      scopeFailure: null,
      // 期望跑到的用例名 —— 供假绿验真（`verifyNarrowedTestsRan`）。
      expectedTests: selected.names,
    };
  }

  /**
   * 跑一条命令，失败时按配置重试。
   *
   * **重试会收窄到失败用例（ADR-096 决策四）**：
   * 重试的语义是「再试一次，看是不是偶发」。对测试失败而言，
   * 真正要回答的问题是「上次失败的那几个用例现在还失败吗」——
   * 而不是「再跑一遍全部 2333 个用例、再看是不是同一个失败」。
   *
   * 第一轮**已经全量跑过**，所以全量覆盖没有丢；收窄只是把重试的
   * 边际成本从 O(全量) 降到 O(失败用例数)。
   *
   * 收窄不可用时（认不出失败用例 / 不是 ctest 命令 / 清单写不了）
   * 退回全量重试 —— 宁可慢，也不漏验。
   *
   * @param expectedTests 作用域收窄时**应该**跑到的用例名 ——
   *   用来做假绿验真（`--tests-from-file` 没匹配到用例时退出码是 0）。
   */
  private async runWithRetry(
    cmd: GateCommand,
    slice: SliceData,
    actor: string,
    expectedTests?: string[],
  ): Promise<{ result: GateResult; retries: number }> {
    const timeoutSec = cmd.timeoutSec ?? this.config.timeoutSec;
    let result = await runCommand(cmd, timeoutSec, this.projectRoot, {
      grandchildPidFile: this.config.grandchildPidFile,
    });
    let attempts = 0;

    // ADR-097 决策三：**作用域收窄的假绿防线**。
    //
    // `ctest --tests-from-file` 在「没匹配到任何用例」时退出码是 **0**
    // （ADR-096 已实测：`No tests were found!!!`）—— 那是假绿。
    //
    // 与 ADR-096 的重试收窄用的是**同一个**验真函数（`verifyNarrowedTestsRan`）：
    // 两处各写一份判据，迟早会改一处漏一处，而漏掉的后果是**门禁假绿**。
    if (expectedTests && expectedTests.length > 0 && result.passed) {
      const verification = verifyNarrowedTestsRan(
        `${result.stdout}\n${result.stderr}`,
        expectedTests,
      );
      if (!verification.ran) {
        result = {
          ...result,
          passed: false,
          exitCode: result.exitCode ?? 1,
          stderr: `${result.stderr}\n【作用域收窄没有跑到用例】${verification.reason ?? ''}`.trim(),
        };
      }
    }

    while (!result.passed && attempts < this.config.retry.max) {
      attempts++;

      // ADR-096：重试前先试着把命令收窄到「上一轮失败的用例」。
      //
      // 收窄清单文件写在门禁工作目录里（固定名 + 切片 id，
      // 避免并行切片互相覆盖），跑完删掉。
      const narrowing = await this.buildRetryNarrowing(cmd, result, slice);

      await this.appendEvent(slice.id, 'gate.retry', actor, {
        command: cmd.name,
        attempt: attempts,
        maxRetries: this.config.retry.max,
        previousExitCode: result.exitCode,
        timeoutSec,
        // ADR-096：这次重试是不是收窄的、收窄到哪些用例 —— 留痕，便于审计。
        ...(narrowing
          ? {
              narrowedToTests: narrowing.testNames,
              narrowedManifest: narrowing.manifestFile,
            }
          : {}),
      });

      // Re-read slice before writing to avoid overwriting concurrent modifications
      try {
        const fresh = await this.store.read(slice.id);
        fresh.stall.gateRetries++;
        fresh.stall.class = 'gate_retry';
        await this.store.write(fresh);
      } catch {
        // Fallback to stale slice if read fails
        slice.stall.gateRetries++;
        slice.stall.class = 'gate_retry';
        await this.store.write(slice);
      }

      const retryCmd: GateCommand = narrowing
        ? { ...cmd, run: narrowing.command }
        : cmd;
      result = await runCommand(retryCmd, timeoutSec, this.projectRoot, {
        grandchildPidFile: this.config.grandchildPidFile,
      });

      // ADR-096 决策二：收窄跑的 ctest 可能**一个用例都没跑到**就退出 0
      // （`No tests were found!!!`）—— 那是假绿，必须当成失败。
      if (narrowing && result.passed) {
        const verification = verifyNarrowedTestsRan(
          `${result.stdout}\n${result.stderr}`,
          narrowing.testNames,
        );
        if (!verification.ran) {
          result = {
            ...result,
            passed: false,
            exitCode: result.exitCode ?? 1,
            stderr: `${result.stderr}\n【收窄重跑没有跑到用例】${verification.reason ?? ''}`.trim(),
          };
        }
      }

      if (narrowing) {
        await this.removeNarrowingManifest(narrowing.manifestPath);
      }
    }

    // ZD-027：失败时抽失败用例摘要（只对最终失败的那次跑，
    // 重试被覆盖的中间结果不需要）。纯计算，不改变命令的退出码语义。
    if (!result.passed) {
      result = enrichFailureDiagnostics(result);
    }

    return { result, retries: attempts };
  }

  /**
   * 为一次重试构造「收窄到失败用例」的改写（ADR-096）。
   *
   * 返回 null 表示「不该收窄」—— 调用方退回全量重试。
   *
   * 收窄条件全部满足才收窄：
   * 1. 上一轮失败；
   * 2. 上一轮的失败能被认成 CTest 失败（有 runner 判定 + 失败用例名）；
   * 3. 这条命令确实是 ctest 命令；
   * 4. 清单文件能写出来。
   *
   * 清单文件放在**门禁工作目录**（worktree 根）而不是系统临时目录：
   * 相对路径最短、最可预测，且避免 Windows 路径里的空格/引号。
   */
  private async buildRetryNarrowing(
    cmd: GateCommand,
    previous: GateResult,
    slice: SliceData,
  ): Promise<{
    command: string;
    testNames: string[];
    manifestFile: string;
    manifestPath: string;
  } | null> {
    // 只对「认得出是 CTest 失败」的失败收窄。
    const extraction = extractGateFailures(`${previous.stdout}\n${previous.stderr}`);
    if (extraction.runner !== 'ctest') return null;
    const testNames = extraction.failures.map((f) => f.test).filter((n) => n.length > 0);
    if (testNames.length === 0) return null;

    const manifestFile = GATE_NARROWING_MANIFEST_PREFIX + `${sanitizeForFilename(slice.id)}.txt`;

    // 清单的**落点**必须与 ctest 解析相对路径的基准一致 ——
    // `ctest --test-dir build` 是相对 `build/` 解析 `--tests-from-file` 的，
    // 清单写在工作目录根就找不到（2026-11-25 nimrtc 实测，exit 8）。
    const placement = resolveCtestManifestPlacement(cmd.run, this.projectRoot, manifestFile);

    // 命令本身不适合收窄（不是 ctest / 已经带了过滤参数）→ 不收窄。
    //
    // **引用路径用 `relativeRef`（落点的自洽写法）**，不是裸文件名 ——
    // 真 ctest 相对 `--test-dir` 解析清单，而 ctest 替身相对 cwd 解析；
    // 只有指向同一个绝对路径，两边才都对。
    const rewritten = narrowCtestCommandByFile(cmd.run, placement.relativeRef);
    if (!rewritten) return null;

    const written = await writeManifestFile(placement.absolutePath, `${testNames.join('\n')}\n`);
    if (!written) {
      // 清单写不出来 → 不收窄（退回全量）。
      return null;
    }

    return { command: rewritten, testNames, manifestFile: placement.relativeRef, manifestPath: placement.absolutePath };
  }

  /** 删掉收窄清单文件（跑完就删，不留垃圾）。 */
  private async removeNarrowingManifest(manifestPath: string): Promise<void> {
    try {
      await rm(manifestPath, { force: true });
    } catch {
      // 删不掉不是致命问题 —— 下一轮会覆盖同名文件。
    }
  }

  private async appendEvent(
    sliceId: string,
    type: EventType,
    actor: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.events.append(sliceId, type, actor, payload);
    } catch {
      // Event stream failure is non-fatal for gate execution
    }
  }

  /**
   * Check for uninitialized git submodules that could cause build failures.
   * Returns null if OK, or an error message string if issues are found.
   * Skips check if .gitmodules doesn't exist.
   */
  private async checkSubmodules(): Promise<string | null> {
    const gitmodulesPath = join(this.projectRoot, '.gitmodules');
    if (!existsSync(gitmodulesPath)) return null; // No submodules configured

    try {
      // Read .gitmodules to find expected submodule paths
      const content = await readFile(gitmodulesPath, 'utf-8');
      const submodulePaths: string[] = [];
      for (const line of content.split('\n')) {
        const match = line.match(/^\s*path\s*=\s*(.+)$/);
        if (match) {
          submodulePaths.push(match[1].trim());
        }
      }

      if (submodulePaths.length === 0) return null;

      // Check each submodule path exists and is non-empty
      const missingPaths: string[] = [];
      const emptyPaths: string[] = [];

      for (const subPath of submodulePaths) {
        const fullPath = join(this.projectRoot, subPath);
        if (!existsSync(fullPath)) {
          missingPaths.push(subPath);
          continue;
        }
        // Check if directory is empty (submodule not initialized)
        const entries = readdirSync(fullPath);
        if (entries.length === 0) {
          emptyPaths.push(subPath);
        }
      }

      if (missingPaths.length > 0 || emptyPaths.length > 0) {
        const parts: string[] = [];
        if (missingPaths.length > 0) parts.push(`missing: ${missingPaths.join(', ')}`);
        if (emptyPaths.length > 0) parts.push(`empty: ${emptyPaths.join(', ')}`);
        return `Uninitialized git submodules found (${parts.join('; ')}). Run "git submodule update --init --recursive" first.`;
      }

      return null;
    } catch {
      return null; // Non-fatal: skip check if we can't read .gitmodules
    }
  }
}
