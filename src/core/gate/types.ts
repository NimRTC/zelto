// Gate — gate② executor
// See docs/zelto-技术架构.md §6.1

/**
 * 门禁命令的**阶段**。
 *
 * 为什么需要（ZD-009）：C++ 项目「配一次、用很多次」——
 * `cmake --build build` 假设 `build/` 已经存在，而**配置步骤没人做**。
 * 于是门禁失败，而失败原因与被验的代码无关（人第一反应是「agent 写坏了」，
 * 实际是环境没准备好）。
 *
 * 阶段给了门禁命令序列一个**语义顺序**，而不只是「一条条按配置顺序跑」：
 * - `configure`：配置构建树（跑一次，用很多次）；
 * - `build`：编译；
 * - `test`：跑测试。
 *
 * **`default`**：没写 `phase` 的命令落在这里。
 * 排在 `configure` 之后、`build`/`test` 之前 —— 这样老配置
 * （`commands: [test, lint]`）的行为**完全不变**（仍然是按配置顺序逐条跑）。
 */
export type GatePhase = 'configure' | 'default' | 'build' | 'test';

export interface GateCommand {
  name: string;
  run: string;
  /** Per-command timeout in seconds. Falls back to GateConfig.timeoutSec if not set. */
  timeoutSec?: number;
  /**
   * 这条命令属于哪个阶段（ZD-009）。
   *
   * 没写 = 「默认阶段」（见 `GATE_PHASE_ORDER`）—— 老配置行为不变。
   */
  phase?: GatePhase;
}

/**
 * 阶段的执行顺序。
 *
 * `default` 排在 `configure` 之后、`build` 之前 —— 这是为了**不改变**
 * 老配置的行为：老配置里全是没写 `phase` 的命令，它们之间仍然按
 * **配置里的先后顺序**跑（同一阶段内保序），整体排在 configure 之后。
 */
export const GATE_PHASE_ORDER: GatePhase[] = ['configure', 'default', 'build', 'test'];

/**
 * 一条命令属于哪个阶段（没写 `phase` → `default`）。
 */
export function gatePhaseOf(cmd: GateCommand): GatePhase {
  return cmd.phase ?? 'default';
}

/**
 * 按**阶段**给门禁命令排序（ZD-009）。
 *
 * 排序是**稳定**的：同一阶段内的命令保持**配置里的先后顺序**。
 * 这一点很重要 —— 老配置（全是没写 `phase` 的命令）排序后
 * 与原顺序**完全一致**，行为零变化。
 *
 * 为什么按阶段排而不是按配置顺序：
 * C++ 项目的门禁序列是「配置 → 编译 → 测试」，
 * 而配置里若把 test 写在 build 前面（或者干脆漏了 configure），
 * 门禁就会失败 —— 且失败原因与被验代码无关。
 * 阶段给了「顺序」一个**语义**，不依赖人把命令排对。
 *
 * 但阶段**不改变**「跑哪几条命令」—— 只改变「按什么顺序跑」。
 * 人没写 `phase` 时，命令集合与顺序都不变。
 */
export function orderGateCommands(commands: GateCommand[]): GateCommand[] {
  const indexed = commands.map((cmd, i) => ({ cmd, i }));
  indexed.sort((a, b) => {
    const pa = GATE_PHASE_ORDER.indexOf(gatePhaseOf(a.cmd));
    const pb = GATE_PHASE_ORDER.indexOf(gatePhaseOf(b.cmd));
    if (pa !== pb) return pa - pb;
    return a.i - b.i; // 同阶段内保序（稳定）
  });
  return indexed.map((x) => x.cmd);
}

export interface GateAcceptanceConfig {
  /**
   * Command template for running the slice's own acceptance tests.
   *
   * The literal `{acceptance}` is replaced by the slice's acceptance path
   * (`slice.acceptance.dir`, resolved against the gate root). When the
   * template has no placeholder, the path is appended as a trailing argument.
   */
  command: string;
  /**
   * Whether the slice must have a runnable acceptance target.
   *
   * - `true` (default): a missing / empty acceptance target fails the gate.
   * - `false`: a missing target is reported as `skipped` instead.
   *
   * This governs *presence*, not outcome — a target that runs and fails
   * always fails the gate.
   */
  required?: boolean;
  /** Per-acceptance timeout in seconds. Falls back to GateConfig.timeoutSec. */
  timeoutSec?: number;
  /**
   * Compile-output directory, relative to the gate root.
   *
   * TypeScript sources cannot be executed by `node --test` directly, so the
   * gate looks for the compiled counterpart here first (ADR-033).
   * Defaults to `dist-test`.
   */
  buildDir?: string;
}

export interface GateConfig {
  commands: GateCommand[];
  /** Named gate profiles keyed by slice type (code, docs, config, refactor) */
  profiles?: Record<string, GateCommand[]>;
  /**
   * Optional slice-level acceptance gate.
   *
   * When absent, the gate only runs the project-wide `commands` and the
   * acceptance step is reported as `skipped` (explicitly, never silently).
   */
  acceptance?: GateAcceptanceConfig;
  /**
   * 门禁作用域（ADR-097）—— 按写集收窄「跑哪些用例」。
   *
   * 没配 = 门禁跑全量（老行为，零变化）。
   */
  scope?: ScopeConfig;
  /**
   * 是否允许按作用域收窄（默认 true）。
   *
   * `false` = 强制跑全量 —— 人显式说「这轮我要全量」时的出口
   * （例如怀疑作用域规则漏了某个模块时）。
   */
  scoped?: boolean;
  timeoutSec: number;
  /**
   * 是否在跑命令前预检「子模块未初始化」（默认 true）。
   *
   * 预检只判断子模块目录是否为空；有些项目（如 nimrtc）的子模块 pin
   * 被本地改动弄脏，预检会把环境噪声当成问题拦住每一次门禁。
   * 关掉它不是跳过验证 —— 缺头文件时构建本身会失败。
   */
  submoduleCheck?: boolean;
  /**
   * **仅测试用**：门禁超时杀树后，读这个文件拿到**孙子进程**的 pid
   * （命令自己落盘），再按树强杀一次（ZD-062 第二次实测）。
   *
   * 生产配置不写它 —— 不写时行为与之前完全一致。
   */
  grandchildPidFile?: string;
  retry: {
    max: number;
    budgetStepUsd: number;
  };
}

import type { SliceType } from '../slice/kind.js';
import type { GateFailureSummary } from './diagnostics.js';
import type { ScopeConfig, ScopeSource } from './scope.js';

export type { GateFailureSummary, GateFailureExtraction } from './diagnostics.js';
export type { ScopeConfig, ScopeRule, ScopeSource, ScopeMatch } from './scope.js';

/**
 * Slice type classification for gate profile selection.
 *
 * Re-exported for compatibility: the definition now lives in `core/slice/kind.ts`
 * because it classifies a **slice**, not a gate. Gate consumes it to pick the
 * profile; the vocabulary belongs to the slice domain.
 *
 * See docs/adr-031-slice-type-ownership.md.
 */
export type { SliceType };

/**
 * Auto-detect slice type from write-set paths.
 * - All .md files → docs
 * - Config files (.yaml, .json, .toml) → config
 * - Mixed or code files (.ts, .js, .cpp, .hpp, etc.) → code
 */
export function detectSliceType(writes: string[]): SliceType {
  if (writes.length === 0) return 'code';

  const allMd = writes.every((w) => w.endsWith('.md') || w.includes('docs/'));
  if (allMd) return 'docs';

  const allConfig = writes.every((w) =>
    /\.(yaml|yml|json|toml|ini|cfg)$/i.test(w) || w.includes('config'),
  );
  if (allConfig) return 'config';

  const allRefactor = writes.every((w) =>
    /\.(ts|js|tsx|jsx)$/.test(w) && !w.includes('test'),
  );
  if (allRefactor && writes.length <= 3) return 'refactor';

  return 'code';
}

export interface GateResult {
  command: string;
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /**
   * 失败用例摘要（ZD-027）。
   *
   * 只对**失败**的命令有意义 —— 命令通过时为空/省略。
   *
   * 为什么需要：原 `gate.result` 事件把 stdout 截到头 500 字符，
   * 而那几行恰好是**前面通过了**的用例，真正失败的用例在中间段被截掉了。
   * agent 拿到的是「2333 个用例里错了，错哪个不知道」。这里把
   * 「哪几个用例挂了、断言说了什么」抽成结构化摘要，随事件一起落盘。
   *
   * 抽不出时为空数组 —— **空不等于通过**，只表示「没抽到」。
   */
  failures?: GateFailureSummary[];
  /**
   * 运行器原文里声明的失败总数（`X tests failed`）。
   * 抽出比总数少时，呈现层要说明「还有 N 条没抽到」。抽不出为 null。
   */
  reportedFailureCount?: number | null;
  /** 识别出的测试运行器（用于呈现与排查）。 */
  runner?: string;
}

/**
 * Outcome of the slice-level acceptance step.
 *
 * `skipped` means "there was nothing to run" (no acceptance configured, or
 * the slice has no acceptance target and `required` is false). It is never
 * used for a run that was attempted and failed — that is `failed`.
 */
export interface AcceptanceOutcome {
  status: 'passed' | 'failed' | 'skipped';
  /** The acceptance target that was run (or would have been run). */
  path: string | null;
  /** The command as actually executed (after `{acceptance}` substitution). */
  command: string | null;
  /** Why the step was skipped / failed, when there is something to say. */
  reason?: string;
  /** The concrete test files that were executed (relative to the gate root). */
  files?: string[];
  exitCode?: number | null;
  durationMs?: number;
}

export interface GateReport {
  sliceId: string;
  passed: boolean;
  results: GateResult[];
  retryCount: number;
  totalDurationMs: number;
  /** Result of the slice-level acceptance step, when one was configured. */
  acceptance?: AcceptanceOutcome;
  /**
   * 门禁作用域的事实（ADR-097）。
   *
   * **为什么必须有**：门禁过了到底意味着什么，取决于这轮跑的是
   * 全量还是本片相关的子集。不说清楚，收窄就成了「悄悄降级的门禁」。
   */
  scope?: GateScopeFacts;
}

/**
 * 门禁作用域的事实（ADR-097 决策五）。
 *
 * 全部字段都是「已经算好的事实」，不含判定 —— 判定在呈现层。
 */
export interface GateScopeFacts {
  /** 这轮是不是收窄跑的。 */
  scoped: boolean;
  /** 按哪些标签收窄的（没收窄时为空）。 */
  labels: string[];
  /** 为什么收窄 / 为什么没收窄。 */
  source: ScopeSource;
  /** 人话说明。 */
  reason: string;
  /** 收窄后实际跑的用例数（没收窄时为 null）。 */
  testCount: number | null;
  /** 全量有多少个用例（对比用；没枚举时为 null）。 */
  totalTestCount: number | null;
}
