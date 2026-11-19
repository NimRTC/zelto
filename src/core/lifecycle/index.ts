// 生命周期编排层（ADR-086）
//
// 这一层存在的唯一理由：**让 CLI 与 Web 调同一份编排**。
//
// ADR-072 §4 / ADR-084 §1 排除 Web 侧做 freeze / gate / run / resume 的理由是
// 「CLI 侧有完整实现，Web 侧再实现一份会分叉判定」（C3 的隐患）。
//
// 核实后的实际情况：判据本来就在 core 里，**编排序列在 CLI 里**。
// 所以「Web 侧再实现一份」的真实成本不是「重写判据」，
// 而是「把编排序列抄第二遍」—— 那才是分叉的来源。
//
// 这一层把编排序列收进 core，让两端调同一份：
//   - `freeze.ts` —— 冻结编排（追溯物化 → 写集×策略 → D-4 覆盖 → 追溯合格 → FREEZE）
//   - `gate.ts`   —— 门禁编排（状态 → 架构护栏 → 拼配置 → 调 GateExecutor）
//   - `resume.ts` —— 续跑编排（薄封装 Scheduler.resume + 结果分类）
//
// **`run` 不在这里** —— 它必须用 executor adapter，
// 而 `core/` 不许 import `adapters/`（C2）。
// `run` 走**进程边界复用**：Web 拉起 CLI 进程（`zelto run --detach`）。
//
// C1: 状态只在文件里 —— 编排只写文件，不持有内存状态。
// C2: 零第三方依赖、不 import adapters/。
// C3: 判定确定性 —— 只读文件、纯计算 + 文件写，不调模型、不触网。

export { freezeSlice, resolveEffectiveWrites, hashSpecFile, detectDefaultWrites } from './freeze.js';
export { runGate } from './gate.js';
export { resumeSlice } from './resume.js';
export { ok, fail } from './types.js';
export type { LifecycleContext, LifecycleOutcome } from './types.js';
export type { FreezeOptions } from './freeze.js';
export type { GateOptions, GateConfigSource } from './gate.js';
export type { ResumeOptions } from './resume.js';
