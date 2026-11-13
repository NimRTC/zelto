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
import type { SignReviewFacts, SignCheck } from './types.js';

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

/** ② 验收真跑过本片 —— 判据 gate.result 事件的 acceptance 字段（ADR-033/051） */
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
  return {
    label: '验收真跑过本片',
    ok: ran && passed,
    evidence,
    adrRef: 'ADR-033/051',
  };
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
