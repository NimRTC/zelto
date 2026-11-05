// 架构偏离检查（G-4/B）—— 只读报告
//
// 「设计里画的模块图」 vs 「代码里实际的 import 图」。
// 差出来的东西是架构腐化的证据，怎么处置由人决定（这一层不拦人）。

export {
  classifyPythonSpecifier,
  classifySpecifier,
  detectLang,
  matchModuleBySpecifier,
  parseImports,
} from './imports.js';

export {
  compareSpecificity,
  isEmptyToken,
  normalizeModuleSpecs,
  patternSpecificity,
  stripWrappingQuotes,
} from './normalize.js';

export {
  collectAllFiles,
  collectSourceFiles,
  resolveRelative,
  scanArchitecture,
} from './scan.js';

export { buildArchitectureReport, findCycles } from './report.js';

export {
  buildArchRelaxSnippet,
  filterRelevantDeviations,
  HARD_DEVIATION_KINDS,
  isDeviationRelevantToSlice,
  judgeArchGuard,
  judgeSliceArchGuard,
  relevantModuleNames,
} from './guard.js';
export type { GuardKindResult, GuardRule, GuardVerdict } from './guard.js';

export type {
  ArchitectureReport,
  Deviation,
  DeviationKind,
  ImportRef,
  ModuleEdge,
  ModuleSpec,
  ScanResult,
  ScannedFile,
  SourceLang,
} from './types.js';

export type { PatternSpecificity } from './normalize.js';
