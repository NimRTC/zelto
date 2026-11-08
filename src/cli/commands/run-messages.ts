// 运行期提示的统一口径 —— 单切片、并行、后台三条路径说同一件事时必须说同一句话
//
// 为什么单独抽一个模块：同一种结局有三个执行路径（`zelto run` 单片、
// `zelto run --parallel` 批量、`zelto run --background` 后台），它们各自的
// 提示语是各写各的。结果是同一个错误（写集越界）在不同路径下措辞不同：
//
//   单片：  ❌ Slice "x" 写集越界 —— 未进入 gate。
//   并行：  ❌ x: 写集越界 — 未进入 gate，切片已退回 frozen，等人处理
//   后台：  ❌ Slice "x" 写集越界 —— 未进入 gate，等人处理。
//
// 人读到的却是三套说法，得自己判断它们是不是同一件事、状态是不是一样。
// 措辞漂移的代价不是"不好看"——是人按 A 路径的提示去操作 B 路径的现场，
// 动作对不上。
//
// 这里只管**措辞与顺序**，不管判定：判定仍然在各自的位置（写集判定在
// `runtime-guard.ts`，预算判定在 `run-support.ts`），避免提示语和判定逻辑
// 一起漂。

/** 结局分类 —— 三条路径共用同一套名字 */
export type RunOutcome = 'write-set-violation' | 'budget-exhausted' | 'agent-failed';

/** 提示的呈现位置 —— 决定要不要带切片 id 前缀 */
export interface MessageContext {
  /** 切片 id */
  sliceId: string;
  /** 是否处在批量输出里（每个切片一行，紧凑） */
  compact?: boolean;
}

/**
 * 写集越界。
 *
 * 三条路径必须说清三件事，一件都不能少：
 *   1. 越界了 —— 这一轮**不算数**（门禁没跑、签字没发）
 *   2. 切片没废 —— 已退回 frozen，扩完写集就能重跑
 *   3. 下一步是什么 —— 具体命令
 *
 * 细节（哪些文件越界、哪些托管文件被篡改）也在这里出 —— 越界信息是
 * 人决定「扩写集还是重做规格」的唯一依据，不能只在某条路径上出现。
 */
export function writeSetViolationMessage(
  ctx: MessageContext,
  detail?: { violations?: string[]; tampered?: string[] },
): string[] {
  const { sliceId } = ctx;
  const violations = detail?.violations ?? [];
  const tampered = detail?.tampered ?? [];

  const lines: string[] = [];
  if (ctx.compact) {
    lines.push(`❌ ${sliceId}: 写集越界 — 未进入 gate，切片已退回 frozen`);
  } else {
    lines.push(`❌ Slice "${sliceId}" 写集越界 —— 未进入 gate。`);
  }

  for (const p of violations) {
    lines.push(`   - ${p}（不在写集内）`);
  }
  for (const p of tampered) {
    lines.push(`   - ${p}（zelto 托管的文件被改动了 —— 门禁可能已被绕过）`);
  }

  if (ctx.compact) {
    lines.push(`   扩写集后重跑: zelto run ${sliceId}`);
  } else {
    lines.push(`   切片已退回 frozen：扩写集后重跑 zelto run ${sliceId}`);
  }
  lines.push(`   事件流：.zelto/events/${sliceId}/events.jsonl`);

  return lines;
}

/**
 * 写集审计失败。
 *
 * 与「越界」是两回事，不能混着说：
 *   - 越界 = 判定成立，agent 确实写了不该写的文件 → 人扩写集；
 *   - 审计失败 = 判定没做成（读不到 git 状态之类），边界**未知** → 人先
 *     把环境修好让审计能跑起来。
 *
 * 措辞混了，人就会去扩写集 —— 而实际问题是环境坏了，扩了写集也没用，
 * 白跑一轮。
 *
 * 与越界同构的一点：这一轮同样不算数（不进 gate、不发签字请求），
 * 切片退回 frozen、可重跑。
 */
export function auditFailedMessage(
  ctx: MessageContext,
  error: string,
): string[] {
  const { sliceId } = ctx;
  const lines: string[] = [];
  if (ctx.compact) {
    lines.push(`⚠️ ${sliceId}: 写集审计失败，无法确认边界 — 未进入 gate，切片已退回 frozen`);
  } else {
    lines.push(`⚠️ Slice "${sliceId}" 写集审计失败，无法确认边界 —— 未进入 gate。`);
  }

  lines.push(`   原因：${error}`);

  if (ctx.compact) {
    lines.push(`   修好审计环境后重跑: zelto run ${sliceId}`);
  } else {
    lines.push(`   切片已退回 frozen：修好审计环境后重跑 zelto run ${sliceId}`);
  }
  lines.push(`   事件流：.zelto/events/${sliceId}/events.jsonl`);

  return lines;
}

/**
 * 预算耗尽。
 *
 * 与写集越界同构：这一轮不算数，但切片没废 —— 停在 frozen 等人处理。
 */
export function budgetExhaustedMessage(
  ctx: MessageContext,
  spent: number,
  limit?: number,
): string[] {
  const { sliceId } = ctx;
  const amount = `$${spent.toFixed(2)}`;
  const limitStr =
    limit !== undefined && Number.isFinite(limit) ? ` / 上限 $${limit.toFixed(2)}` : '';
  if (ctx.compact) {
    return [
      `⛔ ${sliceId}: 预算耗尽（${amount}${limitStr}）— 未进入 gate`,
      `   切片停在 frozen，等人处理`,
    ];
  }
  return [
    `⛔ Slice "${sliceId}" 预算耗尽（${amount}${limitStr}）—— 未进入 gate，等人处理。`,
  ];
}

/**
 * agent 以非零退出码结束。
 */
export function agentFailedMessage(
  ctx: MessageContext,
  exitCode: number | null,
  attempts: number,
  elapsedSec: number,
): string[] {
  const { sliceId } = ctx;
  const code = exitCode === null ? 'signal' : String(exitCode);
  const attemptsStr = attempts > 1 ? ` after ${attempts} attempt(s)` : '';
  if (ctx.compact) {
    return [`❌ ${sliceId}: agent 退出码 ${code}（${elapsedSec}s）${attemptsStr}`];
  }
  return [`❌ Slice "${sliceId}" agent 退出码 ${code}（${elapsedSec}s）${attemptsStr}`];
}

/**
 * 写集审计结论 —— 与 `runtime-guard.ts` 的 `WriteSetVerdict` 对齐。
 *
 * 这里只声明用得到的字段，不 import 运行时模块 —— 提示层不依赖判定层，
 * 免得两条依赖方向搅在一起（措辞归 run-messages，判定归 runtime-guard）。
 */
export interface WriteSetOutcome {
  /** 边界守住了吗 */
  ok: boolean;
  /** 越界写入的文件 */
  violations?: string[];
  /** 被篡改的托管文件 */
  tampered?: string[];
  /** 审计本身失败（读不到 git 状态之类） */
  error?: string;
}

/**
 * 把审计结论排成提示行。
 *
 * 结论只有三种，走向只有两条：
 *   - 通过（ok）→ 没有提示行（返回空数组）
 *   - 越界 → 扩写集重跑
 *   - 审计失败 → 先修审计环境
 *
 * 「越界」与「审计失败」必须分开说：两者的下一步完全不同，
 * 混着说会让人白跑一轮。
 *
 * 三条执行路径（单片 / 并行 / 后台）在同一种结局下必须说同一句话，
 * 所以排版只在这里做一次 —— 调用方只管把结论丢进来。
 */
export function writeSetOutcomeLines(ctx: MessageContext, outcome: WriteSetOutcome): string[] {
  if (outcome.ok) return [];
  if (outcome.error) {
    return auditFailedMessage(ctx, outcome.error);
  }
  return writeSetViolationMessage(ctx, {
    violations: outcome.violations ?? [],
    tampered: outcome.tampered ?? [],
  });
}

/**
 * 把一组提示行打印出来。
 *
 * 单片路径用 `console.log`（与既有的运行输出混在一条流里），
 * 批量路径也用 `console.log`（每片一行，紧凑）——
 * 两者都走 stdout，避免人重定向 stderr 时丢线索。
 */
export function printOutcome(lines: string[]): void {
  for (const line of lines) console.log(line);
}
