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

/** 门禁作用域的三种来源（与 core/gate/scope.ts 的 ScopeSource 同口径）。 */
export type ScopeSource = 'config' | 'fallback-full' | 'no-config';

/**
 * 门禁作用域事实（ADR-097 决策五 / ADR-104 决策一）。
 *
 * **来源是 `gate.result` 事件 payload** —— 字段**已经在那里**
 * （ADR-097 决策五「留痕」），本段只是把它**读出来**。
 *
 * **老事件兼容**：老事件的 payload 没有这些字段 → 按「没收窄」降级
 * （`scoped: false` / `source: 'no-config'`）。
 * **为什么这个降级是安全的**：老事件是**收窄功能上线之前**写的，
 * 那时的门禁**必然跑的是全量** —— 全量永远覆盖本片。
 */
export interface GateScopeFacts {
  /** 这轮是不是收窄跑的。 */
  scoped: boolean;
  /** 按哪些标签收窄的（没收窄时为空）。 */
  labels: string[];
  /** 收窄后实际跑的用例数（没收窄或没枚举时为 null）。 */
  testCount: number | null;
  /** 全量有多少个用例（对比用；没枚举时为 null）。 */
  totalTestCount: number | null;
  /** 为什么收窄 / 为什么没收窄。 */
  source: ScopeSource;
  /** 人话说明。 */
  reason: string;
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
    /**
     * 门禁作用域事实（ADR-104 决策一）。
     *
     * **为什么要有这一段**：ADR-097 让门禁能按写集收窄跑哪些用例，
     * 但签字侧原本**只**看「跑没跑、过没过」——
     * **看不出这轮跑的是不是本片相关的用例**。
     *
     * 「规则配窄了 → 本片该验的用例没被验」是一个真实存在的失败模式
     * （`gate.scope` 的规则是**人配的**），而人签字时看不到它
     * = 人在**不知情**的情况下批准。
     *
     * **判据本身不变**（仍是 `ran && passed`）——
     * 收窄的 fail closed 已经在门禁侧承担了（ADR-097 决策三），
     * 签字侧再判一次是重复。这里做的是**让证据可见**。
     */
    scope: GateScopeFacts;
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
