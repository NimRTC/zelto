// Gate and sign commands: gate, inbox, sign

import { createInterface } from 'node:readline';
import { GateExecutor } from '../../core/gate/executor.js';
import { SignManager } from '../../core/gate/sign.js';
import type { GateConfig } from '../../core/gate/types.js';
import { register } from './shared.js';
import { store, events, ZELTO_DIR, loadConfig, resolveTargetDir, existingWorktreePath } from './shared.js';
import { checkSliceGateGuard, describeGuardKinds } from '../../core/arch/guard-wiring.js';
// ADR-086：门禁编排下沉到 core —— CLI 与 Web 调同一份（C3：判定不许分叉）
import { runGate } from '../../core/lifecycle/gate.js';
import { SpecMdExecutor } from '../../core/spec/SpecMdExecutor.js';
import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { runSignReview } from './sign-review.js';
import { collectSignReviewFacts } from '../sign-review/collect-facts.js';
import { evaluateSignChecks } from '../../core/sign-review/evaluate.js';
import {
  SIGN_APPROVAL_DEFAULT_EXEMPT,
  evaluateSignApprovalGate,
  renderSignApprovalBlockers,
} from '../../core/sign-review/approval-gate.js';

// ─── gate ────────────────────────────────────────────────────────────────────

register('gate', async (args) => {
  const hasSpecMd = args.includes('--spec-md');

  // Handle `gate --spec-md` without a slice ID: run spec-md on all slices
  if (hasSpecMd && (!args[0] || args[0].startsWith('--'))) {
    return runSpecMdOnAllSlices();
  }

  const [id] = args;
  if (!id || id === '--help' || id === '-h') {
    if (!id && hasSpecMd) {
      // --spec-md without slice-id is handled above
      return 0;
    }
    console.error('Usage: zelto gate <slice-id> [--retry <N>] [--dry-run] [--spec-md] [--only <name>] [--rerun-failed] [--full]');
    console.error('       zelto gate --spec-md                    (validate all specs)');
    console.error('       --full                                  强制跑全量（不做作用域收窄，ADR-097）');
    return 1;
  }

  const isJson = args.includes('--json');
  const isDryRun = args.includes('--dry-run');
  const rerunFailed = args.includes('--rerun-failed');
  // `--full` = 人显式要求跑全量（怀疑作用域规则漏了某个模块时的出口）。
  const forceFull = args.includes('--full');
  const retryFlag = args.indexOf('--retry');
  const forceRetry = retryFlag >= 0 && args[retryFlag + 1] ? Math.max(0, parseInt(args[retryFlag + 1], 10) || 0) : -1;
  const onlyFlag = args.indexOf('--only');
  const onlyCommand = onlyFlag >= 0 && args[onlyFlag + 1] ? args[onlyFlag + 1] : null;

  try {
    const slice = await store.read(id);
    if (slice.state !== 'frozen') {
      if (forceRetry >= 0) {
        // Force re-run gate on any state
        console.log(`zelto gate ${id} — re-running gate② (forced, state=${slice.state})...`);
      } else {
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, passed: false, error: `Slice is in state "${slice.state}", must be "frozen"` }));
        } else {
          console.error(`Slice "${id}" is in state "${slice.state}". Must be "frozen" to run gate.`);
          console.error(`  Use --retry <N> to force re-run regardless of state.`);
        }
        return 1;
      }
    } else {
      console.log(`zelto gate ${id} — running gate②...`);
    }

    const config = loadConfig();

    // Resolve target project directory for cross-project execution
    const targetDir = resolveTargetDir();
    // 本片专属命令优先（ADR-051）：不同模块的测试目标名不同，
    // 项目级命令去构建别的模块的目标，既不验本片产物又白等一次构建。
    const sliceSpecific = slice.spec?.gateCommands;
    const projectGateCommands = targetDir && config.targetProject?.gate?.commands
      ? config.targetProject.gate.commands
      : config.gate.commands;
    const gateCommands = sliceSpecific && sliceSpecific.length > 0
      ? sliceSpecific
      : projectGateCommands;
    const gateProfiles = targetDir && config.targetProject?.gate?.profiles
      ? config.targetProject.gate.profiles
      : config.gate.profiles;

    if (targetDir) {
      console.log(`  Target:   ${targetDir}`);
    }
    if (sliceSpecific && sliceSpecific.length > 0) {
      console.log(`  Commands: 本片专属（${gateCommands.length} 条）`);
    }

    const worktreePath = existingWorktreePath(id);
    const gateRoot = worktreePath ?? targetDir ?? undefined;

    // ── spec-md 校验（CLI 特有：它是「规格格式」检查，不是门禁命令）────
    //
    // 为什么留在 CLI：spec-md 验的是规格文件的**格式**，
    // 不属于门禁②的「产物验过了吗」。Web 端不做这一步 ——
    // 驾驶舱不做「另一个 CLI 的全部功能」。
    if (hasSpecMd) {
      const specMd = new SpecMdExecutor(resolve(process.cwd(), 'specs', 'slices'));
      const result = await specMd.validate(id);
      if (!result.valid) {
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, specMdValid: false, specMdErrors: result.errors }));
        } else {
          console.log(`  Spec-MD: ❌ ${id} spec file validation failed`);
          for (const err of result.errors) {
            console.log(`    - ${err}`);
          }
        }
        return 1;
      }
      if (!isJson) {
        console.log(`  Spec-MD: ✅ ${id} spec file validated`);
      }
    }

    // ── ADR-086：门禁编排下沉到 core/lifecycle/gate.ts ────────────────
    // CLI 与 Web 调**同一份**编排（判定不许分叉，C3）。
    // 这里只负责**呈现** —— 渲染成人看的终端输出。
    const outcome = await runGate(
      {
        repoRoot: process.cwd(),
        store,
        events,
        actor: 'cli',
        via: 'cli',
      },
      id,
      {
        // 命令原样传下去 —— **不要在这里裁剪字段**。
        // 只取 `{ name, run }` 会把命令级 `timeoutSec` 悄悄丢掉，
        // 让它退回全局超时（实测 2026-11-27：全量测试要 ~650 秒，
        // 全局 120 秒 → 门禁必红，且没有任何提示说超时被丢了）。
        commands: gateCommands,
        profiles: gateProfiles,
        timeoutSec: config.gate.timeoutSec,
        retryMax: forceRetry >= 0 ? forceRetry : config.gate.retry.max,
        ...(config.gate.acceptance ? { acceptance: config.gate.acceptance } : {}),
        ...(config.gate.scope ? { scope: config.gate.scope } : {}),
        ...(config.gate.submoduleCheck !== undefined ? { submoduleCheck: config.gate.submoduleCheck } : {}),
        ...(gateRoot ? { gateRoot } : {}),
        requestSign: true,
      },
      {
        ...(onlyCommand ? { only: onlyCommand } : {}),
        ...(forceRetry >= 0 ? { retry: forceRetry } : {}),
        ...(isDryRun ? { dryRun: true } : {}),
        ...(rerunFailed ? { rerunFailed: true } : {}),
        ...(forceFull ? { full: true } : {}),
      },
    );

    // ── 干跑：只看要跑什么 ────────────────────────────────────────────
    if (isDryRun) {
      if (isJson) {
        console.log(JSON.stringify({
          sliceId: id, dryRun: true,
          commands: outcome.facts?.commands ?? [],
          timeoutSec: config.gate.timeoutSec,
          retry: config.gate.retry,
          only: onlyCommand,
          targetDir,
        }));
      } else {
        const facts = (outcome.facts ?? {}) as { commands?: Array<{ name: string; run: string }> };
        const filteredCmds = facts.commands ?? [];
        console.log(`  Dry-run for gate ${id}:`);
        console.log(`  Commands: ${filteredCmds.length}${onlyCommand ? ` (filtered: ${onlyCommand})` : ''}`);
        for (const c of filteredCmds) {
          console.log(`    - ${c.name}: ${c.run}`);
        }
        console.log(`  Timeout: ${config.gate.timeoutSec}s`);
        console.log(`  Retries: ${config.gate.retry.max}`);
        if (targetDir) console.log(`  CWD:     ${targetDir}`);
        console.log(`\n  Run without --dry-run to execute.`);
      }
      return 0;
    }

    if (onlyCommand && !isJson) {
      console.log(`  Only:     ${onlyCommand}`);
    }

    const facts = (outcome.facts ?? {}) as {
      passed?: boolean;
      results?: Array<{
        command: string; passed: boolean; exitCode: number | null; durationMs: number;
        stderr?: string | null;
        failures?: Array<{ test?: string; message?: string; location?: string }>;
        reportedFailureCount?: number | null;
        runner?: string;
      }>;
      acceptance?: { status: string; path: string | null; command: string | null; reason: string | null } | null;
      retryCount?: number;
      totalDurationMs?: number;
      signRequestId?: string;
      code?: string;
      designId?: string;
      // 作用域事实（ADR-097）—— 「门禁过了意味着什么」要说清楚。
      scope?: {
        scoped: boolean;
        labels: string[];
        source: string;
        reason: string;
        testCount: number | null;
        totalTestCount: number | null;
      };
    };

    // 架构护栏拦截 —— 它在跑门禁命令**之前**就拦下了。
    if (facts.code === 'arch_guard_blocked') {
      const msg = outcome.reason;
      if (isJson) {
        console.log(JSON.stringify({ sliceId: id, passed: false, error: msg, code: 'arch_guard_blocked' }));
      } else {
        console.log(`  Arch:     ❌ ${msg}`);
        if (facts.designId) console.log(`  Design:   ${facts.designId}`);
      }
      return 1;
    }

    // 「门禁跑了但没过」与「门禁根本没跑起来」是**两回事** ——
    // 退出码不一样，输出也不一样。
    //
    //   门禁跑了但没过 → 文本模式**退出码仍是 0**（重构前的既有契约）。
    //     为什么：门禁的结论写在输出里（❌ + Gate failed），
    //     而退出码被 `zelto batch` / CI 脚本当「命令本身出错」用。
    //     门禁没通过 ≠ 命令崩了 —— 混成一个信号，
    //     批处理就会把「这片没过门禁」当成「zelto 坏了」而中断整批。
    //     （`tests/acceptance/gate-retry` 明确守着这条契约。）
    //
    //   门禁根本没跑起来（状态不对 / `--only` 名字不存在）→ 退出码 1。
    //     那是**命令用错了**，不是「结论为否」。
    const gateRan = outcome.ok === false && facts.passed === false && Array.isArray(facts.results);

    if (!outcome.ok && !gateRan) {
      // 命令用错了 —— 退出码 1。
      if (isJson) {
        console.log(JSON.stringify({ sliceId: id, passed: false, error: outcome.reason }));
        return 1;
      }
      console.error(`zelto gate ${id} — ❌ ${outcome.reason}`);
      for (const d of outcome.details) console.error(`  - ${d}`);
      for (const a of outcome.advisories) console.error(`  ⚠ ${a}`);
      return 1;
    }

    if (worktreePath && !isJson) {
      console.log(`  Worktree: ${worktreePath}`);
    }

    if (isJson) {
      console.log(JSON.stringify({
        sliceId: id, passed: facts.passed,
        commands: facts.results?.map((r) => ({
          command: r.command, passed: r.passed, exitCode: r.exitCode, durationMs: r.durationMs,
        })),
        ...(facts.acceptance ? { acceptance: facts.acceptance } : {}),
        retryCount: facts.retryCount,
        totalDurationMs: facts.totalDurationMs,
        ...(facts.scope ? { scope: facts.scope } : {}),
      }));
      // JSON 模式的退出码跟着**结论**走（重构前既有契约）：
      // 门禁没通过 = 结论为否 = 退出码 1。
      return facts.passed ? 0 : 1;
    }

    console.log(`  Commands: ${facts.results?.length ?? 0}`);

    // 作用域（ADR-097 决策五）—— 门禁过了意味着什么，必须说清楚。
    //
    // 收窄跑的门禁过了 = 「本片相关用例全过」，不是「整个项目都好了」。
    // 不说清楚，收窄就成了「悄悄降级的门禁」。
    const scope = facts.scope;
    if (scope) {
      if (scope.scoped) {
        const total = scope.totalTestCount ?? '?';
        const ran = scope.testCount ?? '?';
        console.log(`  Scope:    🎯 收窄（标签：${scope.labels.join('、')}）—— 跑了 ${ran} / ${total} 个用例`);
      } else {
        console.log(`  Scope:    全量（${scope.reason}）`);
      }
    }

    for (const r of facts.results ?? []) {
      const icon = r.passed ? '✅' : '❌';
      console.log(`    ${icon} ${r.command} (${r.durationMs.toFixed(0)}ms, exit ${r.exitCode ?? 'signal'})`);
      if (!r.passed) {
        // ZD-027：先给结构化失败用例清单（哪个用例挂了、断言说了什么），
        // 再退回裸 stderr —— 后者往往只有一句「Errors while running CTest」。
        const failures = r.failures ?? [];
        if (failures.length > 0) {
          const runner = r.runner && r.runner !== 'unknown' ? ` · ${r.runner}` : '';
          console.log(`       ✗ 失败用例${runner}：${failures.length} 个`);
          for (const f of failures.slice(0, 8)) {
            const name = f.test?.trim() || '(未命名用例)';
            const loc = f.location ? `  ${f.location}` : '';
            console.log(`         ✗ ${name}${loc}`);
            if (f.message) {
              for (const ml of f.message.split('\n').slice(0, 4)) {
                console.log(`             ${ml.slice(0, 200)}`);
              }
            }
          }
          if (failures.length > 8) {
            console.log(`         … 另有 ${failures.length - 8} 个失败用例（见 gate.result 事件）`);
          }
          const reported = r.reportedFailureCount;
          if (typeof reported === 'number' && reported > failures.length) {
            console.log(`         （运行器共报 ${reported} 个失败）`);
          }
        } else if (r.stderr) {
          const stderrLines = r.stderr.split('\n').filter((l) => l.trim()).slice(0, 5);
          for (const line of stderrLines) {
            console.log(`       ${line.slice(0, 200)}`);
          }
        }
      }
    }

    // 切片级验收（ADR-033）：跑没跑、跑没跑过、结论是什么，都要说清楚。
    // skipped 也要显式说 —— 静默跳过等于骗人。
    const acceptance = facts.acceptance;
    if (acceptance) {
      const icon = acceptance.status === 'passed' ? '✅'
        : acceptance.status === 'failed' ? '❌'
        : '⏭️';
      const target = acceptance.path ? ` ${acceptance.path}` : '';
      console.log(`  Acceptance: ${icon} ${acceptance.status}${target}`);
      if (acceptance.command) {
        console.log(`    Command: ${acceptance.command}`);
      }
      if (acceptance.reason) {
        console.log(`    Reason:  ${acceptance.reason}`);
      }
    }

    if ((facts.retryCount ?? 0) > 0) {
      console.log(`  Retries:  ${facts.retryCount}`);
    }

    // 非失败类提示（例如 --rerun-failed 收窄了哪些命令）—— 无论过没过都说。
    if (facts.passed && outcome.advisories.length > 0) {
      for (const a of outcome.advisories) console.log(`  ⚠ ${a}`);
    }

    if (facts.passed) {
      console.log(`  Result:   ✅ Gate passed (${(facts.totalDurationMs ?? 0).toFixed(0)}ms)`);
      console.log(`  State:    ✅ Slice transitioned to "completed"`);
      if (facts.signRequestId) {
        console.log(`  Sign:     📋 Sign request created (${facts.signRequestId})`);
        console.log(`  Next:     Run "zelto sign ${id} --approve" to approve`);
      }
    } else {
      // 门禁跑了但没过 —— 逐条说清哪条命令、什么错。
      console.log(`  Result:   ❌ Gate failed (${(facts.totalDurationMs ?? 0).toFixed(0)}ms)`);
      for (const d of outcome.details) console.log(`  - ${d}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      console.log(JSON.stringify({ sliceId: id, error: msg }));
    } else {
      console.error(`Error running gate for "${id}": ${msg}`);
    }
    return 1;
  }
  return 0;
});

// ─── inbox ───────────────────────────────────────────────────────────────────

register('inbox', async (args) => {
  const signManager = new SignManager(ZELTO_DIR, events, store);
  const pending = await signManager.list('pending');

  if (args.includes('--list') || !process.stdout.isTTY) {
    if (pending.length === 0) {
      console.log('Inbox is empty. Nothing pending.');
      return 0;
    }
    console.log('Inbox — Pending Sign Requests:');
    console.log('');
    for (const req of pending) {
      console.log(`  [${req.id}]`);
      console.log(`    Slice:    ${req.sliceId}`);
      console.log(`    Requested: ${req.requestedAt}`);
      console.log(`    By:        ${req.requestedBy}`);
      console.log(`    Action:    zelto sign ${req.sliceId} --approve | --reject`);
      console.log('');
    }
    console.log(`${pending.length} pending request(s).`);
    return 0;
  }

  if (pending.length === 0) {
    console.log('📋 Inbox is empty. Nothing pending.');
    return 0;
  }

  console.log('📋 Inbox — Pending Sign Requests:');
  console.log('');
  for (let i = 0; i < pending.length; i++) {
    const req = pending[i];
    console.log(`  ${i + 1}. [${req.sliceId}] — requested ${req.requestedAt.slice(0, 10)}`);
  }
  console.log('');
  console.log('Enter number to review, or q to quit.');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question('> ', resolve);
  });
  rl.close();

  const idx = Number.parseInt(answer, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= pending.length) {
    if (answer === 'q' || answer === 'Q') {
      console.log('Bye.');
      return 0;
    }
    console.log('Invalid selection.');
    return 1;
  }

  const req = pending[idx];
  console.log('');
  console.log(`  Slice:    ${req.sliceId}`);
  console.log(`  Request:  ${req.requestedAt}`);
  console.log(`  By:       ${req.requestedBy}`);

  const rl2 = createInterface({ input: process.stdin, output: process.stdout });
  const decision = await new Promise<string>((resolve) => {
    rl2.question('  Approve? [Y/n] ', resolve);
  });
  rl2.close();

  if (decision === '' || decision.toLowerCase() === 'y' || decision.toLowerCase() === 'yes') {
    await signManager.approve(req.id, 'human', null);
    console.log(`  ✅ ${req.sliceId} approved`);
    // ADR-018: 签字只改状态。合并是显式动作 —— zelto merge <id>
    console.log(`  下一步：zelto merge ${req.sliceId}`);
  } else {
    const rl3 = createInterface({ input: process.stdin, output: process.stdout });
    const comment = await new Promise<string>((resolve) => {
      rl3.question('  Rejection comment: ', resolve);
    });
    rl3.close();
    await signManager.reject(req.id, 'human', comment || null);
    console.log(`  ❌ ${req.sliceId} rejected`);
  }

  return 0;
});

// ─── spec-md on all slices (for gate --spec-md without slice-id) ──────────────

async function runSpecMdOnAllSlices(): Promise<number> {
  const { readFile } = await import('node:fs/promises');
  const slicesDir = resolve(process.cwd(), 'specs', 'slices');
  const executor = new SpecMdExecutor(slicesDir);
  try {
    const entries = await readdir(slicesDir);
    const mdFiles = entries.filter((f) => f.endsWith('.md'));
    if (mdFiles.length === 0) {
      console.log('No spec files found in specs/slices/.');
      return 0;
    }
    let validated = 0;
    let skipped = 0;
    let allValid = true;
    for (const file of mdFiles) {
      const sliceId = file.replace(/\.md$/, '');
      // Skip old-format spec files that don't have ## Spec section
      const content = await readFile(resolve(slicesDir, file), 'utf-8');
      if (!content.includes('## Spec')) {
        skipped++;
        continue;
      }
      const result = await executor.validate(sliceId);
      if (result.valid) {
        console.log(`  ✅ ${sliceId}`);
        validated++;
      } else {
        console.error(`  ❌ ${sliceId}`);
        for (const err of result.errors) {
          console.error(`     - ${err}`);
        }
        allValid = false;
      }
    }
    if (allValid) {
      console.log(`\n✅ ${validated} spec files validated (spec-md). ${skipped > 0 ? `${skipped} old-format skipped.` : ''}`);
    } else {
      console.error(`\n❌ Some spec files failed validation (spec-md). ${skipped > 0 ? `${skipped} old-format skipped.` : ''}`);
      return 1;
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error running spec-md on all slices: ${msg}`);
    return 1;
  }
}

// ─── sign ────────────────────────────────────────────────────────────────────

register('sign', async (args) => {
  // `--review` 在参数解析最前分流（ADR-070 §4.1 / §5.4）：
  // 它是 `sign` 的修饰符，不是新命令 —— 人从 review 跳到 approve 是同一条路径。
  // 原有 `--approve/--reject/--revoke` 分支一字不动。
  if (args.includes('--review')) {
    const reviewId = args.find((a) => !a.startsWith('--'));
    if (!reviewId) {
      console.error('Usage: zelto sign --review <slice-id>');
      return 1;
    }
    return runSignReview(reviewId, { json: args.includes('--json') });
  }

  const [id, action] = args;
  if (!id || !action) {
    console.error('Usage: zelto sign <slice-id> [--approve|--reject|--revoke|--revise] [--comment <text>]');
    console.error('       zelto sign <slice-id> --approve [--force]');
    console.error('         --approve 会先跑签字前确认（追溯/验收/写集）；有不过的就拦下（D-48）');
    console.error('         --force   明知故犯地跳过确认项（会在输出里留痕）');
    console.error('       zelto sign <slice-id> --revise --comment "要改什么"');
    console.error('         --revise  退回重跑：方向对、细节要改。意见会带进下一轮 agent 的上下文');
    return 1;
  }

  const isJson = args.includes('--json');
  // ADR-018 §3.3：--push 从签字迁到合并。推的必须是合并结果，不是签字那一刻的分支。
  if (args.includes('--push')) {
    const message = 'zelto sign 不再接受 --push（签字只改状态，不推远端）';
    if (isJson) {
      console.log(JSON.stringify({ sliceId: id, error: 'sign does not accept --push', message: `${message}：zelto merge ${id} --push` }));
    } else {
      console.error(message);
      console.error(`        要推送合并结果，请跑：zelto merge ${id} --push`);
    }
    return 1;
  }
  const signManager = new SignManager(ZELTO_DIR, events, store);
  const commentIndex = args.indexOf('--comment');
  const comment = commentIndex >= 0 ? args[commentIndex + 1] : null;

  try {
    if (action === '--approve') {
      // ── 签字前确认闸门（D-48）────────────────────────────────────────
      //
      // 病灶（nimrtc-zelto v2-input-binder，2026-11-17）：验收测试三条
      // 用例**全是 `test.todo`**，规格的 5 条验收标准一条都没被验证过；
      // 项目又没配 `gate.acceptance` → 门禁②的验收步骤记为 `skipped`
      // → gate 报 `passed: true` → 签字请求照常发出。
      //
      // ADR-070 的 `sign --review` 其实抓到了这件事（「验收真跑过本片 ❌」），
      // 但 `--approve` **不经过它** —— 审查工具存在，签字路径绕过审查。
      //
      // 现在 `--approve` 先跑四项确认，有不过的就拦住。
      // `--force` 是留给人的显式出口：明知故犯可以，但要明着做。
      const force = args.includes('--force');
      if (!force) {
        const approvalGate = await evaluateApprovalGate(id);
        if (!approvalGate.approvable) {
          if (isJson) {
            console.log(
              JSON.stringify({
                sliceId: id,
                action: 'blocked',
                error: '签字前确认项没有全部通过',
                blockers: approvalGate.blockers.map((b) => ({
                  label: b.label,
                  evidence: b.evidence,
                  adrRef: b.adrRef,
                })),
                hint: '确认要跳过：zelto sign <id> --approve --force',
              }),
            );
          } else {
            console.error(renderSignApprovalBlockers(approvalGate.blockers));
          }
          return 1;
        }
      } else if (!isJson) {
        console.log('  ⚠️  --force：跳过签字前确认项（明知故犯）');
      }

      const pending = await signManager.list('pending');
      const req = pending.find((r) => r.sliceId === id);

      // 签字是**人的决定** —— 工具不替人拒绝。
      // 切片状态对不上时（`sign.state_mismatch`），如实报出来，
      // 但不推翻签字 —— `--force` 存在的意义就是明知故犯地签。
      let approved;
      let autoRequested = false;
      if (!req) {
        const newReq = await signManager.request(id, 'human');
        approved = await signManager.approve(newReq.id, 'human', comment);
        autoRequested = true;
      } else {
        approved = await signManager.approve(req.id, 'human', comment);
      }

      // 状态转移有没有真的发生？读了才知道 —— 不猜。
      const sliceAfter = await store.read(id).catch(() => null);
      const stateMismatch =
        sliceAfter !== null &&
        sliceAfter.state !== 'completed' &&
        (req === undefined || approved.status === 'approved');

      if (isJson) {
        console.log(
          JSON.stringify({
            sliceId: id,
            action: 'approved',
            signId: approved.id,
            sliceState: sliceAfter?.state ?? null,
            ...(stateMismatch ? { stateMismatch: true } : {}),
            ...(autoRequested ? { autoRequested: true } : {}),
          }),
        );
      } else if (autoRequested) {
        console.log(`zelto sign ${id} -- ✅ Approved (auto-requested)`);
      } else {
        console.log(`zelto sign ${id} -- ✅ Approved`);
      }

      if (stateMismatch) {
        console.error('');
        console.error(`  ⚠️  切片状态仍是 ${sliceAfter!.state} —— 签字已记录，但状态没跟着变。`);
        console.error('     这两件事在追溯链里对不上。多数情况是这片还没跑完门禁②。');
        console.error('');
        console.error('     要让状态与签字一致，先把片跑到 completed：');
        console.error(`       zelto gate ${id} && zelto sign ${id} --approve`);
      }

      // ADR-018：签字只改状态。合并是显式动作 —— zelto merge <id>
      if (!isJson) {
        console.log(`下一步：zelto merge ${id}`);
      }
    } else if (action === '--reject') {
      const pending = await signManager.list('pending');
      const req = pending.find((r) => r.sliceId === id);
      if (!req) {
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, action: 'rejected', error: 'No pending sign request' }));
        } else {
          console.error(`No pending sign request for slice "${id}".`);
        }
        return 1;
      }
      // 拒绝是**人的决定** —— 工具不替人拒绝。
      // 状态对不上就**如实报出来**，但不推翻拒绝。
      const rejected = await signManager.reject(req.id, 'human', comment);

      const sliceAfter = await store.read(id).catch(() => null);
      const stateMismatch = sliceAfter !== null && sliceAfter.state !== 'abandoned';

      if (isJson) {
        console.log(
          JSON.stringify({
            sliceId: id,
            action: 'rejected',
            signId: rejected.id,
            sliceState: sliceAfter?.state ?? null,
            ...(stateMismatch ? { stateMismatch: true } : {}),
          }),
        );
      } else {
        console.log(`zelto sign ${id} -- ❌ Rejected`);
      }

      if (stateMismatch) {
        console.error('');
        console.error(`  ⚠️  切片状态仍是 ${sliceAfter!.state} —— 拒绝已记录，但状态没跟着变。`);
        console.error('     多数情况是这片还没到 completed（门禁②没过）。');
        console.error('');
        console.error('     要让状态与拒绝一致，先把片跑到 completed 再拒：');
        console.error(`       zelto gate ${id} && zelto sign ${id} --reject`);
      }
    } else if (action === '--revise') {
      // ── 退回重跑（ADR-094 §5.1）────────────────────────────────────────
      //
      // 人审出毛病但**方向是对的** —— 让片回 frozen 带着意见重跑。
      //
      // 与 `--reject` 的区别是这一档的全部意义：
      //   --reject  → 切片进终态 abandoned，规格得重写，整片作废
      //   --revise  → 切片回 frozen，规格与写集都不动，意见进下一轮上下文
      //
      // 与 `--revoke` 的区别：
      //   --revoke  → 只作废「批准」这条记录，切片状态不动，门禁结论还在
      //   --revise  → **改变切片状态**，且意见会真的到达 agent
      //
      // **必须有意见**（ADR-094 §5.2）：不给意见就让人重跑 = 人自己也不
      // 清楚要改什么，重跑必然白跑（agent 拿到的信息与上一轮完全等价）。
      if (!comment || !comment.trim()) {
        if (isJson) {
          console.log(JSON.stringify({
            sliceId: id,
            action: 'blocked',
            error: '退回重跑必须带意见',
            hint: 'zelto sign <id> --revise --comment "要改什么"',
          }));
        } else {
          console.error('❌ 退回重跑必须带意见（--comment）。');
          console.error('   没有意见，agent 拿到的信息与上一轮完全等价 —— 重跑必然白跑。');
          console.error('   用法：zelto sign <id> --revise --comment "要改什么"');
        }
        return 1;
      }

      // ── 找可退的签字请求 ────────────────────────────────────────────────
      //
      // 两种状态都能退（ADR-094 D11）：
      //
      // - `pending` —— 还没批就发现问题；
      // - `approved` —— **批了之后又发现问题** —— 这是最常见的场景！
      //
      // 后者以前会撞「No pending sign request」而退不掉 ——
      // 但「签了字又发现毛病」恰恰是最该退的时候。
      //
      // 优先取 `pending`（最新的那条）；没有 pending 就取 `approved`。
      const pendingReq = (await signManager.list('pending')).find((r) => r.sliceId === id);
      const approvedReq = (await signManager.list('approved')).find((r) => r.sliceId === id);
      const req = pendingReq ?? approvedReq;
      if (!req) {
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, action: 'revised', error: 'No sign request to revise' }));
        } else {
          console.error(`No sign request to revise for slice "${id}".`);
          console.error('  退回重跑要求有**待签字**或**已批准**的请求 —— 没请求就没法退。');
        }
        return 1;
      }

      // ── D11：连带作废已批准的状态 ────────────────────────────────────────
      //
      // `merge` 的判据是「存在 approved 的签字请求」。若批准之后再退回，
      // approved 请求还在 → merge 照样会收它 → 「已批准的片被退回」与
      // 「已批准的片可合并」同时成立 = 追溯链自相矛盾。
      //
      // `reviseRequest()` 把 approved 请求**就地**转成 revised ——
      // 所以 approved 状态自然不再成立，不需要「先 revoke 再 revise」
      // 两步（两步之间会有一个「既没批准也没退回」的中间态）。
      //
      // 但「批准被作废了」这件事**必须在输出里明说** ——
      // 人以为在退回，实际连带撤了批准，这件事不能悄悄做。
      const revokedApproval = approvedReq !== undefined && approvedReq !== null;

      // `reviseRequest()` 在**动手之前**校验切片状态 ——
      // 状态不对就抛错，且**一个字都没改**（签字请求没被消耗）。
      //
      // 这里必须接住并说清楚：让异常冒到顶层会打印栈，对人没用。
      let revised;
      try {
        revised = await signManager.reviseRequest(req.id, 'human', comment);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, action: 'blocked', error: msg }));
        } else {
          console.error(`zelto sign ${id} -- ❌ 退回重跑失败：${msg}`);
          console.error('');
          console.error('  **没有退回**：签字请求与切片状态都没动。');
          console.error('');
          console.error('  退回重跑要求切片处于 completed（门禁②过了、等签字）。');
          console.error('  各状态下的出路：');
          console.error('    - draft     —— 还没冻结：改完规格直接 freeze');
          console.error('    - frozen   —— 已冻结未完成：zelto run ' + id);
          console.error('    - running   —— 正在跑：等它跑完，或 zelto stall ' + id);
        }
        return 1;
      }

      if (isJson) {
        console.log(JSON.stringify({
          sliceId: id,
          action: 'revised',
          signId: revised.id,
          ...(revokedApproval ? { revokedApproval: true } : {}),
        }));
      } else {
        console.log(`zelto sign ${id} -- ↩️  Sent back for rework`);
        if (revokedApproval) {
          console.log(`  ⚠️  此前的批准已作废（${approvedReq!.id}）—— 否则它仍可被合并。`);
        }
        console.log('  切片回到 frozen：规格与写集不动，可以重跑。');
        console.log('  你的意见会带进下一轮 agent 的上下文。');
        console.log('下一步：zelto run ' + id);
      }
    } else if (action === '--revoke') {
      // 签错了要能回退：撤销已经通过的签字记录（ADR-021）
      const approved = await signManager.list('approved');
      const req = approved.find((r) => r.sliceId === id);
      if (!req) {
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, action: 'revoked', error: 'No approved sign request' }));
        } else {
          console.error(`No approved sign request for slice "${id}".`);
          console.error('  只有已签字（approved）的切片才能撤销。');
        }
        return 1;
      }
      await signManager.revoke(req.id, 'human', comment);
      if (isJson) {
        console.log(JSON.stringify({ sliceId: id, action: 'revoked', signId: req.id }));
      } else {
        console.log(`zelto sign ${id} -- ↩️  Revoked (签字已作废)`);
        console.log('  切片仍是 completed：门禁结论保留，批准记录作废。');
        console.log('  修好之后重新发起签名请求，再走 zelto merge。');
      }
    } else {
      if (isJson) {
        console.log(JSON.stringify({ error: `Unknown action: ${action}` }));
      } else {
        console.error(`Unknown action: ${action}`);
        console.error('Usage: zelto sign <slice-id> [--approve|--reject|--revoke|--revise]');
      }
      return 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      console.log(JSON.stringify({ sliceId: id, error: msg }));
    } else {
      console.error(`Error processing sign for "${id}": ${msg}`);
    }
    return 1;
  }
  return 0;
});

/**
 * 收集签字前事实并跑确认闸门（D-48）。
 *
 * 与 `sign --review` 走**同一套**事实收集与判定 —— 不另写一份判据，
 * 否则两处会漂移（ADR-070 的核心诉求：判定只有一处）。
 *
 * 「产物真落地」在签字阶段必然是 `not-in-trunk`（产物要合并后才进主干），
 * 所以默认豁免它 —— 它属于合并阶段的确认。
 */
async function evaluateApprovalGate(sliceId: string) {
  const facts = await collectSignReviewFacts(sliceId);
  const checks = evaluateSignChecks(facts);
  return evaluateSignApprovalGate(checks, { excludeLabels: SIGN_APPROVAL_DEFAULT_EXEMPT });
}
