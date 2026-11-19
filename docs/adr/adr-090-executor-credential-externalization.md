# ADR-090：执行器凭证外部化 —— zelto 不绑定任何一种 Cursor 登录方式

**状态**：已实现（2026-11-19）
**日期**：2026-11-19
**相关**：ADR-087（Cursor 第二执行器）、ADR-089（CursorFree 代理路实测）

## 背景

ADR-087 落地了 `CursorAgentAdapter`，它 spawn 的是官方 `cursor-agent` CLI。
CLI 本身支持**三种互斥的凭证来源**：

| 方式 | 用法 | 适用人群 |
|---|---|---|
| 交互登录 | `cursor-agent login`（浏览器授权，落 `~/.local/share/cursor-agent`） | 有 Cursor 订阅的个人用户 |
| API key | `--api-key <key>`，或 `CURSOR_API_KEY` 环境变量 | CI、服务账号 |
| 自建/第三方网关 | `--endpoint <url>`，或 `CURSOR_API_ENDPOINT` 环境变量 | 走代理、企业内网网关的用户 |

目前 `CursorAgentAdapter` **只跑默认路径**（`cursor-agent` 自己找登录态），
`cursorFlags()` 里没有任何透传凭证参数的通道。

后果：
- 走代理网关的用户（如 CursorFree、企业网关）**无法在 zelto 里用 Cursor**；
- 用 API key 的 CI 场景**同样无法**；
- 想临时换模型 / 换端点，只能改 `agent.command` 整串字符串 ——
  而 `agent.command` 是**命令名**，把它写成带参数的一长串会撞上
  `resolveAgentCommand()` 的语义（它被当作命令本体去 `where` 查）。

ADR-089 已经实测：CursorFree 这类代理链路**结构上跑不通**
（`Run` 需要 IDE 侧签发的 `clientLlmGatewayCredential`）。
但**这只说明「CursorFree」这一个具体产品不通**，不代表
「所有非默认端点的用户都不该被支持」——企业网关、自建 relay、
API key 是真实存在且**能跑通**的用法。

**所以本 ADR 解决的是一条独立的、正向的需求：
不把 zelto 绑死在某一种凭证方式上。**

## 决策

### 1. 新增 `agent.env` —— 环境变量透传

```yaml
agent:
  adapter: cursor-agent
  env:
    CURSOR_API_KEY: "key_xxx"          # CI / 服务账号
    CURSOR_API_ENDPOINT: "https://gw.example.com"
```

`agent.env` 是 `Record<string, string>`，在 spawn 时**合并进子进程环境**，
优先级：`process.env` < `agent.env` < 适配器自己的 ZELTO_* 变量
（ZELTO_* 是 zelto 的协议变量，不许被覆盖）。

**为什么用环境变量而不是命令行旗标**：
- `cursor-agent` 官方的两个凭证入口**都有环境变量形态**
  （`CURSOR_API_KEY` / `CURSOR_API_ENDPOINT`），且是官方文档化行为；
- 环境变量**不会出现在进程表**里 —— 旗标形态（`--api-key xxx`）
  会把密钥暴露在 `ps` / 任务管理器里；
- 不依赖具体 CLI 的旗标拼法，换 CLI 版本不会崩。

### 2. 新增 `agent.cursor` 节 —— Cursor 专属可选参数

```yaml
agent:
  adapter: cursor-agent
  cursor:
    endpoint: "https://gw.example.com"   # → --endpoint
    apiKeyEnv: "MY_CURSOR_KEY"           # 读取哪个环境变量作为 --api-key
```

| 字段 | 作用 | 落地方式 |
|---|---|---|
| `endpoint` | 自定义网关地址 | `--endpoint <url>` |
| `apiKeyEnv` | 从**哪个环境变量**读 key | 运行时取 `env[apiKeyEnv]` → `--api-key <key>` |

`apiKeyEnv` 存的是**变量名**，不是密钥本身 ——
配置文件进 git，密钥不进（与 ADR-022 的 `ZELTO_LLM_API_KEY` 同一口径）。

`cursor` 节是**可选覆盖**：same 值也能通过上面的 `agent.env` 给到，
两者等价；`cursor` 节存在是为了让「我想用哪个端点」比
「我需要知道 Cursor 的环境变量叫什么」更可读。

### 3. 优先级（从高到低）

```
1. CLI 显式 --endpoint / --api-key（将来若要加）
2. agent.cursor.endpoint / agent.cursor.apiKeyEnv
3. agent.env.CURSOR_API_ENDPOINT / CURSOR_API_KEY
4. process.env 里的同名变量（用户 shell 里已设置的）
5. cursor-agent 自己的默认（api2.cursor.sh + 本地登录态）
```

任何一层都没配 → **完全退回 CLI 默认**，行为与今天一致（向后兼容）。

### 4. 不做的

- **不内置任何代理或中转**：zelto 只透传配置，不实现网关。
  走哪条链路是用户的事，zelto 不推荐也不屏蔽。
- **不在配置里存明文密钥**：只支持「读环境变量」，不支持 `apiKey: "xxx"`。
  理由同 ADR-022 —— 配置文件是要进版本库的。
- **不做凭证探活**：适配器不主动调 `cursor-agent status` 去验证凭证。
  跑失败自然会在事件流里报错，多一次网络请求只会让 `run` 变慢。

## 影响面

| 文件 | 改动 |
|---|---|
| `src/core/config/loader.ts` | 解析 `agent.env`、`agent.cursor` |
| `src/core/config/index.ts` | 类型导出 |
| `src/adapters/cursor-agent/index.ts` | `cursorFlags()` 接受 endpoint/apiKey；spawn 合并 env |
| `src/cli/commands/shared.ts` | 把配置透传给适配器构造 |
| `.zelto/config.yaml` 模板 / 文档 | 示例 |

**不涉及**：`core/policy/`、`core/gate/`、`core/sched/`（C3 不受影响）、
schema（`.zelto/config.yaml` 没有 JSON Schema 校验，是手写解析器）。

## 不变量自查

- **C1**：状态只在文件里 —— 凭证从环境变量读，不落盘 ✓
- **C2**：`core/` 零第三方依赖、不 import `adapters/` —— 配置解析在
  `core/config/`，适配器在 `adapters/`，方向正确 ✓
- **C3**：判定不触网 —— 本 ADR 只影响 spawn 参数，不进判定路径 ✓
- **C4**：事件流不受影响 ✓
- **C5**：保护域不可覆盖 —— 凭证配置**不触碰**保护域与策略锚点 ✓
- **C7**：`llm/` 只产草稿 —— 无关 ✓
- **C9**：写集预约 —— 本改动不绕过 hook ✓

## 备选方案

| 方案 | 为什么不选 |
|---|---|
| 把凭证写进 `agent.command` 一长串 | 命令名会被 `where` 查（必失败）；且密钥进进程表 |
| 让用户自己在 shell 里 export | 可行但不可审计、不可复现 —— 换台机器就丢 |
| 内置对 CursorFree 之类的专用适配 | 那是把 zelto 绑死在第三方产品上，且 ADR-089 已证不可行 |

## 未决

- 是否给 `--api-key` 也加 CLI 旗标（`zelto run --api-key`）？
  倾向**不加**：密钥走命令行会进 shell 历史与进程表。
- `agent.cursor` 是否该泛化成 `agent.options`（任意 CLI 的任意旗标）？
  倾向**不泛化**：泛化后 zelto 就变成了「CLI 参数拼接器」，
  而每个 CLI 的旗标语义都不同，泛化只会把语义问题推给用户。
