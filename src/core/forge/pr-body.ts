// PR title / body 的确定性渲染（ADR-094 §6.2 / §6.3）
//
// **纯函数** —— 同样的事实永远渲染出同样的文本（C3）。
// 这不是「文案」，是**契约的一部分**：body 里的追溯块要被工具解析，
// 格式漂了就等于契约破坏。
//
// 所以这里的每一个字段都来自 `ForgeTraceFacts`（已算好的事实），
// 渲染层**不重新判定**任何事 —— 判定只有一处（ADR-070）。
//
// 两个受众，一份 body：
//
// - **人**：看得懂的摘要表 + 「这片是什么」；
// - **机器**：HTML 注释里的 `<!-- zelto-trace ... -->` JSON 块。
//
// 为什么要放 HTML 注释里：GitHub 渲染 markdown 时 HTML 注释**不可见**，
// 所以人看到的是干净的摘要，机器读到的是完整的结构化数据。两全其美。
//
// 为什么用 JSON 而不是 YAML（ADR-094 D6）：JSON 在 HTML 注释里最安全
// —— 不必担心 `#` 开头被当注释、不必担心缩进被 GitHub 编辑器吃掉，
// 且 `JSON.parse` 无依赖。

import type { ForgeTraceFacts } from './collect.js';

/** 追溯块的格式版本 —— 将来加字段时，解析方靠它判断代际 */
export const TRACE_BLOCK_SCHEMA = 'zelto-trace/1';

/** 追溯块的形状（机器可读部分） */
export interface TraceBlock {
  schema: string;
  sliceId: string;
  title: string;
  specPath: string;
  frozenHash: string | null;
  boundaryHash: string | null;
  signId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  gate: {
    passed: boolean;
    acceptanceRan: boolean;
    acceptancePassed: boolean;
    passCount: number;
    totalCount: number;
  };
  trace: {
    requirements: number;
    contracts: number;
    tests: number;
  };
  writeSetViolations: string[];
  stalled: boolean;
  stallClass: string | null;
  costUsd: number;
  artifact: string;
  baseBranch: string;
  headBranch: string;
  writtenAt: string;
}

/** 渲染 PR 的完整输出 */
export interface RenderedPr {
  /** PR 标题 */
  title: string;
  /** PR 正文 */
  body: string;
  /** 追溯块（结构化，便于测试与将来的工具消费） */
  trace: TraceBlock;
}

/**
 * 渲染 PR title。
 *
 * 标题带上前缀 `[zelto]` —— 远端 reviewer 在 PR 列表里一眼就知道
 * 这个 PR 的来历（这是驾驶舱开的，不是随手提的）。
 */
export function renderPrTitle(facts: ForgeTraceFacts): string {
  return `[zelto] ${facts.title}`;
}

/**
 * 渲染 PR body。
 *
 * @param facts 追溯链事实
 * @param now 写入时刻（ISO 8601）—— 由调用方给，渲染层不读时钟
 *   （纯函数：同样输入永远同样输出，测试也不必去 mock 时间）
 */
export function renderPrBody(facts: ForgeTraceFacts, now: string): RenderedPr {
  const trace = buildTraceBlock(facts, now);
  const lines: string[] = [];

  // 追溯块 —— 机器可读，人看不见。
  lines.push('<!-- zelto-trace');
  lines.push(JSON.stringify(trace));
  lines.push('-->');
  lines.push('');

  // ── 摘要表：人看的部分 ────────────────────────────────────────────────
  lines.push('## 追溯链');
  lines.push('');
  lines.push('| 环节 | 结果 |');
  lines.push('|---|---|');
  lines.push(
    `| 追溯项 | 需求 ${trace.trace.requirements} / 契约 ${trace.trace.contracts} / 测试 ${trace.trace.tests} |`,
  );
  lines.push(`| 门禁② | ${trace.gate.passed ? '✅ 通过' : '❌ 未通过'} |`);
  lines.push(`| 验收 | ${acceptanceLabel(trace.gate)} |`);
  lines.push(
    `| 写集越界 | ${trace.writeSetViolations.length === 0 ? '无' : `⚠️ ${trace.writeSetViolations.length} 处`} |`,
  );
  lines.push(`| 停机 | ${trace.stalled ? `⚠️ ${trace.stallClass ?? '是'}` : '无'} |`);
  lines.push(`| 成本 | $${trace.costUsd.toFixed(2)} |`);
  lines.push(`| 产物在主干 | ${artifactLabel(trace.artifact)} |`);
  lines.push('');

  // ── 人工核对：让人能自己去核对，而不是只能信这段话 ────────────────────
  lines.push('## 人工核对');
  lines.push('');
  lines.push(`- 冻结规格哈希：\`${facts.frozenHash ?? '（未冻结）'}\``);
  lines.push(`- 边界摘要（写集 + 门禁命令）：\`${facts.boundaryHash ?? '（未钉）'}\``);
  lines.push(`- 签字请求：\`${facts.signId ?? '（无）'}\``);
  if (facts.approvedBy) {
    lines.push(`- 批准人：${facts.approvedBy}${facts.approvedAt ? `（${facts.approvedAt}）` : ''}`);
  }
  lines.push(`- 规格路径：\`${facts.specPath}\``);
  lines.push(`- 分支：\`${facts.headBranch}\` → \`${facts.baseBranch}\``);
  lines.push('');

  // ── 合并在 zelto 里显式执行（ADR-094 D7）────────────────────────────
  //
  // 这句**必须**在 body 里 —— 远端 reviewer 看到 PR 就会以为
  // 「合并 = 点 merge 按钮」。不写这句，他就会这么以为，
  // 而 zelto 的合并是单点的（ADR-018）。
  lines.push('## 合并方式');
  lines.push('');
  lines.push(
    `本 PR 由 zelto 驾驶舱开。**批准权在 zelto 里** —— ` +
      `GitHub 上点 approve 不会触发合并。`,
  );
  lines.push('');
  lines.push(`合并是显式动作：`);
  lines.push('');
  lines.push('```');
  lines.push(`zelto merge ${facts.sliceId}`);
  lines.push('```');
  lines.push('');

  return {
    title: renderPrTitle(facts),
    body: lines.join('\n'),
    trace,
  };
}

/**
 * 组装机器可读的追溯块。
 *
 * **只放已经算好的事实** —— 不放「结论」。
 * 「门禁过没过」在 `gate.passed` 里，但「该不该合」的判断不在这块里
 * —— 那是 `zelto merge` 的事（ADR-018 / ADR-094 D7）。
 */
export function buildTraceBlock(facts: ForgeTraceFacts, now: string): TraceBlock {
  const review = facts.review;
  return {
    schema: TRACE_BLOCK_SCHEMA,
    sliceId: facts.sliceId,
    title: facts.title,
    specPath: facts.specPath,
    frozenHash: facts.frozenHash,
    boundaryHash: facts.boundaryHash,
    signId: facts.signId,
    approvedBy: facts.approvedBy,
    approvedAt: facts.approvedAt,
    gate: {
      // 判据与 `core/sign-review/evaluate.ts` 的「② 验收真跑过本片」**一致**：
      // 「跑过」且「通过」。
      //
      // **不能**额外要求 `passCount > 0` ——
      // 用例数是从验收 stdout 里解析出来的，而门禁**没有把 stdout 存进事件**
      // （`AcceptanceOutcome` 只留 status/exitCode/durationMs/reason）。
      // 于是 `passCount` 对所有走「显式验收配置」路径的片**恒为 0**。
      // 加上 `passCount > 0` 这个条件，会把一片**验收确实过了**的片
      // 在 PR body 里写成「门禁② ❌ 未通过」——
      // 追溯链说假话，比没有追溯链更糟（远端 reviewer 会据此拒绝一片好片）。
      //
      // 用例数拿不到就**拿不到**（ADR-059：不冒充数字），
      // 但不能因为拿不到就推翻「验收通过」这个**明确记录在案**的结论。
      passed: review.gate.acceptanceRan && review.gate.acceptancePassed,
      acceptanceRan: review.gate.acceptanceRan,
      acceptancePassed: review.gate.acceptancePassed,
      passCount: review.gate.passCount,
      totalCount: review.gate.totalCount,
    },
    trace: {
      requirements: review.trace.requirements.length,
      contracts: review.trace.contracts.length,
      tests: review.trace.tests.length,
    },
    writeSetViolations: review.writeSetAudit.violations,
    stalled: review.stall.stalled,
    stallClass: review.stall.stallClass,
    costUsd: review.cost.totalUsd,
    artifact: review.artifact.status,
    baseBranch: facts.baseBranch,
    headBranch: facts.headBranch,
    writtenAt: now,
  };
}

/** 产物证据的三态 → 人话 */
function artifactLabel(status: string): string {
  switch (status) {
    case 'in-trunk':
      return '✅ 已在主干';
    case 'not-in-trunk':
      return '未合并（正常 —— 合并是显式动作）';
    default:
      return '未知（HEAD 读不到）';
  }
}

/**
 * 验收结论 → 人话。
 *
 * **用例数拿不到时不显示数字** —— 门禁没把验收 stdout 存进事件
 * （`AcceptanceOutcome` 只留 status/exitCode/durationMs/reason），
 * 所以 `passCount`/`totalCount` 对走「显式验收配置」路径的片恒为 0。
 *
 * 显示成「✅ 0/0」是**自相矛盾**：0 个用例通过了？0 个用例里通过了几个？
 * 人读到只会困惑，不会更信任这块追溯链。
 *
 * 所以分三态（与 `cli/sign-review/render.ts` 的 `formatAcceptance` 同一套）：
 *   - 没跑 → 「⏭️ 未跑」
 *   - 跑了但用例数拿不到 → 「✅ 通过（用例数未记录）」
 *   - 拿得到 → 「✅ 5/5」
 *
 * **不拿 0/0 冒充数字**（ADR-059：查不到就是查不到，绝不冒充）。
 */
function acceptanceLabel(gate: TraceBlock['gate']): string {
  if (!gate.acceptanceRan) return '⏭️ 未跑';
  if (!gate.acceptancePassed) {
    return gate.totalCount > 0 ? `❌ ${gate.passCount}/${gate.totalCount}` : '❌ 未通过';
  }
  if (gate.totalCount > 0) return `✅ ${gate.passCount}/${gate.totalCount}`;
  return '✅ 通过（用例数未记录）';
}
