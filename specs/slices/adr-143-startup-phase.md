# Slice: adr-143-startup-phase

## 目的

实施 ADR-143（`docs/adr/adr-143-startup-phase.md`）：
**启动阶段要用真实信号报，不能被空转超时误杀**。

现在的洞：ACP agent 的**启动阶段不发 `tool_call`**（加载 MCP server、鉴权、
读上下文文件都不是工具调用），于是 zelto 的空转倒计时**不被重置** →
一个**正常启动但比较慢**的 agent 被当成「卡住了」杀掉 —— 而它被杀的时候
**一行代码都还没写**，白跑一轮。

## 背景：这一片修的是「慢启动 = 白跑一轮」

### 从 zelto 的视角看，两种情况**无法区分**

| | 观测到的 | 真实情况 |
|---|---|---|
| 慢启动 | 0 条 tool_call，静默 | agent 正在加载 |
| 真卡住 | 0 条 tool_call，静默 | agent 死了/网络挂了 |

**zelto 区分不了** —— 因为它没有「agent 现在处于哪个阶段」的概念。

### T3 的规则

T3 的 `docs/internals/03_providers.md`（"Honest capabilities and permissions"）：

> **Startup phases come from real signals.** An adapter reports the step a
> starting turn is on as `startupPhase` on its provider session, and only when
> the protocol says so: **a notification or an awaited request with one
> meaning, never a timer.** Clear it the moment the provider can be doing
> something else. Clients show it until the run's first output.

拆开看有五条：
1. 启动阶段要有**名字**（`startupPhase`），人能看到「现在在干什么」；
2. **只从真实信号来** —— 「一个通知，或一个被等待的请求」，**绝不用计时器**；
3. 一旦 provider 能干别的了，**立刻清掉**；
4. `openSession` 期间发出的任何东西都不可见；
5. 多线程的会话要指名是哪个线程。

## 范围

要改的：

- `src/adapters/acp/index.ts` —— 启动阶段状态；阶段推进点；豁免空转超时；请求级超时
- `src/adapters/acp/startup-phase.ts`（**新增**）—— 阶段类型 +
  阶段与「是否豁免空转」的纯计算（C3）
- `src/core/ports/executor.ts` —— `ExecutorAdapter` 加**可选**方法 `getStartupPhase?()`
- `src/adapters/session-store.ts` —— 会话文件加 `startupPhase` 字段（**可选**）
- `src/cli/commands/core-slice.ts` —— 进度输出显示阶段
- `tests/adr-143-startup-phase.test.ts`（**新增**）—— 阶段的用例

只读参考（**不得修改**）：

- 只读 `docs/adr/adr-143-startup-phase.md` —— 本片的规则真源。
- 只读 `src/hook/**` —— 判定内核（**本片不改它**）。
- 只读 `AGENTS.md` —— 项目约定。

## 需求

- 无（本片没有关联的需求条目；验收口径见下）。

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

5. **协议请求有独立超时** ——
   验证方式：单测让 mock agent **不回** `initialize` 回包，
   断言在超时后**失败**（而不是永远挂着）。
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

9. **现有 ACP 单测与端到端测试全绿、`npm test` 全绿、`npm run lint` 通过。**

10. **不越界** —— 改动只在写集内。

## 关键实现要点（规格里已定，实施时不要重新发明）

### 阶段只有四个值

```ts
export type AcpStartupPhase =
  | 'launch'          // 子进程刚起，还没握手
  | 'initialize'      // 正在 initialize 握手
  | 'session'         // 正在建立会话（session/new|load|resume）
  | 'authenticating'; // 正在鉴权
```

**为什么只这四个**：它们对应 ACP 协议里**明确的、语义唯一的请求** ——
T3 的规则是「a notification or an awaited request with **one meaning**」。
这四个都是**正在被等待的请求**，每一个语义唯一。

**为什么没有「加载 MCP server」这类**：ACP v1 里 MCP server 的连接是
**agent 内部**的（`session/new` 的 `mcpServers` 字段是 client 传进去的，
agent 什么时候连它，协议不说）。zelto **看不到**这个信号 ——
看不到就不能编（编了就违反「只从真实信号来」）。

### 阶段由「正在等待的协议请求」推导

| 时刻 | 阶段 | 依据 |
|---|---|---|
| `spawn()` 之后、`initialize` 发出之前 | `'launch'` | 子进程已起，还没握手 |
| `initialize` 发出、等待回包 | `'initialize'` | **被等待的请求**，语义唯一 |
| 版本校验通过、准备建会话 | `'session'` | 被等待的 `session/new`/`load`/`resume` |
| 鉴权失败、需要用户登录 | `'authenticating'` | 鉴权是**独立于版本协商的第二道关卡**（ADR-133 修正二） |

**「绝不用计时器」怎么落到实现上**：阶段**只能**在「发出某个请求」时
被设置，**没有任何代码路径靠时间推进来改它**。

### 启动阶段**豁免**空转超时（而不是延长它）

| 做法 | 含义 | 问题 |
|---|---|---|
| **延长**空转超时 | 启动阶段用更长的超时 | 引入「启动阶段该给多久」的魔法数字；而且「启动阶段」本身没有边界 |
| **豁免**空转超时 | 启动阶段**不计入**空转判定 | 不需要任何数字 |

**采用豁免**。空转计时器的语义改成：
「**不在启动阶段**且**没有进展**这么久 → 杀掉」。

**为什么豁免不会导致永不超时**：启动阶段**一定会结束** ——
因为阶段是由协议请求推进的，而那些请求都有回包。
如果 agent 卡在 `initialize` 不回包 → 那不是「启动慢」，那是「协议卡住」，
由**请求级超时**兜。

### 请求级超时与空转超时的交接点是「prompt 返回」

- `session/prompt` 返回**之前** → 请求级超时管；
- `session/prompt` 返回**之后** → 空转超时管（且此时已有 `tool_call` 可作进展信号）。

### 阶段的清除条件是「拿到第一个真实产出」

收到**任意一条** `session/update` 通知时，清空 `startupPhase`。

**为什么不用「第一个 tool_call」**：太晚了。
`session/update` 里先来的是 `agent_message_chunk` —— 那已经说明 agent **活着且在动**。

**为什么不用「prompt 返回」**：更晚。agent 可能先说一段话、再调工具、最后才结束这一轮。

### 端口上是**可选**方法

```ts
/** 当前处于哪个启动阶段；不在启动阶段 → null */
getStartupPhase?(sessionId: string): string | null;
```

**可选**方法 = 不实现也不破坏（与 `getUsage` / `markProgress` /
`getLiveUsage` 同一形状 —— 端口上已有多个可选方法）。

**为什么这不是「在端口上开口子」**：端口上已有的可选方法是**纯读取**
（「这个会话现在什么状态」），而 ADR-141 否决的是**行为差异**
（「用哪套闸门」）。读取一个状态不改变任何行为。

## 边界（规格里已定，实施时不要越界）

- **不改**判定内核（`src/hook/**`）；
- **不改**写集匹配、保护域；
- **不改**事件**类型**清单、事件契约 schema；
- **不改**端口的**必填**部分；
- `src/adapters/session-store.ts` 的 `PersistentSessionData` 加字段
  是**加可选字段**，不是改必填字段 —— 老的会话文件读出来没有这个字段是正常的；
- **不引入**平台相关依赖（阶段完全由协议请求驱动，Windows / POSIX 完全一致）。

## 一个自查提醒（实施时不要按直觉走）

**「启动阶段反正 agent 很快就会开始写代码，直接把空转超时调大就行」** —— 这是错的。

1. 「调多大」没有共同答案（不同 agent / 网络 / 模型差别巨大）；
2. 它把**所有**的慢启动都算成「启动中」，包括「agent 真的卡死了」
   —— 那样切片会**永远卡在 running**；
3. 本 ADR 的做法**不需要任何数字** —— 豁免靠的是「阶段是否结束」这个
   **协议事实**，不是「过了多久」这个推测。
