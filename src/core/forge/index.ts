// Forge —— PR 追溯链的收集与渲染（ADR-094 §6）
//
// 对外只暴露：收集事实 + 渲染 title/body。
// **不触网** —— 远端写操作在 `adapters/` 里（C2/C3/C6）。

export {
  buildForgeTraceFacts,
  findLatestApproval,
  type ForgeTraceFacts,
} from './collect.js';

export {
  buildTraceBlock,
  renderPrBody,
  renderPrTitle,
  TRACE_BLOCK_SCHEMA,
  type RenderedPr,
  type TraceBlock,
} from './pr-body.js';
