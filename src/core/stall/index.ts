export {
  classifyStall,
  isAutoResolvable,
  isSliceStalled,
} from './classifier.js';
export type {
  StallClass,
  StallEvent,
  StallInfo,
  StallResolution,
} from './types.js';
export { detectUsageLimit } from './usage-limit.js';
export type { UsageLimitSignal } from './usage-limit.js';
export {
  findDeadSlices,
  findOrphanShells,
  reapDeadSlices,
  classifyOrphanShell,
} from './reap.js';
export type { DeadSlice, OrphanShell, ReapResult } from './reap.js';
