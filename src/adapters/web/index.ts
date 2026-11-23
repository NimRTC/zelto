// Web 驾驶舱适配器入口（ADR-072）
//
// 形态：`src/adapters/web/` —— 适配器层。
// 依赖方向：`adapters/` → `core/`（单向向下，C2/C6）。
// `core/` 不 import `adapters/`，本适配器也不 import `cli/`。
//
// 零第三方运行时依赖：只用 `node:http` + `node:crypto`（C2）。

export { WebServer, sendJson, validId, type WebServerOptions } from './server.js';
export { WebApi, type SliceSummary, type SliceDetail } from './api.js';
export { createWebRouter, type WebContext, type WebRouter } from './router.js';
export { renderIndexHtml } from './frontend.js';
export {
  installCockpitCrashGuard,
  type CockpitCrashGuard,
  type CockpitCrashGuardOptions,
  type CockpitCrashRecord,
} from './crash-guard.js';
