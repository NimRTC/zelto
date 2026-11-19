# ADR-089：CursorFree 代理链路 —— `cursor-agent` 能否复用 IDE 的代理与凭证

**状态**：调研完成 + 两轮复核（结论：**不可行**，卡在凭证签发模型，非协议问题）
**日期**：2026-11-19
**相关**：ADR-087（Cursor 第二执行器）、ADR-035（用量口径）

> **一句话结论**：CursorFree 代理能把 `cursor-agent` 的请求**完整送到上游**，
> 但 `agent.v1.AgentService/Run` 需要一枚只有 IDE 侧才能签发的
> `clientLlmGatewayCredential`，缺它恒被判 `ERROR_UNAUTHORIZED`（`isRetryable: false`）。
> 这条路由**不是配置或协议能解决的**。

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

### 第 2 层：CursorFree 返回**重复的 content-type 头** —— 只发生在 h1 上

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

### 第 3 层：`agent.v1.AgentService/Run` 用**空请求体**测是 400「注入失败」

> ⚠️ **2026-11-19 12:00 修正**：这一层的原始结论「`Run` 恒定 400」**不成立**。
> 当时是用空帧（`\x00\x00\x00\x00\x00`）打的，CursorFree 解析不出
> `AgentRunRequest`，自然报「注入失败」。用 `cursor-agent` 发出的**真实请求体**
> 重测后，`Run` 走 h2 并被正常转发 —— 详见下文「第二轮复核」。

用空帧直连 8788 时各路由表现：

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
>
> ⚠️ **下表是调研阶段的判断，第 2、3 条已被第二轮复核推翻**（见文末）。
> 保留它是为了记录推理过程 —— 最终依据以「第二轮复核」一节为准。

理由不是「配置没调对」，而是三处**结构性**不匹配：

| # | 不匹配 | 能否绕过 |
|---|---|---|
| 1 | CursorFree 返回重复 `content-type` 头，connect 客户端拒收 | **能** —— 写 shim 删掉多余的头 |
| 2 | ~~CursorFree 的 `Agent/Run` 注入逻辑解析不了双向流帧~~ | **误判** —— 真实请求能被正常转发 |
| 3 | ~~CursorFree 声明的 `x-cursor-client-version` 过旧~~ | **误判** —— 带上 `cli-<version>` 头即可过 |

第 1 条可以在 zelto 侧用一层薄 shim 解决（本 ADR 的探测过程中已验证可行：
握手 `system/init` 成功拿到 session id）。
第 2、3 条经第二轮复核确认**不是障碍** —— 真正的墙是网关令牌（见文末）。

**这不是 zelto 的问题，也不是配置问题。** 结论：
CursorFree 是给 **Cursor IDE** 用的第三方代理，
它转发的是「IDE 客户端协议」的一个子集；而 `cursor-agent` 的 `Run`
需要一枚**由 IDE 侧签发**的网关令牌，代理无法代签。

### 对 zelto 的影响

1. **ADR-087 的 `CursorAgentAdapter` 保持不变** ——
   它对接的是官方 `cursor-agent` CLI 协议，与 CursorFree 无关。
2. **ADR-087 §「未能验证的部分」要更新** ——
   真实服务端端到端**依然未验证**。本次调研把「无凭证」的原因查清了：
   不是「本机没装 / 没登录」，而是**免费额度已耗尽**
   （直连官方 `api2.cursor.sh` 时报 `ActionRequiredError:
   You've hit your usage limit`），且 CursorFree 代理这条路走不通。
3. **不引入 CursorFree 作为 zelto 的 Cursor 后端。**
   若 CursorFree 将来改成能代签网关令牌，可以重新评估 ——
   但那属于契约变更，需再写 ADR。
   （两轮复核确认：shim 本身可行、转发可行、版本闸门可过；
   卡点是**令牌签发方**，不是协议。）

### 备选路径（按优先级）

1. **官方 API + 可用额度**：`cursor-agent login` + 可用额度，
   直接连 `api2.cursor.sh`。这是 ADR-087 设计的原生路径。
   —— 当前本机卡在免费额度耗尽（`You've hit your usage limit`）。
2. **Cursor 官方 `cursor-agent` 订阅**：与 IDE 同一账号但独立计费。
3. ~~`cursor-agent --api-key` 绕过网关~~ —— **经查证无效**：
   `--api-key` 只改 `authorization` 头（账单层），
   而 `Run` 缺的是**请求体内**的 `clientLlmGatewayCredential`（算力层），
   两者不是同一层。走这条路仍会撞 `ERROR_UNAUTHORIZED`。

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

> ⚠️ **2026-11-19 12:00 修正：这条判断错了。**
> `Run`（BiDiStreaming）走的是 **h2**，实测抓到 `PRI * HTTP/2.0` 前导。
> 只有 unary RPC（`GetMe`、`GetServerConfig` 等）走 h1。
> 下面「h2 无法在字节层删头」的推理本身没错，但**不构成障碍** ——
> 因为重复 `content-type` 只出现在 h1 响应上，h2 的 HPACK 头天然是单值。
> 保留原文是为了记住这个教训。

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

---

## 第二轮复核（2026-11-19 12:00）—— 上一轮有三处判断错了

上面那轮复核用的是 h2 shim，测出的错误其实是**我自己的 shim 引入的**。
换成**纯字节直通**（h2 一个字节都不改、h1 只在字节层删重复头）重测，
结论发生实质变化。

### 修正 1：`Run` 走 h2，且被 CursorFree **正常转发**

抓到的连接前导（`c16.req` 首 16 字节）：

```
PRI * HTTP/2.0
```

CursorFree 对该 h2 连接的响应拆帧后（`c16.res`，960 字节）：

```
SETTINGS len=24
SETTINGS len=0
PING sid=0 len=8
HEADERS sid=1 len=353 flags=0x4
DATA sid=1 len=9    ← Connect 帧头
DATA sid=1 len=47   ← 回显 session_id: abe6986c-...
DATA sid=1 len=9
DATA sid=1 len=416  ← 真正的错误体
RST_STREAM sid=1
```

**它回显了 `cursor-agent` 的 session_id** —— 证明 CursorFree **成功解析了**
h2 的 `AgentRunRequest`、成功注入、成功送到上游。
「注入失败」是我上一轮用空请求体测出来的假象。

### 修正 2：真正的拦路虎是**网关鉴权**，不是协议

那段 416 字节的 DATA 解出来是标准 Cursor proto 错误：

```json
{"error":{"code":"unauthenticated","message":"User is unauthorized",
  "details":[{"type":"aiserver.v1.ErrorDetails","debug":{
    "error":"ERROR_UNAUTHORIZED",
    "details":{"title":"Unauthorized request.","detail":"User is unauthorized",
      "isRetryable":false,
      "analyticsMetadata":{"actionRequired":"login"}},
    "isExpected":true},"value":"CCYSOAoVVW5hdXRob3JpemVkIHJlcXVlc3Qu
      EhRVc2VyIGlzIHVuYXV0aG9yaXplZCAAUgcKBWxvZ2luGAE"}]}}
```

`actionRequired: "login"`、`isExpected: true`、`isRetryable: false`
—— 云端明确要求**登录**，且**不可重试**。

### 修正 3：账单类 RPC 全部通过，只有 `Run` 被拒

同一进程、同一凭证、同一代理，unary RPC 全绿：

| 路由 | 结果 |
|---|---|
| `DashboardService/GetMe` | ✅ 200（`local_pro`、`pro-plugin@cursorfree.fun`）|
| `AiService/AvailableModels` | ✅ 200（360KB 完整模型列表）|
| `AiService/GetUsableModels` | ✅ 200 |
| `AiService/GetDefaultModelForCli` | ✅ 200 |
| `ServerConfigService/GetServerConfig` | ✅ 200（h1，重复头已被 shim 修掉）|
| `DashboardService/GetManagedSkills` | ✅ 200 |
| `agent.v1.AgentService/Run` (h2) | ❌ `ERROR_UNAUTHORIZED` |

**这说明「代理的路由/凭证转发」是好的**，被拒的是**真正消耗模型算力的那一步**。

### 机制：`Run` 需要一枚额外的网关令牌，而客户端自己拿不到

反查 bundle 里 `AgentRunRequest` 的构造（`index.js:3596706`）：

```js
clientLlmGatewayCredential: Se,   // ← 由 mintLlmGatewayCredential 回调产出
// ...
const Se = void 0 === g.mintLlmGatewayCredential
  ? void 0
  : await (g.mintLlmGatewayCredential)({signal, isCanceled, requestId});
// 产出后校验：bearerToken 不能为空
```

即：`Run` 除了 `authorization: Bearer <IDE JWT>`，还要在**请求体内**带一枚
`ClientLlmGatewayCredential.bearerToken`。这枚 token 由宿主（IDE）注入。

`cursor-agent` 以 `--endpoint http://127.0.0.1:9911` 指向代理时，
`mintLlmGatewayCredential` **拿不到**这枚 token（它本来要靠 IDE 侧的会话），
于是 `Run` 请求里这枚凭证缺失 → 上游判 `unauthenticated`。

**而 IDE 能跑通**，正是因为 IDE 是 token 的原生签发方。
这是整条链路里最硬的一环：**它不是协议问题，也不是配置问题，
是「谁是凭证签发方」的身份问题。**

### 修正 4：`x-cursor-client-version` 确实能过版本闸门

上一轮说「上游认为 CursorFree 声明的版本过旧」。实测：带上
`x-cursor-client-version: cli-2026.09.18-9a7762b`（`cursor-agent` 自己就会发这个头，
bundle 里 `index.js:283371` 构造 `cli-${version}`）后，
`RunSSE` 返回 **200 且保持连接**，不再报 `resource_exhausted`。

**版本闸门是可以过的** —— 但它过后，仍会撞上 `ERROR_UNAUTHORIZED`。

### 第二轮复核后的净结论

**结论不变（不通），但理由完全换了。**

| 原以为的障碍 | 实际 |
|---|---|
| h1 重复 `content-type` | 真实存在，**但可绕过**（字节层删重复行，已跑通）|
| `Run` 注入失败 | **伪障碍** —— 空请求体测出来的，真实请求能被转发 |
| 上游版本过旧 | **可绕过** —— 带上 `cli-<version>` 头即可 |
| —— | **真正的墙：`Run` 缺 `clientLlmGatewayCredential` → `ERROR_UNAUTHORIZED`** |

最后一道墙属于 **Cursor 的凭证签发模型**，不是 zelto 或 CursorFree 能改的。
`isRetryable: false` 说明重试无意义。

### 方法论（比上一轮那条更硬的版本）

上一轮记的是「绕过一道障碍 ≠ 能跑起来」。
这一轮补上更关键的一条：

> **代理式诊断里，先排除「我的 shim 自己引入了错误」。**

上一轮把 h2 解析式转发的实现 bug（`http2` 流默认 paused、
`ServerHttp2Stream` 没有 `.resume()`）当成了代理的缺陷，
于是得出「`Run` 注入失败」的错误结论。
换成纯字节直通（h2 零干预）后，错误立刻从
`unsupported content type` / `注入失败` 变成云端白纸黑字的 `ERROR_UNAUTHORIZED`。

**诊断代理的第一原则：能不改字节就不改字节。**
只有在确认字节层缺陷（如重复 `content-type`）时才动，且一次只动一处。

---

## 对结论的影响

**结论不变**（走 CursorFree 代理不能让 `cursor-agent` 跑起来），
但依据完全换了 —— 不是「协议不通」，而是「**凭证签发模型不通**」：

- 重复 `content-type`：**可在 zelto 侧绕过** —— 已实测跑通握手
- `Run` 的 h2 请求：**CursorFree 能正常转发** —— 已抓到 session 回显
- 版本闸门：**带上 `cli-<version>` 头即可过**
- `ERROR_UNAUTHORIZED`：**过不去** —— 缺 IDE 侧签发的
  `clientLlmGatewayCredential`，且 `isRetryable: false`

前三道都能绕过，最后一道不能。**净结果仍然是零**，
但这次是「知道撞在哪面墙上」的零。

### 可复用的产物

这轮排查留下的两个事实对 zelto 有独立价值：

1. **诊断代理的原则**：纯字节直通优先，改动一次只改一处。
   上一轮的错误结论就是 shim 自身 bug 造成的假象。
2. **`cursor-agent` 的鉴权分层**：`GetMe`/模型列表走 JWT 即可（账单层），
   `Run` 额外要网关令牌（算力层）。这解释了为什么会看到
   「能登录、能看模型、就是不能跑」这种割裂现象。

## 参考

- `cursor-agent 2026.09.18-9a7762b` bundle 反查
- `D:\Program Files\CursorFree\cursorfree.exe` 字符串分析
  （`crates\gateway-core\src\core.rs`、`x-jg-auth`、`x-jg-model`、
  `X-Gateway-Key`、`x-cursor-client-version`）
- `%APPDATA%\com.cursorfree.app\config.json` / `license.json`
