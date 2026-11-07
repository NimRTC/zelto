# ADR-035: 适配器花费 → 预算闭环

**状态**: 已实施
**日期**: 2026-11-07
**作者**: 系统架构
**关联约束**: C1, C2, C3, C4
**关联文档**: `docs/zelto-项目目标.md`, `docs/adr-024-affinity-scheduling.md`,
`docs/zelto-技术架构.md`

---

## 8. 实施记录

ADR 定案后分三步落地：

1. **端口契约**（`core/ports/executor.ts`）：`AdapterUsage` + 可选的 `getUsage?(sessionId)`。
   事件类型 `budget.spent` 复用，不新增。
2. **用量解析助手**（`adapters/usage-parse.ts`）：把 Claude 的两种上报形状
   （Agent SDK 的 `result` 消息 / Claude Code CLI 的 json 输出）收敛成端口形状。
   `costUsd === 0` 是有效数据，与 null（「没测到」）严格分开。
3. **适配器与 CLI 接线**：
   - `adapters/claude-agent-sdk`：消费消息流时从 `result` 消息记下用量；
   - `adapters/claude-agent`：切到 `--output-format json`，`getOutput` 优先取
     JSON 的 `result` 字段，解析不出则**退回原始 stdout**（不吞输出）；
   - `cli/commands/run-support.ts`：`recordAdapterUsage()` 是写 `budget.spent`
     事件的**唯一入口**（适配器不碰事件流）；`settleRunCost()` 负责
     「先记账 → 再复判预算」并把判定与停机事件绑在一起；
   - 四条执行路径（`run` / `start` / 后台任务监视器 / 提问续跑 / 并行执行器）
     都在 agent 退出后记账，`run.finished` 带 `costUsd`（数字或 null）。

判定语义（与 §3.5 一致）：花费达到上限 → **不进 gate、不发签字请求**，
写 `stall.classified`（`class: 'budget_exhausted'`），切片停在 `frozen` 等人。
适配器没报用量 → 按「未测到」处理，**不判定超支**，但 `costUsd = null` 让这件事可见。

上限语义（§3.6）：`budgetLimitUsd: 0` 表示**不限**（用 `UNLIMITED_BUDGET = Infinity`
作哨兵，而不是 `0` —— `0` 会被误读成「一分钱都不许花」），缺失配置回落默认 `1.0`。

---

## 1. 摘要

zelto 有一套预算机制：`.zelto/config.yaml` 里的 `budgetLimitUsd`、
`core/budget/collector.ts` 的 `BudgetCollector`、以及运行前 / 批次准入时的
预算检查点（`checkBudget`）。

但这条链**从来没接上真实开销**：

- `budget.spent` 事件只有 LLM 通路写（`adapters/llm/event-emitting-adapter.ts`，
  即 clarify / spec / stall 用的草稿模型调用）；
- **agent 真正执行切片的钱，一次都没有入账**；
- 于是 `BudgetCollector.getSpent()` 对任何 agent 切片都读到 0，
  `isExhausted()` 永远为 false，预算检查点永远放行。

结论：**现在的预算闸门是一道永远敞开的门**。项目目标 §2.4 写的
「预算耗尽 → 批次停在待签字」在实现上并不成立 —— 因为没人告诉它预算耗尽了。

本次定案：

- 端口层新增**可选**的 `getUsage(sessionId)` —— 适配器报告本次会话花了多少；
- 两个 executor 适配器实现它（Agent SDK 从 `result` 消息取；Claude Code CLI
  从 `--output-format json` 的输出取）；
- CLI 在 agent 退出后把用量写成 `budget.spent` 事件；
- 记账之后立刻复判预算：**超预算的切片不进 gate、不自动签字**，
  归入 `budget_exhausted` 停机类交回给人。

---

## 2. 为什么现在做

预算闸门是驾驶舱「拉闸层」的四件事之一（项目目标 §2.4）：
预算耗尽 → 批次停在待签字 → 人决定加预算还是砍范围。

一个不读真实开销的预算闸门，比没有更糟：
它让人以为「跑不动了会自动停」，于是放心地派十个 agent 并行，
每个都跑满上下文窗口，最后拿到一份账单和一堆半成品。

而且这条链的**两端都已经存在**，只差中间一段：

```
上限（config.yaml budgetLimitUsd）──→ checkBudget ──→ 判定
                                             ↑
                                        缺：spent 从哪来
```

不是新造机制，是把已有的两端接起来。

---

## 3. 决策

### 3.1 端口契约：一个可选方法

`core/ports/executor.ts`：

```ts
export interface AdapterUsage {
  costUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

export interface ExecutorAdapter {
  // ...
  getUsage?(sessionId: string): AdapterUsage | null;
}
```

**为什么是可选方法**：端口在 `core/`，实现在 `adapters/`（C2）。
加必选方法会让所有适配器都被迫实现一个它们可能真的没有的能力
（比如未来的本地 agent 根本不花钱）。
可选方法 + 运行时「有就用、没有就承认没有」，是这里唯一诚实的形状。

**为什么不在 `AdapterMeta.capabilities` 里加一个 `costReporting` 标志**：
能力标志描述的是「这个适配器能不能做某件事」，而 `getUsage` 的**存在性**
本身已经表达了这件事。加标志等于让同一个事实有两个真源。

### 3.2 两个适配器各自的取数方式

两种 executor 的花钱方式完全不同，所以取数方式也必须不同。

**`claude-agent-sdk`**：SDK 的 `result` 消息自带 `total_cost_usd`（累计估算值，
覆盖 query 管道里所有模型调用）。适配器在消费消息流时把它记到会话上，
`getUsage` 直接返回。

**`claude-agent`（shell 拉起 CLI）**：Claude Code CLI 在 `--print` 模式下，
`--output-format json` 会输出**一个** JSON 对象，其中含：

- `result` —— 最终文本答案；
- `total_cost_usd` —— 累计花费；
- `usage` —— `input_tokens` / `output_tokens`；
- `modelUsage` —— 分模型明细。

因此这个适配器把 Claude Code 的调用切到 `--output-format json`，
stdout 保留原文，**解析是惰性的**：

- `getOutput()` 优先返回 JSON 的 `result` 字段（回答问题回路依赖这段文本）；
- 解析不出 JSON（CLI 报错、非 Claude Code 命令）时**退回原始 stdout 文本**，
  不吞输出；
- `getUsage()` 解析不出就返回 `null`。

副作用（写进 ADR 以免将来当 bug 修）：json 输出模式下 stdout 是一次性到达的，
`onOutput` 回调不再逐块流式回调。这是 CLI 换输出格式的固有代价，不是缺陷；
进度显示本来也不依赖 stdout 流（见 `core-slice.ts` 的定时器）。

### 3.3 记账事件：复用 `budget.spent`，加一个 `source`

不新增事件类型 —— `budget.spent` 已经是「这笔钱花在这儿」的语义。
payload 增补字段：

```json
{
  "amount": 0.1234,
  "source": "agent",
  "adapter": "claude-agent",
  "sessionId": "claude-agent-SLICE-1757...",
  "model": "claude-sonnet-4-20250514",
  "inputTokens": 8123,
  "outputTokens": 1456
}
```

`source` 取 `agent` | `llm`。`llm` 侧的既有事件不强制补字段（不破坏旧事件），
但新写的 agent 侧事件必须带 `source`，以便事后能分开统计
「模型草稿花的钱」和「agent 干活花的钱」。

`run.finished` 事件的 payload 补一个 `costUsd`（数字或 `null`）。
`null` 的含义是**「没测到」**，不是「零」—— 两者必须能区分开，
否则又是一道假闸门。

### 3.4 谁来写这个事件：CLI，不让适配器碰事件流

适配器不知道切片 id、也不该知道事件流（C2：依赖单向向下，适配器可以 import
core，但让适配器写事件等于让它承担记账语义，两处实现必然漂移）。

所以：**CLI 在 agent 退出后调用 `adapter.getUsage(sessionId)`，把结果写成事件。**
写事件的唯一入口是 `cli/commands/run-support.ts` 里的 `recordAdapterUsage()`。

记账时机覆盖**全部**退出路径：成功、失败、提问挂起、重试后的每一次会话。
每一次 agent 会话单独记一条 —— 事件流是追加的，累加自然等于总量。

### 3.5 判定闭环：超预算的切片不进 gate

记账之后立刻复判：

| 情况 | 动作 |
|---|---|
| 已花费 < 上限 | 照常进 gate② → 自动签字请求 |
| 已花费 ≥ 上限 | **不进 gate、不发签字请求**；写 `stall.classified`（`class: budget_exhausted`），切片停在 `frozen` 等人 |
| 适配器没有用量数据 | 按「未测到」处理：**不判定超支**（没有数据不等于超支），但 `run.finished.costUsd = null` 让这件事在事件流里可见 |

「没有数据就不拦」是刻意的：拦一个可能没超预算的切片，比放过一个真超支的更糟 ——
真超支的后果是账单，前者的后果是项目卡住。两者都记在事件流里，由人裁决。

### 3.6 上限语义修正：`0` = 不限

`config.yaml` 里的注释写着「0 = unlimited」，但 `BudgetCollector.getLimit()`
把 `0` 当成「无效值」而回落到默认 `1.0`。注释与实现不符 = 假的。

修正为：`budgetLimitUsd > 0` 才是上限；`0` 表示不限；缺失配置仍是默认 `1.0`。

### 3.7 明确不做

- 不做成本预测、不做预算的跨切片分摊 —— 上限仍是**每片**上限；
- 不做「按剩余预算自动缩小 agent 权限」；
- 不引入任何第三方依赖（C2）；
- 不让 `core/` 反向依赖 `adapters/`（C2）—— 取数只发生在 CLI 层。

---

## 4. 约束合规检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C1** | 用量记在 append-only 事件流文件里；适配器侧只保留内存态的会话用量，不落盘为真源 | ✅ |
| **C2** | `core/` 只加了一个纯类型接口 + 一个可选方法，零第三方依赖，不 import `adapters/` | ✅ |
| **C3** | 预算判定（累加、比较上限）是纯计算，不调模型、不触网 | ✅ |
| **C4** | 每次 agent 退出追加一条 `budget.spent` 事件，只追加不改 | ✅ |

禁区检查：未新增自动批准、自动合并、自动改规格；未新增事件类型；
签字仍不自动合并（ADR-018 不变）。

---

## 5. 后果

**好的**

- 预算闸门第一次真的会关；
- `run.finished` 里带着这一片花了多少钱，事后可查；
- 「没测到」与「零」在事件流里能分开，不再有假闸门；
- 适配器要换（CLI → SDK，或接第三方 agent）时，记账路径不用改 —— 它只认端口。

**代价与边界**

- 依赖适配器如实上报用量。适配器不报 = 预算不生效（记在事件流里的 `null`）；
- Claude Code CLI 的调用从文本输出切到 json 输出，stdout 不再流式到达。

**明确不做**

- 不替人判断「这一片值不值这个钱」—— 只报数，不劝退；
- 不因为超预算就自动回滚 agent 已经写下的代码 —— 现场交回给人（与 ADR-020 一致）。

---

## 6. 验收标准

1. `npm test` 全绿，`npm run lint` 通过；
2. 两个适配器都实现 `getUsage`，且对未知会话返回 `null`（不抛异常）；
3. Claude Code CLI 适配器在 stdout 非 json 时退回原始文本，输出不丢；
4. agent 退出后事件流里出现 `budget.spent`（`source: 'agent'`），
   `run.finished` 带 `costUsd`；
5. 花费达到上限后：切片**不进 gate**、不发签字请求，写 `budget_exhausted` 停机事件；
6. `budgetLimitUsd: 0` 被解释为「不限」。

---

## 7. 关联 ADR 的状态更新

- **ADR-018**（签字不自动合并）不变 —— 预算超支只是让流程**停在签字前**，
  签字语义不变；
- **ADR-020**（拉闸）不变 —— 超预算的切片同样「现场交回给人」，
  只是触发原因是账而不是人的喊停；
- **ADR-024**（亲和分组调度）不变 —— 预算闸门在准入点，不在排阶段里。
