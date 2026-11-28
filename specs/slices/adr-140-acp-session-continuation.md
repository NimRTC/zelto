# Slice: adr-140-acp-session-continuation

## 目的

实施 ADR-140（`docs/adr/adr-140-acp-session-continuation.md`）：
**ACP 续跑必须续同一个会话，不许重开**。

现在的洞：`src/adapters/acp/index.ts` 的 `resume()` 拿到上一轮的 ACP 会话 id
之后**只做存在性检查就丢弃了**，然后 `spawn()` → `connect()` →
`buildSession().start()` 发的是 **`session/new`** ——
于是续跑时 agent 的**上下文清零**。

## 背景：这一片修的是「续跑时 agent 忘了自己刚才干了什么」

### `resume()` 承诺 vs 实际

`resume()` 的注释承诺：

> 问答回路：把人的回答喂回**同一个** ACP 会话。

实际发生的是：**开一个新会话**，把「你之前问了问题，人回答了：xxx」
当作首条提示词塞进去。`acpSessionId` 只被用来做一次存在性检查。

### 这不是罕见路径

`resume()` 是**提问回路的必经之路**（ADR-013 §3.6）：
agent 在规格不全时主动停下问人 → 切片挂起在 `agent_question` →
人回答 → `zelto answer` 调 `adapter.resume()`。

也就是说：**任何一次「agent 问了问题」的切片，agent 都在续跑时丢失全部上下文。**

### 最隐蔽的后果：ADR-139 的验收失去了鉴别力

ADR-139 修的是「续跑段没有守卫」，验收标准是
「续跑期间写文件产生 `policy.decision` 事件」。
而 agent 每次续跑都是新会话 → 它自然「第一次写文件」→ 自然每次都触发判定 →
**看起来一切正常**。

也就是说 ADR-139 的验收**无法区分**
「续跑段真的有守卫」与「续跑段是全新会话所以行为上像有守卫」。

两件事必须一起修。

### ACP 协议里明明有这个能力

| 方法 | 语义 | 能力位 |
|---|---|---|
| `session/new` | 开新会话 | 所有 agent 必须支持 |
| `session/load` | 恢复上下文，**并把整个对话历史回放给 client** | `agentCapabilities.loadSession` |
| `session/resume` | 恢复上下文，**不回放历史**（更省 token） | `sessionCapabilities.resume` |

规范明文（`LoadSessionRequest` 的描述）：

> Restore the session context and conversation history; Connect to the specified
> MCP servers; Stream the entire conversation history back to the client via notifications

以及 `SessionStatus` 的硬约束：

> A Client that did not create or resume the session on its own connection
> **MUST still call `session/load` or `session/resume`** before sending
> `session/prompt` or expecting `session/update` notifications.

zelto 每次续跑都换一条新连接 → 按规范必须先 load/resume → 而它没发。

## 范围

要改的：

- `src/adapters/acp/index.ts` —— 会话建立流程支持 `session/resume` / `session/load`；
  读能力位；退回路径告知
- `src/adapters/acp/protocol.ts` —— 新增能力位的解析（`parseAcpSessionCapabilities`）
- `src/core/ports/executor.ts` —— `AdapterMeta.capabilities` 增加 `sessionContinuation`
- `src/adapters/claude-agent/index.ts` —— 声明 `sessionContinuation`
- `src/adapters/cursor-agent/index.ts` —— 声明 `sessionContinuation`
- `src/adapters/claude-agent-sdk/index.ts` —— 声明 `sessionContinuation`
- `src/cli/commands/question.ts` —— 续跑前按能力位告知人；事件负载加 `sessionMode`
- `tests/fixtures/mock-acp-agent.mjs` —— 支持 `session/load` / `session/resume`（可开关）
- `tests/adr-140-acp-session-continuation.test.ts`（**新增**）—— 续跑真续 / 退回两条路

只读参考（**不得修改**）：

- 只读 `docs/adr/adr-140-acp-session-continuation.md` —— 本片的规则真源。
- 只读 `src/hook/**` —— 判定内核（**本片不改它**）。
- 只读 `AGENTS.md` —— 项目约定。

## 需求

- 无（本片没有关联的需求条目；验收口径见下）。

## 验收标准

1. **agent 支持 `session/resume` 时，续跑发的是 `session/resume`** ——
   验证方式：单测用 mock ACP agent（声明 `sessionCapabilities.resume: {}`），
   断言 `resume()` 之后 agent 收到了 `session/resume` 请求，
   且**没有**收到 `session/new`。
   > **为什么这条不能省**：这是本 ADR 要修的病灶本身。

2. **agent 只支持 `loadSession` 时，续跑发 `session/load`** ——
   验证方式：同上，断言收到 `session/load` 且带 `mcpServers` / `cwd` / `sessionId`。
   > `mcpServers` 是**必填**字段（schema 里是 `mcpServers: Array<McpServer>`，
   > 不是可选）—— 不传 = 违反 schema = agent 可能拒绝。

3. **agent 都不支持时退回 `session/new`，且告知人** ——
   验证方式：单测断言 `session/new` 被发出，且**输出里有明确的「上下文已丢失」提示**。
   > **为什么这条不能省**：静默退回 = 人以为 agent 记得刚才讨论过什么，
   > 实际它什么都不记得。人会基于错误的假设做判断。

4. **续跑不再丢弃 `acpSessionId`** ——
   验证方式：单测断言 `session/resume`（或 `load`）请求里的 `sessionId`
   **等于**上一轮 `session/new` 返回的 id。

5. **能力位读不到 → 当作不支持** ——
   验证方式：单测让 `initialize` 回包缺 `agentCapabilities`，
   断言**不发** `session/load` / `session/resume`。
   > fail closed：读不到就当作没有，不是当作有。

6. **`session/resume` 优先于 `session/load`** ——
   验证方式：单测让 agent 两个能力都声明，断言只发了 `session/resume`。
   > **为什么这条不能省**：`session/load` 会把**整个对话历史回放**给 client，
   > 而 zelto 的提问检测是**纯字符串解析** —— 历史里如果有上一轮的
   > `<<<ZELTO_QUESTION` 标记，回放时会被**再解析一次** →
   > 上一轮的问题被当成这一轮又问了一次 → **无限挂起**。

7. **续跑事件带 `sessionMode`** ——
   验证方式：单测断言 `run.resumed` 事件的负载含 `sessionMode`，
   值为 `'resume'` / `'load'` / `'new'` 之一。
   > **为什么这条不能省**：续跑的**语义**不同（上下文在不在），
   > 这件事必须在追溯链上看得见（C4）。

8. **四个 adapter 的 `sessionContinuation` 都已声明** ——
   验证方式：单测断言四个 adapter 的 `metadata.capabilities.sessionContinuation` 有值。

9. **现有 ACP 单测与端到端测试全绿、`npm test` 全绿、`npm run lint` 通过。**

10. **不越界** —— 改动只在写集内。

## 关键实现要点（规格里已定，实施时不要重新发明）

### 会话建立的顺序

```
1. 起新子进程（新连接）
2. initialize → 读 init.agentCapabilities.loadSession / init.sessionCapabilities.resume
3. 版本校验（不变）
4. 若有 acpSessionId：
     resume 能力 → session/resume { sessionId: acpSessionId, cwd }
     load 能力  → session/load   { sessionId: acpSessionId, cwd, mcpServers: [] }
     都不行     → session/new（退回路径）+ 告知
   否则：
     session/new（首轮）
5. session/prompt
```

### `session/load` 要传 `mcpServers: []`

`LoadSessionRequest` 的必填字段是 `mcpServers` / `cwd` / `sessionId`。
zelto 不给 agent 配 MCP server（ADR-133 决策四：`clientCapabilities: {}`），
所以传空数组。**不传 = 违反 schema = agent 可能拒绝**。

### `session/resume` 不传 `mcpServers`

`ResumeSessionRequest` 里 `mcpServers` 是**可选**的（`mcpServers?`）。
不传 = 「沿用会话原有的」。这与 zelto 的实际更一致。

### `AdapterMeta.sessionContinuation` 声明的是**能力上限**

ACP adapter 声明 `'load-resume'`（能力上限），
而**实际用哪条**由运行时读到的能力位决定。

`AdapterMeta` 表达的是「这个 adapter **能**做什么」，
运行时决定的是「**这个 agent** 能不能做」。

**为什么不是反过来**：如果 adapter 声明 `'new-session'`，
而实际 agent 支持 load，zelto 就永远不会去试 load —— 能力被静态声明**卡死**了。
声明上限更安全。

## 边界（规格里已定，实施时不要越界）

- **不改**写集匹配规则；
- **不改**hook 判定内核（`src/hook/**`）；
- **不改**事件流格式（C4）—— `run.resumed` 已存在，只加负载字段；
- **不动** `core/` 的判定逻辑（C2 保持）—— 端口加能力位是**声明**，不是判定；
- **不引入**第三方依赖。

## 一个自查提醒（实施时不要按直觉走）

**「`buildSession().start()` 之后再补一个 `session/resume`」** —— 这是错的。

ACP 规范要求：**在发送 `session/prompt` 之前**就已经 load/resume 好了。
先 `session/new` 再 `session/resume` 等于开了个新会话再续一个不存在的会话 ——
agent 侧会收到两个不一致的会话 id，续的那个根本不是它刚建的那个。
