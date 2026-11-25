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
