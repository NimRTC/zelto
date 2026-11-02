# ADR-010: Web UI Adapter — Zelto 驾驶舱浏览器界面

**状态**: 提案  
**日期**: 2026-10-30  
**作者**: 系统架构  
**关联切片**: 待定（新功能，无对应切片规格）  
**关联约束**: C1, C2, C3, C4, C5, C6, C7, C8, C9  
**关联文档**: `docs/zelto-技术架构.md`, `docs/zelto-场景功能地图.md`

---

## 1. 摘要

为 zelto 实现一个浏览器端 Web UI，作为**适配器（Adapter）**运行，让开发者可以通过图形界面与 zelto 交互：查看切片列表、事件流、执行审批/拒绝/恢复等操作。所有操作仍走已有核心路径（policy → gate → sched → events），不引入数据库，不绕过任何不变量。

---

## 2. 动机

当前 zelto 仅通过 CLI 交互。随着切片数量增长和 AI pipeline 流程的复杂化，CLI 的局限性日益明显：

| 问题 | 影响 |
|------|------|
| 切片状态需反复 `zelto slice <id>` 查询 | 无法一眼看到全局状态 |
| 事件流只能 `zelto events <id> --tail <N>` | 缺少实时可视化和过滤 |
| 签名审批需在终端执行 `zelto sign <id> --approve` | 操作不直观 |
| 停机恢复需记命令 `zelto resume <id> [--skip\|--abandon]` | 对新手不友好 |
| AI pipeline 状态（需求→设计→计划→版本）只能文本展示 | 缺少图形化的全链路追踪 |

Web UI 让交互更自然，同时**不破坏任何架构约束**。

---

## 3. 设计原则

1. **适配器模式** — Web UI 是 `adapters/web/` 下的一个适配器，遵循现有适配器约定
2. **零数据库** — 状态只从 `.zelto/slices/`, `.zelto/events/`, `.zelto/locks/` 读取和写入（C1）
3. **同路径读写** — Web UI 和 CLI 读取/写入完全相同的文件，保证一致性
4. **本地绑定** — 仅监听 `127.0.0.1`，不暴露到网络
5. **无状态服务端** — HTTP 服务端不维护 session，每次请求独立读取文件状态
6. **读多写少** — 写操作（审批、拒绝、恢复）走与 CLI 相同的 `core/` 代码路径
7. **策略门禁不可绕过** — 任何写操作都经过 policy 判定（C5/C8）

---

## 4. 现有架构基础分析

### 4.1 可直接复用的核心模块

| 模块 | 类/函数 | Web UI 用途 | 复用方式 |
|------|---------|-------------|----------|
| **SliceStore** | `read()`, `list()`, `transit()`, `write()`, `exists()` | 切片 CRUD、状态转换 | 直接实例化，与 CLI 共用 |
| **EventStream** | `read()`, `append()` | 事件流展示、记录操作 | 直接实例化，与 CLI 共用 |
| **SignManager** | `list()`, `approve()`, `reject()`, `request()`, `get()`, `delete()` | 签名审批 UI | 直接实例化 |
| **Scheduler** | `admit()`, `startRun()`, `resume()`, `buildConstraints()` | 准入检查、执行控制 | 直接实例化 |
| **GateExecutor** | `execute()` | 门禁触发 | 直接实例化 |
| **ClarifyEngine** | `generateQuestions()`, `applyAnswers()`, `runRound()` | 澄清交互 | 直接实例化 |
| **MetricsCollector** | `generateReport()`, `reworkRate()`, `cycleTime()`, `stallCounts()` | 度量面板 | 直接实例化 |
| **AuditTrail** | `forSlice()`, `toText()`, `latestEvent()` | 审计追踪 | 直接实例化 |
| **BudgetCollector** | `getSpent()`, `getLimit()`, `isExhausted()` | 预算展示 | 直接实例化 |
| **Policy Engine** | `evaluatePolicy()`, `matchPath()` | 策略检查 | 直接实例化（或调用 hook） |
| **Stall Classifier** | `classifyStall()`, `isAutoResolvable()`, `isSliceStalled()` | 停机展示 | 直接实例化 |

### 4.2 适配器模式参考

现有 `adapters/claude-agent-sdk/` 的模式：
- 实现 `core/ports/` 中定义的接口（`ExecutorAdapter`）
- 可以有自己的 npm 依赖（SDK adapter 依赖 `@anthropic-ai/claude-agent-sdk`）
- 通过 `adapters/index.ts` 导出

Web UI 适配器不完全遵循 `ExecutorAdapter` 接口（它不是一个 agent 执行器），但遵循相同的**适配器约定**：
- 位于 `adapters/` 目录下
- 可以有自己的依赖
- 通过 `core/` 模块访问核心功能
- 不反向依赖 `core/`

### 4.3 CLI 模式参考

CLI 命令（`src/cli/commands/`）的模式：
- 直接 `import` 并实例化 `SliceStore`, `EventStream`, `GateExecutor`, `SignManager` 等
- 使用 `shared.ts` 中的全局单例 `store`, `events`
- 所有写操作通过 `core/` 方法完成，自动记录事件

Web UI 服务端可以复用同样的模式。

---

## 5. 设计

### 5.1 目录结构

```
src/
  adapters/
    web/
      index.ts              # 适配器入口 + 服务端启动
      server.ts             # HTTP 服务端（node:http）
      router.ts             # 请求路由
      api/
        slices.ts           # /api/slices/* 处理器
        events.ts           # /api/events/* 处理器
        sign.ts             # /api/sign-requests/* 处理器
        stalls.ts           # /api/stalls 处理器
        pipeline.ts         # /api/pipeline 处理器（AI pipeline 状态）
        summary.ts          # /api/summary 处理器
        clarify.ts          # /api/slices/:id/clarify 处理器
        gate.ts             # /api/slices/:id/gate 处理器
        policy.ts           # /api/policy 处理器
      frontend/
        index.html          # SPA 入口
        app.js              # 前端应用（原生 JS，无框架依赖）
        app.css             # 样式
      static/
        ...                 # 其他静态资源
  adapters/
    index.ts                # 导出 WebAdapter（新增）
```

### 5.2 架构图

```
浏览器 (SPA)
    │
    │ HTTP fetch (127.0.0.1)
    ▼
┌─────────────────────────────────┐
│   adapters/web/server.ts        │
│   node:http (零额外运行时依赖)    │
│                                 │
│   router.ts → api/*.ts          │
│       │                         │
│       ├── core/slice/store.ts   │  ← 直接读取 .zelto/slices/<id>.json
│       ├── core/events/stream.ts │  ← 读取/写入 .zelto/events/<id>/events.jsonl
│       ├── core/gate/sign.ts     │  ← 审批/拒绝签名
│       ├── core/sched/engine.ts  │  ← 准入/执行控制
│       ├── core/gate/executor.ts │  ← 门禁执行
│       ├── core/clarify/engine.ts│  ← 澄清交互
│       ├── core/metrics/         │  ← 度量报告
│       ├── core/audit/trail.ts   │  ← 审计追踪
│       └── core/budget/          │  ← 预算信息
└─────────────────────────────────┘
    │
    ▼
.zelto/slices/*.json   .zelto/events/*/events.jsonl   .zelto/locks/*.json
```

### 5.3 API 设计

所有 API 无认证（本地绑定）、无 session、RESTful 风格。

#### 切片操作

| 方法 | 路径 | 描述 | 对应的 CLI 命令 |
|------|------|------|----------------|
| GET | `/api/slices` | 列出所有切片 | `zelto slices` |
| GET | `/api/slices/:id` | 切片详情 | `zelto slice <id>` |
| POST | `/api/slices` | 创建切片 | `zelto create <id>` |
| POST | `/api/slices/:id/clarify` | 生成/回答澄清问题 | `zelto clarify <id>` |
| POST | `/api/slices/:id/freeze` | 冻结切片 | `zelto freeze <id>` |
| POST | `/api/slices/:id/admit` | 准入检查 | `zelto admit <id>` |
| POST | `/api/slices/:id/run` | 执行切片 | `zelto run <id>` |
| POST | `/api/slices/:id/gate` | 门禁检查 | `zelto gate <id>` |
| POST | `/api/slices/:id/abandon` | 废弃切片 | `zelto abandon <id>` |
| POST | `/api/slices/:id/resume` | 恢复停机 | `zelto resume <id>` |

#### 事件与审计

| 方法 | 路径 | 描述 | 对应的 CLI 命令 |
|------|------|------|----------------|
| GET | `/api/slices/:id/events` | 事件流（支持 tail/过滤） | `zelto events <id>` |
| GET | `/api/slices/:id/audit` | 审计报告 | `zelto audit <id>` |
| GET | `/api/events` | 所有切片的最新事件 | 无直接对应 |

#### 签名

| 方法 | 路径 | 描述 | 对应的 CLI 命令 |
|------|------|------|----------------|
| GET | `/api/sign-requests` | 签名请求列表 | `zelto inbox` |
| POST | `/api/sign-requests/:id/approve` | 审批签名 | `zelto sign <id> --approve` |
| POST | `/api/sign-requests/:id/reject` | 拒绝签名 | `zelto sign <id> --reject` |

#### 度量和统计

| 方法 | 路径 | 描述 | 对应的 CLI 命令 |
|------|------|------|----------------|
| GET | `/api/summary` | 项目概况 | `zelto summary` |
| GET | `/api/metrics` | 全项目度量 | `zelto summary --metrics` |
| GET | `/api/slices/:id/metrics` | 切片度量 | 无直接对应 |
| GET | `/api/stalls` | 停机列表 | `zelto stall` |
| GET | `/api/pipeline` | AI pipeline 全链状态 | `zelto pipeline status` |
| GET | `/api/policy` | 策略规则列表 | `zelto policy list` |
| GET | `/api/budget` | 预算概览 | 无直接对应 |

### 5.4 前端设计

前端为**纯静态 SPA**，无框架依赖（仅原生 HTML/CSS/JS），通过 `fetch()` 调用 API。

**页面结构**：

```
┌──────────────────────────────────────────────────┐
│  Zelto Dashboard  [slices] [events] [sign] [···] │  ← 导航栏
├──────────────────────────────────────────────────┤
│                                                   │
│  ┌─ 切片总览 ──────────────────────────────────┐  │
│  │  [draft] slice-001: 实现 Web UI 基础框架     │  │
│  │  [frozen] slice-002: 添加事件流展示          │  │  ← 状态色标
│  │  [running] slice-003: 签名审批流程           │  │
│  │  [completed] slice-004: 度量面板             │  │
│  │  [abandoned] slice-005: 旧方案               │  │
│  └──────────────────────────────────────────────┘  │
│                                                   │
│  ┌─ 待办事项 ──────────────────────────────────┐  │
│  │  ✗ 签名待审批: slice-001 (2 个)             │  │
│  │  ⚠ 停机需处理: slice-006 (cognitive_stuck)  │  │
│  └──────────────────────────────────────────────┘  │
│                                                   │
│  ┌─ 最近事件 ──────────────────────────────────┐  │
│  │  10:32:15  [run.finished]  slice-003 执行完成 │  │
│  │  10:28:03  [gate.result]   slice-001 门禁通过 │  │
│  │  10:25:41  [sign.requested] slice-001 待签名  │  │
│  └──────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

**切片详情页**：
```
┌──────────────────────────────────────────────────┐
│  ← 返回总览      slice-001: Web UI 基础框架      │
├──────────────────────────────────────────────────┤
│  状态: ● frozen   创建: 2026-10-30               │
│  写集: src/adapters/web/**, src/web/**           │
│                                                   │
│  ┌─ 事件时间线 ────────────────────────────────┐  │
│  │  ○ spec.drafted                             │  │
│  │  ○ clarify.question — "写集范围？"          │  │
│  │  ○ clarify.answer — "src/adapters/web/**"   │  │
│  │  ● spec.frozen                              │  │
│  │  ○ sched.admitted                           │  │
│  │  ○ run.started — 正在执行...                │  │
│  └──────────────────────────────────────────────┘  │
│                                                   │
│  [▶ 执行]  [✓ 门禁]  [📋 审计]  [🗑 废弃]        │
│                                                   │
│  ┌─ 度量 ──────────────────────────────────────┐  │
│  │  周期: 12m  返工率: 0.0  停机: 0            │  │
│  └──────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

**签名审批页**：
```
┌──────────────────────────────────────────────────┐
│  签名待审批 (2)                                   │
├──────────────────────────────────────────────────┤
│                                                   │
│  ┌─ slice-001 ────────────────────────────────┐  │
│  │  实现 Web UI 基础框架                        │  │
│  │  请求者: zelto  请求时间: 10:25             │  │
│  │  [✓ 批准]  [✗ 拒绝]                        │  │
│  └──────────────────────────────────────────────┘  │
│                                                   │
│  ┌─ slice-004 ────────────────────────────────┐  │
│  │  度量面板                                    │  │
│  │  请求者: zelto  请求时间: 10:30             │  │
│  │  [✓ 批准]  [✗ 拒绝]                        │  │
│  └──────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### 5.5 事件流实时更新

使用 **Server-Sent Events (SSE)** 而非 WebSocket：
- SSE 是 HTTP 原生支持，不需要额外依赖
- 单向（服务端→浏览器），符合"读多写少"模式
- 浏览器自动重连

**端点**: `GET /api/slices/:id/events/stream` — SSE 流，推送新事件

**轮询兜底**: 对于不支持 SSE 的环境，前端每隔 5s 轮询 `GET /api/slices/:id/events?since=<seq>`。

---

## 6. 约束合规性检查

| 约束 | 检查 | 合规 |
|------|------|------|
| **C1** 状态只在文件里 | 不引入数据库，所有数据从 `.zelto/` 文件读取 | ✅ |
| **C2** core/ 无 SDK 依赖 | Web 适配器在 `adapters/`，可以有依赖；不修改 `core/` | ✅ |
| **C3** 判定确定性 | 所有写操作（审批/拒绝/恢复）使用已有的确定性 core 模块 | ✅ |
| **C4** append-only 事件流 | 每个操作通过 `EventStream.append()` 记录 | ✅ |
| **C5/C8** 保护域 | 写操作走 `evaluatePolicy()` 或 hook；前端不绕过 | ✅ |
| **C6** 依赖单向向下 | `adapters/web/` → `core/`，不反向 | ✅ |
| **C7** llm 不参与判定 | Web UI 不调用 llm 做判定 | ✅ |
| **C9** 写集预约强制 | 执行前走 `Scheduler.admit()` | ✅ |

---

## 7. 技术选型

| 组件 | 选择 | 理由 |
|------|------|------|
| **HTTP 服务端** | `node:http`（Node 内置） | 零额外依赖；请求量小，无需框架 |
| **路由** | 手动路由（`adapters/web/router.ts`） | 简单直接，API 端点 < 20 个 |
| **JSON 序列化** | `JSON.stringify` / `JSON.parse`（内置） | 零依赖 |
| **前端** | 原生 HTML/CSS/JS | 零框架依赖，避免构建工具链 |
| **SSE 推送** | `node:http` + `text/event-stream` | 原生支持，零依赖 |
| **端口** | 默认 4321（可通过 `--port` 配置） | 避免冲突，易于记忆 |
| **绑定地址** | `127.0.0.1`（硬编码） | 安全：仅本地可访问 |
| **启动方式** | `zelto web [--port 4321]` | 作为 zelto 子命令启动 |

### 7.1 为什么不选框架

Web UI 的 API 端点不超过 20 个，且都是简单的文件读取/写入操作。引入 Express/Fastify 会增加：
- 构建时间
- 依赖审计负担
- 与 C2 精神不符（虽然 `adapters/` 可以有依赖）

`node:http` 的少量样板代码完全可管理。

---

## 8. 启动与使用

### 8.1 CLI 集成

新增 zelto 子命令：

```bash
zelto web [--port 4321] [--open]
```

- `--port`: 指定端口（默认 4321）
- `--open`: 启动后自动打开浏览器

### 8.2 注册命令

在 `src/cli/commands/web.ts` 中注册 `web` 命令：

```typescript
register('web', async (args) => {
  const portFlag = args.indexOf('--port');
  const port = portFlag >= 0 ? parseInt(args[portFlag + 1], 10) || 4321 : 4321;
  const openBrowser = args.includes('--open');

  const server = new WebServer({ port, zeltoDir: ZELTO_DIR });
  await server.start();

  console.log(`zelto web UI running at http://127.0.0.1:${port}`);
  if (openBrowser) {
    // 自动打开浏览器
  }

  // 保持进程运行
  await new Promise(() => {});
});
```

### 8.3 开发模式

```bash
# 启动 web UI
pnpm zelto web --open

# 在浏览器中打开 http://127.0.0.1:4321
```

---

## 9. 安全考虑

| 风险 | 缓解措施 |
|------|---------|
| 未授权访问 | 仅绑定 `127.0.0.1`，不暴露到网络 |
| CSRF | 无 session/cookie，fetch 调用无副作用问题 |
| XSS | 所有 JSON 响应设置 `Content-Type: application/json`；前端渲染使用 `textContent` 而非 `innerHTML` |
| 路径遍历 | API 参数中的 `:id` 经过 `/[^a-zA-Z0-9_-]/` 过滤 |
| 写操作绕过 policy | 所有写操作通过 `core/policy/` 判定或通过 hook 检查 |
| 文件锁竞争 | Node 单线程 + 同步文件读取避免竞态（写操作为异步但通过核心模块序列化） |

---

## 10. 替代方案与放弃理由

### 10.1 方案 A：WebSocket 双向通信

**放弃理由**：
- 增加了复杂度（需要管理连接状态、心跳、重连）
- 我们的场景是"读多写少"，SSE + fetch 更简单
- 浏览器兼容性 SSE 优于 WebSocket（SSE 自动重连）

### 10.2 方案 B：Express/Fastify 框架

**放弃理由**：
- 20 个端点不值得引入框架
- `node:http` 足够用
- 框架增加依赖审计负担

### 10.3 方案 C：React/Vue 前端框架

**放弃理由**：
- 需要构建工具链（Vite/Webpack）
- 增加了包体积和开发复杂度
- 原生 JS 足以实现简单的仪表盘
- 避免前端框架版本迭代的维护负担

### 10.4 方案 D：独立进程（类似 hook）

**放弃理由**：
- hook 需要零依赖是因为它被嵌入到各种环境（CI、编辑器插件）
- Web UI 没有这种约束
- 放在 `adapters/` 下更符合架构
- 复用 CLI 已有的共享实例（`shared.ts`）

### 10.5 方案 E：使用 SSE 替代简单轮询

**选择理由**：
- SSE 提供实时更新，比轮询更高效
- Node 内置支持，无需额外依赖
- 提供轮询兜底以兼容所有环境

---

## 11. 实施计划

### 阶段 1：基础服务（1 切片）

1. 创建 `adapters/web/` 目录结构和 `server.ts`
2. 实现 `router.ts` 和基础 API（`GET /api/slices`、`GET /api/slices/:id`）
3. 实现静态文件服务（`frontend/index.html`）
4. 实现 `index.html` 前端切片列表页
5. 注册 `zelto web` CLI 命令
6. 验收：`zelto web` 启动后浏览器可看到切片列表

### 阶段 2：切片操作（1 切片）

1. 实现创建/冻结/废弃 API
2. 实现澄清交互 API（生成问题 + 回答问题）
3. 实现前端切片详情页
4. 实现前端事件时间线
5. 验收：可在 UI 中完成切片全生命周期基本操作

### 阶段 3：审批与执行（1 切片）

1. 实现签名审批/拒绝 API
2. 实现准入/执行/门禁 API
3. 实现前端签名审批页
4. 实现前端执行控制按钮
5. 验收：可在 UI 中审批切片、触发门禁

### 阶段 4：度量和增强（1 切片）

1. 实现度量/审计/预算 API
2. 实现 SSE 事件流
3. 实现前端仪表盘（总览页）
4. 实现前端度量面板
5. 实现停机展示和恢复
6. 验收：仪表盘完整可用，事件实时更新

---

## 12. 未来扩展（不在本 ADR 范围内）

- **AI pipeline 图形化** — 需求→设计→计划→版本→切片的图形化追踪
- **写集冲突可视化** — 图形化展示切片间的写集重叠
- **策略规则编辑器** — 在 UI 中添加/编辑策略规则
- **快照比较** — 对比不同时间点的项目快照
- **自定义仪表盘** — 用户可配置关注哪些切片和指标
- **主题支持** — 亮色/暗色主题切换

---

## 13. 附录：关键接口示例

### 13.1 服务端入口

```typescript
// src/adapters/web/index.ts
export class WebAdapter {
  private server: WebServer;

  constructor(options: { port: number; zeltoDir: string }) {
    this.server = new WebServer(options);
  }

  async start(): Promise<void> {
    await this.server.start();
  }

  async stop(): Promise<void> {
    await this.server.stop();
  }
}
```

### 13.2 路由示例

```typescript
// src/adapters/web/router.ts
export function route(req: IncomingMessage, res: ServerResponse, handlers: Handlers): void {
  const { method, url } = req;
  const [path, query] = url!.split('?');

  // GET /api/slices
  if (method === 'GET' && path === '/api/slices') {
    return handlers.listSlices(req, res);
  }

  // GET /api/slices/:id
  const sliceMatch = path!.match(/^\/api\/slices\/([a-zA-Z0-9_-]+)$/);
  if (sliceMatch && method === 'GET') {
    return handlers.getSlice(req, res, sliceMatch[1]);
  }

  // POST /api/sign-requests/:id/approve
  const approveMatch = path!.match(/^\/api\/sign-requests\/([a-zA-Z0-9_-]+)\/approve$/);
  if (approveMatch && method === 'POST') {
    return handlers.approveSign(req, res, approveMatch[1]);
  }

  // 404
  sendJson(res, 404, { error: 'Not found' });
}
```

### 13.3 切片 API 实现示例

```typescript
// src/adapters/web/api/slices.ts
import { SliceStore } from '../../../core/slice/store.js';
import { EventStream } from '../../../core/events/stream.js';

export function createSliceHandlers(store: SliceStore, events: EventStream) {
  return {
    async listSlices(req, res) {
      const ids = await store.list();
      const slices = await Promise.all(
        ids.map(id => store.read(id).catch(() => null))
      );
      sendJson(res, 200, slices.filter(Boolean));
    },

    async getSlice(req, res, id) {
      try {
        const slice = await store.read(id);
        sendJson(res, 200, slice);
      } catch {
        sendJson(res, 404, { error: `Slice "${id}" not found` });
      }
    },

    async freezeSlice(req, res, id) {
      try {
        const slice = await store.read(id);
        if (slice.state !== 'draft') {
          sendJson(res, 400, { error: `Slice must be "draft", got "${slice.state}"` });
          return;
        }
        // 执行冻结逻辑（同 CLI freeze 命令）
        slice.spec.frozenHash = hashSpecFile(slice.spec.path);
        slice.spec.frozenAt = new Date().toISOString();
        await store.transit(id, 'FREEZE', 'web-ui');
        await events.append(id, 'spec.frozen', 'web-ui', {
          sliceId: id,
          hash: slice.spec.frozenHash,
        });
        const updated = await store.read(id);
        sendJson(res, 200, updated);
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
    },
  };
}
```

### 13.4 前端获取切片列表

```javascript
// frontend/app.js
async function loadSlices() {
  const res = await fetch('/api/slices');
  const slices = await res.json();

  const container = document.getElementById('slice-list');
  container.innerHTML = '';

  for (const slice of slices) {
    const div = document.createElement('div');
    div.className = `slice-card state-${slice.state}`;
    div.textContent = `${slice.id}: ${slice.title} [${slice.state}]`;
    div.addEventListener('click', () => showSliceDetail(slice.id));
    container.appendChild(div);
  }
}

// 自动刷新
setInterval(loadSlices, 5000);
loadSlices();
```

---

## 14. 与现有架构的关系

```
CLI (src/cli/)                     Web UI (src/adapters/web/)
       │                                      │
       ├── shared.ts (store, events)          ├── server.ts
       │       │                              │       │
       │       ▼                              │       ▼
       │   .zelto/slices/*.json               │   .zelto/slices/*.json
       │   .zelto/events/*.jsonl              │   .zelto/events/*.jsonl
       │   .zelto/locks/*.json                │   .zelto/locks/*.json
       │                                      │
       └── core/* ────────────────────────────┘── core/*
                (SliceStore, EventStream, SignManager, Scheduler, ...)
```

**关键点**：CLI 和 Web UI 共享相同的 `core/` 模块和相同的文件状态。它们可以同时运行、交替操作切片，不会产生不一致。

---

## 15. 决定

采用**方案：Web UI Adapter（`src/adapters/web/`）**，理由：

1. ✅ 完全遵循现有架构约束
2. ✅ 复用已有 core 模块，无重复逻辑
3. ✅ 零数据库，状态与 CLI 共享文件
4. ✅ 所有写操作走 policy 判定
5. ✅ 渐进式实施，每阶段一个切片
6. ✅ 安全（仅本地绑定）
7. ✅ 极简依赖（仅 Node 内置）
