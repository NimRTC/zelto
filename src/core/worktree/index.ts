// Worktree isolation — 每个切片在独立 git worktree 中执行
//
// C2/C6: core 不依赖 adapters/
// C3: 判定确定性，不调模型、不触网

export {
  WorktreeManager,
  WorktreeError,
  WORKTREE_BASE_DIR,
  type WorktreeInfo,
  type CreateWorktreeOptions,
} from './manager.js';
