// 启动阶段（ADR-143）
//
// ## 为什么这个模块存在
//
// zelto 的超时语义是**空转超时**（ADR-055）：「没有进展就这么久就杀掉」。
// 进展从哪来？
//
// - Claude Code 路线：agent 的 stdout/stderr + hook 事件；
// - ACP 路线：`session/update` 里的 `tool_call` / `tool_call_update`。
//
// **但 ACP agent 的启动阶段不发 `tool_call`** —— 初始化模型连接、加载
// MCP server、鉴权、读项目的上下文文件，这些**都不是工具调用**，
// 它们是 agent **进程内部**的事。
//
// 于是：**正常启动但比较慢**的 agent，被 zelto 当成「卡住了」杀掉 ——
// 而且它被杀的时候**一行代码都还没写**，白跑一轮。
//
// ## 最要命的一点：慢启动与真卡住**在信号上无法区分**
//
// | | 观测到的 | 真实情况 |
// |---|---|---|
// | 慢启动 | 0 条 tool_call，静默 | agent 正在加载 |
// | 真卡住 | 0 条 tool_call，静默 | agent 死了 / 网络挂了 |
//
// zelto 区分不了 —— 因为它没有「agent 现在处于哪个阶段」的概念。
//
// ## T3 的规则
//
// T3 的 `docs/internals/03_providers.md`：
//
// > **Startup phases come from real signals.** An adapter reports the step a
// > starting turn is on as `startupPhase` on its provider session, and only
// > when the protocol says so: **a notification or an awaited request with
// > one meaning, never a timer.** Clear it the moment the provider can be
// > doing something else.
//
// 拆开是四条：
//
// 1. **只从真实信号来** —— 「一个通知，或一个被等待的请求」，**绝不用计时器**；
// 2. **一旦 provider 能干别的了，立刻清掉**；
// 3. **启动阶段不延长空转超时，而是完全豁免它**（决策四）；
// 4. **协议卡住由请求级超时兜底**（决策五）。
//
// C3: 纯类型 + 纯计算，不调模型、不触网、不读文件
// C6: core/ 内，不依赖 adapters/（本文件在 adapters/ 下，但**不 import core/**）

/**
 * ACP 启动阶段 —— **封闭集合**。
 *
 * 只有这四个：它们对应 ACP 协议里**语义唯一**的**被等待的请求**
 * （T3 的规则：「an awaited request with one meaning」）。
 *
 * **为什么没有「加载 MCP server」这类**：ACP v1 里 MCP server 的连接是
 * **agent 内部**的（`session/new` 的 `mcpServers` 字段是 client 传进去的，
 * agent 什么时候连它，协议不说）。zelto **看不到**这个信号 ——
 * 看不到就不能编（编了就违反「只从真实信号来」）。
 */
export type AcpStartupPhase =
  /** 子进程刚起，还没握手 */
  | 'launch'
  /** 正在 `initialize` 握手 */
  | 'initialize'
  /** 正在建立会话（`session/new` | `session/load` | `session/resume`） */
  | 'session'
  /** 正在鉴权（版本协商之后的第二道关卡，ADR-133 修正二） */
  | 'authenticating';

/** 全部阶段值 —— 供测试与文档同步用。 */
export const ACP_STARTUP_PHASES: readonly AcpStartupPhase[] = [
  'launch',
  'initialize',
  'session',
  'authenticating',
];

/** 阶段的中文说明（给人看 —— 决策六）。 */
const PHASE_LABELS: Record<AcpStartupPhase, string> = {
  launch: '启动中（进程已起）',
  initialize: '启动中（协议握手）',
  // 「建立会话」也覆盖「等 agent 起步」那段时间 ——
  // 从建好会话到收到第一条 `session/update` 之间，agent 一条 tool_call
  // 都不发（它可能在加载 MCP server、读项目上下文）。
  session: '启动中（建立会话 / 等待 agent 起步）',
  authenticating: '启动中（鉴权）',
};

/**
 * 阶段的中文说明。
 *
 * 认不出来的阶段 → 返回 `null`（**不编** —— 那是「没这个阶段」，
 * 不是「编一个像样的说法」）。
 */
export function describeStartupPhase(phase: AcpStartupPhase | null | undefined): string | null {
  if (!phase) return null;
  return PHASE_LABELS[phase] ?? null;
}

/**
 * 启动阶段的**默认时限**（毫秒）。
 *
 * ## 为什么要有这个数
 *
 * 启动阶段**豁免**空转超时（决策四）—— 代价是「agent 卡住」不再被
 * 空转超时杀。所以启动阶段需要**自己的**上界，否则「握手完了但 agent
 * 一个字都不说」会**永远挂着**（切片永远停在 running）。
 *
 * ## 为什么它是「启动的**总时长**」而不是「没进展的时长」
 *
 * 启动阶段**没有进展信号** —— agent 在加载 MCP server / 鉴权 /
 * 读上下文时**一条 `tool_call` 都不发**。所以它只能按**总时长**计：
 * 「从接到指令到第一次产出，最多给这么久」。
 *
 * ## 为什么是 15 分钟
 *
 * 覆盖的是**外部依赖**的冷启动区间：MCP server 连接、模型连接、
 * 上下文索引、可能的首次鉴权。实测区间在十几秒到几分钟；
 * 15 分钟是给「网络慢 / server 多」的宽松上界。
 *
 * 超了就是「启动卡住」—— 那时人应该看到的是**明确的启动超时**，
 * 而不是「跑着但没进展」。
 *
 * **它不是「魔法宽限期」**（决策四否决的那种）：阶段本身**不由它决定**
 * —— 阶段只由协议信号推进；这个数只是**上界**，与「阶段是什么」无关。
 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 15 * 60_000;

/**
 * 空转超时的豁免判定 —— **纯计算**（ADR-143 决策四）。
 *
 * 语义：「**不在启动阶段**且**没有进展**这么久 → 杀掉」。
 *
 * ## 为什么是「豁免」而不是「延长」
 *
 * | 做法 | 含义 | 问题 |
 * |---|---|---|
 * | **延长**空转超时 | 启动阶段用更长的超时 | 引入「启动阶段该给多久」的魔法数字；而且「启动阶段」本身没有边界（agent 可能永远停在启动） |
 * | **豁免**空转超时 | 启动阶段**不计入**空转判定 | 不需要任何数字 |
 *
 * **采用豁免**。
 *
 * ## 为什么豁免不会导致永不超时
 *
 * 启动阶段**一定会结束** —— 因为阶段是由协议请求推进的，
 * 而那些请求都有回包，且**每个请求自带超时**（决策五）。
 *
 * 如果 agent 卡在 `initialize` 不回包 → 那不是「启动慢」，
 * 那是「协议卡住」，由**请求级超时**兜。
 *
 * @param phase 当前阶段（null = 不在启动阶段）
 * @returns 该不该豁免本次空转超时判定
 */
export function shouldExemptIdleTimeout(phase: AcpStartupPhase | null | undefined): boolean {
  return phase !== null && phase !== undefined;
}

/**
 * 阶段是否**已结束**（拿到第一个真实产出）。
 *
 * T3 的规则：「Clear it the moment the provider can be doing something else.」
 *
 * zelto 的口径：**拿到第一个 `session/update` 通知就算「能干别的了」**。
 *
 * **为什么不用「第一个 tool_call」**：太晚了。
 * `session/update` 里先来的是 `agent_message_chunk`（agent 开始说话了）
 * —— 那已经说明 agent **活着且在动**。
 *
 * **为什么不用「prompt 返回」**：更晚。agent 可能先说一段话、
 * 再调工具、最后才结束这一轮。
 *
 * @param phase 当前阶段
 * @param sawUpdate 是否已经收到过 `session/update` 通知
 * @returns 新的阶段（`null` = 阶段结束）
 */
export function clearPhaseOnFirstOutput(
  phase: AcpStartupPhase | null | undefined,
  sawUpdate: boolean,
): AcpStartupPhase | null {
  if (!sawUpdate) return phase ?? null;
  return null;
}
