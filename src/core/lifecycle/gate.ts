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
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GateConfig } from '../gate/types.js';
import { narrowCommandsToFailedTestsByFile, GATE_NARROWING_MANIFEST_PREFIX, sanitizeForFilename } from '../gate/diagnostics.js';
import { resolveScope } from '../gate/scope.js';
import { pathMatches } from '../sched/paths.js';
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
  /**
   * 只重跑上次失败的用例（`--rerun-failed`，ZD-027）。
   *
   * 病灶：一次小改（5 个文件）要全量跑 2333 个用例，250~400 秒；
   * 改完再跑一遍全量，大部分用例根本没受影响。
   *
   * 实现：读**上一次** `gate.result` 里抽出的失败 CTest 用例名，
   * 把 ctest 命令收窄成 `ctest -R "<失败的用例名正则>"`。
   * 只对本片上一次确实失败过、且能识别出失败用例时生效；
   * 其它情况（没有历史、识别不出、非 ctest 命令）退回全量 ——
   * 宁可慢，也不要漏跑该跑的用例。
   */
  rerunFailed?: boolean;
  /**
   * 强制跑**全量**（`--full`，ADR-097）。
   *
   * 用途：怀疑作用域规则漏了某个模块时，人显式要求「这轮别收窄」。
   */
  full?: boolean;
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
   * 门禁作用域配置（ADR-097）—— 按写集收窄「跑哪些用例」。
   *
   * 没配 = 跑全量（老行为，零变化）。
   */
  scope?: GateConfig['scope'];
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
  let commands = (
    sliceCommands && sliceCommands.length > 0
      ? sliceCommands
      : selectProfileCommands(config, slice.type ?? detectSliceType(slice.writes))
  ).filter((c) => !options.only || c.name === options.only);

  if (options.only && commands.length === 0) {
    return fail(`没有名为 "${options.only}" 的门禁命令`);
  }

  // ── 2b. 只重跑上次失败的用例（--rerun-failed，ZD-027 / ADR-096）────
  // 读上一次 gate.result 的失败清单；能识别出 CTest 失败用例时，
  // 把 ctest 命令收窄成 `ctest --tests-from-file <清单>`。
  //
  // **为什么用清单文件而不是 `-R` 正则（ADR-096）**：`-R` 的值是命令行里的
  // 正则，而 Windows 上 `cmd` 把 `|` 当**管道符** —— 实测
  // `cmd /c "ctest -R "^(?:A|B)$" ..."` 直接把命令打崩（exit 255）。
  // 用例名是精确串，本来就不需要正则。
  //
  // 没有历史 / 识别不出 / 非 ctest → 一条都不改（退回全量，宁可慢不漏跑）。
  const rerunNotes: string[] = [];
  const manifestsToClean: string[] = [];
  if (options.rerunFailed) {
    const gateRoot = config.gateRoot ?? ctx.repoRoot;
    const narrowed = await narrowToFailedTests(events, sliceId, commands, gateRoot);
    if (narrowed) {
      commands = narrowed.commands;
      manifestsToClean.push(...narrowed.manifestFiles);
      rerunNotes.push(
        `只重跑上次失败的用例（--rerun-failed）：${narrowed.narrowed.size} 条命令收窄，共 ${countAll(narrowed.narrowed)} 个失败用例`,
      );
    } else {
      rerunNotes.push('--rerun-failed 不可用（没有可识别的上次失败用例），已退回全量');
    }
  }

  // ── 2c. 作用域判定（ADR-097）────────────────────────────────────────
  //
  // **干跑也要算作用域** —— 否则干跑显示的命令与真跑跑的不一样，
  // 干跑就失去意义了（人以为看的是真要跑的东西）。
  //
  // 这里只做「判定」，不做「收窄」—— 收窄要在 executor 里做，
  // 因为它要真跑 ctest --show-only 枚举用例、要写清单文件。
  const scopeMatch = resolveScope(
    slice.writes,
    config.scope,
    pathMatches,
    options.full === true,
  );

  const gateConfig: GateConfig = {
    commands,
    ...(config.profiles ? { profiles: config.profiles } : {}),
    ...(config.acceptance ? { acceptance: config.acceptance } : {}),
    // 门禁作用域（ADR-097）—— 收窄在 executor 里做（那里才有写集、
    // 事件流、清单文件的写权限）。
    ...(config.scope ? { scope: config.scope } : {}),
    // `--full` = 人显式要求跑全量，不做作用域收窄。
    ...(options.full ? { scoped: false } : {}),
    timeoutSec: config.timeoutSec,
    ...(config.submoduleCheck !== undefined ? { submoduleCheck: config.submoduleCheck } : {}),
    retry: {
      max: options.retry !== undefined && options.retry >= 0 ? options.retry : config.retryMax,
      budgetStepUsd: 0.05,
    },
  };

  // ── 3. dry-run：只看要跑什么 ───────────────────────────────────────
  //
  // ── 4. 架构护栏（切片级）──────────────────────────────────────────
  //
  // 设计与策略读主仓（设计不在 worktree 里），源码扫门禁实际跑的目录
  // （worktree 有就验 worktree，没有就验主仓）。
  // 无确认设计时跳过（老项目无感）；ask 只提示不拦，deny 才拦。
  // --dry-run 不拦（只展示命令）；--only 只跑单个命令时不拦（不是完整门禁）。
  const gateRoot = config.gateRoot ?? ctx.repoRoot;

  // 收窄清单文件跑完就删 —— **不管走哪条出口**都要删（不留垃圾）。
  //
  // 用 try/finally 兜住所有出口：dry-run、护栏拦截（blocked）、
  // 护栏待确认、正常跑完 —— 四条路都不能把清单留在工作目录里。
  try {
    if (options.dryRun) {
      return ok('干跑：未执行任何命令', {
        sliceId,
        dryRun: true,
        commands: commands.map((c) => ({ name: c.name, run: c.run })),
        timeoutSec: gateConfig.timeoutSec,
        retry: gateConfig.retry.max,
        // 作用域事实（ADR-097）—— 干跑也要说清「这轮会不会收窄」。
        scope: {
          scoped: scopeMatch.source === 'config',
          labels: scopeMatch.labels,
          source: scopeMatch.source,
          reason: scopeMatch.reason,
        },
      });
    }

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
          return await runGateCommands(ctx, sliceId, gateConfig, gateRoot, [
            `架构护栏待确认（不拦）：${describeGuardKinds(sliceGuard.verdict, 'pending')}`,
            ...rerunNotes,
          ]);
        }
      }
    }

    return await runGateCommands(ctx, sliceId, gateConfig, gateRoot, rerunNotes);
  } finally {
    await cleanupManifests(manifestsToClean, gateRoot);
  }
}

/** 删掉收窄清单文件（跑完就删，不留垃圾）。 */
async function cleanupManifests(files: string[], gateRoot: string): Promise<void> {
  await Promise.all(
    files.map((f) => rm(join(gateRoot, f), { force: true }).catch(() => {})),
  );
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

  // 作用域说明（ADR-097 决策五）—— 不管过没过都要说。
  //
  // 门禁过了到底意味着什么，取决于这轮跑的是全量还是本片相关的子集。
  // 不说清楚，收窄就成了「悄悄降级的门禁」。
  const scopeAdvisory = report.scope
    ? report.scope.scoped
      ? `门禁按作用域收窄跑了 ${report.scope.testCount ?? '?'} 个用例` +
        `（标签：${report.scope.labels.join('、')}；全量 ${report.scope.totalTestCount ?? '?'} 个）` +
        `—— 门禁过了意味着「本片相关用例全过」，不是「整个项目都好了」`
      : `门禁跑全量（${report.scope.reason}）`
    : '';

  const allAdvisories = scopeAdvisory ? [...advisories, scopeAdvisory] : advisories;

  if (!report.passed) {
    return fail(
      '门禁未通过',
      failedCommandDetails(report.results),
      allAdvisories,
      {
        sliceId,
        passed: false,
        results: report.results.map((r) => ({
          command: r.command,
          passed: r.passed,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          stderr: r.stderr ? r.stderr.slice(0, 2000) : null,
          // ZD-027：带上失败用例清单，CLI 与 Web 才呈现得出「哪个用例挂了」
          ...(r.failures && r.failures.length > 0 ? { failures: r.failures } : {}),
          ...(r.reportedFailureCount !== undefined ? { reportedFailureCount: r.reportedFailureCount } : {}),
          ...(r.runner ? { runner: r.runner } : {}),
        })),
        retryCount: report.retryCount,
        totalDurationMs: report.totalDurationMs,
        acceptance: report.acceptance,
        ...(report.scope ? { scope: report.scope } : {}),
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
    ...(report.scope ? { scope: report.scope } : {}),
  };

  const post = await applyGatePass(ctx, sliceId);
  if (post) {
    facts.state = post.state;
    facts.signRequestId = post.signRequestId;
  }

  return ok('门禁通过', facts, allAdvisories);
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

/**
 * 把门禁命令收窄成「只跑上次失败的 CTest 用例」（--rerun-failed）。
 *
 * 数据来源：本片事件流里**最近一条** `gate.result` 的失败清单
 * （由 `executor.ts` 的 ZD-027 诊断抽出，存在 `results[].failures`）。
 *
 * 只收窄**与失败命令同名**的 ctest 命令 —— 比如上次 `test` 命令挂了，
 * 就只给 `test` 命令加 `--tests-from-file`，`build` / `lint` 等其它命令原样跑。
 *
 * **清单文件形态（ADR-096）**：过滤条件写成文件（每行一个精确用例名），
 * 命令行只多一个 `--tests-from-file <相对路径>`。
 * 之所以不用 `-R` 正则：Windows 上 `cmd` 把正则里的 `|` 当管道符，
 * 实测会把命令直接打崩（exit 255）。
 *
 * 返回 null 表示「这次不该收窄」：
 * - 没有 `gate.result`，或最近一次其实**通过了**（没有要重跑的失败）；
 * - 抽不出失败用例名（不是 ctest，或上一轮不是诊断版本写的）；
 * - 没有可收窄的 ctest 命令；
 * - 清单文件写不出来。
 *
 * 全是「退到全量」的信号 —— 宁可跑全量，也不能因为收窄逻辑出错而漏验。
 */
async function narrowToFailedTests(
  events: LifecycleContext['events'],
  sliceId: string,
  commands: Array<{ name: string; run: string }>,
  gateRoot: string,
): Promise<{
  commands: Array<{ name: string; run: string }>;
  narrowed: Map<string, string[]>;
  manifestFiles: string[];
} | null> {
  let all;
  try {
    all = await events.read(sliceId);
  } catch {
    return null;
  }
  const gateResults = all.filter((e) => e.type === 'gate.result');
  const last = gateResults[gateResults.length - 1];
  if (!last) return null;
  // 最近一次其实过了 → 没有「上次失败的用例」可重跑。
  if (last.payload?.passed !== false) return null;

  const results = (last.payload?.results ?? []) as Array<{
    command?: string;
    passed?: boolean;
    runner?: string;
    failures?: Array<{ test?: string }>;
  }>;

  // 收集**所有**失败命令里的 CTest 失败用例名（通常只有一条 test 命令挂）。
  const failedByName = new Map<string, string[]>();
  for (const r of results) {
    if (r.passed !== false) continue;
    if (r.runner !== 'ctest') continue;
    const names = (r.failures ?? [])
      .map((f) => f.test ?? '')
      .filter((n) => n.trim().length > 0);
    if (names.length > 0 && r.command) {
      failedByName.set(r.command, names);
    }
  }

  if (failedByName.size === 0) return null;

  // 为每条被收窄的命令写一份清单文件（一个文件对应一条命令 ——
  // 每条命令的失败用例集不同）。
  const manifestFiles = new Map<string, string>();
  const writtenFiles: string[] = [];
  let index = 0;
  for (const [commandName, names] of failedByName) {
    const manifestFile = `${GATE_NARROWING_MANIFEST_PREFIX}${sanitizeForFilename(sliceId)}-${index}.txt`;
    index++;
    try {
      await writeFile(join(gateRoot, manifestFile), `${names.join('\n')}\n`, 'utf8');
    } catch {
      // 写不出来就不收窄这一条（退回全量）。
      continue;
    }
    manifestFiles.set(commandName, manifestFile);
    writtenFiles.push(manifestFile);
  }

  if (manifestFiles.size === 0) return null;

  // 纯逻辑下沉到 diagnostics（便于单测），这里只负责读事件与调用。
  const result = narrowCommandsToFailedTestsByFile(commands, failedByName, manifestFiles);
  if (!result) {
    // 一条都没收窄成功 → 把已写的清单删掉，退回全量。
    await Promise.all(writtenFiles.map((f) => rm(join(gateRoot, f), { force: true }).catch(() => {})));
    return null;
  }
  return { ...result, manifestFiles: writtenFiles };
}

/** 数一数所有命令的失败用例总数（给人看的摘要）。 */
function countAll(narrowed: Map<string, string[]>): number {
  let total = 0;
  for (const names of narrowed.values()) total += names.length;
  return total;
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
