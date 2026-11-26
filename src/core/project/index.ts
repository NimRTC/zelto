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
  type CockpitRoot,
  type CockpitScope,
} from './cockpit-roots.js';

// ADR-114：分支可见性 —— 「完成」是在盘上完成，还是在版本分支里完成
export {
  annotateBranchEvidence,
  annotateBranchEvidenceAsync,
  defaultGitProbe,
  defaultAsyncGitProbe,
  type GitProbe,
  type AsyncGitProbe,
} from './branch-evidence.js';
