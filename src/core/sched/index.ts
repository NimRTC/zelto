export { type SchedResult, type SchedBlock, type SchedDecision, type ConstraintBundle, type AffinityContext, type AffinitySummary } from './types.js';
export { Scheduler } from './engine.js';
export {
  type BatchMember,
  type BatchReview,
  type BatchIssue,
  type BatchPhasePlan,
  type PhaseDowngrade,
  type ExecutionPhasePlan,
  type WriteSetMember,
  type AffinityPlan,
  affinityPrefixOf,
  planAffinityGroups,
  affinityPreviousOf,
  splitPhaseByAffinity,
} from './batch.js';
export {
  pathMatches,
  pathsOverlap,
  writeSetsOverlap,
  pathInWriteSet,
} from './paths.js';
export {
  type WriteReservation,
  type AcquireOptions,
  ReservationStore,
  isProcessAlive,
  reapStaleReservations,
  LOCKS_DIR,
} from './reservation.js';
export {
  type ProcessRow,
  readProcessTable,
  findDescendants,
  isProcessTreeAlive,
  findPidsByCmdline,
  invalidateProcessTable,
} from './process-table.js';
export {
  type ManagedFile,
  type AuditOptions,
  type WriteAuditResult,
  type SliceCommits,
  auditWorktreeWrites,
  parsePorcelainStatus,
  hashFile,
  listFilesUnder,
  listChangedPaths,
} from './audit.js';
export {
  type VersionWriteSet,
  type CrossVersionConflict,
  detectCrossVersionConflicts,
  overlappingPaths,
  versionsOverlap,
} from './cross-version.js';
export {
  type RunWatchdogInput,
  type RunWatchdogAction,
  SPAWN_GRACE_MS,
  decideRunWatchdog,
  selectGenerationRecords,
  toWatchdogDecision,
} from './watchdog-policy.js';
