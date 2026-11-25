// sched/paths —— 兼容转发层
//
// 路径匹配的实现已上移到 `core/pathspec/`（理由见那里的头注释：
// 它是 gate / lifecycle / arch / sched 共用基元，钉在 sched 下会让
// gate、arch 为了一个纯函数反向依赖调度器）。
//
// 本文件只为既有引用保留导出面，**不再有实现** —— 任何语义修改
// 都必须改 `core/pathspec/`，这里跟着转发即可。

export {
  isAppendOnlyDocPath,
  pathInWriteSet,
  pathMatches,
  pathsOverlap,
  writeSetsConflict,
  writeSetsOverlap,
} from '../pathspec/index.js';
