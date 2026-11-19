// zelto 配置（ADR-086）
//
// 配置语义的**唯一实源** —— CLI 与 Web 都读它。
//
// 解析器曾经住在 `cli/commands/shared.ts`，那意味着 Web 端（adapters/web）
// 要么自己再写一份（配置语义漂移 —— 一边认 `acceptance:`、一边不认），
// 要么 import `cli/`（adapters 依赖 cli，分层反过来）。
// 两条都不行，所以它下沉到了 core（ADR-086）。

export {
  expandConfigEnvRefs,
  loadConfig,
  loadConfigAt,
  parseConfigYaml,
  parseEnvRef,
  resolveApiKey,
  ZELTO_DIR_NAME,
  type ZeltoConfig,
} from './loader.js';

export {
  parseBlockScalarHeader,
  readBlockScalar,
  type BlockScalarChomp,
  type BlockScalarHeader,
  type BlockScalarStyle,
  type BlockScalarValue,
} from './blocks.js';
