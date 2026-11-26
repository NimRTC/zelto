// Project module barrel export

export type {
  ProjectMap, ProjectModule, ProjectType,
  ProjectInitOptions, ProjectStatus,
} from './types.js';

export { scanProject } from './scanner.js';
export { initializeProject } from './initializer.js';

// ADR-112：驾驶舱按「根」扫描 —— 仓库根 + 每个版本集成目录
export {
  discoverCockpitRoots,
  isRootScope,
  VERSION_WORKTREES_REL,
  WORKTREES_REL,
  type CockpitRoot,
  type CockpitScope,
} from './cockpit-roots.js';

// 执行目录脉络：仓库根 / 版本集成目录 / 切片执行目录 / 额外工作区
export {
  discoverWorktrees,
  normalizeDir,
  readGitWorktrees,
  type WorktreeEntry,
  type WorktreeKind,
  type GitWorktreeEntry,
} from './worktree-map.js';

// ADR-114：分支可见性 —— 「完成」是在盘上完成，还是在版本分支里完成
export {
  annotateBranchEvidence,
  annotateBranchEvidenceAsync,
  defaultGitProbe,
  defaultAsyncGitProbe,
  type GitProbe,
  type AsyncGitProbe,
} from './branch-evidence.js';
