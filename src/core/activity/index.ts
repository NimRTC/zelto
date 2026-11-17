// 活性模块的出口 —— 心跳判定（liveness）+ 看门狗处置（watchdog）
// C6: core/ 内，不依赖 adapters/

export {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_STALE_THRESHOLD_MS,
  classifyLiveness,
  lastActivityOf,
  lastOutputLine,
  formatIdle,
  SESSIONS_DIR_REL,
  TASKS_DIR_REL,
  readSessionLiveness,
  readTaskLiveness,
  readSliceLivenessRecord,
} from './liveness.js';
export type { LivenessState, LivenessInfo, LivenessRecord } from './liveness.js';

export {
  MAX_AUTO_RECOVERIES,
  RECOVERIES_DIR_REL,
  decideRecovery,
  readRecoveries,
  recordRecovery,
  recordEscalation,
} from './watchdog.js';
export type { RecoveryRecord, WatchdogDecision, StuckSliceInfo } from './watchdog.js';
