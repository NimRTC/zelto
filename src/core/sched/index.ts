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
  type ManagedFile,
  type AuditOptions,
  type WriteAuditResult,
  auditWorktreeWrites,
  parsePorcelainStatus,
  hashFile,
  listFilesUnder,
} from './audit.js';
