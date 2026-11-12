// Worktree isolation — 切片的执行目录 + 版本的集成目录
//
// C2/C6: core 不依赖 adapters/
// C3: 判定确定性，不调模型、不触网

export {
  WorktreeManager,
  WorktreeError,
  WORKTREE_BASE_DIR,
  VERSION_WORKTREE_BASE_DIR,
  type WorktreeInfo,
  type WorktreeKind,
  type CreateWorktreeOptions,
} from './manager.js';
export {
  type LockfileState,
  type PackageManager,
  type DependencyPlan,
  type DependencyResult,
  type DependencyStrategy,
  type PrepareDependenciesOptions,
  readLockfileState,
  lockfilesMatch,
  planVersionDependencies,
  prepareVersionDependencies,
  removeVersionNodeModules,
} from './dependencies.js';
