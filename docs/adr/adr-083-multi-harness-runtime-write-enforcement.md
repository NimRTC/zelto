# ADR-083：写集预约的运行时强制必须覆盖 Cursor 与 Codex

**状态**：实施
**日期**：2026-11-18
**相关**：ADR-014（运行时策略强制）、C9（写集预约运行时强制）、C5（保护域）、ADR-072（只读驾驶舱）

## 背景

C9 说：

> **写集预约运行时强制** —— 以 PreToolUse 钩子逐写判定为主、运行后 git 审计兜底；
> 预约缺失时 fail closed（一律拒绝）

「PreToolUse 钩子」目前**只对 Claude Code 成立**：

```
src/cli/commands/hook-install.ts
  export const CLAUDE_SETTINGS_RELATIVE = join('.claude', 'settings.local.json');
  export const PRETOOL_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';
```

grep `\.cursor|\.codex|\.gemini|opencode|copilot` —— **零命中**。

### 为什么这不是「少支持一个工具」

C9 的两段式设计里，**git 审计兜底是 fail open**：

```
src/core/sched/audit.ts
  * 审计类问题一律 fail open：报告但不阻断
```

所以「hook 装不上」= **关掉唯一的硬闸门，只剩下一个会说话但不拦人的审计员**。

> **在 Cursor 里跑 zelto，不等于「少一个集成」——
> 等于「C9 这条不变量对 Cursor 用户不生效」。**

而 zelto 的产品定位是「一个人 + 一组 agent」（`docs/zelto-项目目标.md` §1），
§6.2 又把「与 Cursor 的关系」列为竞争力标准。
**不支持 Cursor = 跟 Cursor 竞争的前提不成立。**

### 调研结论（2026-11-18 实查）

| | Cursor | Codex | DeepSeek Harness |
|---|---|---|---|
| hook 机制 | **原生** `.cursor/hooks.json` | **原生** `.codex/hooks.json` | 桥接（读 Claude Code / Codex 的 hooks.json） |
| 写前事件 | `preToolUse`、`beforeShellExecution`、`beforeReadFile`、`beforeFileEdit` | `PreToolUse` 等 | 映射到 `tool:before` |
| 阻断方式 | exit code 2 = 阻断；`failClosed: true` 让**崩溃也阻断** | exit code 2 | exit code 2 |
| 成熟度 | 官方文档，原生一等公民 | 原生 | **experimental** 包，需额外装 bridge 插件 |

**结论：做 Cursor + Codex。**

- **DeepSeek Harness 不需要我们写代码** ——
  `dsh-hooks-claude-code` / `dsh-hooks-codex` 这两个 bridge 读的就是
  Claude Code / Codex 的 `hooks.json`。**zelto 支持了 Claude Code 和 Codex，
  DeepSeek Harness 就自动能用**（前提是用户装了那个 bridge）。
- 这不是「不支持」，而是「**不需要支持**」——
  差别在于：我们要保证的是「**判定内核**与 harness 无关」，
  而不是「每种 harness 都要写一遍适配」。

## 决策

### 1. 判定内核保持 harness 无关

`src/hook/pretool.ts` 里的 `judgeWriteTargets()` / `extractWriteTargets()` /
`evaluateRules()` **一行都不改**。

新增的只有**协议层**（把某个 harness 的输入翻译成统一载荷，
再把统一判决翻译成该 harness 的输出）。

```
harness 输入 ──▶ normalize(harness) ──▶ 统一载荷 {tool_name, tool_input}
                                            │
                                            ▼
                                   judgeWriteTargets()  ← 不变量所在
                                            │
                                            ▼
harness 输出 ◀── render(harness, 判决) ◀─── 统一判决 {decision, reason}
```

**理由**：判定是**约束**（C3/C5/C9），协议是**适配**。
让约束去适配协议，等于让每个 harness 都可能长出自己的判定语义 ——
那正是「同一个结论在不同 agent 下不一样」的根源。

### 2. 载荷归一化（新增 `src/hook/harness.ts`）

各 harness 的工具命名不同，但**写入目标**的语义相同：

| harness | 工具名 | 路径字段 | 命令字段 |
|---|---|---|---|
| Claude Code | `Write` / `Edit` / `MultiEdit` | `tool_input.file_path` | `tool_input.command` |
| Claude Code | `NotebookEdit` | `tool_input.notebook_path` | — |
| Claude Code | `Bash` | — | `tool_input.command` |
| **Cursor** | `edit_file` / `create_file` | `tool_input.path` | — |
| **Cursor** | `terminal` | — | `tool_input.command` |
| **Codex** | `apply_patch` | `tool_input.path` | — |
| **Codex** | `shell` | — | `tool_input.command` |

归一化后统一成 `{tool_name, tool_input}`，**并补一条新的映射规则**：
工具名不在已知集合里时，**退回「找路径字段」** 而不是「不判定」。

> **为什么不能「不认识就不判」**：
> 那等于给每个新 harness 开一个绕过闸门的后门 ——
> harness 改个工具名，闸门就静默失效。
> **退回找路径字段**是保守的：可能多拦（误判成本 = agent 重试一次），
> 不会漏拦（漏判成本 = 越界写入落盘）。

### 3. 输出渲染（每个 harness 一份）

| harness | 输出契约 |
|---|---|
| Claude Code | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow\|deny","permissionDecisionReason":"..."}}` |
| **Cursor** | `{"permission":"allow\|deny","userMessage":"...","agentMessage":"..."}` |
| **Codex** | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow\|deny",...}}`（与 Claude Code 同构，但**事件名大小写与字段名需实测确认**） |

### 4. **必须显式设 `failClosed: true`（Cursor）**

Cursor 的 hook **默认 fail open** —— hook 崩溃/超时/无输出时，动作**照常执行**。

而 C9 要求「预约缺失时 fail closed（一律拒绝）」。

**所以 Cursor 的 hook 配置必须显式带 `failClosed: true`。**

> 这是本 ADR 最容易被漏掉、后果最严重的一条：
> 不设它，zelto 在 Cursor 下就是**默认放行**，
> 而 zelto 自己的文档写着「判定不了就拒绝」——
> **文档说 fail closed，代码是 fail open。**
> 这跟 D-63 / D-73 / README 那句「已发布到 npm」是**同一个形状**：
> 声称的强度与实际的强度不一致。

**Codex 侧同理** —— 若其 hook 配置支持 `failClosed`，必须显式设上；
不支持的话，**由 zelto 侧兜底**：hook 进程自身在任何异常路径上都
返回「拒绝」而不是崩溃（`pretool.ts` 的 `main()` 已经是 `catch → return 2`）。

### 5. 安装与卸载

```
zelto hook --install [--claude] [--cursor] [--codex] [--all]
```

- 默认装**全部**已知的 harness（Claude Code + Cursor + Codex）——
  一个项目里往往同时开着好几种 agent；
- `--claude` / `--cursor` / `--codex` 单独装某一个；
- `--all` 显式声明「全装」（供脚本使用，避免默认值将来变化时行为漂移）；
- `--uninstall` 对称；
- `--status` 显示每个 harness 的安装状态。

配置文件：

| harness | 文件 | 标记 |
|---|---|---|
| Claude Code | `<root>/.claude/settings.local.json` | `--zelto-pretool` |
| Cursor | `<root>/.cursor/hooks.json` | `--zelto-pretool` |
| Codex | `<root>/.codex/hooks.json` | `--zelto-pretool` |

**不改用户已有的其它 hook** —— 只替换 zelto 自己那一条
（沿用 Claude Code 实现的「按标记过滤、只动自己那条」的纪律）。

### 6. 事件流里的 harness 字段

`policy.decision` 事件原本**硬编码** `harness: 'claude-code'`。
改为记录**真实来源**：

```json
{ "type": "policy.decision", "payload": { "harness": "cursor", ... } }
```

**理由**：追溯链要能回答「这次判定是哪个 agent 触发的」。
硬编码成 `claude-code` 就是**写入假账**（D-63 的形状）。

## 影响面

- `src/hook/harness.ts`（**新增**）：载荷归一化 + 输出渲染，各 harness 一份
- `src/hook/pretool.ts`：加 `--harness` 参数；事件里的 `harness` 字段改为真实值
- `src/cli/commands/hook-install.ts`：Cursor / Codex 的装卸实现；`--status` 显示三者
- `src/cli/commands/catalog.ts`：`hook` 命令的 detail 补充新旗标
- `tests/hook/harness-adapters.test.ts`（**新增**）：各 harness 的归一化与渲染
- `tests/hook/cursor-fail-closed.test.ts`（**新增**）：**Cursor 配置必须带 `failClosed: true`**

## 不变量核查

- **C1**（状态只在文件里）：无影响 —— hook 配置也是文件。
- **C2**（core 零第三方依赖）：**无影响** —— 新代码在 `src/hook/` 与 `src/cli/`，
  不在 `core/`；且只用 Node 内置。
- **C3**（判定确定性）：**加强** —— 判定内核一行未改；
  归一化是**纯函数**（同一输入 → 同一输出），不含时间/随机。
- **C4**（append-only 事件流）：**加强** —— `harness` 字段记录真实来源，不再硬编码。
- **C5**（保护域外部化）：无影响 —— 保护域判定在 `judgeWriteTargets()` 里，未改。
- **C9**（写集预约运行时强制）：**这条 ADR 就是为了让它对更多 harness 成立**。
  并且**显式堵上 Cursor 的 fail open 默认值**。
- **C7**（llm 只产草稿）：无影响。

## 验收标准

1. ✅ Cursor 的 `hooks.json` 里 zelto 那条**带 `failClosed: true`**；
2. ✅ Codex 的 `hooks.json` 里 zelto 那条同样 fail closed；
3. ✅ 三种 harness 的输入都能归一化成统一载荷；
4. ✅ 统一载荷 → 判决 → 各 harness 的输出，**判决内容一致**（allow/deny 与原因相同）；
5. ✅ 事件里的 `harness` 字段是**真实来源**，不是硬编码；
6. ✅ 装卸只动 zelto 自己那一条，用户已有的 hook 原样保留；
7. ✅ `zelto hook --status` 显示三个 harness 的状态；
8. ✅ 归一化不认识新工具名时**退回找路径字段**（不是「不判定」）；
9. ✅ `npm test` 全绿。

## 关联缺陷

- **README「已发布到 npm」是假的**（D-63 同形状）：
  **声称的强度与实际的强度不一致** —— 本 ADR 的 `failClosed` 一条，
  是同一个形状的第四次出现。
- D-69：审计只认 trailer → 认不出本片提交 → 越界 fail open。
  **同样是「兜底比主闸门弱」**。

## 参考

- Cursor Hooks 官方文档：`https://cursor.com/docs/hooks`
- `docs/zelto-实战演练记录-20261116.md` §11.37
