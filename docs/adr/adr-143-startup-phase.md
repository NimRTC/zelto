# ADR-143：启动阶段要用真实信号报，不能被空转超时误杀

**状态**：已决（2026-11-28）· 已落地（提交 `342d954`）
**日期**：2026-11-28
**相关**：ADR-055（超时续跑）、ADR-083（多 harness 判定内核）、ADR-133（ACP 执行器）、
C1/C3/C4

**背景来源**：T3 Code 的 `docs/internals/03_providers.md`（2026-11-28 核对源码）。

## 背景

### zelto 的空转超时靠「进展」判定，而 ACP 的启动阶段**没有进展**

zelto 的超时语义是**空转超时**（ADR-055）：
「没有进展就这么久就杀掉」。进展从哪来？

- Claude Code 路线：agent 的 stdout/stderr + **hook 事件**（每调一次工具就有一条）；
- ACP 路线：`session/update` 里的 `tool_call` / `tool_call_update`
  （`src/adapters/acp/events.ts` 的 `isProgressUpdate()`）。

问题是：**ACP agent 的启动阶段不发 `tool_call`**。

启动阶段在干什么？初始化模型连接、加载 MCP server、鉴权、
读项目的上下文文件、可能还要扫一遍目录。这些**都不是工具调用** ——
它们是 agent **进程内部**的事。在这段时间里：

```
客户端 → agent: initialize        ✓ 有响应
客户端 → agent: session/new       ✓ 有响应
客户端 → agent: session/prompt     ← agent 开始干活
   agent: 加载 MCP server（3 个 server，每个 5 秒）
   agent: 读 package.json / tsconfig / 5 个源文件
   agent: ...
```

**这整段时间里，zelto 收到 0 条 `tool_call`。**
于是 `markProgress` 不被调用 → 空转倒计时**不被重置** →
到点就杀。

**后果**：一个**正常启动但比较慢**的 agent，被 zelto 当成「卡住了」杀掉。
而它被杀的时候**一行代码都还没写** —— 白跑一轮。

### 这与「agent 卡住了」在信号上**无法区分**

这是最要命的一点。从 zelto 的视角看，两种情况的观测**完全一样**：

| | 观测到的 | 真实情况 |
|---|---|---|
| 慢启动 | 0 条 tool_call，静默 | agent 正在加载 |
| 真卡住 | 0 条 tool_call，静默 | agent 死了/网络挂了 |

**zelto 区分不了** —— 因为它没有「agent 现在处于哪个阶段」的概念。

T3 把这件事做成了**显式的状态**（`startupPhase`），
而且写下了严格的规则 —— 这一整节的论证就是从那里来的。

### T3 的规则

T3 的 `docs/internals/03_providers.md` 里「Honest capabilities and permissions」
一节：

> **Startup phases come from real signals.** An adapter reports the step a
> starting turn is on as `startupPhase` on its provider session, and only when
> the protocol says so: **a notification or an awaited request with one
> meaning, never a timer.** Clear it the moment the provider can be doing
> something else. Clients show it until the run's first output.
> A session that serves several threads names the one it describes with
> `startupPhaseThreadId`.
>
> Before a turn opens, even before the server has the send, clients show
> "Starting" only when the session is not live or reports a phase. A live
> session with no process reports `launch` while no turn is open; an open turn,
> even one being stopped, would read it as starting.
>
> **Nothing an adapter emits during `openSession` is visible**, because the
> session is not attached yet. Turn start republishes `runtime.providerSession`,
> so a phase that spans it must be on that record.

拆开看，规则有五条：

1. **启动阶段要有名字**（`startupPhase`），人能看到「现在在干什么」；
2. **只从真实信号来** —— 「一个通知，或一个被等待的请求」，
   **绝不用计时器**；
3. **一旦 provider 能干别的了，立刻清掉**；
4. **`openSession` 期间发出的任何东西都不可见**（会话还没挂上）；
5. **多线程的会话要指名是哪个线程**。

T3 的 `docs/internals/01_architecture.md` 里还有一条配套的：

> A provider turn ending and follow-up work settling (checkpoints, diffs, PR sync)
> are separate milestones. **Late finalization must not keep the client showing
> provider work as active** or extend recorded provider duration.

## 决策

### 决策一：ACP 适配器维护一个「启动阶段」状态，用真实信号驱动

`AcpSessionState` 增加一个字段：

```ts
/** 启动阶段（ADR-143）—— 只从真实信号来，绝不用计时器 */
startupPhase: AcpStartupPhase | null;
```

取值是一个**封闭集合**（ACP 规范里能明确指认的阶段）：

```ts
export type AcpStartupPhase =
  | 'launch'          // 子进程刚起，还没握手
  | 'initialize'      // 正在 initialize 握手
  | 'session'         // 正在建立会话（session/new|load|resume）
  | 'authenticating'  // 正在鉴权
  ;
```

**为什么只这四个**：它们对应 ACP 协议里**明确的、语义唯一的请求** ——
T3 的规则是「a notification or an awaited request with **one meaning**」。
这四个都是**正在被等待的请求**，每一个语义唯一。

**为什么没有「加载 MCP server」这类**：ACP v1 里 MCP server 的连接是
**agent 内部**的（`session/new` 的 `mcpServers` 字段是 client 传进去的，
agent 什么时候连它，协议不说）。zelto **看不到**这个信号 ——
看不到就不能编（编了就违反「只从真实信号来」）。

### 决策二：阶段由「正在等待的协议请求」推导，不由计时器推导

具体地：

| 时刻 | 阶段 | 依据 |
|---|---|---|
| `spawn()` 之后、`initialize` 发出之前 | `'launch'` | 子进程已起，还没握手 |
| `initialize` 发出、等待回包 | `'initialize'` | **被等待的请求**，语义唯一 |
| 版本校验通过、准备建会话 | `'session'` | 被等待的 `session/new`/`load`/`resume` |
| 鉴权失败、需要用户登录 | `'authenticating'` | 鉴权是**独立于版本协商的第二道关卡**（ADR-133 修正二） |

**「绝不用计时器」怎么落到实现上**：阶段**只能**在「发出某个请求」时
被设置，**没有任何代码路径靠时间推进来改它**。
阶段被清空的条件是**明确的**（见决策三），不是「过了 X 毫秒」。

**为什么这条要这么严**：一旦允许计时器，「启动阶段」就退化成
「启动后 X 毫秒内都算启动阶段」—— 那等于**给超时加了一个宽限期**，
而宽限期是**拍脑袋的魔法数字**。T3 明确拒绝这条路，zelto 也拒绝。

### 决策三：阶段的清除条件是「拿到第一个真实产出」，不是「进入某个阶段」

T3 的规则：「Clear it the moment the provider can be doing something else.」

zelto 的口径：**拿到第一个 `session/update` 通知就算「能干别的了」**。

具体地，收到**任意一条** `session/update` 通知时，清空 `startupPhase`。

**为什么不用「第一个 tool_call」**：太晚了。
`session/update` 里先来的是 `agent_message_chunk`（agent 开始说话了）
或 `user_message_chunk` —— 那已经说明 agent **活着且在动**。

**为什么不用「prompt 返回」**：更晚。agent 可能先说一段话、
再调工具、最后才结束这一轮。

### 决策四：启动阶段**不延长**空转超时，而是**完全豁免**它

这是本 ADR 最重要的技术决策。

两种做法：

| 做法 | 含义 | 问题 |
|---|---|---|
| **延长**空转超时 | 启动阶段用更长的超时 | 引入「启动阶段该给多久」的魔法数字；而且「启动阶段」本身没有边界（agent 可能永远停在启动） |
| **豁免**空转超时 | 启动阶段**不计入**空转判定 | 不需要任何数字 |

**采用豁免**。

具体地，空转计时器的语义改成：
「**不在启动阶段**且**没有进展**这么久 → 杀掉」。

**为什么豁免不会导致永不超时**：启动阶段**一定会结束**——
因为阶段是由协议请求推进的，而那些请求都有回包。
如果 agent 卡在 `initialize` 不回包 → 那不是「启动慢」，那是「协议卡住」，
由**另一个**机制兜（见决策五）。

**为什么这比延长好**：延长需要回答「给多久」，
而那个答案在不同的 agent / 网络 / 模型上完全不同。
豁免不需要任何数字 —— 它只是说「**还没到能判定卡住的阶段**」。

### 决策五：协议卡住由**请求级超时**兜底，不靠空转超时

豁免的代价是：agent 卡在 `initialize` 不回包 → 空转计时器不管它 →
**永远不杀**。

所以补两道：

**(a) 握手请求自带超时** ——
`initialize` / `session/new` / `session/load` / `session/resume`
各自有超时（用现有的 `timeoutMs`），超了就当失败。

**(b) 启动阶段有自己的上界** ——
`startupTimeoutMs`（默认 15 分钟）：从接到指令到**第一次产出**，
最多给这么久。超了就是「启动卡住」，单独一条出口
（`handleStartupTimeout()`），写出的提示与空转超时**不同**。

**为什么 `session/prompt` 不套请求级超时**：ACP 里 `session/prompt` 是
**整轮**的时长（agent 干完活才回 `stopReason`）—— 套请求级超时会杀掉
**长轮次**（有进展但做得久）。那与 ADR-055 的空转超时语义冲突。

**为什么这不是重复**：两者管的是**不同的东西**：
- 请求级超时：管「**这一把握手请求**有没有回来」；
- 启动上界：管「**启动总共多久**」（启动阶段没有进展信号，
  只能按总时长计）；
- 空转超时：管「**这一轮工作**有没有在推进」。

**所以交接点是「第一条 `session/update`」**：
- 收到之前 → 启动上界管（阶段还没结束）；
- 收到之后 → 空转超时管（且此时已有 `tool_call` 可作进展信号）。

**为什么不让两个计时器同时活着**：同一时刻两个都能触发 →
「谁先写状态」变成竞态（状态可能是 timeout 也可能是 failed），
判定不确定（C3 要求确定性判定）。

### 决策五之二：失败优先于退出码

失败是 **zelto 这一侧**判定的（握手超时、鉴权失败、协议版本不符……），
而**子进程可能自己正常退出**（退出码 0）。

只看退出码 → 「这一轮失败了」会被读成「这一轮成功了」。
后果是实打实的：CLI 走进「成功」分支，门禁照跑、签字照走 ——
而实际上 agent **一行代码都没写**。

所以：**退出码 = 退出码 + 失败记录** 一起判。
`failSession()` 记下原因，`handleExit()` 把对外的退出码从 0 改成 1，
`waitForExit()` 返回纠正后的值。

### 决策六：阶段要**对人可见**

阶段不是内部状态 —— 它要出现在人能看到的地方：

- `zelto run` 的进度输出（现在只有 `Agent running... 2m 30s`）；
- 会话文件（`.zelto/sessions/<id>.json`）—— 便于事后追溯。

**为什么必须可见**：T3 的规则说「Clients show it until the run's first output」。
人看到「正在启动（session）」比看到「Agent running... 2m 30s」有用得多 ——
后者让人以为它卡住了。

**会话文件里要记**：因为**跨进程**要看（`zelto status` / 驾驶舱 / 事后审计）。
内存里的状态进程一死就没了。

### 决策七：`AdapterMeta` 不加能力位

启动阶段是**实现细节**，不是「这个 adapter 能不能做某事」的事实。

**为什么不加**：ADR-140 的 `sessionContinuation` 加能力位是因为
**调用方需要在动作之前知道**（要在人看到之前给提示）。
而启动阶段是**运行中**的状态 —— 调用方不需要提前知道，
它只需要**读出来**（显示给人）。

**为什么端口上也不加**：`ExecutorAdapter` 端口上加一个 `getStartupPhase()`
会让**所有 adapter** 都得实现它（哪怕只返回 null）。
而 hook 路线的三个 adapter 没有这个概念。

**解法**：启动阶段的读取走**具体类型**（`AcpAdapter`），
不放在端口上。CLI 层在 adapter 是 ACP 时才读它。

**但这会造成「类型判断」**：CLI 层要 `instanceof AcpAdapter` 吗？
不要 —— **加一个可选的端口方法**更好：

```ts
/** 当前处于哪个启动阶段；不在启动阶段 → null */
getStartupPhase?(sessionId: string): string | null;
```

**可选**方法 = 不实现也不破坏（与 `getUsage` / `markProgress` /
`getLiveUsage` 同一形状 —— 端口上已有多个可选方法）。

**为什么这条不是「在端口上开口子」**（ADR-141 决策五否决过那种做法）：
端口上已有的可选方法是**纯读取**（「这个会话现在什么状态」），
而 ADR-141 否决的是**行为差异**（「用哪套闸门」）。
读取一个状态不改变任何行为。

### 决策八：跨平台 —— 不引入任何平台相关依赖

阶段完全由**协议请求**驱动，**不读文件、不查进程、不用系统 API**。
所以 Windows / POSIX 完全一致（与 ADR-139 那批切片的跨平台要求一致）。

## 被否决的方案

1. **启动阶段延长空转超时**（给一个魔法数字）：
   决策四。「给多久」在不同 agent 上没有共同答案。
2. **启动阶段豁免空转超时，但不补兜底**：
   决策五的前半。代价是「agent 卡在 initialize」→ **永远不杀**，
   切片卡在 running 直到看门狗（ADR-074）来收。这不是「更安全」，
   这是「换个地方卡住」。
   > **落地补充**：这条在落地时改成了「豁免 + **两道**兜底」——
   > 握手请求级超时（挡「协议卡住」）+ 启动上界（挡「启动卡住」）。
   > 单靠请求级超时不够：握手完了但 agent 一个字都不说，
   > 那个空档里没有任何请求在等待 —— 请求级超时管不到它。
3. **用计时器推导阶段**（如「发起后 5 秒还在等 → 阶段是 `initialize`」）：
   T3 明文拒绝（「never a timer」）。而且它把「阶段」变成了「猜的」。
4. **给 ACP 加更多阶段**（如「加载 MCP server」「读文件」）：
   那些**不是 ACP 协议里语义唯一的信号** —— zelto 看不到。
   编出来就是「假信号」，违反「只从真实信号来」。
5. **启动阶段也用 `tool_call` 判定**（即不改）：
   决策一的整段话。慢启动 = 白跑一轮。
6. **把 `getStartupPhase` 做成端口的**必填**方法**：
   hook 路线的三个 adapter 没有这个概念 —— 为它们编一个 `null`
   就是「假装有这个能力」（T3：「A capability left enabled that fails at
   runtime is a bug」的反面）。
   **可选**方法就不存在这个问题：不实现 = 没有这个能力。

## 影响面

| 文件 | 改动 |
|---|---|
| `src/adapters/acp/index.ts` | 启动阶段状态；阶段推进点；豁免空转超时；握手请求级超时；启动上界；失败优先于退出码 |
| `src/adapters/acp/startup-phase.ts`（**新增**） | 阶段类型 + 阶段与「是否豁免空转」的纯计算（C3）+ 启动上界的默认值 |
| `src/core/ports/executor.ts` | `ExecutorAdapter` 加**可选**方法 `getStartupPhase?()` |
| `src/adapters/session-store.ts` | 会话文件加 `startupPhase` 字段（可选） |
| `src/cli/commands/core-slice.ts` | 进度输出显示阶段 |
| `tests/adr-143-startup-phase.test.ts`（**新增**） | 17 条用例（纯函数 + 端到端 + 源码检查） |

**不涉及**：判定内核（`src/hook/`）、写集匹配、保护域、
事件**类型**清单、事件契约 schema、端口的**必填**部分。

**注意**：`src/adapters/session-store.ts` 的 `PersistentSessionData` 加字段
是**加可选字段**，不是改必填字段 —— 老的会话文件读出来没有这个字段是正常的。

## 验收标准

1. **启动阶段只由协议请求驱动，不用计时器** ——
   验证方式：源码检查 —— 断言 `startup-phase.ts` 里**没有**任何
   `Date.now()` / `setTimeout` 驱动的阶段推进；阶段推进点全部在
   「发出某个协议请求」处。
   > **为什么这条不能省**：这是 T3 的硬规则，也是本 ADR 与
   > 「加个宽限期」的根本区别。
2. **阶段值是封闭集合** ——
   验证方式：单测断言类型只有 `launch` / `initialize` / `session` /
   `authenticating` 四个。
3. **收到第一条 `session/update` → 阶段清空** ——
   验证方式：单测用 mock agent，断言在收到通知前 `getStartupPhase()`
   非 null、收到后为 null。
4. **启动阶段豁免空转超时** ——
   验证方式：单测断言「在启动阶段 + 无进展」**不会**触发空转超时；
   且「不在启动阶段 + 无进展」**会**触发。
   > **为什么这条不能省**：这是本 ADR 要修的病灶本身。
5. **协议卡住有兜底，不会永不终止** ——
   验证方式：单测让 mock agent **不回** `initialize` 回包，
   断言在超时后**失败**（而不是永远挂着）；
   且断言「启动阶段一直不产出 → 启动上界到了就被杀」。
   > **为什么这条不能省**：豁免空转超时的代价就是这一条。
   > 没有它，「agent 卡在 initialize」= 永不终止。
6. **阶段对人可见** ——
   验证方式：单测断言会话文件里有 `startupPhase` 字段；
   且 `zelto run` 的输出里有阶段文字。
7. **端口方法是可选的** ——
   验证方式：单测断言三个 hook 路线 adapter **不**实现 `getStartupPhase`
   （`typeof adapter.getStartupPhase === 'undefined'`），且不报错。
   > **为什么这条不能省**：可选方法不实现不该在调用时炸。
8. **会话文件加的是可选字段** ——
   验证方式：单测用一个**没有** `startupPhase` 的老会话文件，
   断言读出来不报错、该字段为 undefined。
9. **失败优先于退出码** ——
   验证方式：单测让握手超时（子进程**正常退出**，退出码 0），
   断言 `waitForExit()` 返回**非 0**、会话状态是 `failed`。
   > **为什么这条不能省**：只看退出码的话，「这一轮失败了」会被读成
   > 「这一轮成功了」—— CLI 走成功分支、门禁照跑、签字照走，
   > 而 agent 一行代码都没写。
10. **现有 ACP 单测与端到端测试全绿、`npm test` 全绿、`npm run lint` 通过。**
11. **不越界** —— 改动只在写集内。

## 一个自查提醒（实施时不要按直觉走）

**「启动阶段反正 agent 很快就会开始写代码，直接把空转超时调大就行」** —— 这是错的。

1. 「调多大」没有共同答案（不同 agent / 网络 / 模型差别巨大）；
2. 它把**所有**的慢启动都算成「启动中」，包括「agent 真的卡死了」
   —— 那样切片会**永远卡在 running**；
3. 本 ADR 的做法**不需要任何数字** —— 豁免靠的是「阶段是否结束」这个
   **协议事实**，不是「过了多久」这个推测。

## 参考

- T3 Code `docs/internals/03_providers.md`（「Startup phases come from real signals」）
- T3 Code `docs/internals/01_architecture.md`（「Turn completion and checkpoints」）
- 本仓库：`docs/adr-055-timeout-kills-tree-and-continues.md`、`docs/adr/adr-133-acp-executor-and-permission-as-write-guard.md`、
  `src/adapters/acp/index.ts`、`src/adapters/acp/events.ts`

---

## 版本追溯

| 字段 | 值 |
| --- | --- |
| 所属版本号 | v0.7.1 |
| 关联 ADR 编号 | ADR-143 |
| 提交哈希 | 342d9546337618bd5237c31b0abd29c4f5c16599 |
| 验证方式 | [tests/adr-143-startup-phase.test.ts 16 个用例全绿 + npm test 全绿 + npm run lint 通过 + 人工复核] |
