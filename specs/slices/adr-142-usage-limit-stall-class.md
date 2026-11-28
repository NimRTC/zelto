# Slice: adr-142-usage-limit-stall-class

## 目的

实施 ADR-142（`docs/adr/adr-142-usage-limit-stall-class.md`）：
**配额耗尽是独立停机类，不许自动重试**。

现在的洞：agent 撞服务端配额（429 / rate limit / usage limit）时，
退出码是普通非 0 → `classifyStall()` 判成 `environment_failure` →
`isAutoResolvable()` 判成**可自动恢复** → **自动重试**。

## 背景：这一片修的是「配额墙面前自动重试，纯浪费」

### 完整链条

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

### 与 `budget_exhausted` 不是一回事

| | `budget_exhausted`（⑥） | `usage_limit`（新） |
|---|---|---|
| 是什么 | zelto 自己的预算闸门（`agent.budgetLimitUsd`） | **agent 服务端**的配额 |
| 谁能解决 | **调高 zelto 的上限就能继续** | 调高 zelto 的配置**没用** |
| 等多久 | 立刻 | 可能几十分钟后（reset time） |

### 为什么值得单独一类

它和「环境失败」的**处置**根本不同：

| | 环境失败（构建/测试挂） | 配额耗尽 |
|---|---|---|
| 重试有用吗 | **有用**（环境抖动、依赖装好就好了） | **没用**（墙还在） |
| 该怎么办 | 自动重试 | 停机，告诉人「等配额」 |
| 人要做什么 | 不用管 | **等**，或者换个账号/模型 |

### T3 的原则

> **Usage limits.** Classify quota/rate-limit errors as `usage_limit`
> (with reset time when available) rather than generic failures.

## 范围

要改的：

- `src/core/stall/types.ts` —— `StallClass` 增加 `'usage_limit'`
- `src/core/stall/classifier.ts` —— 加一条分类规则；`isAutoResolvable` 排除它
- `src/core/stall/usage-limit.ts`（**新增**）—— 纯文本识别 + reset time 提取（C3）
- `src/core/stall/index.ts` —— 导出新函数
- `src/cli/commands/run-support.ts` —— `handleAgentFailure` 接 `agentOutput`；
  停机时说明「等配额」
- `src/cli/commands/core-slice.ts` —— 两个调用点传 `agentOutput`
- `src/cli/commands/parallel-executor.ts` —— 调用点传 `agentOutput`
- `src/cli/commands/supervisor.ts` —— 调用点传 `agentOutput`
- `src/cli/commands/question.ts` —— 续跑失败路径也识别配额
- `docs/zelto-技术架构.md` —— 同步 `StallClass` 清单
- `tests/adr-142-usage-limit-stall-class.test.ts`（**新增**）——
  识别 + 分类 + 处置的用例

只读参考（**不得修改**）：

- 只读 `docs/adr/adr-142-usage-limit-stall-class.md` —— 本片的规则真源。
- 只读 `src/hook/**` —— 判定内核（**本片不改它**）。
- 只读 `AGENTS.md` —— 项目约定。

## 需求

- 无（本片没有关联的需求条目；验收口径见下）。

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
   > **为什么这条不能省**：误判成配额 = 真环境抖动也不重试了；
   > 认不出配额 = 只是不优化重试，**不影响安全**。

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
    验证方式：人工核对 `docs/zelto-技术架构.md` 的 `StallClass` 清单
    含 `'usage_limit'`。

11. **`npm test` 全绿、`npm run lint` 通过。**

12. **不越界** —— 改动只在写集内。

## 关键实现要点（规格里已定，实施时不要重新发明）

### 识别靠**错误输出**，不靠退出码

退出码**说不了**这件事 —— agent 撞配额时退出码就是普通的非 0。
唯一的信号在**输出文本**里。

### 判定分层：core 只接 `type` 字符串

`classifyStall()` 现在**只接 `signal.type` 字符串**，不读文件、不读输出。

**为什么不把输出传进 `classifyStall()`**：那会让 `core/` 的判定函数
依赖「输出文本从哪来」的形状（adapter 的输出缓冲？会话文件？）。
更干净的做法是：**调用方**读输出 → 判定出类型 → 把**判定结果**
（`type: 'usage_limit'`）传给 `classifyStall()`。

- `classifyStall()` 加一条规则：`if (signal.type === 'usage_limit') return 'usage_limit';`
- 识别文本的纯函数放在**新文件** `src/core/stall/usage-limit.ts` ——
  纯计算（C3），不读文件，接收文本返回判定结果。
- `handleAgentFailure()` 调它。

### `handleAgentFailure` 的 `agentOutput` 是**可选**参数

```ts
options?: { maxRetries?: number; agentOutput?: string }
```

**为什么是可选的**：不传 = 拿不到输出 = 识别不了配额 = 退回现状行为。
**不是「所有调用点都必须传」** —— 那是更大的改动。

**但四个调用点都要传** —— 否则这条 ADR 在真实路径上不生效。

### reset time 的两种形态

- `usage limit reached ... resets at 2026-11-28T17:30:00Z` → 给**绝对时间**（`resetAt`）；
- `Rate limit exceeded. Please try again in 3600s.` → 只给**相对秒数**（`retryAfterSec`），
  **不自己换算成绝对时间**（换算要引入「现在几点」，那是推测）。

**两种都取不到 → `resetAt: null` + `retryAfterSec: null`**（如实留空，不编）。

## 边界（规格里已定，实施时不要越界）

- **不改**判定内核（`src/hook/**`）；
- **不改**写集匹配、保护域；
- **不改**事件**类型**清单 —— `stall.classified` 已存在，只加负载字段；
- **不改**事件契约 schema（`contracts/schemas/event-envelope.json` 的 enum 是**事件类型**，
  不含 `StallClass` 的取值；`slice.json` 里 `stall.class` 是
  `{"type": ["string", "null"]}`，不受影响）；
- **不引入**第三方依赖。

## 一个自查提醒（实施时不要按直觉走）

**「配额错误也是失败的一种，判成 `environment_failure` 也行，
只是把重试次数调小一点」** —— 这是错的。

1. 「调小重试次数」是**猜** —— 配额恢复时间**取决于账号**，
   不是取决于 zelto 的某个参数；
2. 更根本的问题：配额的**处置**根本不是「重试」——
   是「**等**」。判成 `environment_failure` 时 `handleAgentFailure`
   走的是**自动重试分支**，连停机横幅都不会打；
3. ADR-052 记录的病灶就是「**分类误导人**」——
   配额耗尽看起来像「agent 跑砸了」，人第一反应必然是「重跑」→ 再烧一遍。
