# ADR-142：配额耗尽是独立停机类，不许自动重试

**状态**：已决（2026-11-28）· 已落地（提交 `a538011`）
**日期**：2026-11-28
**相关**：ADR-035（adapter 成本与预算闸门）、ADR-047（agent 失败解卡）、ADR-052（重试预算）、
C1/C3/C4

**背景来源**：T3 Code 的 `docs/internals/03_providers.md`（2026-11-28 核对源码）。

## 背景

### zelto 现在没有「配额耗尽」这个分类

`src/core/stall/types.ts` 的 `StallClass` 九个分类：

```ts
export type StallClass =
  | 'permission_prompt'   // ① 权限确认
  | 'environment_failure' // ② 环境失败 — build/test repeatedly fail
  | 'context_exhaustion'  // ③ 上下文耗尽 — max_turns reached
  | 'cognitive_stuck'     // ④ 认知卡壳 — same thing fails repeatedly
  | 'plan_gate'           // ⑤ 计划门禁
  | 'budget_exhausted'    // ⑥ 预算耗尽 — max budget reached
  | 'gate_retry'          // ⑦ 门禁重试
  | 'agent_question'      // ⑧ agent 提问
  | 'human_halt';         // ⑨ 人工拉闸
```

**没有「配额 / 限流耗尽」这一类。**

我在 `src/core/budget/` 与 `src/core/stall/` 里搜 `rate|429|quota|reset`
—— **零命中**。

注意 `budget_exhausted`（⑥）是**zelto 自己的预算闸门**
（`agent.budgetLimitUsd`，ADR-035）—— 那是**钱**。
本 ADR 要加的是**agent 服务端的配额**（Claude/Cursor/OpenAI 的
usage limit / rate limit / 429）—— 那是**账号**。

两者形状相似但处置完全不同：zelto 自己的预算超了，调高上限就能继续；
服务端配额超了，**调高上限也没用**（那不是 zelto 的闸门）。

### 现在的后果：配额错误被当环境失败，然后自动重试

`handleAgentFailure()`（`src/cli/commands/run-support.ts`）里：

```ts
const stallClass = classifyStall({
  type: exitCode === null ? 'build_failure' : 'test_failure',
  message: `Agent exited with code ${exitCode ?? 'signal'}`,
  attempts: 1,
});
```

而 `classifyStall()` 里：

```ts
if (signal.type === 'build_failure' || signal.type === 'test_failure') return 'environment_failure';
```

`environment_failure` 在 `isAutoResolvable()` 里 → **可自动恢复** → 自动重试。

所以完整链条是：

```
agent 撞 429（配额耗尽）
  → 退出码非 0
  → classifyStall → 'environment_failure'
  → isAutoResolvable → true
  → 自动重试（最多 maxRetries 次，默认 2）
  → 每次重试再撞一次 429
  → 重试预算耗尽 → 才停机
```

**配额耗尽时自动重试是纯浪费**：
1. 配额**不会**因为你重试而恢复 —— 重试只是再撞一次同样的墙；
2. 每次重试都要**重新起一个 agent 会话**、重新读上下文、重新烧 token；
3. 更糟的是：重试会**消耗掉重试预算**（`stall.autoResolved`），
   于是下次真正需要重试的机会（环境抖动）也没了。

### 为什么「配额耗尽」值得单独一类

它和「环境失败」的**处置**根本不同：

| | 环境失败（构建/测试挂） | 配额耗尽 |
|---|---|---|
| 重试有用吗 | **有用**（环境抖动、依赖装好就好了） | **没用**（墙还在） |
| 该怎么办 | 自动重试 | 停机，告诉人「等配额恢复」 |
| 等多久 | 立刻 | 可能是几十分钟后（reset time） |
| 人要做什么 | 不用管 | **等**，或者换个账号/模型 |

T3 把这条列在「**反复坑到多个 adapter**」的陷阱清单里：

> **Usage limits.** Classify quota/rate-limit errors as `usage_limit`
> (with reset time when available) rather than generic failures.

并且它的 `docs/internals/01_architecture.md` 里有一条配套原则：

> A command acknowledgement therefore means intent committed, not that
> provider, checkpoint, or follow-up work finished.

## 决策

### 决策一：新增停机类 `usage_limit`

`StallClass` 增加一个分类：

```ts
| 'usage_limit'         // ⑩ 配额耗尽 — agent 服务端的 usage limit / rate limit
```

它**不属于** `isAutoResolvable()` —— 配额耗尽**不可自动恢复**。

**为什么放在 `core/stall/types.ts`**：那是 `StallClass` 的真源
（文件头明确说「现在类型只有这一个真源」）。
分类的**计算**在 `classifier.ts`。

**为什么不叫 `quota_exhausted`**：与 `budget_exhausted` 区分。
`budget_exhausted` 是 zelto 自己的闸门（可调高），
`usage_limit` 是服务端的（调高 zelto 的配置没用）。名字要能让人一眼分清。

### 决策二：识别靠**错误输出**，不靠退出码

退出码**说不了**这件事 —— agent 撞配额时退出码就是普通的非 0。
唯一的信号在**输出文本**里（stderr / agent 的错误消息）。

所以新增一个判定函数，读 agent 的输出文本，识别配额耗尽的特征：

```
'rate limit' / 'rate_limit' / 'usage limit' / 'usage_limit'
/ 'quota' / '429' / 'too many requests' / 'overloaded'
/ 'insufficient_quota' / 'credit balance is too low'
```

**这个判定放在哪**：`src/core/stall/classifier.ts` 是纯计算层，
但它现在**只接 `signal.type` 字符串**，不读文件、不读输出。

**为什么不把输出传进 `classifyStall()`**：那会让 `core/` 的判定函数
依赖「输出文本从哪来」的形状（adapter 的输出缓冲？会话文件？）。
更干净的做法是：**调用方**（`handleAgentFailure`）读输出 → 判定出类型
→ 把**判定结果**（`type: 'usage_limit'`）传给 `classifyStall()`。

**所以**：
- `classifyStall()` 加一条规则：`if (signal.type === 'usage_limit') return 'usage_limit';`
- 识别文本的纯函数放在**新文件** `src/core/stall/usage-limit.ts` ——
  纯计算（C3），不读文件，接收文本返回 boolean。
- `handleAgentFailure()` 调它。

**为什么判定要确定性**（C3）：识别靠**固定的特征串**，
不调模型、不猜。认不出就当普通失败（**不是**当成配额）——
「认不出 ≠ 放行」的同一原则：认不出配额错误只是**不优化重试**，
不影响安全。

### 决策三：`handleAgentFailure` 必须能拿到 agent 的输出

`handleAgentFailure(id, exitCode, options)` 现在**拿不到输出**。

三个调用点：
- `core-slice.ts`（前台 run 循环）—— 有 `adapter` 和 `sessionId`
- `core-slice.ts`（后台 start 循环）—— 有 `adapter` 和 `sessionId`
- `parallel-executor.ts` —— 有 `adapters[i]` 和会话 id
- `supervisor.ts` —— 有 adapter

所以给 `handleAgentFailure` 加一个**可选**参数：

```ts
options?: { maxRetries?: number; agentOutput?: string }
```

**为什么是可选的**：不传 = 拿不到输出 = 识别不了配额 = 退回现状行为。
**不是「所有调用点都必须传」** —— 那是更大的改动。

**但四个调用点都要传** —— 否则这条 ADR 在真实路径上不生效。
（`question.ts` 的续跑失败路径**不走** `handleAgentFailure`，
它自己调 `markSliceStalled` —— 那里也要改，见决策五。）

### 决策四：事件里要带上 reset time（如果有）

`stall.classified` 的负载里，如果 agent 报了重置时间就带上：

```ts
{ sliceId, class: 'usage_limit', resetAt: '2026-11-28T17:30:00Z' | null }
```

**为什么**：T3 明确说「(with reset time when available)」。
让人知道「等多久」比让人知道「撞墙了」有用得多。

**怎么取 reset time**：从输出文本里找。常见的形态：
- `usage limit reached ... resets at 2026-11-28T17:30:00Z`
- `Rate limit exceeded. Please try again in 3600s.`

第二种形态给不出绝对时间 —— 那就**只报相对秒数**（`retryAfterSec`），
不自己换算成绝对时间（换算要引入「现在几点」，那是推测）。

**两种都取不到 → `resetAt: null` + `retryAfterSec: null`**（如实留空，
不编）。

### 决策五：停机时告诉人「等配额」，而不是「重试预算用尽」

`handleAgentFailure` 现在在重试预算耗尽时打印：

```
⚠️ 自动重试预算已用尽（2/2）—— 不重置预算的话，下次失败会直接停机
```

配额耗尽时**不该走这条路**（`usage_limit` 不可自动恢复 → 根本不进重试分支），
但停机横幅要额外说明：

```
║  Class: usage_limit                          ║
║  Agent 服务端配额已耗尽。                     ║
║  重试没用 —— 配额不会因为重试而恢复。          ║
║  恢复时间: 2026-11-28T17:30:00Z               ║
```

**为什么必须说清楚**：ADR-052 记录的病灶就是「分类误导人」——
「预算耗尽」看起来像「agent 跑砸了」，人第一反应是重跑 → 再烧一遍。
配额耗尽**更**容易误导：它的退出码与普通失败**一模一样**，
人看到「agent failed」的第一反应必然是「重跑」。

### 决策六：`isAutoResolvable('usage_limit')` 必须是 false

已在决策一说明。这是本 ADR 最核心的一条。

**为什么这条不能省**：如果 `usage_limit` 落在 `isAutoResolvable` 里，
`handleAgentFailure` 会自动重试 —— **配额墙还在，重试纯浪费**，
而且会烧掉重试预算。这条判错，整个 ADR 就白做。

### 决策七：`docs/zelto-技术架构.md` 的 `StallClass` 清单要同步

那份文档里有一段 `StallClass` 的完整清单（§「Stall」）。
加了新分类就要同步 —— **文档与代码漂移**是 ADR-036 踩过的坑
（「代码能发、契约不认」）。

## 被否决的方案

1. **不加新分类，把配额错误归到 `environment_failure`**：
   决策一的整段话。核心是「重试有没有用」—— 配额墙面前没有。
2. **按退出码识别配额**：
   退出码不携带这个信息。Claude Code / Cursor 撞配额时退出码就是普通非 0。
3. **靠 agent 的**具体**错误码**（如 Anthropic 的 `rate_limit_error` 类型）：
   各家形状不同，且 shell 适配器拿到的是**文本**不是结构化错误。
   靠固定特征串识别是**跨 agent** 的做法，且是**纯文本判定**（确定性，C3）。
   > 更细的特征串（区分 `rate_limit` 与 `overloaded`）留给将来 ——
   > 现在**分不分都不影响处置**（都归 `usage_limit`、都不重试）。
4. **在 `classifyStall()` 里直接读会话文件拿输出**：
   那会让 `core/stall/` 依赖「输出存在哪」的形状。
   判定层只接 `type` 字符串，**调用方**负责把信号变成 type。
5. **让配额耗尽可自动恢复（换个模型重试）**：
   「换个模型」是**策略选择**，不是「自动恢复」——
   而且 `AdapterMeta` 里没有模型可用性信息（`modelSelection` 只是个能力位）。
   越权。
6. **给 `handleAgentFailure` 加必填参数**：
   会破所有调用点（含测试）。用**可选**参数 + 四个调用点都传。

## 影响面

| 文件 | 改动 |
|---|---|
| `src/core/stall/types.ts` | `StallClass` 增加 `'usage_limit'` |
| `src/core/stall/classifier.ts` | 加一条分类规则；`isAutoResolvable` 排除它 |
| `src/core/stall/usage-limit.ts`（**新增**） | 纯文本识别 + reset time 提取（C3） |
| `src/core/stall/index.ts` | 导出新函数 |
| `src/cli/commands/run-support.ts` | `handleAgentFailure` 接 `agentOutput`；停机时说明「等配额」 |
| `src/cli/commands/core-slice.ts` | 两个调用点传 `agentOutput` |
| `src/cli/commands/parallel-executor.ts` | 调用点传 `agentOutput` |
| `src/cli/commands/supervisor.ts` | 调用点传 `agentOutput` |
| `src/cli/commands/question.ts` | 续跑失败路径也识别配额 |
| `docs/zelto-技术架构.md` | 同步 `StallClass` 清单 |

**不涉及**：判定内核（`src/hook/`）、写集匹配、保护域、事件**类型**清单
（`stall.classified` 已存在，只加负载字段）、事件契约 schema
（`contracts/schemas/event-envelope.json` 的 enum 是**事件类型**，
不含 `StallClass` 的取值 —— 核对过，`slice.json` 里 `stall.class` 是
`{"type": ["string", "null"]}`，不受影响）。

## 验收标准

1. **配额错误 → 分类为 `usage_limit`** ——
   验证方式：单测给一段含 `rate limit` / `429` / `quota` 的输出文本，
   断言 `classifyStall({ type: 'usage_limit', ... }) === 'usage_limit'`。
2. **`usage_limit` 不可自动恢复** ——
   验证方式：单测断言 `isAutoResolvable('usage_limit') === false`。
   > **为什么这条不能省**：这条是整个 ADR 的核心。判成 true =
   > 配额墙面前自动重试 = 纯浪费 + 烧掉重试预算。
3. **识别靠输出文本，且认不出时不误判** ——
   验证方式：单测给一段普通失败输出（无配额特征），断言**不**识别为配额；
   给一段含配额特征的输出，断言识别为配额。
4. **不改既有分类的行为** ——
   验证方式：现有 `tests/stall-classifier.test.ts` 全绿。
5. **`handleAgentFailure` 拿到配额输出时不自动重试** ——
   验证方式：单测让 agent 输出含 `rate limit`，断言**没有**走重试分支
   （`stall.autoResolved` 不变），而是直接停机。
   > **为什么这条不能省**：这是「识别 → 处置」这条链的端到端验证。
   > 分类对了但处置没跟着变 = 配额错误照样被重试。
6. **停机时说明「等配额」并给出 reset time** ——
   验证方式：单测断言停机输出里有「配额」字样与 reset time。
7. **reset time 取不到时如实留空** ——
   验证方式：单测给一段没有 reset time 的配额输出，断言事件里
   `resetAt === null`（**不是**编一个）。
8. **四个调用点都传了 `agentOutput`** ——
   验证方式：源码检查（`grep` 四个文件里 `handleAgentFailure` 调用处
   都有 `agentOutput`）。
9. **既有调用点不传该参数时行为不变** ——
   验证方式：单测调 `handleAgentFailure(id, 1, { maxRetries })`（不传输出），
   断言行为与改动前一致。
10. **文档同步** ——
    验证方式：单测或人工核对 `docs/zelto-技术架构.md` 的 `StallClass` 清单
    含 `'usage_limit'`。
11. **`npm test` 全绿、`npm run lint` 通过。**
12. **不越界** —— 改动只在写集内。

## 参考

- T3 Code `docs/internals/03_providers.md`（「Usage limits」）
- 本仓库：`docs/adr-035-adapter-cost-budget-loop.md`、
  `docs/adr-047-agent-failure-unsticks-slice.md`、
  `docs/adr-052-retry-budget-reset.md`、`src/core/stall/`、`src/cli/commands/run-support.ts`

---

## 版本追溯

| 字段 | 值 |
| --- | --- |
| 所属版本号 | v0.7.1 |
| 关联 ADR 编号 | ADR-142 |
| 提交哈希 | a538011521ddb6f38e908eaf99572daaaa989138 |
| 验证方式 | [tests/adr-142-usage-limit-stall-class.test.ts 24 个用例全绿 + npm test 全绿 + npm run lint 通过 + 人工复核] |
