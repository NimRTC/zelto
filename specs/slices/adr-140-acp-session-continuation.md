# Slice: adr-140-acp-session-continuation

## 目的

实施 ADR-140（`docs/adr/adr-140-acp-session-continuation.md`）：
ACP 的续跑必须**续同一个会话**（`session/resume` / `session/load`），
不许拿 `acpSessionId` 只做存在性检查、然后开一个**新会话**。

## 背景：现在的洞

`src/adapters/acp/index.ts` 的 `resume()` 拿到 `acpSessionId` 之后没用它 ——
`connect()` 里永远是：

```ts
const session = await connection.agent.buildSession(this.cwd).start();  // ← session/new
```

**agent 的上下文清零。** 而 `resume()` 是**提问回路的必经之路**（ADR-013 §3.6）——
任何一次「agent 问了问题」的切片，agent 都在续跑时丢失全部上下文。

更要紧的是：**它让 ADR-139 的验收失去鉴别力** ——
每次续跑都是新会话 → agent 自然「第一次写文件」→ 自然每次都触发判定 →
看起来续跑段「有守卫」。区分不出「真续跑且有守卫」与「新会话所以像有守卫」。

## 范围

要改的：

- `src/adapters/acp/index.ts` —— 会话建立流程支持 `session/resume` / `session/load`
- `src/adapters/acp/protocol.ts` —— 新增能力位解析
- `src/core/ports/executor.ts` —— `AdapterMeta.capabilities` 加 `sessionContinuation`
- `src/adapters/claude-agent/index.ts`、`src/adapters/cursor-agent/index.ts`、
  `src/adapters/claude-agent-sdk/index.ts` —— 各加 `sessionContinuation` 一行
- `src/cli/commands/question.ts` —— 续跑前按能力位告知人；事件负载加 `sessionMode`
- `tests/fixtures/mock-acp-agent.mjs` —— 支持 `session/load` / `session/resume`
- `tests/adr-140-session-continuation.test.ts`（**新增**）

只读参考（**不得修改**）：

- 只读 `docs/adr/adr-140-acp-session-continuation.md` —— 本片的规则真源。
- 只读 `src/hook/acp.ts` —— 判定内核（本片一行不改）。
- 只读 `node_modules/@agentclientprotocol/sdk/` —— SDK 的类型定义与 schema。

## 需求

- 无（本片没有关联的需求条目；验收口径见下）。

## 验收标准

1. **agent 支持 `session/resume` 时，续跑发的是 `session/resume`** ——
   验证方式：单测用 mock ACP agent（声明 `sessionCapabilities.resume: {}`），
   断言 `resume()` 之后 agent 收到了 `session/resume` 请求，
   且**没有**收到 `session/new`。
   > **为什么这条不能省**：这是本片的核心 —— 「真续」的证据。

2. **agent 只支持 `loadSession` 时，续跑发 `session/load`** ——
   验证方式：同上，断言收到 `session/load`，且请求带
   `mcpServers` / `cwd` / `sessionId` 三个字段。
   > **为什么 `mcpServers` 不能省**：它是 `LoadSessionRequest` 的**必填**字段。
   > 不传 = 违反 schema = agent 可能拒绝。

3. **agent 都不支持时退回 `session/new`，且明确告知人** ——
   验证方式：单测断言 `session/new` 被发出，且**输出里有明确的
   「上下文已丢失 / 新会话」提示**。
   > **为什么这条不能省**：静默退回 = 人以为 agent 记得刚才讨论过什么，
   > 实际它什么都不记得 —— 最坏的失败模式（界面看不出问题）。

4. **续跑不再丢弃 `acpSessionId`** ——
   验证方式：单测断言 `session/resume`（或 `load`）请求里的 `sessionId`
   **等于**上一轮 `session/new` 返回的 id。

5. **能力位读不到 → 当作不支持** ——
   验证方式：单测让 `initialize` 回包缺 `agentCapabilities`，
   断言**不发** `session/load` / `session/resume`（走退回路径）。
   > **为什么这条不能省**：fail closed 的同一原则 ——
   > 「读不到就当作没有」，不是「读不到就当作有」。

6. **`session/resume` 优先于 `session/load`** ——
   验证方式：单测让 agent 两个能力都声明，断言只发了 `session/resume`。
   > **为什么这条不能省**：`session/load` 会回放整个历史到
   > `session/update` 通道，而 zelto 的提问检测是纯字符串解析 ——
   > 回放里的 `<<<ZELTO_QUESTION` 会被再解析一次 → 无限挂起。

7. **续跑事件带 `sessionMode`** ——
   验证方式：单测断言 `run.resumed` 事件的负载含 `sessionMode`，
   值为 `'resume'` / `'load'` / `'new'` 之一。

8. **四个 adapter 的 `sessionContinuation` 都已声明** ——
   验证方式：单测断言四个 adapter 的
   `metadata.capabilities.sessionContinuation` 有值。
   > **为什么这条不能省**：它是**调用方提前知道**的唯一途径 ——
   > `question.ts` 必须在 `adapter.resume()` **之前**给提示。

9. **既有 ACP 单测与端到端测试全绿、`npm test` 全绿、`npm run lint` 通过。**

10. **不越界** —— 改动只在写集内；
    `docs/adr/adr-140-*.md` 的规则正文不得改动。
    验证方式：`git status --porcelain` 断言改动路径全部落在写集内。

## 关键实现要点（规格里已定，实施时不要重新发明）

### 能力位从哪读

`initialize` 的回包里：

- `agentCapabilities.loadSession: boolean`（顶层）
- `sessionCapabilities.resume`（对象，存在即支持）

**读不到 / 字段缺失 → 当作不支持。**
（ACP 规范自己给的默认值就是 `false` / `nullish` —— 协议已经是 fail closed 的。）

### 三条路的顺序

```
有 sessionCapabilities.resume  → session/resume { sessionId, cwd }
有 agentCapabilities.loadSession → session/load { sessionId, cwd, mcpServers: [] }
都不支持                        → session/new（退回路径）+ 告知人
```

`session/resume` 的 `mcpServers` 是**可选**的，不传 = 「沿用会话原有的」。
`session/load` 的 `mcpServers` 是**必填**的，传 `[]`（zelto 从不配 MCP server）。

### `AdapterMeta.sessionContinuation` 是「能力上限」，不是「实际行为」

```ts
sessionContinuation: 'load-resume' | 'new-session';
```

ACP adapter 声明 `'load-resume'`（**上限**）。
**实际用哪条由运行时读到的能力位决定** —— 因为能力位是 `initialize` 回包里
才知道的，而 `AdapterMeta` 是构造时定下的静态值。

**为什么不反过来**：若 adapter 静态声明 `'new-session'`，
而实际 agent 支持 load → zelto 永远不会去试 load → 能力被静态卡死。

### 事件负载

`run.resumed` 加一个字段：

```ts
{ sliceId, resolution: 'question_answered', questionId,
  sessionMode: 'resume' | 'load' | 'new' }
```

续跑的**语义**不同（上下文在不在），这件事必须在追溯链上看得见（C4）。

## 边界（规格里已定，实施时不要越界）

- **不改**判定内核（`src/hook/acp.ts` 一行不改）；
- **不改**写集匹配规则、保护域清单；
- **不改**事件**类型**清单（`run.resumed` 已存在，只加负载字段）；
- **不动** `core/` 的判定逻辑（C3/C2 保持）；
- **不引入**第三方依赖（只用已有的 SDK）。

## 一个自查提醒（实施时不要按直觉走）

**「`resume()` 已经检查了 `acpSessionId` 存在，所以它本来就是续会话」** —— 这是错的。

那个检查只是**前置条件**，不是**行为**。真正建会话的那一步在 `connect()` 里，
它发的是 `session/new`。ADR-139 的验收之所以发现不了这个洞，
正是因为「每次续跑都是新会话」在**行为上看起来还挺正常** ——
agent 每次都从零开始，每次都触发判定。

**验收时要看的是「agent 收到了哪个方法」**，不是「结果对不对」。
