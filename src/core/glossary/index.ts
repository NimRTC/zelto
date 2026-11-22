// 领域词汇表 —— 项目的共享语言
//
// C3: 纯计算，不调模型、不触网
// C2: core/ 内，零第三方依赖，不 import adapters/

export {
  checkGlossaryUsage,
  parseGlossary,
  renderGlossary,
  GLOSSARY_FILENAME,
} from './glossary.js';
export type {
  Glossary,
  GlossaryCheckReport,
  GlossaryTerm,
} from './glossary.js';

export { GlossaryStore } from './store.js';
