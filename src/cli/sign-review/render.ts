// 终端渲染 —— `zelto sign --review` 的单屏结构化文本（ADR-070 §5.3）
//
// 纯函数：只吃 `SignCheck[]` 与 `SignReviewFacts`，吐文本，不做任何 IO。
// 80x24 视口内一屏铺开，复用 `src/cli/color.ts` 的颜色/图标体系。
// 结构固定为六段 + 签字≠合并提示行（ADR-018 锚点），任何事实都聚合到
// 固定行数 —— 宁可丢细节也不超屏（一屏铺开、不分页是验收标准）。

import { colors } from '../color.js';
import type { SignCheck } from '../../core/sign-review/types.js';
import type { SignReviewFacts } from '../../core/sign-review/types.js';

/** 渲染视口。宽度控制每行截断，高度由结构固定行数保证不超。 */
export interface SignReviewViewport {
  width?: number;
  height?: number;
}

const DEFAULT_VIEWPORT: Required<SignReviewViewport> = { width: 80, height: 24 };

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

  const lines: string[] = [];

  // 头
  lines.push(truncate(`${colors.bold(facts.sliceId)} · 状态 ${facts.sliceState}`, width));
  lines.push(divider(width));

  // ① 追溯链
  lines.push(sectionTitle('追溯链'));
  lines.push(traceLine('req', '需求', facts.trace.requirements, width));
  lines.push(traceLine('ctr', '契约', facts.trace.contracts, width));
  lines.push(traceLine('tst', '测试', facts.trace.tests, width));
  lines.push(divider(width));

  // ② 验收（门禁②）
  lines.push(sectionTitle('验收（门禁②）'));
  lines.push(`  ${formatAcceptance(facts)}`);
  lines.push(divider(width));

  // ③ 改动
  lines.push(sectionTitle(`改动（${facts.diff.filesChanged} 文件 · +${facts.diff.addedLines} -${facts.diff.deletedLines}）`));
  lines.push(`  完整 diff：zelto diff ${facts.sliceId}`);
  lines.push(divider(width));

  // ④ 成本
  lines.push(sectionTitle(`成本 $${formatUsd(facts.cost.totalUsd)}`));
  lines.push(divider(width));

  // ⑤ 停机
  lines.push(sectionTitle(formatStall(facts)));
  lines.push(divider(width));

  // ⑥ 四项确认项
  lines.push(sectionTitle('签字前请确认四件事'));
  for (const check of checks) {
    lines.push(`  ${check.ok ? colors.green('✓') : colors.red('✗')} ${checkLabel(check.label)}${truncate(check.evidence, width - 18)}`);
  }
  lines.push(divider(width));

  // 签字 ≠ 合并（ADR-018 锚点）
  lines.push(`  ${colors.warn(`签字不等于合并：合入主干需另跑 zelto merge ${facts.sliceId}`)}`);

  return lines.join('\n');
}

// ─── 小工具 ──────────────────────────────────────────────────────────────────

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

/** 验收段内容 —— 说清跑没跑、跑没跑过、结论是什么（ADR-033）。 */
function formatAcceptance(facts: SignReviewFacts): string {
  const g = facts.gate;
  if (!g.acceptanceRan) {
    return colors.red('✗') + ' gate.result 事件没有 acceptance 记录 —— 本片没有真正被验收过';
  }
  if (!g.acceptancePassed) {
    return colors.red('✗') + ` acceptance 跑过但未通过（${g.passCount}/${g.totalCount}）`;
  }
  if (g.totalCount > 0) {
    return colors.green('✓') + ` ${g.passCount}/${g.totalCount} passed · 跑的是本片验收文件`;
  }
  return colors.green('✓') + ' acceptance 通过（本片验收文件）';
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
