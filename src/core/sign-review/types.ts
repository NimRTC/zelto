// 签字复查的共享类型 —— 只放类型、零导入（ADR-070 §4）
//
// 与 evaluate.ts 的依赖方向：本文件不导入任何模块，
// evaluate.ts 只从本文件导入类型，二者不构成循环依赖（切片风险已消解）。
//
// 全部字段都是「已经算好的事实」（ADR-070 §3）：CLI 负责从事件流、git、
// 审计结果里把事实算出来，本模块只声明它们的形状，不做任何 IO。
// 判定逻辑在 evaluate.ts，CLI 与将来的 HTML 共用同一份判定。

/** 产物证据的三态（ADR-059/061） */
export type ArtifactEvidenceStatus = 'in-trunk' | 'not-in-trunk' | 'unknown';

/**
 * 产物证据 —— 语义与 artifact-evidence.ts 一致（ADR-059/061）。
 *
 * 三态：
 *  - `in-trunk`：产物已在主干中找到，path / hash 可佐证；
 *  - `not-in-trunk`：产物不在主干；
 *  - `unknown`：读不到（HEAD 读不到、非 git 仓库等）——
 *    查不到就是查不到，绝不冒充「产物不在主干」（ADR-059 哲学）。
 */
export interface ArtifactEvidence {
  /** 三态 */
  status: ArtifactEvidenceStatus;
  /** 产物在主干中的路径；非 `in-trunk` 时为 null */
  path: string | null;
  /** 产物在主干中的哈希；非 `in-trunk` 时为 null */
  hash: string | null;
  /** 佐证文案；`unknown` 时说明为什么读不到 */
  note: string | null;
}

/** 写集审计结论（ADR-014） */
export interface WriteSetAuditFacts {
  /** 越界写入清单；空数组 = 一切改动都在写集内 */
  violations: string[];
}

/** 签字复查的全部输入事实（ADR-070 §5.1） */
export interface SignReviewFacts {
  /** 切片标识 */
  sliceId: string;
  /** 切片状态（ADR-056 的 SliceState 词汇，CLI 翻译成字符串事实） */
  sliceState: string;
  /** trace 三元组（requirements/contracts/tests，ADR-032） */
  trace: {
    requirements: string[];
    contracts: string[];
    tests: string[];
  };
  /** gate 结果（acceptance 是否跑过、通过数/总数，ADR-033/051） */
  gate: {
    /** acceptance 是否跑过 */
    acceptanceRan: boolean;
    /** acceptance 是否通过 */
    acceptancePassed: boolean;
    /** 通过数 */
    passCount: number;
    /** 总数 */
    totalCount: number;
  };
  /** diff 统计（文件数/增删行） */
  diff: {
    /** 变更文件数 */
    filesChanged: number;
    /** 新增行数 */
    addedLines: number;
    /** 删除行数 */
    deletedLines: number;
  };
  /** 成本聚合（ADR-035） */
  cost: {
    /** 总成本（美元） */
    totalUsd: number;
  };
  /** 停机摘要（ADR-041） */
  stall: {
    /** 是否停机 */
    stalled: boolean;
    /** 停机分类；未停机为 null */
    stallClass: string | null;
  };
  /** 写集审计结论（ADR-014） */
  writeSetAudit: WriteSetAuditFacts;
  /** 产物证据（ADR-059/061） */
  artifact: ArtifactEvidence;
}

/** 一项签字前确认项（ADR-070 §5.2） */
export interface SignCheck {
  /** 确认项标签 */
  label: string;
  /** 是否通过 */
  ok: boolean;
  /** 佐证文案（给人看为什么） */
  evidence: string;
  /** ADR 锚点 —— 判据来源（ADR-070 §5.2） */
  adrRef: string;
}
