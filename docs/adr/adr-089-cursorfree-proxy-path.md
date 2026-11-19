# ADR-089：CursorFree 代理链路 —— `cursor-agent` 能否复用 IDE 的代理与凭证

**状态**：调研完成 + 逐条复核（结论：不推荐作为 zelto 的 Cursor 执行路径）
**日期**：2026-11-19
**相关**：ADR-087（Cursor 第二执行器）、ADR-035（用量口径）

## 背景

ADR-087 落地了 `CursorAgentAdapter`，但当时**没有真实服务端端到端验证** ——
本机 `cursor-agent` 无凭证，报错停在 `Authentication required`。

用户随后提出一个具体问题：

> 「我的 IDE 走的代理，实际凭证应该在代理那儿，代理的客户端软件是 cursor free，
> 我现在运行着呢，走代理是不是可以让 agent 运行起来」

这个问题值得认真回答，不能靠「换个 endpoint 试试」敷衍过去。
本 ADR 记录**逐层实测**的结果。

## 调研对象

| 项 | 值 |
|---|---|
| 代理进程 | `D:\Program Files\CursorFree\cursorfree.exe`（Tauri/Rust） |
| 监听端口 | `http://localhost:8788` |
| 上游网关 | `https://cur-api5.shareai.pro`（来自 `config.json`） |
| 配置 | `%APPDATA%\com.cursorfree.app\config.json` |
| 许可证 | `license.json`：`key_status_code: 1`（使用中），`expired_at: 2026-12-15`，额度 30000 / 已用 23686 |
| IDE 接入方式 | Cursor IDE 以 `--test-backend-url=http://localhost:8788` 启动 |

`config.json` 的关键内容：

```json
{
  "gateway": "https://cur-api5.shareai.pro",
  "port": 8788,
  "headers": [
    { "name": "X-Gateway-Key", "value": "", "enabled": false },
    { "name": "x-jg-model",  "value": "0", "enabled": true },
    { "name": "x-jg-auth",   "value": "eyJpdiI6...", "enabled": true }
  ]
}
```

`x-jg-auth` 是 **AES-GCM 加密**的令牌（`iv` / `ct` / `tag`），无法离线解码，
由 CursorFree 与云端协商产生。

## 实测方法

不靠读文档，全部用真实流量：

1. **TCP 镜像**：把 `cursor-agent` 的连接原样镜像到 8788，落盘双向原始字节，
   看它到底发什么请求；
2. **h2c 代理**：写一个 Node `http2` 明文代理夹在中间，双向流式转发，
   逐个端点探测上游响应；
3. **矩阵探测**：对 `content-type` × 自定义头 × 路由方法做全组合。

## 实测结论（分层）

### 第 1 层：凭证可以复用，握手能过

`cursor-agent` 用 IDE 的 JWT（从 `state.vscdb` 的 `cursorAuth/accessToken`
提取到 `%APPDATA%\Cursor\auth.json`）能通过代理完成握手：

```json
{"type":"system","subtype":"init","apiKeySource":"login",
 "session_id":"83d79d09-...","model":"Auto","permissionMode":"default"}
```

**结论：凭证层没问题。** `apiKeySource: "login"` 表示认证成功、
session 已建立。

### 第 2 层：CursorFree 返回**重复的 content-type 头** —— 这是第一个真实障碍

镜像下来的原始响应字节（`ServerConfigService/GetServerConfig`）：

```
HTTP/1.1 200 OK
server: openresty
content-type: application/octet-stream      ← 第一个
content-type: application/proto              ← 第二个
grpc-status: 0
connection: close
content-length: 0
```

`cursor-agent` 的 connect 客户端读到第一个 `application/octet-stream` 就抛：

```
Error: [unknown] unsupported content type application/octet-stream
```

而正常响应（如 `GetMe`）只有单个 `content-type: application/proto`。

**这不是 `cursor-agent` 的 bug，是 CursorFree 网关的行为。**
注意：`GetMe` 这种路由正常，`GetServerConfig` 这种异常 —— 逐路由不同。

### 第 3 层：`agent.v1.AgentService/Run` 恒定 400「注入失败」

绕开 content-type 问题后，对话端点暴露出来：

| 端点 | content-type | 结果 |
|---|---|---|
| `aiserver.v1.DashboardService/GetMe` | `application/proto` | ✅ 200 + 正确 proto 响应 |
| `aiserver.v1.AiService/GetUsableModels` | `application/proto` | ✅ 200 + 完整模型列表 |
| `agent.v1.AgentService/Run` | `application/connect+proto` | ❌ 400 |
| `agent.v1.AgentService/RunSSE` | `application/connect+proto` | ✅ 200（穿透到上游） |
| `agent.v1.AgentService/RunPoll` | `application/connect+proto` | ✅ 200（`requestId is undefined`） |
| `agent.v1.AgentService/NameAgent` | `application/connect+proto` | ❌ 404（CursorFree 未实现） |
| `aiserver.v1.ChatService/StreamUnifiedChat` | `application/connect+json` | ✅ 200 |

`Run` 的 400 响应体（中文，来自云端而非本地 exe）：

```json
{"error":"Bad Request",
 "message":"注入失败: Agent/Run 注入失败，请激活插件后再使用此功能"}
```

`RunSSE` 能穿透，说明**认证与路由都对**；
`Run` 失败在「注入」这一步 —— CursorFree 要往请求体里注入插件提示，
而它解析不了 `cursor-agent` 发的 `connect+proto` 双向流帧。

### 第 4 层：即使穿透，上游也会拒绝

`RunSSE` 带真实负载时的上游响应：

```json
{"error":{"code":"resource_exhausted","details":[{"debug":{
  "error":"ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT",
  "detail":"Your version of Cursor is no longer supported.
            Please update to the latest version at cursor.com/downloads"}}]}}
```

上游认为 **CursorFree 声明的客户端版本过旧**。
`cursorfree.exe` 里确实有 `x-cursor-client-version` 头（二进制内可见
`cursor-client-version: ... single message / connect frames / headers (whitelist)`）。

### 第 5 层：`cursor-agent` 用的路由与 CursorFree 实现的路由**语义不一致**

反查 `cursor-agent` bundle（`versions/2026.09.18-9a7762b/index.js`）：

```js
p = require("../proto/dist/generated/agent/v1/agent_service_pb.js")
g = { typeName: "agent.v1.AgentService",
      methods: { run:      { name: "Run",     kind: BiDiStreaming },
                 runSSE:   { name: "RunSSE",  kind: ServerStreaming },
                 runPoll:  { name: "RunPoll", kind: ServerStreaming },
                 nameAgent:{ name: "NameAgent", kind: Unary },
                 getUsableModels: {...}, ... } }
```

即 `agent.v1.AgentService` 是**官方 Cursor API 的路由**，
`cursor-agent` 走 `Run`（双向流）。

而 CursorFree 的 `agent.v1` 路由是它自己实现的（`Run` 注入失败、
`NameAgent` 404）。**两边的 `Run` 语义不一致**：
官方 `Run` 是双向流，CursorFree 的 `Run` 期待能被它改写的单次请求。

## 结论

> **走 CursorFree 代理，不能让 `cursor-agent` 跑起来。**

理由不是「配置没调对」，而是三处**结构性**不匹配：

| # | 不匹配 | 能否绕过 |
|---|---|---|
| 1 | CursorFree 返回重复 `content-type` 头，connect 客户端拒收 | **能** —— 写 shim 删掉多余的头 |
| 2 | CursorFree 的 `Agent/Run` 注入逻辑解析不了 `cursor-agent` 的 `connect+proto` 双向流帧 | **不能**（除非改 CursorFree） |
| 3 | CursorFree 声明的 `x-cursor-client-version` 过旧，上游直接拒绝 | **不能**（除非改 CursorFree） |

第 1 条可以在 zelto 侧用一层薄 shim 解决（本 ADR 的探测过程中已验证可行：
握手 `system/init` 成功拿到 session id）。
但第 2、3 条**在 CursorFree 内部**，zelto 无权修改。

**这不是 zelto 的问题，也不是配置问题。** 结论：
CursorFree 是给 **Cursor IDE** 用的第三方代理，
它实现的是「IDE 客户端协议」的一个子集，不是「cursor-agent 协议」。

### 对 zelto 的影响

1. **ADR-087 的 `CursorAgentAdapter` 保持不变** ——
   它对接的是官方 `cursor-agent` CLI 协议，与 CursorFree 无关。
2. **ADR-087 §「未能验证的部分」要更新** ——
   真实服务端端到端**依然未验证**。本次调研把「无凭证」的原因查清了：
   不是「本机没装 / 没登录」，而是**免费额度已耗尽**
   （直连官方 `api2.cursor.sh` 时报 `ActionRequiredError:
   You've hit your usage limit`），且 CursorFree 代理这条路走不通。
3. **不引入 CursorFree 作为 zelto 的 Cursor 后端。**
   若将来 CursorFree 支持了 `agent.v1.AgentService/Run` 的双向流语义，
   可以重新评估 —— 但那需要 zelto 侧加一层 shim，属于契约变更，需再写 ADR。
   （复核后更确定：shim 本身已验证可行，卡点全在 CursorFree 内部。）

### 备选路径（未验证，按优先级）

1. **官方 API + 可用额度**：`cursor-agent login` + 可用额度，
   直接连 `api2.cursor.sh`。这是 ADR-087 设计的原生路径。
2. **Cursor 官方 `cursor-agent` 订阅**：与 IDE 同一账号但独立计费。
3. `cursor-agent` 支持 `--api-key` —— 若 CursorFree 侧有可用的 API key 形态凭证，
   可绕过网关协议直接用（**未验证**）。

## 复核（2026-11-19 11:43 之后逐条重测）

上面的结论是**调研过程**里得到的。落地前逐条重测了一遍 ——
每一条都复现，且**补上了调研过程里没记的一个关键事实**。

### 逐条复现结果

| 结论 | 复现方式 | 结果 |
|---|---|---|
| 官方额度已耗尽 | 用 IDE 的 JWT 直连 `api2.cursor.sh` 跑 `cursor-agent` | ✅ `ActionRequiredError: You've hit your usage limit` |
| 重复 `content-type` 头 | 抓 `cursor-agent` → CursorFree 的**真实响应头原文** | ✅ 见下方原始字节 |
| `Run` 恒定 400「注入失败」 | 直连 8788 打 `agent.v1.AgentService/Run` | ✅ 400 + 中文「注入失败」 |
| `NameAgent` 404 | 同上 | ✅ 404 |
| 凭证可复用 | 同上 | ✅ `GetMe` → 200 + 正确 proto 响应 |

真实响应头原文（同一个连接里的两个响应 —— 一个正常、一个重复）：

```
HTTP/1.1 200 OK
server: openresty
content-type: application/proto            ← 单个头，正常
content-length: 108

HTTP/1.1 200 OK
server: openresty
content-type: application/octet-stream     ← 第一个
content-type: application/proto           ← 第二个
grpc-status: 0
connection: close
content-length: 0
```

### 补上的一条：协议层是 **h1**，不是 h2

调研过程里没记这条，但它决定了第 1 条**能不能绕过**：

```
cursor-agent → CursorFree 的连接是 HTTP/1.1
```

**为什么重要**：h2 的响应头是 HPACK 压缩的，**没法在字节层删掉多余的头**
（删字面量会破坏动态表索引）。h1 就可以 —— 逐行扫响应头，删掉重复的
`content-type` 行即可。

结论从「原理上可行」变成「**实测可行**」。

### 第 1 条能绕过 —— 已实测

用一层 h1 字节层 shim（删重复 `content-type`、保留 `application/proto`，
其余原样转发），`cursor-agent` **成功握手**：

```json
{"type":"system","subtype":"init","apiKeySource":"login",
 "session_id":"9acf4997-87fb-495d-ada9-d386639d1b1c",
 "model":"Auto","permissionMode":"default"}
```

`apiKeySource: "login"` = 认证成功、session 已建立。
**shim 日志确认它确实命中了 4 次重复头。**

握手之后 `cursor-agent` 进入 `reconnecting` 重试 ——
**这正是第 2 条说的那个障碍**（`Run` 端点注入失败 → 重连）。

> 所以结论比调研时更精确：
> **shim 能把 `cursor-agent` 送到「会话已建立」这一步，
> 但过不去第 2 条。**
>
> 「绕过了 content-type」不等于「能跑起来」—— 这两件事之间还隔着
> 一个 CursorFree 内部的注入逻辑。

### 对结论的影响

**结论不变**（走 CursorFree 代理不能让 `cursor-agent` 跑起来），
但依据更硬了：

- 第 1 条**确实可以**在 zelto 侧绕过 —— 已跑通到握手成功
- 第 2、3 条在 CursorFree 内部 —— zelto 无权修改
- 因此**净结论仍然是「不通」**

### 一条方法论

这次复核最值得记的不是结论，是**「绕过一道障碍 ≠ 能跑起来」**：

调研时第 1 条被判为「能绕过」，容易读成「所以这条路能走」。
实际上第 2 条会立刻接上。**三道障碍要一起看** ——
一道能绕过、两道不能，净结果仍然是零。

## 参考

- `cursor-agent 2026.09.18-9a7762b` bundle 反查
- `D:\Program Files\CursorFree\cursorfree.exe` 字符串分析
  （`crates\gateway-core\src\core.rs`、`x-jg-auth`、`x-jg-model`、
  `X-Gateway-Key`、`x-cursor-client-version`）
- `%APPDATA%\com.cursorfree.app\config.json` / `license.json`
