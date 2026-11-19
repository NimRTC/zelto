// 门禁编排（ADR-086）
//
// 与 freeze 编排同一个理由：**判据在 core，编排序列要下沉**，
// 让 CLI 与 Web 调同一份（C3 —— 判定不许分叉）。
//
// 门禁判定本身住在 `core/gate/executor.ts` 的 `GateExecutor` ——
// 本模块负责整条序列：
//   1. 状态检查（必须 frozen）
//   2. 架构护栏（切片级，只看与本片写集相关的偏离）
//   3. 拼 GateConfig（读 config → 取本片专属命令 → 拼重试策略）
//   4. 调 GateExecutor.execute()
//   5. 通过 → GATE_PASS 状态转换 + 发签字请求
//
// **第 5 步为什么在 core**：
// 「门禁过了就发签字请求」是门禁语义的一部分，不是呈现。
// 如果它在 CLI 层，Web 端跑完门禁就拿不到签字请求 ——
// 人得再切回终端跑一次门禁才能推进，那驾驶舱就还是半个。
//
// C3: 判定确定性 —— 门禁跑的是命令（确定性执行），不调模型、不触网。
// C2: 零第三方依赖、不 import adapters/。

import { GateExecutor } from '../gate/executor.js';
import { SignManager } from '../gate/sign.js';
import { join } from 'node:path';
import type { GateConfig } from '../gate/types.js';
import { detectSliceType } from '../gate/types.js';
import { checkSliceGateGuard, describeGuardKinds } from '../arch/guard-wiring.js';
import type { LifecycleContext, LifecycleOutcome } from './types.js';
import { fail, ok } from './types.js';

/** 门禁的选项。 */
export interface GateOptions {
  /** 只跑某一条命令（`--only <name>`） */
  only?: string;
  /** 强制重跑次数（`--retry <N>`）—— 覆盖配置里的重试上限 */
  retry?: number;
  /** 只看要跑什么，不真跑（`--dry-run`） */
  dryRun?: boolean;
}

/** 门禁配置 —— 由调用方提供（CLI 与 Web 各自的 config 读法不同）。 */
export interface GateConfigSource {
  /** 项目级门禁命令 */
  commands: Array<{ name: string; run: string }>;
  /** 按切片类型分的命令档 */
  profiles?: Record<string, Array<{ name: string; run: string }>>;
  /** 超时（秒） */
  timeoutSec: number;
  /** 重试上限 */
  retryMax: number;
  /** 切片级验收配置 */
  acceptance?: GateConfig['acceptance'];
  /** 子模块预检 */
  submoduleCheck?: boolean;
  /**
   * 门禁跑在哪个目录（worktree 路径优先）。
   *
   * 架构护栏扫的就是这个目录 —— 验的是 agent 刚写出来的代码，
   * 不是主干。没给就用项目根。
   */
  gateRoot?: string;
  /**
   * 门禁过了之后**要不要**发签字请求。
   *
   * 为什么这是个开关：CLI 的 `zelto gate` 会发（`GATE_PASS` 转换 + 签字请求），
   * 而 `run` 之后的**自动**门禁（`autoGateAfterRun`）走的是另一条路。
   * 调用方必须明确说，不能由本模块猜。
   */
  requestSign?: boolean;
}

/**
 * 跑门禁②。
 *
 * 与 CLI `zelto gate` **同一份判定、同一份编排**（ADR-086 §1）。
 */
export async function runGate(
  ctx: LifecycleContext,
  sliceId: string,
  config: GateConfigSource,
  options: GateOptions = {},
): Promise<LifecycleOutcome> {
  const { store, events, actor, via } = ctx;

  const slice = await store.read(sliceId);

  // ── 1. 状态检查 ────────────────────────────────────────────────────
  //
  // 门禁要验的是「冻结基线上的产物」—— 切片不在 frozen，
  // 就没有「基线」可验。强制重跑（--retry N）可以绕过，
  // 因为那是「明知状态不对还要再验一次」的人为决定。
  if (slice.state !== 'frozen' && (options.retry === undefined || options.retry < 0)) {
    return fail(`切片 "${sliceId}" 处于 ${slice.state}，门禁要求 frozen`, [], [
      '强制重跑请用 retry 选项（zelto gate <id> --retry <N>）',
    ]);
  }

  // ── 2. 选命令 ──────────────────────────────────────────────────────
  //
  // 本片专属命令优先（ADR-051）：不同模块的测试目标名不同，
  // 项目级命令去构建别的模块的目标，既不验本片产物又白等一次构建。
  const sliceCommands = slice.spec?.gateCommands;
  const commands = (
    sliceCommands && sliceCommands.length > 0
      ? sliceCommands
      : selectProfileCommands(config, slice.type ?? detectSliceType(slice.writes))
  ).filter((c) => !options.only || c.name === options.only);

  if (options.only && commands.length === 0) {
    return fail(`没有名为 "${options.only}" 的门禁命令`);
  }

  const gateConfig: GateConfig = {
    commands,
    ...(config.profiles ? { profiles: config.profiles } : {}),
    ...(config.acceptance ? { acceptance: config.acceptance } : {}),
    timeoutSec: config.timeoutSec,
    ...(config.submoduleCheck !== undefined ? { submoduleCheck: config.submoduleCheck } : {}),
    retry: {
      max: options.retry !== undefined && options.retry >= 0 ? options.retry : config.retryMax,
      budgetStepUsd: 0.05,
    },
  };

  // ── 3. dry-run：只看要跑什么 ───────────────────────────────────────
  if (options.dryRun) {
    return ok('干跑：未执行任何命令', {
      sliceId,
      dryRun: true,
      commands: commands.map((c) => ({ name: c.name, run: c.run })),
      timeoutSec: gateConfig.timeoutSec,
      retry: gateConfig.retry.max,
    });
  }

  // ── 4. 架构护栏（切片级）──────────────────────────────────────────
  //
  // 设计与策略读主仓（设计不在 worktree 里），源码扫门禁实际跑的目录
  // （worktree 有就验 worktree，没有就验主仓）。
  // 无确认设计时跳过（老项目无感）；ask 只提示不拦，deny 才拦。
  // --dry-run 不拦（只展示命令）；--only 只跑单个命令时不拦（不是完整门禁）。
  const gateRoot = config.gateRoot ?? ctx.repoRoot;
  if (!options.only) {
    const sliceGuard = await checkSliceGateGuard(slice.writes, {
      designRoot: ctx.repoRoot,
      scanRoot: gateRoot,
    });
    if (sliceGuard) {
      if (sliceGuard.verdict.blocked) {
        return fail(
          `架构护栏拦截：${describeGuardKinds(sliceGuard.verdict, 'blocked')} —— 修好或改 policy.yaml 的 arch 段后再跑门禁`,
          [],
          [],
          {
            sliceId,
            passed: false,
            code: 'arch_guard_blocked',
            designId: sliceGuard.designId,
          },
        );
      }
      if (sliceGuard.verdict.needsConfirm) {
        // ask 只提示不拦 —— 但**必须说出来**（人有权知道有偏离）。
        return runGateCommands(ctx, sliceId, gateConfig, gateRoot, [
          `架构护栏待确认（不拦）：${describeGuardKinds(sliceGuard.verdict, 'pending')}`,
        ]);
      }
    }
  }

  return runGateCommands(ctx, sliceId, gateConfig, gateRoot, []);
}

/**
 * 真正跑门禁命令 —— 并在通过后走完后置动作。
 *
 * 拆出来是因为架构护栏那条路径也要走到这里。
 */
async function runGateCommands(
  ctx: LifecycleContext,
  sliceId: string,
  gateConfig: GateConfig,
  gateRoot: string,
  advisories: string[],
): Promise<LifecycleOutcome> {
  const { store, events, actor, via } = ctx;

  // `GateExecutor.execute()` 自己写 gate.executed / gate.result / gate.retry
  // 三个事件 —— 那是判定的产物，不是「人的决定」，所以 actor 用 zelto。
  //
  // **这里不重复写 `gate.executed`**：`via` 传进 executor，
  // 由它在**同一条**事件上标「从哪儿触发的」。
  //
  // 为什么不能「补写一条」：多一条 `gate.executed` 会让
  // `rework_rate`（gate.retry ÷ gate.executed）直接砍半 ——
  // 门禁跑一次、事件两条，度量从此失真（ADR-086 §6）。
  const executor = new GateExecutor(store, events, gateConfig, gateRoot);
  const report = await executor.execute(sliceId, 'zelto', { via });

  if (!report.passed) {
    return fail(
      '门禁未通过',
      failedCommandDetails(report.results),
      advisories,
      {
        sliceId,
        passed: false,
        results: report.results.map((r) => ({
          command: r.command,
          passed: r.passed,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          stderr: r.stderr ? r.stderr.slice(0, 2000) : null,
        })),
        retryCount: report.retryCount,
        totalDurationMs: report.totalDurationMs,
        acceptance: report.acceptance,
      },
    );
  }

  // ── 5. 通过 → GATE_PASS 转换 + 签字请求 ────────────────────────────
  const facts: Record<string, unknown> = {
    sliceId,
    passed: true,
    results: report.results.map((r) => ({
      command: r.command,
      passed: r.passed,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
    })),
    retryCount: report.retryCount,
    totalDurationMs: report.totalDurationMs,
    acceptance: report.acceptance,
  };

  const post = await applyGatePass(ctx, sliceId);
  if (post) {
    facts.state = post.state;
    facts.signRequestId = post.signRequestId;
  }

  return ok('门禁通过', facts, advisories);
}

/**
 * 门禁通过后的状态转换与签字请求。
 *
 * **签字不等于合并**（ADR-018）：这里只发**请求**，
 * 批不批是人的事，而且合并必须显式跑 `zelto merge`。
 */
async function applyGatePass(
  ctx: LifecycleContext,
  sliceId: string,
): Promise<{ state: string; signRequestId: string } | null> {
  const { store, events, actor, via } = ctx;

  let prevState = '';
  try {
    const slice = await store.read(sliceId);
    prevState = slice.state;
  } catch {
    return null;
  }

  try {
    await store.transit(sliceId, 'GATE_PASS', actor);
    await events.append(sliceId, 'slice.state.changed', actor, {
      sliceId, from: prevState, to: 'completed', event: 'GATE_PASS', via,
    });
  } catch {
    // 状态被别处改过 —— 不强改，门禁结果照样算过。
    // 「门禁过了但状态没转」是真实存在的状态（并发），
    // 把它说出来比硬转要诚实。
    return null;
  }

  try {
    const signManager = new SignManager(joinZeltoDir(ctx.repoRoot), events, store);
    // `requestedBy` 固定是 'zelto'，**不是** actor。
    //
    // 为什么：签字请求是**工具在门禁通过后自动发起的**，
    // 不是「人」发起的（人批的是签字本身，不是「发起签字」这件事）。
    // actor 在这里是「谁触发的门禁」（'cli' / 'human'），
    // 把它写进 `requestedBy` 会让「谁要求签字」这个字段变成
    // 「谁点的门禁」—— 语义漂移。
    //
    // 这也是 CLI 原实现的口径（`signManager.request(id, 'zelto')`）——
    // 下沉编排不能顺手改掉这个语义。
    const signReq = await signManager.request(sliceId, 'zelto');
    return { state: 'completed', signRequestId: signReq.id };
  } catch {
    // 签字请求发不出去 —— 门禁结果仍然成立，人可以手动 `zelto sign`。
    return { state: 'completed', signRequestId: '' };
  }
}

/** `.zelto` 目录 —— SignManager 的基目录。 */
function joinZeltoDir(repoRoot: string): string {
  return join(repoRoot, '.zelto');
}

/** 按切片类型查命令档，查不到就用默认命令。 */
function selectProfileCommands(
  config: GateConfigSource,
  sliceType: string,
): Array<{ name: string; run: string }> {
  const profile = config.profiles?.[sliceType];
  return profile && profile.length > 0 ? profile : config.commands;
}

/** 失败命令的逐条说明 —— 人要看到「哪条命令、什么错」。 */
function failedCommandDetails(
  results: Array<{ command: string; passed: boolean; exitCode: number | null; stderr?: string }>,
): string[] {
  return results
    .filter((r) => !r.passed)
    .map((r) => {
      const detail = r.stderr ? r.stderr.trim().split('\n').slice(-3).join(' / ') : '';
      return detail
        ? `${r.command} 失败（退出码 ${r.exitCode ?? '无'}）：${detail}`
        : `${r.command} 失败（退出码 ${r.exitCode ?? '无'}）`;
    });
}
