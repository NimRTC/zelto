# Slice: adr-143-startup-phase

## 目的

实施 ADR-143（`docs/adr/adr-143-startup-phase.md`）：
ACP 的**启动阶段**要用**真实协议信号**推导，
且**豁免空转超时** —— 慢启动的 agent 不该被当成「卡住了」杀掉。

## 背景：现在的洞

zelto 的超时语义是**空转超时**（ADR-055）：「没有进展就这么久就杀掉」。
ACP 路线的进展信号是 `session/update` 里的 `tool_call` / `tool_call_update`。

**但 ACP agent 的启动阶段不发 `tool_call`** ——
初始化模型连接、加载 MCP server、鉴权、读项目上下文，这些都不是工具调用。

```
客户端 → agent: session/prompt
   agent: 加载 MCP server（3 个 server，每个 5 秒）
   agent: 读 package.json / tsconfig / 5 个源文件
   ...
```

**这整段时间 0 条 `tool_call`** → `markProgress` 不被调用 →
空转倒计时不被重置 → 到点就杀。

**后果**：一个正常但慢启动的 agent 被当成卡住杀掉，
而且被杀时**一行代码都还没写** —— 白跑一轮。

更糟的是：慢启动与真卡住在信号上**无法区分** ——
zelto 没有「agent 现在处于哪个阶段」的概念。

## 范围

要改的：

- `src/adapters/acp/startup-phase.ts`（**新增**） —— 阶段类型 + 纯计算
- `src/adapters/acp/index.ts` —— 阶段状态；阶段推进点；豁免空转超时；请求级超时
- `src/core/ports/executor.ts` —— `ExecutorAdapter` 加**可选**方法 `getStartupPhase?()`
- `src/adapters/session-store.ts` —— 会话文件加**可选**字段 `startupPhase`
- `src/cli/commands/core-slice.ts` —— 进度输出显示阶段
- `tests/adr-143-startup-phase.test.ts`（**新增**）

只读参考（**不得修改**）：

- 只读 `docs/adr/adr-143-startup-phase.md` —— 本片的规则真源。
- 只读 `src/adapters/acp/events.ts` —— `isProgressUpdate()`（本片不改它；
  引用它是为了说明「进展信号从哪来」）。

## 需求

- 无（本片没有关联的需求条目；验收口径见下）。

## 验收标准

1. **启动阶段只由协议请求驱动，不用计时器** ——
   验证方式：源码检查 —— 断言 `startup-phase.ts` 里**没有**任何
   `Date.now()` / `setTimeout` 驱动的阶段推进；阶段推进点全部在
   「发出某个协议请求」处。
   > **为什么这条不能省**：这是 T3 的硬规则，也是本 ADR 与
   > 「加个宽限期」的根本区别 —— 计时器推导 = 拍脑袋的魔法数字。

2. **阶段值是封闭集合** ——
   验证方式：单测断言只有 `launch` / `initialize` / `session` /
   `authenticating` 四个。
   > **为什么只有这四个**：它们对应 ACP 协议里**语义唯一的被等待请求**。
   > 「加载 MCP server」这类**不是**协议信号 —— zelto 看不到，
   > 编出来就是假信号。

3. **收到第一条 `session/update` → 阶段清空** ——
   验证方式：单测用 mock agent，断言在收到通知前 `getStartupPhase()`
   非 null、收到后为 null。
   > **为什么不是「第一个 tool_call」**：太晚了 ——
   > `agent_message_chunk` 已经说明 agent 活着且在动。

4. **启动阶段豁免空转超时** ——
   验证方式：单测断言「在启动阶段 + 无进展」**不会**触发空转超时；
   且「不在启动阶段 + 无进展」**会**触发。
   > **为什么这条不能省**：这是本片要修的病灶本身。

5. **协议请求有独立超时** ——
   验证方式：单测让 mock agent **不回** `initialize` 回包，
   断言在超时后**失败**（而不是永远挂着）。
   > **为什么这条不能省**：豁免空转超时的代价就是这一条。
   > 没有它，「agent 卡在 initialize」= 永不终止 = 切片卡在 running。

6. **阶段对人可见** ——
   验证方式：单测断言会话文件里有 `startupPhase` 字段；
   且 `zelto run` 的输出里有阶段文字。
   > **为什么这条不能省**：T3 的规则是「Clients show it until the
   > run's first output」。人看到「正在启动（session）」比看到
   > 「Agent running... 2m 30s」有用得多 —— 后者让人以为它卡住了。

7. **端口方法是可选的** ——
   验证方式：单测断言三个 hook 路线 adapter **不**实现 `getStartupPhase`
   （`typeof adapter.getStartupPhase === 'undefined'`），且调用不报错。
   > **为什么这条不能省**：可选方法不实现不该在调用时炸；
   > 也不能为它们编一个 `null` —— 那是「假装有这个能力」。

8. **会话文件加的是可选字段** ——
   验证方式：单测用一个**没有** `startupPhase` 的老会话文件，
   断言读出来不报错、该字段为 undefined。
   > **为什么这条不能省**：老会话文件必须仍能读（C1）。

9. **跨平台** ——
   验证方式：单测断言阶段推导**不读文件、不查进程、不用系统 API**
   —— 纯协议驱动，Windows / POSIX 完全一致。

10. **既有 ACP 单测与端到端测试全绿、`npm test` 全绿、`npm run lint` 通过。**

11. **不越界** —— 改动只在写集内；
    `docs/adr/adr-143-*.md` 的规则正文不得改动。
    验证方式：`git status --porcelain` 断言改动路径全部落在写集内。

## 关键实现要点（规格里已定，实施时不要重新发明）

### 阶段取值与推进点

| 时刻 | 阶段 | 依据 |
|---|---|---|
| `spawn()` 之后、`initialize` 发出之前 | `'launch'` | 子进程已起，还没握手 |
| `initialize` 发出、等待回包 | `'initialize'` | 被等待的请求，语义唯一 |
| 版本校验通过、准备建会话 | `'session'` | 被等待的 `session/new`/`load`/`resume` |
| 鉴权失败、需要用户登录 | `'authenticating'` | 鉴权是独立于版本协商的第二道关卡 |

### 豁免而不是延长

**不延长**（要回答「给多久」，各 agent 答案不同），
**豁免**（不需要任何数字）。

空转计时器的语义改成：
「**不在启动阶段**且**没有进展**这么久 → 杀掉」。

### 交接点

- **prompt 返回之前** → 请求级超时管（每个协议请求自带超时，用现有 `timeoutMs`）；
- **prompt 返回之后** → 空转超时管（此时已有 `tool_call` 可作进展信号）。

**所以启动阶段可以豁免** —— 启动阶段的每一步都有一个「正在被等待的请求」，
都被请求级超时管着。

### 端口方法

```ts
/** 当前处于哪个启动阶段；不在启动阶段 → null */
getStartupPhase?(sessionId: string): string | null;
```

**可选**方法 —— 不实现也不破坏（与 `getUsage` / `markProgress` /
`getLiveUsage` 同一形状，端口上已有多个可选方法）。

**为什么是可选读取而不是必填行为**：hook 路线的三个 adapter 没有这个概念 ——
为它们编一个 `null` 就是「假装有这个能力」。

## 边界（规格里已定，实施时不要越界）

- **不改**判定内核（`src/hook/`）、写集匹配、保护域；
- **不改**事件**类型**清单与事件契约 schema；
- **不改**端口的**必填**部分；
- **会话文件只加可选字段**（不改必填字段）；
- **不引入**第三方依赖；**不读文件、不查进程**（阶段纯协议驱动）。

## 一个自查提醒（实施时不要按直觉走）

**「启动阶段反正 agent 很快就会开始写代码，直接把空转超时调大就行」** —— 错的。

1. 「调多大」没有共同答案（不同 agent / 网络 / 模型差别巨大）；
2. 它把**所有**的慢启动都算成「启动中」，包括「agent 真的卡死了」
   —— 那样切片会**永远卡在 running**；
3. 本片的做法**不需要任何数字** —— 豁免靠的是「阶段是否结束」这个
   **协议事实**，不是「过了多久」这个推测。

**验收时要看的是「有没有触发空转超时」**，不是「阶段名字对不对」。
