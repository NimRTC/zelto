# ADR-140：ACP 续跑必须续同一个会话，不许重开

**状态**：已决（2026-11-28）· 已落地（提交 `0cd2398`）
**日期**：2026-11-28
**相关**：ADR-133（ACP 执行器）、ADR-013（提问回路）、ADR-139（续跑段重装守卫）、ADR-055（超时续跑）、C1/C3/C4/C9

**背景来源**：T3 Code 的 `docs/internals/03_providers.md` 与 `01_architecture.md`（2026-11-28 核对源码）。

## 背景

### 现在的洞：ACP 的 `resume()` 其实在开新会话

`src/adapters/acp/index.ts` 的 `resume()` 拿到上一轮的 ACP 会话 id 之后，
**根本没有用它**：

```ts
// src/adapters/acp/index.ts:739
const acpSessionId = this.sessions.get(sessionId)?.acpSessionId ?? data.agentSessionId;
if (!acpSessionId) {
  throw new Error(`Session "${sessionId}" has no ACP session id — cannot continue the same conversation ...`);
}
// ... 然后：
return this.spawn({ sessionId: newSessionId, sliceId: data.sliceId, instructions, bundlePath, runId });
```

`spawn()` 走的是 `connect()`，而 `connect()` 里是：

```ts
// src/adapters/acp/index.ts:583
const session = await connection.agent.buildSession(this.cwd).start();
```

`buildSession()` 发的是 **`session/new`** —— 开一个**全新会话**。

所以 `acpSessionId` 只被用来做一次**存在性检查**（拿不到就抛错），
之后就被丢弃了。`resume()` 的注释承诺的是：

> 问答回路：把人的回答喂回同一个 ACP 会话。

而实际发生的是：**开一个新会话，把「你之前问了问题，人回答了：xxx」
当作首条提示词塞进去。**

**agent 的上下文清零了。**

### 为什么这件事比它看起来严重

`resume()` 不是罕见路径 —— 它是**提问回路的必经之路**（ADR-013 §3.6）：
agent 在规格不全时主动停下问人 → 切片挂起在 `agent_question` →
人回答 → `zelto answer` 调 `adapter.resume()`。

也就是说：**任何一次「agent 问了问题」的切片，agent 都在续跑时丢失全部上下文。**

具体后果：

1. **agent 必须重新摸索** —— 它读过哪些文件、改过什么、卡在哪，全部重来。
   「你之前问了问题，人回答了：xxx」这句话只携带了**答案**，
   不携带「**在什么上下文里问的**」。
2. **已做的分析被丢弃** —— agent 在提问前可能已经读了 10 个文件、跑了测试。
   续跑后它对这些一无所知。
3. **与其它续跑路径不一致** —— `claude-agent` 适配器的 `resume()` 是**真续**
   （同一进程、同一会话），`cursor-agent` 同理。
   只有 ACP 这一条是「假续」。**同一个端口，两种语义** —— 这是最坏的一种不一致。
4. **ADR-139 的修复测不出来** —— 这条最隐蔽。ADR-139 修的是
   「续跑段没有守卫」，验收标准是「续跑期间写文件产生 `policy.decision` 事件」。
   而 agent 每次续跑都是新会话 → 它自然「第一次写文件」→ 自然每次都触发判定 →
   **看起来一切正常**。也就是说，ADR-139 的验收**无法区分**
   「续跑段真的有守卫」与「续跑段是全新会话所以行为上像有守卫」。

第 4 条是决定性的：**它让前一个 ADR 的验收标准失去鉴别力**。
两件事必须一起修。

### ACP 协议里明明有这个能力

`node_modules/@agentclientprotocol/sdk/schema/v1/schema.json`（**稳定入口 v1**）
里定义了三个方法：

| 方法 | 语义 | 能力位 |
|---|---|---|
| `session/new` | 开新会话 | 所有 agent 必须支持 |
| `session/load` | 恢复上下文，**并把整个对话历史回放给 client** | `agentCapabilities.loadSession` |
| `session/resume` | 恢复上下文，**不回放历史**（更省 token） | `sessionCapabilities.resume` |

规范原文（`LoadSessionRequest` 的描述）：

> Restore the session context and conversation history; Connect to the specified
> MCP servers; Stream the entire conversation history back to the client via
> notifications

以及 `SessionStatus` 的描述里那条硬约束：

> A Client that did not create or resume the session on its own connection
> **MUST still call `session/load` or `session/resume`** before sending
> `session/prompt` or expecting `session/update` notifications.

**「新建连接之后，必须先 load/resume 才能 prompt」** —— 这是规范明文。
zelto 现在的实现每次续跑都换一条新连接（`spawn()` 一个新子进程），
所以按规范就必须先 `session/load` 或 `session/resume`。

而 zelto 恰恰**没有**发这两个请求 —— 它直接发了 `session/new`。

### T3 怎么做的

T3 Code（`pingdotgg/t3code`，MIT）的 `packages/provider-acp/src/server/adapter.ts`
把 `resumeSessionId` 透传进 runtime 输入，runtime 重启后直接调 `session/resume`。
它的 `docs/user/providers-acp.md` 还写明了 ACP 的能力边界：

> Checkpoint rollback restores workspace files as usual. Because ACP agents
> cannot rewind their own conversation, the next turn starts a fresh session
> with the kept conversation history.

—— 这句说的是 **rollback**（T3 有 checkpoint，zelto 没有），
**不是**普通续跑。普通续跑在 T3 那里是**真续**。

T3 的 `docs/internals/01_architecture.md` 里那条原则也适用：

> Turn completion and checkpoints are separate milestones.

以及 `03_providers.md` 的「Terminal settlement」—— 见 ADR-141。

## 决策

### 决策一：续跑优先 `session/resume`，其次 `session/load`，都不支持才退回新会话

`resume()` / `continueSession()` 的会话建立流程改成：

```
agent 声明了 sessionCapabilities.resume
  → 发 session/resume { sessionId, cwd }        ← 首选：不回放历史，省 token
agent 声明了 agentCapabilities.loadSession
  → 发 session/load { sessionId, cwd, mcpServers: [] }   ← 次选：回放历史
都不支持
  → 退回现在的行为（session/new + 把答案当首条提示词）
```

**为什么 `session/resume` 优先于 `session/load`**：

- `session/load` 会把**整个对话历史回放给 client**。
  zelto 拿到这些历史文本后会做一件危险的事：**把回放出来的文本当成 agent 的新输出**。
  而 zelto 的提问检测（`parseQuestion()`）是**纯字符串解析** ——
  历史里如果有上一轮的 `<<<ZELTO_QUESTION` 标记，回放时会被**再解析一次**，
  于是 agent 上一轮问的问题被当成**这一轮又问了一次** → 无限挂起。

  `session/resume` **不回放历史**，没有这个问题。

- `session/resume` 更省 —— 回放整个历史对长会话是实打实的 token 成本。

**为什么不是「只用 `session/load`」**：`session/load` 的历史回放需要 zelto
**正确处理回放流**（区分「历史」与「新输出」），而 ACP v1 **没有一个
「历史回放结束」的信号**。`session/load` 的回放是以 `session/update` 通知的形式来的，
与正常输出**同一个通道**。zelto 区分不了。

**这不是「实现起来麻烦」，是「协议没有这个信号」** —— 所以 `session/load`
只能是次选，且用了它就必须处理「回放文本不得进提问检测」。

### 决策二：agent 没声明能力 → 明确告知「这次是真续不了」，不假装

T3 的 `docs/internals/03_providers.md` 有一条纪律：

> **Never emulate missing permission modes.** Expose only modes the provider
> enforces natively; do not fake a mode by auto-answering approvals in T3.

同样的原则适用于会话续跑：**不许假装能续**。

所以走退回路径时，zelto 必须**说清楚**：

```
⚠️  agent 不支持 session/resume / session/load —— 这次续跑是**新会话**。
    agent 之前的上下文已丢失，它需要重新摸索。
```

**为什么必须说**：静默退回 = 人以为 agent 记得刚才讨论过什么，
实际它什么都不记得。人会基于错误的假设做判断 —— 这是最坏的一种失败模式
（「界面看不出问题，跑起来才发现连的不是那个 agent」，ADR-133 落地期三处修正的同形状)。

**为什么不直接拒绝续跑**：那会让 ACP 路线在没有 `loadSession` 能力的 agent 上
**完全不可用**（比如当前的 `cursor-agent acp` 实测就是 `loadSession: false`）。
「能用但说清楚」优于「不能用」。

### 决策三：能力位从 `initialize` 回包里读，读不到就不发那两个请求

`initialize` 的回包里带两处能力声明：

- `agentCapabilities.loadSession: boolean`（顶层）
- `sessionCapabilities.resume`（对象，存在即支持）

zelto 现在的 `connect()` 已经把 `init` 读出来了（用于版本校验与鉴权），
但**没读能力位**。决策三要求把它读出来，存在会话状态里。

**读不到 / 字段缺失 → 当作不支持**（fail closed 的同一原则：
「读不到就当作没有」，不是「读不到就当作有」）。

**为什么这个判据是可靠的**：ACP 规范把 `loadSession` 的默认值定义为 `false`
（`node_modules/@agentclientprotocol/sdk/dist/v1/schema/zod.gen.js`：
`loadSession: defaultOnError(z.boolean().optional().default(false), () => false)`），
且 `sessionCapabilities.resume` 是 `nullish` —— 缺失即不支持。
**协议自己已经给了 fail closed 的默认值。**

### 决策四：退回路径必须**保留现有行为**，不能顺手改语义

走退回路径（agent 不支持 load/resume）时，行为与今天**完全一致**：
`session/new` + 把「你之前问了问题，人回答了：xxx」当首条提示词。

**为什么不改**：那条提示词模板是**已经验证过能用**的路径。
在 agent 不支持 load/resume 的情况下，它是唯一可用的路径。
决策二只是**加一句告知**，不改它的语义。

**但要记一件事**：这条路径下 agent 是新会话 → 它**不知道**自己上一轮写了什么。
所以续跑段的工作集是「从零开始」，人要知道这一点。

### 决策五：续跑段的事件要能看出「是真续还是新会话」

事件流里新增一条 `run.resumed` 的负载字段：

```ts
{ sliceId, resolution: 'question_answered', questionId,
  sessionMode: 'resume' | 'load' | 'new' }
```

**为什么**：续跑的**语义**不同（上下文在不在），这件事必须在追溯链上看得见。
C4 说事件是追溯的唯一证据载体 —— 「这次续跑是不是真续」正是审计要问的问题。

### 决策六：`AdapterMeta` 加一个能力位，让调用方能提前知道

```ts
capabilities: {
  ...
  /**
   * 续跑时**真续会话**的能力。
   *
   * - `'load-resume'` —— 支持 `session/load` / `session/resume`（真续）
   * - `'new-session'` —— 续跑只能开新会话（上下文会丢）
   */
  sessionContinuation: 'load-resume' | 'new-session';
}
```

**为什么不查运行时再决定**：调用方（`question.ts`）在 `adapter.resume()` 之前
就需要知道这件事 —— 因为它要在**人看到之前**给出提示。
运行时才知道 = 提示来不及 = 决策二的告知落空。

**为什么是 adapter 声明而不是配置**：与 ADR-133 的 `writeGuard` 同一理由 ——
「这个 adapter 怎么实现续跑」是**它的事实**，不是用户的偏好。

**但有个时序问题**：能力位是 `initialize` 回包里才知道的，
而 `AdapterMeta` 是**静态**的（适配器构造时就定下来）。

**解法**：ACP adapter 的 `sessionContinuation` 声明为 `'load-resume'`
（**能力上限**），而**实际用哪条**由运行时读到的能力位决定。
`AdapterMeta` 表达的是「这个 adapter **能**做什么」，
运行时决定的是「**这个 agent** 能不能做」。

**为什么不是反过来**：如果 adapter 声明 `'new-session'`，而实际 agent 支持 load，
zelto 就永远不会去试 load —— 能力被静态声明**卡死**了。
声明上限更安全。

### 决策七：能力位在**会话建立时**才读，所以「真续」的判定发生在 `resume()` 内部

`resume()` 的流程：

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

**为什么 `session/load` 要传 `mcpServers: []`**：
`LoadSessionRequest` 的必填字段是 `mcpServers` / `cwd` / `sessionId`。
zelto 不给 agent 配 MCP server（ADR-133 决策四：`clientCapabilities: {}`，
fs/terminal 回调全关），所以传空数组。
**不传 = 违反 schema = agent 可能拒绝**。

**为什么 `session/resume` 不传 `mcpServers`**：
`ResumeSessionRequest` 里 `mcpServers` 是**可选**的（`mcpServers?`）。
不传 = 「沿用会话原有的」。这与 zelto 的实际更一致（zelto 从不配 MCP server）。

## 被否决的方案

1. **在 `resume()` 里无条件发 `session/load`**：
   agent 不支持 → 请求失败 → 续跑彻底不可用。
   且历史回放会污染提问检测（决策一的第二个理由）。
2. **在 `resume()` 里无条件发 `session/resume`**：
   同样有「agent 不支持 = 不可用」的问题，且 `session/resume` 是
   `sessionCapabilities.resume` 能力位（比 `loadSession` 更少见）。
3. **把 `session/load` 的历史回放做成「新一轮输出」**（即接受污染）：
   提问检测会重复解析历史里的标记 → 上一轮的问题被当成这一轮又问 →
   **无限挂起**。不可接受。
4. **给 zelto 自己实现一套会话历史持久化**（不依赖 agent 的 load/resume）：
   那是「重造 agent 编排引擎」—— AGENTS.md 负向清单明列。
   而且 zelto 拿不到 agent 的内部状态（tool call 结果、thinking），
   拼出来的历史**不是**agent 的历史。
5. **agent 不支持 load/resume 时拒绝续跑**：
   当前 `cursor-agent acp` 实测就是 `loadSession: false`（ADR-133 落地期实测）。
   拒绝 = ACP 路线在真 agent 上完全不可用。
   决策二的「能用但说清楚」是更好的取舍。

## 影响面

| 文件 | 改动 |
|---|---|
| `src/adapters/acp/index.ts` | 会话建立流程支持 `session/resume` / `session/load`；读能力位；退回路径告知 |
| `src/adapters/acp/protocol.ts` | 新增能力位的解析（`parseAcpSessionCapabilities`） |
| `src/core/ports/executor.ts` | `AdapterMeta.capabilities` 增加 `sessionContinuation` |
| `src/adapters/claude-agent/index.ts` 等三个 adapter | 各加 `sessionContinuation` 一行 |
| `src/cli/commands/question.ts` | 续跑前按能力位告知人；事件负载加 `sessionMode` |
| `tests/fixtures/mock-acp-agent.mjs` | 支持 `session/load` / `session/resume`（可开关） |
| `tests/acp-adapter.test.ts` | 续跑真续 / 退回两条路的用例 |

**不涉及**：判定内核（`src/hook/`）、写集匹配、保护域、事件**类型**清单
（`run.resumed` 已存在，只加负载字段）、`core/` 的判定逻辑。

**不改** `src/core/ports/executor.ts` 之外的 `core/`（C2 保持）。

## 验收标准

1. **agent 支持 `session/resume` 时，续跑发的是 `session/resume`** ——
   验证方式：单测用 mock ACP agent（声明 `sessionCapabilities.resume: {}`），
   断言 `resume()` 之后 agent 收到了 `session/resume` 请求，
   且**没有**收到 `session/new`。
2. **agent 只支持 `loadSession` 时，续跑发 `session/load`** ——
   验证方式：同上，断言收到 `session/load` 且带 `mcpServers` / `cwd` / `sessionId`。
3. **agent 都不支持时退回 `session/new`，且**告知人** ——
   验证方式：单测断言 `session/new` 被发出，且**输出里有明确的「上下文已丢失」提示**。
   > **为什么这条不能省**：静默退回 = 人以为 agent 记得刚才讨论过什么。
4. **续跑不再丢弃 `acpSessionId`** ——
   验证方式：单测断言 `session/resume`（或 `load`）请求里的 `sessionId`
   **等于**上一轮 `session/new` 返回的 id。
5. **能力位读不到 → 当作不支持** ——
   验证方式：单测让 `initialize` 回包缺 `agentCapabilities`，
   断言**不发** `session/load` / `session/resume`。
6. **`session/resume` 优先于 `session/load`** ——
   验证方式：单测让 agent 两个能力都声明，断言只发了 `session/resume`。
7. **续跑事件带 `sessionMode`** ——
   验证方式：单测断言 `run.resumed` 事件的负载含 `sessionMode`，
   值为 `'resume'` / `'load'` / `'new'` 之一。
8. **三条 adapter 的 `sessionContinuation` 都已声明** ——
   验证方式：单测断言四个 adapter 的 `metadata.capabilities.sessionContinuation` 有值。
9. **现有 ACP 单测与端到端测试全绿、`npm test` 全绿、`npm run lint` 通过。**
10. **不越界** —— 改动只在写集内。

## 一个必须记住的边界

**「真续」不等于「agent 的历史一定完整」。**

`session/load` 会回放历史（决策一说明了为什么它是次选），
`session/resume` 不回放 —— agent 保留了**自己的**上下文，
但 zelto 这边**看不到**那段上下文。

所以：**zelto 不得依赖 agent 的上下文来做判定**。
判定永远只依赖「这一轮 agent 报告的写目标」+「写集预约」+「policy」。
这条与 ADR-139 修的是同一类问题（不能靠「agent 应该记得」来保证安全）。

## 参考

- Agent Client Protocol 规范：`https://agentclientprotocol.com/`
- 本仓库 SDK：`node_modules/@agentclientprotocol/sdk`
  （`schema/v1/schema.json`、`dist/v1/schema/zod.gen.js`、`dist/v1/bindings.d.ts`）
- T3 Code：`docs/internals/03_providers.md`、`docs/internals/01_architecture.md`、
  `packages/provider-acp/src/server/adapter.ts`
- 本仓库：`docs/adr/adr-133-acp-executor-and-permission-as-write-guard.md`、
  `src/adapters/acp/index.ts`

---

## 版本追溯

| 字段 | 值 |
| --- | --- |
| 所属版本号 | v0.7.1 |
| 关联 ADR 编号 | ADR-140 |
| 提交哈希 | 0cd2398f094d64a5fe229bb7a272a3565a2e53c8 |
| 验证方式 | [tests/adr-140-acp-session-continuation.test.ts 用例全绿 + npm test 全绿 + npm run lint 通过 + 人工复核] |
