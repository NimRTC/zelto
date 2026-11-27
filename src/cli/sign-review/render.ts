// 终端渲染 —— `zelto sign --review` 的单屏结构化文本（ADR-070 §5.3）
//
// 纯函数：只吃 `SignCheck[]` 与 `SignReviewFacts`，吐文本，不做任何 IO。
// 80x24 视口内一屏铺开，复用 `src/cli/color.ts` 的颜色/图标体系。
// 结构固定为六段 + 签字≠合并提示行（ADR-018 锚点），任何事实都聚合到
// 固定行数 —— 宁可丢细节也不超屏（一屏铺开、不分页是验收标准）。

import { colors } from '../color.js';
import type { SignCheck } from '../../core/sign-review/types.js';
import type { SignReviewFacts } from '../../core/sign-review/types.js';
import { describeScope } from '../../core/sign-review/evaluate.js';

/** 渲染视口。宽度控制每行截断，高度由结构固定行数保证不超。 */
export interface SignReviewViewport {
  width?: number;
  height?: number;
}

const DEFAULT_VIEWPORT: Required<SignReviewViewport> = { width: 80, height: 24 };

/**
 * 单屏预算 —— 除文件清单外的固定行数。
 *
 * 头 1 + 分隔 1 + 追溯链 4 + 验收 2 + 改动标题 1 + 脚注 1 + 分隔 1
 * + 成本 1 + 停机 1 + 分隔 1 + 四项确认 5 + 分隔 1 + 签字≠合并 1 = 21
 *
 * **这个数字是数出来的，不是估的** —— 改动段的文件清单要挤进剩下的行里，
 * 挤不下就少列几个（宁可少列也不超屏，ADR-070 §5.3）。
 */
const FIXED_LINE_COUNT = 21;

/**
 * 文件清单最多列几个文件（实际上限；实际取视口余量的较小者）。
 *
 * 留一行给「… 还有 N 个文件」—— 有漏报的文件时**必须说出来**，
 * 不能让人以为清单就是全部。
 */
const DIFF_FILE_BUDGET = 3;

/**
 * 渲染一片切片的签字复查。
 *
 * @param checks   `evaluateSignChecks` 的四项确认项
 * @param facts    收集层算好的事实
 * @param viewport 可选视口（默认 80x24）
 * @returns 单屏文本（不以换行结尾 —— 调用方决定怎么输出）
 */
export function renderSignReview(
  checks: SignCheck[],
  facts: SignReviewFacts,
  viewport: SignReviewViewport = {},
): string {
  const width = viewport.width ?? DEFAULT_VIEWPORT.width;
  const height = viewport.height ?? DEFAULT_VIEWPORT.height;

  const lines: string[] = [];

  // 头
  lines.push(truncate(`${colors.bold(facts.sliceId)} · 状态 ${facts.sliceState}`, width));
  lines.push(divider(width));

  // ① 追溯链
  lines.push(sectionTitle('追溯链'));
  lines.push(traceLine('req', '需求', facts.trace.requirements, width));
  lines.push(traceLine('ctr', '契约', facts.trace.contracts, width));
  lines.push(traceLine('tst', '测试', facts.trace.tests, width));

  // ② 验收（门禁②）
  lines.push(sectionTitle('验收（门禁②）'));
  lines.push(`  ${formatAcceptance(facts)}`);

  // ③ 改动 —— **文件级清单**（ADR-072 §5.2 的「签字要看得见改了什么」）
  //
  // 以前这一段只有三个数字（文件数 / 增删行），
  // 人要判断「这个改动该不该签」时最缺的是**哪些文件**。
  // 现在把 core 收集的文件清单直接列出来 —— 与 `zelto diff` 同一份。
  lines.push(sectionTitle(formatDiffHeading(facts.diff)));
  const fileLines = renderDiffFiles(facts.diff.files, width, diffFileBudget(height));
  for (const l of fileLines) lines.push(l);
  lines.push(`  ${colors.dim(formatDiffFooter(facts.diff, facts.sliceId))}`);
  lines.push(divider(width));

  // ④ 成本
  lines.push(sectionTitle(`成本 $${formatUsd(facts.cost.totalUsd)}`));

  // ⑤ 停机
  lines.push(sectionTitle(formatStall(facts)));
  lines.push(divider(width));

  // ⑥ 四项确认项
  lines.push(sectionTitle('签字前请确认四件事'));
  for (const check of checks) {
    lines.push(`  ${check.ok ? colors.green('✓') : colors.red('✗')} ${checkLabel(check.label)}${formatEvidence(check.evidence, width - 18)}`);
  }
  lines.push(divider(width));

  // 签字 ≠ 合并（ADR-018 锚点）
  lines.push(`  ${colors.warn(`签字不等于合并：合入主干需另跑 zelto merge ${facts.sliceId}`)}`);

  return lines.join('\n');
}

// ─── 小工具 ──────────────────────────────────────────────────────────────────

/**
 * 改动段标题 —— 文件数 + 增删行。
 *
 * **保留「改动」两个字** —— 签字复查的段标题是稳定的锚点
 * （验收测试按段标题断言），不能因为加了文件清单就改掉。
 */
function formatDiffHeading(diff: SignReviewFacts['diff']): string {
  const files = diff.files ?? [];
  const count = diff.filesChanged ?? files.length;
  return `改动（${count} 文件 · +${diff.addedLines ?? 0} -${diff.deletedLines ?? 0}）`;
}

/**
 * 文件清单最多占几行 —— 由视口高度算出来。
 *
 * 固定结构占 `FIXED_LINE_COUNT` 行，剩下的是文件清单的预算，
 * 再留一行给「… 还有 N 个文件」的漏报提示。
 *
 * 高度不够时（预算 ≤ 0）→ 一个文件都不列，但**漏报提示仍然要给** ——
 * 让人知道「这里本来有文件但屏幕放不下」，比让人以为「没改动」强。
 */
function diffFileBudget(height: number): number {
  const free = height - FIXED_LINE_COUNT - 1;
  return Math.max(0, Math.min(DIFF_FILE_BUDGET, free));
}

/**
 * 改动段的文件清单 —— 单屏预算内列前几个。
 *
 * **为什么要有预算**：ADR-070 §5.3 要求「单屏铺开、不分页」，
 * 80x24 是验收标准。文件可能有几十个 —— 全部列出来就超屏了。
 * 宁可只列前几个 + 一行「还有 N 个」，也不要超屏。
 *
 * 选哪几个：`core/sign-review/diff.ts` 已经按「该看的先看」排过序
 * （删除 → 未跟踪 → 新增 → 改名 → 修改），所以取前 N 个就是最该看的 N 个。
 *
 * @returns 渲染出来的行（**已含**「还有 N 个」那一行）
 */
function renderDiffFiles(
  files: SignReviewFacts['diff']['files'] | undefined,
  width: number,
  budget: number,
): string[] {
  const list = files ?? [];
  if (list.length === 0) return [];

  const shown = list.slice(0, budget);
  const lines = shown.map(
    (f) => `  ${diffStatusMarker(f.status)} ${truncate(f.path, width - 14)}${diffLineDelta(f)}`,
  );

  if (list.length > shown.length) {
    lines.push(colors.dim(`  … 还有 ${list.length - shown.length} 个文件`));
  }
  return lines;
}

/**
 * 改动段的脚注 —— 基准 + 完整 diff 的入口。
 *
 * **基准必须说出来**：人签字时要能回答「相对什么算的改动」。
 * 以前这一段完全没提基准（只按 HEAD 算），现在写清楚。
 */
function formatDiffFooter(diff: SignReviewFacts['diff'], sliceId: string): string {
  const parts: string[] = [];
  if (diff.baseNote) parts.push(diff.baseNote);
  parts.push(`完整 diff：zelto diff ${sliceId}`);
  return parts.join(' · ');
}

/** 改动类型 → 记号 + 颜色。 */
function diffStatusMarker(status: string): string {
  switch (status) {
    case 'added':
      return colors.green('+');
    case 'modified':
      return colors.yellow('✎');
    case 'deleted':
      return colors.red('−');
    case 'renamed':
    case 'copied':
      return colors.cyan('»');
    case 'untracked':
      return colors.green('*');
    default:
      return colors.dim('?');
  }
}

/** 行数增量 —— 没有行数（二进制/未跟踪）就不显示。 */
function diffLineDelta(file: { added: number | null; deleted: number | null }): string {
  const added = file.added ?? 0;
  const deleted = file.deleted ?? 0;
  if (added === 0 && deleted === 0) return '';
  const parts: string[] = [];
  if (added > 0) parts.push(colors.green(`+${added}`));
  if (deleted > 0) parts.push(colors.red(`-${deleted}`));
  return ` ${colors.dim('(')}${parts.join(' ')}${colors.dim(')')}`;
}

/**
 * 佐证文案的呈现 —— 正常截断（ADR-104 决策三）。
 *
 * **为什么佐证里已经有作用域，还要在这里再处理一次**：
 * 佐证文案是「结论 · 作用域说明」两段，作用域说明正是这次要让人看见的东西。
 * 但**这一行的宽度本来就不够**（标签占 14 列 + 前缀），
 * 统一截断会把它切掉 —— 人看到「…· 按写集收窄跑的（标签…」这样一个断句，
 * **等于没看见**（比不显示更糟：看起来像显示过了）。
 *
 * 所以做法是：**作用域说明在「验收（门禁②）」段已经完整显示**
 * （那一段是整行，宽度充足），这里的确认项行只是**结论的复述**，
 * 截断到「按写集收窄」这几个字就够人认出了 ——
 * 真正要核对数字时，看上面那一段。
 *
 * **为什么不换行**：渲染的验收标准是「单屏铺开、不分页」（ADR-070 §5.3），
 * 多一行就可能超屏。所以**放在同一行末尾**。
 */
function formatEvidence(evidence: string, width: number): string {
  return truncate(evidence, width);
}

/** 一行的水平分隔线 —— 全宽。 */
function divider(width: number): string {
  return colors.dim('─'.repeat(width));
}

/** 段落标题：加粗 + 青色（与 formatSection 同一套体系）。 */
function sectionTitle(title: string): string {
  return colors.bold(colors.cyan(title));
}

/** 追溯行：`req  <值> ✓`。多于一条时聚合为「首条 等 N 项」。 */
function traceLine(kind: string, label: string, items: string[], width: number): string {
  const value = items.length === 0
    ? '无记录'
    : items.length === 1
      ? items[0]
      : `${items[0]} 等 ${items.length} 项`;
  const ok = items.length > 0;
  const marker = ok ? colors.green('✓') : colors.red('✗');
  return truncate(`  ${kind}  ${label}：${value}  ${marker}`, width);
}

/**
 * 验收段内容 —— 说清跑没跑、跑没跑过、结论是什么（ADR-033）。
 *
 * **作用域**（ADR-104 决策三）：收窄发生时要在**紧邻结论**处说明
 * 「这轮跑的是不是全量」——
 *
 * 为什么放在这里而不是单独开一段：人签字前需要知道「门禁跑的是不是全量」。
 * 收窄是**工具的判断**（规则是人配的），人签字时看不到它
 * = 人在**不知情**的情况下批准。
 *
 * 与 ADR-097 决策五的 `--full`（人的出口）是同一件事的两面：
 * **看得见收窄 → 才有「按全量重跑」这个动作**。
 */
function formatAcceptance(facts: SignReviewFacts): string {
  const g = facts.gate;
  if (!g.acceptanceRan) {
    return (
      colors.red('✗') +
      ' gate.result 事件没有 acceptance 记录 —— 本片没有真正被验收过' +
      scopeSuffix(g.scope)
    );
  }
  if (!g.acceptancePassed) {
    return (
      colors.red('✗') +
      ` acceptance 跑过但未通过（${g.passCount}/${g.totalCount}）` +
      scopeSuffix(g.scope)
    );
  }
  if (g.totalCount > 0) {
    return (
      colors.green('✓') +
      ` ${g.passCount}/${g.totalCount} passed · 跑的是本片验收文件` +
      scopeSuffix(g.scope)
    );
  }
  return colors.green('✓') + ' acceptance 通过（本片验收文件）' + scopeSuffix(g.scope);
}

/**
 * 作用域说明后缀 —— 复用 core 的同一份措辞（ADR-104 决策六）。
 *
 * **判据与事实必须共用**（D-11 教训：两处各判一套会漂移）；
 * 呈现可以各有一份（CLI 是文本，Web 是 HTML），但**内容必须同源**。
 */
function scopeSuffix(scope: SignReviewFacts['gate']['scope'] | undefined): string {
  const note = describeScope(scope);
  return note ? ` · ${note}` : '';
}

/** 成本 —— 美元金额，两位小数。 */
function formatUsd(usd: number): string {
  return (Number.isFinite(usd) ? usd : 0).toFixed(2);
}

/** 停机段 —— 有记录时给出分类，没有时明说无记录。 */
function formatStall(facts: SignReviewFacts): string {
  if (facts.stall.stalled && facts.stall.stallClass !== null) {
    return `停机历史 ${facts.stall.stallClass}`;
  }
  return '停机历史 无记录';
}

/** 确认项标签 —— 按显示宽度补齐到 14 列，让 evidence 对齐。 */
function checkLabel(label: string): string {
  return padRight(label, 14);
}

/** 按显示宽度（CJK 占 2 列）截断到 width，超出以 … 收尾。 */
function truncate(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** 把字符串按显示宽度右补齐到 width（CJK 及宽字符按 2 列）。 */
function padRight(s: string, width: number): string {
  const pad = width - displayWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

/** 显示宽度：CJK 统一表意区及更宽的字符算 2 列，其余算 1 列。 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    w += code >= 0x2e80 ? 2 : 1;
  }
  return w;
}
