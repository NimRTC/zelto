# ADR-133：ACP 作为一等执行器载体，C9 的主判定点按 adapter 声明

**状态**：已决（2026-11-27）· **已落地**（S1–S5 全部完成，含落地期三处修正）
**日期**：2026-11-27
**相关**：ADR-083（多 harness 判定内核与 harness 无关）、ADR-087（Cursor 执行器）、ADR-090（凭证外部化）、ADR-130（判定事件带 `runId`）、C2/C3/C4/C9

**落地提交**：`ef000b8`（S1–S3 依赖与判定内核）、`7c0ce29`（S4 适配器与协议层）、
`5f0d782`（S5 端到端与验收）、`f7e2e6c`（落地期三处修正）。
**验证**：3542 个单元测试 + 156 个验收测试全绿（`npm test` exit 0）。

## 背景

zelto 现在的执行器都是「spawn 某家 CLI + 解析它私有的事件流」：

| adapter | 驱动 | 协议 | 写前拦截靠什么 |
|---|---|---|---|
| `claude-agent` | `claude` CLI | `--output-format json` | `.claude/settings.local.json` 的 `PreToolUse` |
| `claude-agent-sdk` | Agent SDK | SDK 回调 | SDK `hooks` 选项 |
| `cursor-agent` | `cursor-agent` CLI | `--output-format stream-json`（NDJSON） | `.cursor/hooks.json` 的 `preToolUse` |

问题在于**每接一家 agent 都要写一遍私有协议解析 + 装一遍私有 hook 配置 + 赌它的工具名**。
ADR-083 已经踩过「matcher 写了假想的工具名 → 钩子永远不被调用 → 写集预约在 Cursor 下等于没有」的坑；
再多几家（Codex 已在 `hook-install.ts` 里各自一份，gemini-cli / 其它还在后面），
这个「每家一份私有协议」的成本只会上升。

ACP（Agent Client Protocol，Zed 主导）把这一层标准化了：

- agent 是**子进程**，stdio 上的 JSON-RPC；zelto 作为 **client** 掌握会话；
- `session/new` / `session/prompt` / `session/update` 覆盖「起跑 / 喂提示词 / 收进度」；
- **`session/request_permission` 是 agent 的写前询问** —— agent 要动工具（尤其写文件与执行命令）时，
  先向 client 请求授权，**client 回 allow / reject**。

T3 Code（`pingdotgg/t3code`，MIT）已经用它统一驱动 Claude Code、Codex、Cursor、OpenCode 等
（其 `packages/provider-acp`），证明这条路可行。

**关键观察**：`session/request_permission` 正是 C9 需要的东西 ——
而且是**由 agent 主动问、由 zelto 回答**，比「装个 hook 等它触发」更硬：
不回答 = 拒绝，不依赖任何一家 harness 的 `failClosed` 配置。

## 决策

### 决策一：ACP 是 `ExecutorAdapter` 的第三种实现，端口不变

`src/core/ports/executor.ts` 的**方法**不改。新增 `src/adapters/acp/`：

```
src/adapters/acp/
  index.ts        AcpAdapter implements ExecutorAdapter
  protocol.ts     JSON-RPC 信封、ACP method 名、版本协商
  events.ts       session/update → zelto 事件（进度信号 / 输出文本）
  auth.ts         initialize 的 authMethods → 鉴权失败的修法（落地补充）
  permission.ts   session/request_permission → C9 判定 → allow_once / reject_once
```

`createExecutorAdapter()` 增加 `acp` 分支，由 `agent.acp.command` 指定驱动哪个 ACP agent：

```yaml
agent:
  adapter: acp
  acp:
    command: "cursor-agent acp"     # 或 "codex acp" —— 由用户的 agent CLI 决定
    # 凭证：与 ADR-090 同口径，走 agent.env / 用户已有登录态，zelto 不接管
```

> **「ACP 要不要单独安装」的答案：不用装 —— 但子命令可能被藏起来。**
>
> 实测（2026-11-27，`cursor-agent 2026.09.18-9a7762b`）：`cursor-agent acp`
> **存在且可用**，但注册时带 `hidden: true`，所以 `cursor-agent --help`
> 列出的 20 个子命令里**看不到它**。
>
> 只查 `--help` 会得出「不支持 ACP」的错误结论 —— 这也是为什么本 ADR
> 的实测章节要求**直接跑一次握手**，而不只看帮助文本。

`start / resume / continueSession / stop / waitForExit / markProgress / getUsage` 的语义逐一对应：

| 端口方法 | ACP 落地 |
|---|---|
| `start` | `initialize` → `session/new` → 记下 ACP sessionId → `session/prompt` |
| `resume`（问答回路） | `session/prompt` 往同一 session 追加人的回答 |
| `continueSession`（超时续跑） | 同上，提示词换「接着上次做」 |
| `markProgress` | `session/update` 里任何 `tool_call` / `tool_call_update` 都算进展 |
| `stop` | 终止子进程（与 ADR-055 同：杀整棵进程树） |
| `getOutput` | 累积的 `agent_message_chunk` 文本；`session/prompt` 的 `stopReason` 记状态 |
| `getUsage` | ACP 没有标准用量字段 → **返回 null（测不到），不谎报 0**（ADR-035 口径） |

**会话 id 的取舍与 `CursorAgentAdapter` 一致**：agent 发的 sessionId 是唯一续跑锚点；
拿不到就**抛错**，不静默开新会话（ADR-013 §3.4）。

### 决策二：C9 的「主判定点」是 adapter 声明的能力，不是全局固定的

在 `AdapterMeta.capabilities` 增加一个字段：

```ts
capabilities: {
  resume: boolean;
  events: boolean;
  modelSelection: boolean;
  /** C9 的主判定点：hook（agent 侧装钩子）或 permission（ACP 回调） */
  writeGuard: 'hook' | 'permission';
}
```

- 现有三个 adapter 声明 `writeGuard: 'hook'` —— 行为**完全不变**；
- `AcpAdapter` 声明 `writeGuard: 'permission'`；
- `zelto run` / 并行执行 / 主管在拉起 agent 前读这条声明：
  - `'hook'` → 按现状装 `.claude/settings.local.json` / `.cursor/hooks.json` / `.codex/hooks.json`；
  - `'permission'` → **不装 hook**（装了也不会在 ACP 通道上被调用；见决策四）。

**为什么放在 `AdapterMeta` 而不是配置**：这是「这个 adapter 怎么实现 C9」的事实，
不是用户的偏好。让用户去配「用哪套闸门」等于给「关掉闸门」开了一个配置项 ——
C9 是硬约束，不可选。

### 决策三：permission 回调的判定**只在 `src/hook/` 里**，adapter 只做翻译

沿用 ADR-083 §1 的分层，只把「输入」从 hook 的 stdin 换成 ACP 的 `request_permission`：

```
ACP request_permission ──▶ normalizeAcpToolCall() ──▶ 统一载荷 {tool_name, tool_input}
                                                         │
                                                         ▼
                                          judgeWriteTargets()  ← 不变量在这（一行不改）
                                                         │
                                                         ▼
   ACP response ◀── renderAcpPermission(判决) ◀─────── 统一判决
```

- 新增 `src/hook/acp.ts`（与 `harness.ts` 并列）：`normalizeAcpToolCall(kind, rawInput) → NormalizedPayload`、
  `renderAcpPermission(verdict) → { outcome: 'selected', optionId }`；
- ACP 的 `ToolCallKind`（`read` / `edit` / `delete` / `move` / `execute` / `search` / `fetch` / `think` / `other` …）
  映射到现有归一化工具名：`edit|delete|move → Write`，`execute → Bash`，`read|search|fetch|think → 只读（read_only: true）`；
- **`kind` 不认识、`rawInput` 里找不到路径或命令 → 按现有兜底「找路径字段」，仍找不到 → 拒绝**
  （与 ADR-083 §2 同一个原则：不认识不等于放行）。

### 决策四：ACP 下「写集预约主判定」与「hook」的边界

| 机制 | ACP 路线下 | 理由 |
|---|---|---|
| **写集预约 / 保护域 / 路径逃逸（C9 主闸门）** | `session/request_permission` → `judgeWriteTargets()` | 逐写判定，**没有 allow_always**（见下） |
| hook（`.claude/…`、`.cursor/…`、`.codex/…`） | **不装** | 同一会话两套闸门 = 两份 `policy.decision`、两种结论可能并存，追溯链反而变脏 |
| git 审计（`core/sched/audit.ts`） | **照旧兜底** | fail open，只报告；不受本 ADR 影响 |

**必须遵守的两条硬规则**：

1. **永不发 `allow_always`。** ACP 允许 agent 用一次请求拿到「以后都允许」；
   这与「写集预约是**逐写**判定的」直接冲突。
   适配器只回 `allow_once` / `reject_once`（在 agent 提供的 options 里挑最窄的；
   没有「一次」选项时退回 `reject_once` 并在事件里记原因）。
2. **拒绝要在事件流里留完整证据。** 每次 permission 回调都写一条 `policy.decision`（C4），
   字段与 hook 路径一致（`sliceId / tool / harness / policyVersion / runId / basis / ruleId`），
   `harness` 记为 `acp:<agentCommand>`（例如 `acp:cursor-agent`），**不是**硬编码成某一家
   （ADR-083 §6 的「写假账」同形状）。

### 决策五：并列上线，**不改默认**

- 新增 `'acp'` 作为 `agent.adapter` 的可选值；**默认仍是 `claude-agent`**；
- 在至少一个真实版本里用 `--adapter acp` 跑通验收，再决定是否改推荐；
- 现有三个 adapter 行为不变 —— 本 ADR 是**增量**，不是迁移。

### 决策六：ACP 的 `session/update` 同时解决两件事

- 输出文本 → `getOutput()` / `onOutput`（人看得到 agent 在说什么）；
- `tool_call` / `tool_call_update` → `markProgress()`（D-55 的空转超时信号）。
  这比 `ClaudeAgentAdapter` 下靠 hook 事件喂 `markProgress` 更直接。

ACP 规范的 `session/update` 种类是封闭集合；**不认识的 `sessionUpdate` 值一律忽略并记警告**，
不因新版本多一种通知就让会话崩掉。

## 被否决的方案

1. **把 ACP 塞进 `hook-install.ts`（继续装 hook）**：
   ACP agent 并不读某家 CLI 的 hooks 配置；继续装等于「看起来装了、实际不生效」。
   这正是 ADR-083 注释里那段「假想工具名」的坑的另一种形状。
2. **让 ACP adapter 自己实现一套判定**：
   判定从 `src/hook/` 漂到 `src/adapters/`，下一次审计会发现「同一个结论两处产出」。
   违反 ADR-083 §1 与 ADR-025（追溯判定单一来源）。
3. **把 ACP 的 toolKind 映射放进 `core/`**：
   `core/` 不应知道任何 agent 协议的名字（C2 精神：core 只认自己的端口）。
   映射放 `src/hook/acp.ts`，与现有 `harness.ts` 并列。
4. **允许 `allow_always` 以换「少打断」**：
   违反「逐写判定」。少打断 = 少追溯，这是 zelto 不做的交易。

## 影响面

| 文件 | 改动 |
|---|---|
| `src/core/ports/executor.ts` | `AdapterMeta.capabilities` 增加 `writeGuard: 'hook' \| 'permission'`（**类型扩展，字段必填**） |
| `src/adapters/claude-agent/` `claude-agent-sdk/` `cursor-agent/` | 只加 `writeGuard: 'hook'` 一行 |
| `src/adapters/acp/`（**新增**） | adapter + JSON-RPC 协议层 + 事件映射 + permission 回调 |
| `src/hook/acp.ts`（**新增**） | `normalizeAcpToolCall` / `renderAcpPermission` |
| `src/hook/index.ts` | 对外导出新增函数（若需要） |
| `src/cli/commands/shared.ts` | `createExecutorAdapter` 增加 `acp` 分支；用户配置解析 `agent.acp.*` |
| `src/core/config/loader.ts` | 解析 `agent.acp.command` |
| `src/cli/commands/core-slice.ts` / `parallel-executor.ts` / `supervisor.ts` | 按 `capabilities.writeGuard` 决定装不装 hook |
| `tests/adapters/acp/`（**新增**） | 协议层单测、permission 映射、**「绝不回 allow_always」断言** |
| `tests/hook/acp.test.ts`（**新增**） | 归一化/渲染纯函数单测 |

**实际落地时新增的文件**（ADR 原稿未列，是落地必需的）：

| 文件 | 作用 |
|---|---|
| `tests/acp-adapter.test.ts` | 协议层 / 事件映射 / 用量口径 / **依赖作用域断言** |
| `tests/acp-e2e.test.ts` | **真子进程**跑通 permission 判定（mock ACP agent） |
| `tests/acp-write-guard.test.ts` | **permission 路线不装任何 hook**（验收 2） |
| `tests/acp-command-resolution.test.ts` | 命令解析与 `--adapter` 取值校验 |
| `tests/fixtures/mock-acp-agent.mjs` | mock ACP agent（端到端测试用，非生产代码） |

**原计划的 `tests/adapters/acp/dependency-scope.test.ts` 落到了
`tests/acp-adapter.test.ts`**（同一份文件里已经有依赖作用域那条断言）——
测试文件的位置按 zelto 现有惯例放在 `tests/` 根下，与其它适配器测试一致。

**不涉及**：`core/policy/`、`core/gate/`、`core/sched/` 的判定逻辑（C3 不受影响）、
`.zelto/config.yaml` 的 JSON Schema（没有 schema，手写解析，同 ADR-090）。

## 依赖（已拍板 2026-11-27）

**决定：引入 `@agentclientprotocol/sdk`，且只允许在 `src/adapters/acp/` 里 import。**

已核实的包事实（2026-11-27，`@agentclientprotocol/sdk@2.12.0`）：

| 项 | 值 | 对 zelto 的意义 |
|---|---|---|
| license | **Apache-2.0** | 与 zelto MIT 兼容（不传染） |
| `type` | `"module"`（纯 ESM） | 与 zelto 的 ESM / `NodeNext` 一致；`esModuleInterop` 已开启 |
| `dependencies` | **无** | 不引入传递依赖 |
| `peerDependencies` | `zod`（必选）、`@modelcontextprotocol/server`（optional） | **需要手动把 `zod` 加进 `dependencies`**；MCP peer 不装 |
| 稳定入口 | `@agentclientprotocol/sdk`（ACP v1） | 只用这个入口；`unstable` / `experimental/v2` 一律不用（v2 是 Preview） |
| 体积 | 解包 5.2 MB（含 `schema/*.json`） | npm 包只发 `dist/`，不进最终产物；可接受 |
| engines | 无声明 | 不新加 Node 版本约束（zelto 已要求 ≥22） |

**为什么不再退回手写 JSON-RPC**：
ACP v1 的 `session/update` 是**封闭 union**；`initialize` 带 `clientCapabilities` 时，
客户端还必须「忽略不认识的命名字段、保留未知 alias」。
手写 JSON-RPC 意味着 zelto 自己实现这层宽容度，并跟 v1 schema 演进同步。SDK 已带
`schema/v1/schema.json`，协议面用 fixtures 覆盖即可。

**为什么不让 SDK 进 `core/`**：
C2 不许 —— `core/` 零第三方运行时依赖。判定模块（`judgeWriteTargets`）**根本不 import SDK**；
SDK 只出现在 `src/adapters/acp/`，它把 ACP 的 `toolCall` 翻译成 `src/hook/acp.ts` 的
`NormalizedPayload`，再把判决翻译回 `RequestPermissionOutcome`。

**落地要求**：

1. `package.json` 新增：
   ```jsonc
   "dependencies": {
     "@agentclientprotocol/sdk": "^2.12.0",
     "zod": "^4.0.0",            // SDK 的必需 peer，zelto 直接依赖
     ...
   }
   ```
2. 只允许 `src/adapters/acp/**` 引用该包。新增测试
   `tests/adapters/acp/dependency-scope.test.ts`：扫描 `src/`，一旦在 `src/adapters/acp/`
   之外出现 `from '@agentclientprotocol/sdk'` 就判非零。
3. `src/adapters/acp/` 直接挂在根 `tsconfig.json`（`module: NodeNext`）下 ——
   SDK 是 ESM，`import * as acp from '@agentclientprotocol/sdk'` 在 NodeNext 下即可。

**不符合预期时的退路**（不修改本 ADR 状态，只记录边界）：
- SDK 在 NodeNext / strict 下编译失败 → 退回**手写 JSON-RPC**，
  并把 `schema/v1/schema.json` 作为契约文件落 `contracts/schemas/acp-v1.json`，
  那需要一条独立 ADR（「契约 schema 外置」），不在本 ADR 范围内。

## 不变量自查

- **C1**（状态只在文件里）：**无影响** —— ACP 会话状态落 `.zelto/sessions/<sessionId>.json`
  （复用 `session-store.ts`），与 Cursor 适配器同口径。
- **C2**（core 零依赖、不 import adapters）：**无影响** —— 新代码全在 `src/adapters/` 与 `src/hook/`；
  `core/ports/executor.ts` 只增加一个**类型字段**，仍是零依赖。
- **C3**（判定确定性）：**不触网、不调模型** ——
  permission 回调走的是 `judgeWriteTargets()` 纯函数；
  ACP 协议层与 stdio 通信都在 `src/adapters/`，不在 `core/policy/`。
- **C4**（append-only 事件流）：**加强** —— permission 回调的每次判定都写 `policy.decision`，
  `harness` 字段记录真实 ACP 来源。
- **C5**（保护域与 anchor 外部化）：**无影响** —— 保护域判定仍在 `judgeWriteTargets()`。
- **C7**（llm 只产草稿）：**无影响** —— ACP adapter 不经过 `llm/`。
- **C9**（写集预约运行时强制）：**加强** —— ACP 路线下写前询问内建，不靠装 hook；
  逐写判定、fail closed 靠「不回答 = 拒绝」与「永不 allow_always」。

## 验收标准

1. `AdapterMeta.capabilities.writeGuard` 必填；三个现有 adapter 各加 `writeGuard: 'hook'`，
   `AcpAdapter` 加 `writeGuard: 'permission'`；
2. `zelto run --adapter acp` 拉起一个 ACP agent 时，**不装任何 hook 配置**
   （`.claude/settings.local.json` / `.cursor/hooks.json` / `.codex/hooks.json` 均不被 zelto 动）；
3. ACP 下 agent 发起 `request_permission` 时，**每次**都有一条 `policy.decision` 事件，
   `harness = acp:<command>`、`runId` 是**本轮**（ADR-130）；
4. **任何情况下不回 `allow_always`**（单测断言）；
5. 越界写入（不在写集 / 保护域 / 逃逸）一律 `reject_once`，原因取自 `judgeWriteTargets` 的 reason；
6. `kind` 不认识且找不到路径/命令字段 → `reject_once`（不放过）；
7. `session/update` 的 `tool_call` 能驱动 `markProgress`（空转超时信号有来源）；
8. `getUsage` 返回 `null`（不谎报 0，ADR-035 口径）；
9. 现有三个 adapter 行为不变 + `npm test` 全绿（本 ADR 是增量）；
10. `@agentclientprotocol/sdk` 只被 `src/adapters/acp/**` import；
    其它位置出现 → `tests/adapters/acp/dependency-scope.test.ts` 判非零；
11. `zod` 已加入 `package.json` 的 `dependencies`（SDK 的必需 peer）。

## 落地时发现并修掉的三处「跑起来的不是你说的那个」（2026-11-27）

ADR 写的接口与实现之间有三处缝。它们的共同形状是：**界面看不出问题，
跑起来才发现连的不是那个 agent** —— 这类 bug 最难查，所以逐条钉住。

### 1. `resolveAgentCommand` 不认 ACP —— 命令解析落回 Claude

`resolveAgentCommand` 只认 `cursor-agent`，其它一律落回 `cfg.agent.command`
（默认 `npx claude-code`）。于是 `zelto run --adapter acp` 会**三处不一致**：

- 界面显示 `Agent: npx claude-code`（错的）；
- 预检去查 `where npx`（查的不是真要跑的东西）；
- 而适配器实际起的是 `agent.acp.command`。

**修法**：`resolveAgentCommand` 认 `acp` → 走 `resolveAcpCommand`。
显式覆盖（`--agent`）优先级不变 —— 忽略它会让用户传的参数静默失效。

### 2. ACP 分支忽略显式传入的 `--agent`

`createExecutorAdapter` 的 ACP 分支直接用 `resolveAcpCommand(cfg)`，
把调用方传进来的 `agentCommand` 参数**丢掉了**。
**修法**：与其它适配器统一为「显式覆盖 > adapter 默认值 > 配置」。

### 3. `--adapter` 的取值没有校验 —— 打错字静默落回 Claude

`--adapter acpp`（打错字）会落回默认分支，跑起 Claude，**不报任何错**。
界面正常、流程正常，只是跑的不是你要的 agent。

**修法**：新增 `validateAdapterName()` + `ADAPTER_NAMES` 白名单，
认不出的值**当场报错**并列出可选值。

**共同教训**：`adapter` 决定「跑的是谁」这件事，在本 ADR 之前**散落在三处**
（命令解析、预检、适配器工厂），三处各写一份 → 迟早漂移。
现在由 `resolveAgentCommand` / `resolveAcpCommand` / `writeGuardForAdapter`
三个函数**各自单一来源**，其余地方只调不写。

### 附带修正的两处 ADR 表述

- **验收标准 8**：`getUsage` 的准确口径是「**agent 报了才有，没报就是 null**」——
  ACP v1 的 `usage_update.cost` 字段其实存在（ADR 原文写「没有标准用量字段」不准确）。
  币种非 USD 时**不折算**（折算需要汇率，是「不确定」的来源）。
- **验收标准 2 的边界**：ACP 路线不装 hook，但**预约照取不误** ——
  permission 回调读的就是那份预约。「谁来问」不同，不等于「有没有判据」。

### 一处 ACP 路线独有的 fail closed 闸门（ADR 未写，落地时补）

ACP 的 `kind` 是规范定义的**封闭集合**。落到 `other` 或规范外的值，
意味着这次调用**可能**在写东西，而我们看不出它写什么 ——
这类请求**直接拒绝**，不走 hook 路线的「空目标 = 放行」。

hook 路线下「不认识的工具名」会走「找路径字段」的兜底，找到就判、找不到就放行；
而 ACP 那边「找不到路径」+「不是只读」= **判不出写目标 = 拒绝**。

### 真实 agent 实测（2026-11-27，`cursor-agent acp`）

ADR 写的是「任何 ACP agent」。落地后拿**真实**的 `cursor-agent acp`（2026.09.18-9a7762b）
实测，发现两件 ADR 没写的事：

#### 1. `cursor-agent acp` 存在，但**在 `--help` 里看不见**

它的子命令注册是 `_e.command("acp", { hidden: true })` ——
所以 `cursor-agent --help` 列出 20 个子命令，里面**没有** `acp`。

**这就是「ACP 要不要单独安装」这个问题的答案：不用装，但要知道它被藏起来了。**
只查 `cursor-agent --help` 会得出「不支持 ACP」的错误结论。

bundle 里 ACP 的实现是完整的（`8096.index.js` 有 `session/request_permission`、
`session/new`、`authenticate` 等全套方法）。

#### 2. 协议版本对得上，但**鉴权是独立的关卡**

实测 `initialize` 回包：

```json
{"protocolVersion":1,
 "agentCapabilities":{"loadSession":true, ...},
 "authMethods":[{"id":"cursor_login","name":"Cursor Login",
                 "description":"Authenticate using existing Cursor login credentials. Run 'agent login' first if not logged in."}]}
```

**`protocolVersion: 1`** —— 与 zelto 的 `PROTOCOL_VERSION = 1` 完全一致，
版本闸门（ADR-133 已决的 fail closed）在真实 agent 上**不会误伤**。

但紧接着是第二道关卡：**没登录时 `session/new` 直接返回**
`Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'.`

**ADR 没写这一道**，原实现直接把这句话透传成
「ACP 会话失败：Authentication required」—— 说的是事实，但人不知道该做什么。

**落地补充**（`src/adapters/acp/auth.ts`）：

- `initialize` 回包里的 `authMethods` 记下来；
- 失败时识别「需要登录」，给出**可执行的修法**（登录方式 + agent 自己的说明）；
- 认不出是鉴权问题 → **照原样报错，不猜**。

**zelto 不替用户登录**，这是有意的：

- 登录是浏览器授权流程（`agent login`），弹窗在 agent 子进程里 ——
  zelto 看不见、也点不了；
- 就算能点，也是**替人做凭证授权**（ADR-090 凭证外部化的精神）。

这与 C9 的 fail closed 不冲突：鉴权失败时**根本进不了判定环节**，
没有「静默放行」的可能。

### 登录之后的那一段，尚未在真实 agent 上验证（2026-11-27）

实测到「需要登录」为止 —— 本机 `cursor-agent status` 显示 `Not logged in`，
再往下（真实 `session/prompt` + 真实 `session/request_permission` 往返）**没有实测过**。

原因是登录要用户自己做浏览器授权（zelto 不代劳）。

**但登录方式本身是清楚的**（实测 `cursor-agent models` 的错误原文）：

```
Authentication required. Run 'agent login', pass --api-key/--auth-token,
or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN.
```

三条路：`agent login`（浏览器授权）/ `--api-key` / `--auth-token` /
`CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` 环境变量（ADR-090 的凭证外部化口径）。

### ⚠️ 与 IDE 的登录态**不共用**（2026-11-27 实测，重要）

「ACP 能不能用我 IDE 里那个 Cursor 的额度？」——**不能**，实测：

| | 位置 | 实测 |
|---|---|---|
| IDE | `%APPDATA%\Cursor\User\globalStorage\state.vscdb`（71 GB），含 `cursorAuth` key | **已登录** |
| `cursor-agent` CLI | `%APPDATA%\<Name>\auth.json`（bundle 里的 `getAuthFilePath`） | **不存在 → 未登录** |

**Cursor 的 CLI 与 IDE 是两套登录态。** 这不是 zelto 的问题，是 Cursor 自己的设计。

另外 IDE 里**没有 ACP 实现**（`workbench.desktop.main.js` 里
`agentclientprotocol` / `request_permission` / `session/new` 命中数均为 0）——
`agent_acp` 只是 structured-log 的**分类标签**，不是协议实现。

ACP 的方向是 **zelto → 外部 agent CLI**，不是 zelto → IDE。
IDE 那条路（`cursor desktop`）见 **ADR-091**，闸门至今未开放，且过不了 C9。

**当前已验证 vs 未验证的边界**：

| 环节 | 验证方式 |
|---|---|
| `initialize` 握手 + protocolVersion=1 | ✅ 真实 `cursor-agent acp` 实测 |
| `authMethods` 抽取与错误信息 | ✅ 真实 agent + 单测 |
| 版本不匹配 → fail closed | ✅ 单测（mock agent 报错版本） |
| permission 回调 → 允许/拒绝 | ✅ 端到端（mock ACP agent，真子进程） |
| **真实 agent 的 prompt 往返** | ❌ **未验证**（需先登录） |
| **真实 agent 的 permission 往返** | ❌ **未验证**（需先登录） |

**这不是「已完成」**。登录一次之后应当补测最后两行 ——
尤其是真实 agent 的 `toolCall.kind` 取值是否落在
`src/hook/acp.ts` 的归一化映射表里（ACP 规范的 `kind` 是封闭集合，
但各家 agent 可能塞进 `other`）。

> **注意与 ADR-091 的区别**：`cursor desktop`（驱动 IDE 内的 agent）与
> `cursor-agent acp`（驱动独立 CLI 进程）是**两条不同的路**。
> 前者闸门未开放且过不了 C9；后者今天已可用，只差一次登录。

## 已拍板（2026-11-27）

- **是否引入 `@agentclientprotocol/sdk`** → **引入**（版本 `^2.12.0`，Apache-2.0，纯 ESM，零传递依赖），
  必须把 `zod` 同时加入 `dependencies`。只允许在 `src/adapters/acp/` 里 import；
  其它位置出现判非零。详见上文「依赖（已拍板 2026-11-27）」。
- **`agent.acp.command` 独立字段**（不与 `agent.command` 复用）—— 避免 Cursor 适配器的
  flag 拼装与 `where` 查询误用到 ACP 上。

## 已决（2026-11-27 更新）

- **ACP 版本的向后兼容策略** ——  `initialize` 的 protocolVersion 不匹配时：
  **决定：拒绝（fail closed）**。不降级。违反版本协议的 agent 拒绝建立会话。
- **SDK 的 ACP v2 Preview 入口**（`@agentclientprotocol/sdk/experimental/v2`）是否跟踪：
  **决定：不跟踪**。只挂 v1 稳定入口 `@agentclientprotocol/sdk`。
- **是否借鉴 T3 的 `clientPolicy.ts`**：其路径 canonicalize（符号链接感知、fail closed）与 zelto 现有逻辑相似。
  **决定：借鉴**。在 `src/hook/acp.ts` 的路径判定中参考其思路（符号链接识别、失败即拒绝），
  但不合并为共享模块——路径判定仍留在各自的 hook 层，`core/` 保持 C2 纯洁。
- **ACP session 的 checkpoint 能力（若有）** 是否接入 zelto：
  **不在本 ADR 范围内**。当前 zelto 没有 checkpoint，只在切片层做回滚。后续如需接入，另开 ADR。

## 参考

- Agent Client Protocol 规范（Zed）：`https://agentclientprotocol.com/`
- T3 Code `provider-acp`：`https://github.com/pingdotgg/t3code/tree/main/packages/provider-acp`
- T3 Code 的 provider 纪律：`https://github.com/pingdotgg/t3code/blob/main/docs/internals/03_providers.md`
- 本仓库：`docs/adr/adr-083-multi-harness-runtime-write-enforcement.md`、`src/hook/harness.ts`、`src/hook/pretool.ts`
