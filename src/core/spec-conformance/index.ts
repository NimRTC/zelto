// 规格符合性 —— 「这段改动忠实实现了规格吗」的确定性判定
//
// 追溯链保证「有出处」，这一层保证「出处说了什么，代码真的做了」。
//
// C3: 纯计算，不调模型、不触网
// C2: core/ 内，零第三方依赖，不 import adapters/

export {
  evaluateConformance,
  extractMentionedPaths,
  extractRequirements,
} from './conformance.js';
export type {
  ChangedFile,
  ConformanceReport,
  RequirementKind,
  RequirementVerdict,
  ScopeCreep,
  SpecRequirement,
} from './conformance.js';

export { collectChangedFiles, readFileContents } from './collect.js';
