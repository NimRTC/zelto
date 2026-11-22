// ForgePort —— 远端代码评审平台的端口（ADR-094 §6.1）
//
// core/ 定义端口，adapters/ 实现。这是 zelto 既有的依赖倒置惯例
// （`core/ports/executor.ts` / `core/ports/llm.ts`）。
//
// **为什么 core/ 不知道 GitHub 存在**（C2/C3/C6）：
//
// - core/ 零第三方依赖 —— 写 GitHub REST 客户端意味着要处理 token、
//   分页、重试、API 版本；
// - core/ 的判定层不触网 —— `gh` 调用只发生在**人显式执行**
//   `zelto forge pr` 时，不在任何判定路径上；
// - 将来要支持 GitLab / Gitea，是**加一个 adapter**，不是改 core/。
//
// **PR 是追溯链的载体，不是评审主体**（ADR-094 D7）：
//
// 批准权单点留在 zelto（ADR-018：签字不自动合并）。GitHub 上 reviewer
// 点了 approve，zelto 也不认 —— 那不是缺陷，是刻意的单点。
// 两条批准路径 = 追溯链分叉 = 「谁批的、依据什么」查不准。

/** 开一个 PR 的请求 */
export interface ForgePrRequest {
  /** 标题 */
  title: string;
  /** 正文（含机器可读的追溯块） */
  body: string;
  /** 目标分支（base） */
  base: string;
  /** 来源分支（head） */
  head: string;
  /** 是否为演练（不真的创建） */
  dryRun?: boolean;
}

/** 开完 PR 之后的结果 */
export interface ForgePrResult {
  /** 是否真的创建了 */
  created: boolean;
  /** PR 编号（演练时为 null） */
  number: number | null;
  /** PR 的 URL（演练时为 null） */
  url: string | null;
  /** 目标分支 */
  base: string;
  /** 来源分支 */
  head: string;
}

/**
 * 远端评审平台的端口。
 *
 * 只留「开 PR」这一个动作 —— 它是**唯一**需要远端写权限的动作。
 * 读 PR 状态、评论、review 等都不在 v1 范围内（没有需求支撑就不加，
 * 见 AGENTS.md「遇到不确定时停下来问」）。
 */
export interface ForgePort {
  /** 适配器名字，如 'github' */
  readonly name: string;

  /**
   * 这个适配器在当前环境**是否可用**。
   *
   * 用于在动手之前给出可操作的错误信息（ADR-094 D10）：
   * `gh` 不存在时要说清「PR 没开成」并给出替代路径，
   * 不能让命令「成功」返回而 PR 不存在。
   */
  isAvailable(): Promise<ForgeAvailability>;

  /** 开一个 PR */
  openPr(request: ForgePrRequest): Promise<ForgePrResult>;
}

/** 适配器的可用性检查结果 */
export interface ForgeAvailability {
  /** 是否可用 */
  available: boolean;
  /** 不可用时的原因（人话） */
  reason: string | null;
  /** 不可用时的替代路径（人话） */
  remedy: string | null;
}
