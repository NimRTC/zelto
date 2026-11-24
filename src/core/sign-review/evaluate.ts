// 签字前确认项的纯函数评估（ADR-070 §5.2）
//
// 四项确认项，各有一条 ADR 锚点：
//   1. 追溯链未断     —— 判据 evaluateFreezeTrace（ADR-060/032）
//   2. 验收真跑过本片 —— 判据 gate.result 事件的 acceptance 字段（ADR-033/051）
//   3. 改动在写集内   —— 判据写集审计结论 violations.length === 0（ADR-014）
//   4. 产物真落地     —— 判据 ArtifactEvidence（ADR-059/061）
//
// C3：纯计算、确定性 —— 只读入参，不碰文件、不跑 git、不调模型、不触网。
// 同一份 facts 永远得到同一份结果；可复现、可审计、不修改入参。

import { evaluateFreezeTrace } from '../spec/trace-extract.js';
import type { GateScopeFacts, SignReviewFacts, SignCheck } from './types.js';

/** 输出四项签字前确认项（ADR-070 §5.2），顺序固定 */
export function evaluateSignChecks(facts: SignReviewFacts): SignCheck[] {
  return [
    evaluateTraceCheck(facts),
    evaluateAcceptanceCheck(facts),
    evaluateWriteSetCheck(facts),
    evaluateArtifactCheck(facts),
  ];
}

/** ① 追溯链未断 —— 判据 evaluateFreezeTrace（ADR-060/032） */
function evaluateTraceCheck(facts: SignReviewFacts): SignCheck {
  const gate = evaluateFreezeTrace(
    {
      trace: facts.trace,
      traceWaiver: null,
      baseline: false,
    },
    '',
  );
  const ok = gate.blocking.length === 0;
  return {
    label: '追溯链未断',
    ok,
    evidence: ok
      ? '需求/契约/测试三条追溯均非空，冻结准入判据通过'
      : `追溯断裂：${gate.blocking.map((v) => v.message).join('；')}`,
    adrRef: 'ADR-060/032',
  };
}

/**
 * ② 验收真跑过本片 —— 判据 gate.result 事件的 acceptance 字段（ADR-033/051）
 *
 * **判据不变**（仍是 `ran && passed`）——
 * 收窄的 fail closed 已经在**门禁侧**承担了（ADR-097 决策三：
 * 标签一个都没匹配到 → 门禁判失败，不是「跑 0 个用例判通过」）。
 * 签字侧再判一次是**重复**，且没有新信息。
 *
 * 变的是**佐证文案**（ADR-104 决策二）：收窄发生时要说清
 * 「这轮跑的是本片相关的用例，依据是哪些标签」。
 *
 * **为什么只改文案不改判据**：
 *   1. 门禁侧已经 fail closed —— 重复判定不增加安全；
 *   2. 判据加严会让**老事件**签名失败（老事件必然是全量跑的，
 *      没有作用域字段），而全量当然完整；
 *   3. 人签字时需要的是**看得见**，不是**更严**——
 *      「规则配窄了 → 本片该验的用例没被验」是真实存在的失败模式
 *      （`gate.scope` 的规则是**人配的**），而文案里的
 *      「全量 N 个里选了 M 个」正是让人发现它的那个信息。
 */
function evaluateAcceptanceCheck(facts: SignReviewFacts): SignCheck {
  const ran = facts.gate.acceptanceRan;
  const passed = facts.gate.acceptancePassed;
  const ratio = `${facts.gate.passCount}/${facts.gate.totalCount}`;
  let evidence: string;
  if (!ran) {
    evidence = 'gate.result 事件没有 acceptance 记录——本片没有真正被验收过';
  } else if (!passed) {
    evidence = `acceptance 跑过但未通过（${ratio}）`;
  } else {
    evidence = `gate.result 事件记录了 acceptance 通过（${ratio}）`;
  }
  // ADR-104 决策二：收窄发生时把作用域拼进佐证。
  const scopeNote = describeScope(facts.gate.scope);
  if (scopeNote) {
    evidence = `${evidence} · ${scopeNote}`;
  }
  return {
    label: '验收真跑过本片',
    ok: ran && passed,
    evidence,
    adrRef: 'ADR-033/051',
  };
}

/**
 * 把门禁作用域渲染成一句人话（ADR-104 决策二 / 决策三）。
 *
 * 三种句式：
 * - 收窄了，两个数都在 → `按写集收窄跑的（标签 ice、sdp）· 全量 2387 个里选了 42 个`
 * - 收窄了，只有标签 → `按写集收窄跑的（标签 ice）`
 * - 没收窄，但有原因 → `门禁跑的是全量（原因）`
 *
 * **没收窄且没原因** → 空串（调用方不拼）。
 *
 * **为什么「全量 N 个里选了 M 个」要说清是「全量」**：
 * 人看到「42 个」可能以为验得少 —— 要说清**被排除的是与本片无关的用例**，
 * 而不是「少验了」。所以句式是「全量 2387 个里选了 42 个」，
 * 主语是全量，不是「42」。
 *
 * **两个数都在才用那个句式**（ADR-104 实现要点 3）：
 * 没收窄或枚举失败时 `totalTestCount` 是 null，拼出「全量 null 个」是胡说。
 */
export function describeScope(scope: GateScopeFacts | undefined): string {
  // 老夹具 / 老消费方可能没有 scope 字段（ADR-104 决策一：
  // scope 是**加字段**，老数据不带）—— 不带就当「没有作用域说明」。
  if (!scope) return '';
  if (scope.scoped) {
    const labels = scope.labels.length > 0 ? scope.labels.join('、') : '（无标签）';
    const counts =
      scope.testCount !== null && scope.totalTestCount !== null
        ? ` · 全量 ${scope.totalTestCount} 个里选了 ${scope.testCount} 个`
        : '';
    return `按写集收窄跑的（标签 ${labels}）${counts}`;
  }
  if (scope.reason) {
    return `门禁跑的是全量（${scope.reason}）`;
  }
  return '';
}

/** ③ 改动在写集内 —— 判据写集审计结论 violations.length === 0（ADR-014） */
function evaluateWriteSetCheck(facts: SignReviewFacts): SignCheck {
  const violations = facts.writeSetAudit.violations;
  const ok = violations.length === 0;
  return {
    label: '改动在写集内',
    ok,
    evidence: ok
      ? '写集审计无越界写入'
      : `写集审计发现 ${violations.length} 处越界：${violations.join('、')}`,
    adrRef: 'ADR-014',
  };
}

/** ④ 产物真落地 —— 判据 ArtifactEvidence（ADR-059/061） */
function evaluateArtifactCheck(facts: SignReviewFacts): SignCheck {
  const artifact = facts.artifact;
  if (artifact.status === 'in-trunk') {
    const where = artifact.path === null ? '' : `：${artifact.path}`;
    return {
      label: '产物真落地',
      ok: true,
      evidence: `产物已在主干找到${where}`,
      adrRef: 'ADR-059/061',
    };
  }
  if (artifact.status === 'unknown') {
    return {
      label: '产物真落地',
      ok: false,
      evidence: '产物证据未知、未核对（HEAD 读不到或非 git 仓库等）',
      adrRef: 'ADR-059/061',
    };
  }
  return {
    label: '产物真落地',
    ok: false,
    evidence: '产物不在主干',
    adrRef: 'ADR-059/061',
  };
}
