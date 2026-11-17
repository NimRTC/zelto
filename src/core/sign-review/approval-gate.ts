// 签字批准前的闸门判定（D-48）—— 纯函数、零 IO
//
// 病灶（nimrtc-zelto，2026-11-17）：
//   `v2-input-binder` 的验收测试文件里三条用例**全是 `test.todo`** ——
//   一条真断言都没有；规格的 5 条验收标准**一条都没被验证过**。
//   而项目的 `config.yaml` 没配 `gate.acceptance` → 门禁②的验收步骤
//   记为 `skipped`（ADR-033 的 fail-closed 语义压根没被触发）。
//   于是 gate 报 `passed: true`，签字请求照常发出，人面前一片绿灯。
//
//   真正的判定在 ADR-070 的 `sign --review` 里（它确实抓到了：
//   「验收真跑过本片 ❌」）—— 但 `zelto sign <id> --approve`
//   **不经过它**。审查工具存在，签字路径绕过审查 —— 这就是 D-48。
//
// 本模块提供纯判定：给定四项确认的结果，回答「能不能批准」。
// C3：纯计算、确定性 —— 不读文件、不跑 git、不调模型、不触网。

import type { SignCheck } from './types.js';

/** 批准闸门的判定结论 */
export interface SignApprovalGate {
  /** 是否可以批准 */
  approvable: boolean;
  /** 拦下来的确认项（标签 + 佐证） */
  blockers: SignCheck[];
  /** 没有被拦的确认项 */
  passed: SignCheck[];
}

/**
 * 判断四项签字前确认是否允许批准。
 *
 * 规则：**任何一项不过就不可批准**（fail closed）。
 *
 * 为什么是「任何一项」而不是「只有验收」：
 * 四项确认是签字的**全部依据**（ADR-070 §5.2）。签字的动作是
 * 「人确认这片东西真的达到了规格」。如果四项里有两项不过，
 * 那么签字这个动作本身就没有成立的依据 —— 它退化成「点一下按钮」。
 *
 * 「产物真落地」这一项在**首次**实现时通常是 `not-in-trunk` ——
 * 因为产物要先合入主干才算落地，而合并在签字之后。所以把它
 * 拦下来会挡住正常流程。这一项由调用方按流程阶段决定是否计入，
 * 本函数不做这个判断（见 `excludeLabels`）。
 */
export function evaluateSignApprovalGate(
  checks: SignCheck[],
  options: { excludeLabels?: string[] } = {},
): SignApprovalGate {
  const exclude = new Set(options.excludeLabels ?? []);
  const considered = checks.filter((c) => !exclude.has(c.label));

  const blockers = considered.filter((c) => !c.ok);
  const passed = considered.filter((c) => c.ok);

  return {
    approvable: blockers.length === 0,
    blockers,
    passed,
  };
}

/**
 * 签字时默认豁免的确认项。
 *
 * 「产物真落地」：产物要在**合并之后**才出现在主干里（ADR-059）。
 * 签字发生在合并之前，所以这一项在签字阶段必然是 `not-in-trunk` ——
 * 把它算作阻塞项，等于让任何一片都签不了。
 *
 * 这一项属于**合并**阶段的确认，不是签字阶段的。
 */
export const SIGN_APPROVAL_DEFAULT_EXEMPT = ['产物真落地'];

/**
 * 把拦截结果渲染成人能读的文本。
 *
 * 措辞要回答两件事：**为什么拦**、**怎么解** ——
 * 拦下来却不给人出路，等于把人困住（ADR-020「交回给人」的精神）。
 */
export function renderSignApprovalBlockers(blockers: SignCheck[]): string {
  if (blockers.length === 0) return '';
  const lines: string[] = [];
  lines.push('签字被拦下 —— 签字前确认项没有全部通过：');
  for (const b of blockers) {
    lines.push(`  ✗ ${b.label}`);
    lines.push(`      ${b.evidence}`);
    lines.push(`      （判据：${b.adrRef}）`);
  }
  lines.push('');
  lines.push('  这些不是「工具挑刺」——每一项都对应「这片东西到底有没有被验证过」。');
  lines.push('  先解决它们，再签字；或用 `zelto sign --review <id>` 看完整事实。');
  lines.push('  确认要跳过（明知故犯）：zelto sign <id> --approve --force');
  return lines.join('\n');
}
