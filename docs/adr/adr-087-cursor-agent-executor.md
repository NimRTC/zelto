# ADR-087：Cursor 作为第二种 agent —— 执行器适配器与运行时守卫接线

**状态**：实施
**日期**：2026-11-18
**相关**：ADR-083（多 harness 运行时写前强制）、ADR-014（运行时策略强制）、ADR-035（用量口径）、ADR-055（超时与进程树）、C9（写集预约运行时强制）

## 背景

zelto 的执行器侧一直只有一个实现：`ClaudeAgentAdapter`（`claude` CLI）。
用户要「用 Cursor 跑 zelto」时，现状是**做不到**，而不是「做起来麻烦」：

1. `AdapterType` 只有 `'claude-agent' | 'claude-agent-sdk'` ——
   `--adapter cursor-agent` 会被当成未知值，落到默认分支，
   **起一个 claude 进程**；
2. 配置里的 `agent.command` 默认是 `npx claude-code` ——
   即使硬塞一个 Cursor 适配器进去，命令解析出来的仍是 Claude；
3. 运行时守卫装的是 `.claude/settings.local.json` ——
   Cursor CLI **根本不读这个文件**，hook 一次都不会被调用。

第 3 条是最严重的：**C9 这条不变量在 Cursor 下等于不存在**。
而 git 审计兜底是 fail open 的（`core/sched/audit.ts`：「审计类问题一律 fail open」，
只报告不阻断），所以 hook 不生效 = **唯一的硬闸门被关掉，只剩一个会说话但不拦人的审计员**。

### 与 ADR-083 的关系

ADR-083 解决了「**判定内核**与 harness 无关」这一层：
`src/hook/harness.ts` 做归一化与渲染，判定内核一行未改。

但 ADR-083 只覆盖了**协议层**。本 ADR 补上的是**执行器层**：
谁来起 agent、怎么起、会话怎么续、用量怎么记、
以及 —— **装哪种 harness 的钩子**。

### 调研结论（2026-11-18 实查 cursor-agent 2026.09.18）

| 项 | 实测结果 |
|---|---|
| 无交互旗标 | `-p` / `--print`（**拥有全部工具**，含写文件与 shell） |
| 事件流 | `--output-format stream-json` → **NDJSON**（逐行事件，不是单个 JSON） |
| 增量文本 | `--stream-partial-output` |
| 会话续跑 | `--resume <chatId>` |
| 会话 id 来源 | **agent 自己发的**：`system/init` 事件里的 `session_id` |
| 提示词传输 | headless + 非 TTY 下从 **stdin** 读 |
| 用量 | `result` 事件带 `usage: {inputTokens, outputTokens, ...}`，**不带 `costUsd`** |
| 真实工具名 | `Write` / `Delete` / `Shell` / `Read` / `ReadLints` / `Grep` / `List` / `Fetch` / … |
| PreToolUse 匹配 | `new RegExp(matcher).test(tool_name)` |
| PreToolUse 响应字段 | **`permission` / `user_message` / `agent_message`**（snake_case） |
| hook 失败语义 | 默认 **fail open**，`failClosed: true` 可改为 fail closed |
| `--yolo` 的真实含义 | **`--force` 的别名**（`e.force \|\| e.yolo` → 同一个 `run-everything`） |
| `run-everything` 是否绕过 hook | **否** —— `preToolUse` 在工具执行路径上无条件触发 |
| 工具输入字段 | `Write`/`Delete` → `{file_path}`；`Shell` → `{command, cwd}` |
| hook 配置文件路径 | `<项目根>/.cursor/hooks.json`（还有 enterprise/team/user 三层） |
| hook 事件名枚举 | `preToolUse` / `postToolUse` / `beforeShellExecution` / `afterFileEdit` / … |

## 决策

### 1. 新增 `CursorAgentAdapter`（`src/adapters/cursor-agent/`）

实现 `ExecutorAdapter` 端口（`src/core/ports/executor.ts`），
与 `ClaudeAgentAdapter` 的差别**不是「换个命令」**，而是三处协议差异：

| | Claude Code | Cursor |
|---|---|---|
| stdout | 一个 JSON 对象 | **NDJSON 事件流** |
| 会话 id | zelto 生成 `--session-id` | **agent 自己发**（`system/init`） |
| 用量 | token + **美元** | **只有 token** |

**C2**：只用 Node 内置模块（`node:child_process` / `node:fs` / `node:os`）。
**C1**：会话状态落 `.zelto/sessions/<sessionId>.json`（复用 `adapters/session-store.ts`）。
**C4**：每个动作的 append-only 事件由 CLI 层写（与 Claude 侧同口径）。

### 2. 提示词走 stdin，不走命令行参数

bundle 可能几万字符。塞进命令行会撞 Windows 的 32767 字符上限，
而且会在进程表里留下整段提示词。

Cursor CLI 在 headless + 非 TTY stdin 下会读 stdin 作为提示词 ——
所以适配器把提示词写进 child 的 stdin，写完 `end()`。

### 3. **不用 `-y` / `--yolo`**

先纠正一个**容易想当然的地方**（2026-11-19 实查 cursor-agent 2026.09.18 修正）：

> `--yolo` **不是** `--force` 的「更激进版本」，它是 `--force` 的**别名**。
> 实测 `approval-mode-setting.ts`：
> `const t = e.force || e.yolo;` → 两者都产出 `run-everything`。
>
> 所以「因为 `--yolo` 会关掉闸门所以不用它」这个论证是**错的** ——
> `--force` 关掉的是**同一个**东西。带 `--force` 就已经关掉了。

真正需要论证的是：**`run-everything` 会不会绕过 zelto 的写前 hook？**

实查结论：**不会**。`preToolUse` 的触发点（`te()`）在工具执行器里
是**无条件**执行的，不看 approval mode：

```js
// te() —— 所有工具都走这里
1. fire preToolUse { tool_name, tool_input, tool_use_id }
2. if (response.permission === "deny") → reject
3. catch (hook 出错): if hasFailClosedHooksForStep(preToolUse, toolName) → reject
4. 然后才跑 runPreExecutionHooks（Shell 额外走 beforeShellExecution）
```

也就是说：`run-everything` 关掉的是 **Cursor 自己的确认询问**，
**zelto 的 hook 仍然在同一条路径上被调用**，deny 照样拦得住。

那为什么还是**只写 `--force`、不写 `--yolo`**？

不是为了「少关一个闸门」（两者等价），而是为了**可读性**：
`--force` 是文档里的正式名字，`--yolo` 是别名；
在一个安全相关的命令行里，用一个语义更露骨、更容易被误读成
「跳过一切检查」的别名，没有好处。

> ⚠️ 与 C9 的关系要说清楚：
> `run-everything` **不绕过 hook**，但它**绕过 Cursor 自己的询问**。
> zelto 的判定因此仍然有效 —— 这是「两道闸门里只关了一道」，
> 而不是「C9 失效」。C9 由 zelto 自己的 hook 承担，不依赖 Cursor 的询问。

### 4. **`getUsage()` 返回 null，不返回 0**

Cursor 报 token，**不报美元**。而 `AdapterUsage.costUsd` 是必填字段。

按 ADR-035 的语义返回 **null（= 没测到）**：

> 把「没测到」写成「零」，会让预算闸门变成一道**假闸门** ——
> 它显示「这一轮没花钱」，而实际上 Cursor 侧是按额度订阅的。

token 数单独可查（`getTokenUsage()`），记账层要区分
「真的是零」与「没测到」。

### 5. 拿不到 agent 会话 id 时**报错**，不静默开新会话

Cursor 的会话 id 是 agent 自己发的，zelto **不能预先指定**。
拿不到就意味着 agent 崩在初始化之前。

此时 `resume()` / `continueSession()` **抛错**，而不是开一个新会话：
静默开新会话 = 上下文清零 = agent 已经做掉的事全作废（ADR-013 §3.4）。

### 6. 修正 ADR-083 里的 Cursor 工具名 —— **matcher 必须用 CLI 真实工具名**

ADR-083 §2 写的 Cursor 工具名是 `edit_file` / `create_file` / `terminal` ——
**这些名字在 cursor-agent 里根本不存在**。

matcher 的求值是 `new RegExp(matcher).test(tool_name)` ——
一个都匹配不上 → hook 永远不被调用 → **写集预约在 Cursor 下等于没有**，
而 `.cursor/hooks.json` 看上去一切正常。

> 这是**看不见的失效**：不是报错，是安静地不生效。
> 与 D-63 / README 那句「已发布到 npm」是同一个形状。

本 ADR 把 matcher 改成 CLI 真实工具名：

```
Cursor: Write|Delete|Shell
Codex:  apply_patch|shell|write|edit
```

归一化层（`src/hook/harness.ts`）同步补齐别名：
`delete → Write`、`shell → Bash`。
旧名字（`create_file` / `edit_file` / …）**保留** ——
多认不漏拦，且老版本 Cursor 仍能用。

### 7. **Cursor 的响应字段是 snake_case**

实测 cursor-agent 2026.09.18 的 PreToolUse 响应 schema：

```json
{ "permission": "allow|deny|ask",
  "user_message": "...",
  "agent_message": "..." }
```

写成 camelCase（`userMessage` / `agentMessage`）的话，
Cursor 的校验器会**直接丢掉这两个字段** —— 判决照样生效（`permission` 认了），
但「为什么被拒」人看不到、模型也拿不到：
人看到一句无来由的拒绝，agent 只会反复重试同一个越界动作。

### 8. 只读工具必须显式豁免

归一化的兜底是「工具名不认识 → 找路径字段」。
而 `Read` / `Grep` / `List` / `Fetch` **也带路径字段**。

不显式豁免的话，agent 读一个写集外的文件会被判成「越界写入」——
把「不许写」误判成「不许看」，agent 连查资料都做不了。

`harness.ts` 新增 `READ_ONLY_TOOL_ALIASES` / `READ_ONLY_TOOLS`，
归一化时标 `read_only: true`，`extractWriteTargets()` 跳过它们。

> 注意这条**只豁免只读**，不豁免「未知工具」——
> 未知工具仍然退回「找路径字段」并判定（ADR-083 §2 的保守原则不变）。

### 9. `harnessForAdapter()` —— adapter 与 harness 的对应关系写成一张显式的表

```ts
'cursor-agent' → 'cursor'
'codex'        → 'codex'
其它           → 'claude-code'
```

adapter 决定「谁在跑 agent」，harness 决定「agent 的钩子协议长什么样」。
配错的后果是**静默失效**：hook 收到自己看不懂的信封 → 判不了 →
要么全部拒绝（agent 完全不能动），要么在 Cursor 的 fail-open 默认下全部放行。

所以运行时守卫的 `harness` 选项由 `harnessForAdapter(adapterType)` 填，
**不各处写 if**。

### 10. Cursor 的默认命令是 `cursor-agent`，不继承 Claude 的

配置里的 `agent.command` 默认 `npx claude-code`。直接复用的话，
切到 Cursor 后会起一个 claude 进程 —— 表面上「适配器是 Cursor」，
实际跑的是 Claude。

`resolveAgentCommand(adapterType, override, cfg)` 的优先级：
**显式覆盖 > adapter 默认值 > 配置里的 command**。

### 11. 命令可用性检查与 adapter 解耦

原先用的是 `ClaudeAgentAdapter.checkAgentAvailable()`（静态方法）。
拿 `cursor-agent` 去问「claude 在吗」，答案永远是「不在」。

改用 `src/adapters/agent-command.ts`（ADR-086 抽出来的通用检查）——
Claude / Cursor / Codex 查的都是同一件事：**这条命令找不找得到**。

## 验证记录（2026-11-19）

集成完成后**没有**只跑单元测试就收工 —— 本机装了真实的
`cursor-agent 2026.09.18-9a7762b`，于是拿真东西逐条核。

### 验证层级

| 层 | 做法 | 结果 |
|---|---|---|
| L1 真实二进制旗标 | `cursor-agent --help` + 实跑旗标组合 | 旗标全部被接受；报错停在**鉴权**阶段而非「未知选项」 |
| L2 真实 bundle 反查 | 直接读 `versions/2026.09.18-9a7762b/*.index.js` | 见下方「逐条证实」 |
| L3 hook 端到端 | 用**真实 Cursor 载荷形状**喂 `dist/hook/index.js` | 6 种情形全部正确 |
| L4 单元 + 全量 | `npm test` | **2577 passed / 0 failed** |

### 逐条证实（全部来自真实 bundle 源码，非文档转述）

| 假设 | bundle 里的证据 |
|---|---|
| 提示词走 stdin | `build-prompt.ts`：`if (ve && prompt.length === 0 && stdin) prompt = await readAll(stdin)`；`ve = !process.stdin.isTTY` |
| `system/init` 形状 | `{type:"system",subtype:"init",session_id,model:o.displayName,cwd,permissionMode}` |
| `assistant` 形状 | `{type:"assistant",message:{role:"assistant",content:[{type:"text",text}]}}` |
| `tool_call` 形状 | `{type:"tool_call",subtype:"started",call_id,tool_call,model_call_id}` |
| `result` 形状 | `{type:"result",subtype:"success",is_error,duration_ms,result,session_id,usage?}` |
| usage 字段名 | `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` |
| **无 `costUsd`** | 整个 bundle 里 `costUsd` 字符串**不存在** → `getUsage()` 返回 null 有据 |
| hook 请求字段 | `executeHookForStep(preToolUse, {tool_name: r.toolName, tool_input, tool_use_id})` |
| hook 响应字段（snake_case） | `if ("deny" === a?.permission) { const o = a.user_message \|\| ... }` |
| matcher 求值方式 | `new RegExp(e.matcher).test(t)`，`t` 就是 `tool_name` |
| `failClosed` 语义 | `hasFailClosedHooksForStep`：逐条 `e.failClosed === true` |
| 真实工具名 | `toolName:"Write"` / `"Delete"` / `"Shell"` / `"Read"` / `"ReadLints"` / `"Grep"` / `"List"` / `"Fetch"` / … |
| `Write` 输入字段 | `createToolInput: e => ({file_path: e.path, content: e.fileText})` |
| `Delete` 输入字段 | `createToolInput: e => ({file_path: e.path})` |
| `Shell` 输入字段 | `createToolInput: e => ({command: e.command, cwd: t})` |
| hooks.json 路径 | `projectConfigPath: join(workspace, ".cursor", "hooks.json")` |
| hook 事件名枚举 | `preToolUse` / `postToolUse` / `beforeShellExecution` / `afterFileEdit` / … |
| `--force` / `--yolo` 等价 | `approval-mode-setting.ts`：`const t = e.force \|\| e.yolo` |
| **`--force` 不绕过 hook** | `te()` 里 `preToolUse` 无条件先跑，`deny` 直接 reject |

### L3 hook 端到端（真实载荷 → 真实输出）

| 场景 | 载荷 | 结果 |
|---|---|---|
| 写集内写入 | `{"tool_name":"Write","tool_input":{"file_path":"src/a.ts"}}` | ✅ `allow` |
| 越界写入 | `{"tool_name":"Write","tool_input":{"file_path":"evil.ts"}}` | ✅ `deny`（理由含写集内容） |
| 只读豁免 | `{"tool_name":"Read","tool_input":{"file_path":"outside.ts"}}` | ✅ `allow`（「没有可判定的写入目标」） |
| Shell 越界重定向 | `{"tool_name":"Shell","tool_input":{"command":"echo hi > evil.txt"}}` | ✅ `deny` |
| Shell 写集内重定向 | `{"tool_name":"Shell","tool_input":{"command":"echo hi > src/out.txt"}}` | ✅ `allow` |
| Shell 无写入 | `{"tool_name":"Shell","tool_input":{"command":"ls -la"}}` | ✅ `allow` |

输出信封逐字符合真实 schema：
`{"permission":"allow|deny","user_message":"...","agent_message":"..."}`

### 未能验证的部分（如实说明）

- **未做真实 API 端到端**：本机 `cursor-agent` **无凭证**
  （`CURSOR_API_KEY` 未设，`agent login` 未执行），报错停在
  `Authentication required`。
  因此「真 agent 起进程 → 收 NDJSON → 解析会话 id → 续跑」这条链路
  **未在真实服务端验证过**。
- 替代方案：用**假 agent**（吐真实形状 NDJSON 的本地脚本）覆盖了
  解析层；用**真实 bundle 源码**覆盖了协议层；
  用**真实载荷**覆盖了判定层。
  三层各自可信，但「四者叠在一起」仍有残余风险。

## 影响面

- `src/adapters/cursor-agent/index.ts`（**新增**）：`CursorAgentAdapter`
- `src/adapters/index.ts`：导出 `CursorAgentAdapter`
- `src/adapters/agent-command.ts`：被 CLI 用来做与 adapter 无关的命令检查
- `src/hook/harness.ts`：真实工具名别名 + 只读工具集合 + Cursor 的 snake_case 渲染
- `src/hook/pretool.ts`：只读工具豁免；Cursor 协议注释改为 snake_case
- `src/cli/commands/hook-install.ts`：`CURSOR_PRETOOL_MATCHER` 改成真实工具名；
  新增 `CODEX_PRETOOL_MATCHER`
- `src/cli/commands/shared.ts`：`AdapterType` 扩 `cursor-agent`；
  新增 `harnessForAdapter()` / `resolveAgentCommand()`；
  `createExecutorAdapter()` 认 `cursor-agent`
- `src/cli/commands/runtime-guard.ts`：`harness` 选项；按 harness 装/撤对应的钩子文件；
  托管文件清单跟着 harness 走（改钩子文件 = 关掉门禁）
- `src/cli/commands/core-slice.ts` / `parallel-executor.ts` / `supervisor.ts` / `question.ts`：
  传 `harness`、按 adapter 解析命令
- `tests/cursor-agent-adapter.test.ts`（**新增**）
- `tests/hook/harness-adapters.test.ts`：真实工具名、只读工具、snake_case 信封

## 不变量核查

- **C1**（状态只在文件里）：会话落 `.zelto/sessions/*.json`；hook 配置落
  `.cursor/hooks.json`。无内存态常驻。
- **C2**（core 零第三方依赖）：新代码全在 `src/adapters/`、`src/hook/`、`src/cli/`，
  `core/` 一行未动；只用 Node 内置。
- **C3**（判定确定性）：判定内核（`judgeWriteTargets`）一行未改；
  归一化是纯函数。
- **C4**（append-only 事件流）：与 Claude 侧同口径。
- **C5**（保护域外部化）：保护域判定在判定内核里，未改。
- **C9**（写集预约运行时强制）：**这条 ADR 就是为了让它对 Cursor 成立** ——
  装了正确的 harness、用了真实工具名的 matcher、显式 `failClosed: true`。
- **C7**（llm 只产草稿）：无影响。

## 验收标准

1. ✅ `--adapter cursor-agent` 起 `cursor-agent` 进程（不是 claude）；
2. ✅ NDJSON 事件流被正确解析：会话 id、token 用量、最终回答；
3. ✅ `getUsage()` 返回 **null**（不谎报零成本）；
4. ✅ 拿不到 agent 会话 id 时 `resume()` **报错**（不静默开新会话）；
5. ✅ 命令行**不含** `-y` / `--yolo`（二者与 `--force` 等价，
   选 `--force` 是为了可读性 —— **不是**因为 `--yolo` 更危险）；
6. ✅ `.cursor/hooks.json` 里 zelto 那条带 `failClosed: true`，
   matcher 是 `Write|Delete|Shell`（**CLI 真实工具名**）；
7. ✅ Cursor 的判决信封用 **snake_case**（`user_message` / `agent_message`）；
8. ✅ 只读工具（`Read` / `Grep` / `List` / `Fetch`）**不产生写入目标**；
9. ✅ 运行时守卫按 harness 装**对应**的钩子文件，并把该文件纳入托管清单；
10. ✅ `npm test` 全绿。

## 关联缺陷

- **ADR-083 的 Cursor 工具名是错的**（`edit_file` / `create_file` / `terminal`）——
  那些名字在 cursor-agent 里不存在，matcher 一个都匹配不上。
  **hook 永远不被调用，而配置文件看上去一切正常。**
  本 ADR §6 修正。
- **ADR-083 §3 的 Cursor 输出契约是 camelCase**（`userMessage` / `agentMessage`）——
  Cursor 会静默丢掉这两个字段。本 ADR §7 修正。
- 两处都是**同一个形状**：**声称的强度与实际的强度不一致** ——
  与 D-63 / README「已发布到 npm」同源。

## 参考

- Cursor Hooks 官方文档：`https://cursor.com/docs/hooks`
- cursor-agent 2026.09.18（`2026.09.18-9a7762b`）实测：
  CLI 旗标、stdin 提示词消费、NDJSON 事件形状、hook schema、工具名
- `docs/adr/adr-083-multi-harness-runtime-write-enforcement.md`
