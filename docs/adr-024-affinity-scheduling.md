# ADR-024: 亲和分组调度 —— 同类切片串行连续做，每片仍是新会话

**状态**: 已实现
**日期**: 2026-11-05
**作者**: 系统架构
**关联约束**: C1, C2, C3, C4, C5, C7, C9
**关联文档**: `AGENTS.md`, `docs/zelto-项目目标.md`（§2.3、§6 G-2）,
`docs/adr-019-phased-execution.md`, `docs/adr-014-runtime-policy-enforcement.md`,
`docs/adr-013-agent-question-loop.md`

---

## 1. 摘要

当前并行是“每片冷启动”：每个切片 `adapter.start({ sliceId, prompt: bundlePath })`
都是新会话、新 `agentSessionId`、新 worktree、新预约（见
`src/cli/commands/parallel-executor.ts`）。这是刻意设计，保证追溯干净。

代价是 LLM 上下文一致性损失：同模块、同写集前缀、有依赖链 `A -> B` 的切片，
每片都要重建仓库心智模型，相邻两片容易写出不一致的接口用法。

本 ADR 引入**亲和分组调度**：

1. **分组是确定性计算**：按写集前缀、设计模块、规格“前置切片”分组，不调模型。
2. **组内串行、组间按原阶段计划并行**：亲和只改变同阶段内“谁先谁后”，不改变能否并行。
3. **每片仍是新会话**：不复用 `agentSessionId`，不跨片 `--resume`。
4. **下片只继承只读上下文**：前片的冻结哈希 + 合入 commit + 短摘要注入约束包，仅作建议。

明确不做：同一会话连续做多片、常驻 agent 池、按历史成功率自动选 agent 的路由学习
（AGENTS.md 负向清单）。

---

## 2. 动机

### 2.1 现状

| 事实 | 位置 | 影响 |
|---|---|---|
| 每片都是新会话、新 `agentSessionId` | `src/cli/commands/parallel-executor.ts`、`src/adapters/claude-agent/index.ts` | 无上下文污染，但每片重做预热 |
| `planExecutionPhases()` 只排“能否并行” | `src/core/sched/batch.ts` | 写集重叠只被贪心着色拆开，不管“谁和谁连续做更顺” |
| 约束包只含本片信息 | `src/core/sched/engine.ts` 的 `buildConstraints()` | 下片看不到上片做了什么，只能重读全仓 |
| 唯一复用会话的是提问续跑 | `adapter.resume(sessionId, patch)`，`--resume` | 只续同一片，不跨片 |

### 2.2 为什么是分组串行而不是会话复用

全量复用会话的代价：

- **污染**：上片假设泄漏到下片，下片依据变成“记忆”而非冻结规格，追溯链断裂。
- **归因断裂**：一个会话横跨两个预约写集，`policy.decision`、`run.*` 事件无法归属（C4）。
- **上下文爆炸**：长会话触发 `context_exhaustion` / `cognitive_stuck`，与停机分类对抗。
- **隔离破坏**：同一会话在不同 worktree 间切换，易写错目录（C9）。

分组串行拿走大部分连续性收益（预热成本摊薄、风格一致），不付上述代价。
这与工程师直觉一致：持续干同一件事效率更高，但每件事仍要有独立工单与验收。

---

## 3. 决策

### 3.1 亲和分组规则（确定性，C3）

输入与排阶段相同：`{ id, writes }` + `deps` + 设计模块映射。
输出：`affinityGroup: string | null`，每个切片至多属于一组。

分组优先级（按顺序命中即停）：

1. **依赖链**：`B` 的前置是 `A`，则 `A`、`B` 同组。真源为规格“前置切片”章节，与 D1=A 一致。
2. **写集前缀**：写集首段相同（如 `src/core/sched/**` 与 `src/core/sched/engine.ts`），同组。
3. **设计模块**：`DesignDoc.modules` 覆盖同一模块文件集合，同组。

规则细节：

- 全按字符串与集合运算，不调模型、不触网（C3）。
- 同输入必得同分组：组内按 `id` 排序，组标识为组内最小 `id` 的哈希或 `affinity-<min-id>`。
- 无命中则为 `null`，不强制分组。宁可不分组，不错分组。
- LLM 不参与分组判定（C7）；“这两片像不像”由模型判断即违反 C3 与路由自动学习禁区。

### 3.2 调度语义

- 亲和只在**同一执行阶段内**排序：同组切片在阶段内按依赖拓扑串行，其余仍可并行。
- 不改变 `planExecutionPhases()` 的阶段划分：阶段之间仍串行，前阶段没过后阶段不启动
  （ADR-019 §3.3 不变）。
- 同组串行片**每片仍走完整路径**：准入 → 建 worktree → 取预约 → 装钩子 → 拉起新 agent →
  审计 → 门禁② → 签名请求（C9 不变）。
- `--resume` 仍只用于同一片的问答续跑（ADR-013），不跨片。

### 3.3 上下文注入（只读建议，C7）

`ConstraintBundle` 新增可选字段（纯追加，不改现有字段）：

```typescript
interface AffinityContext {
  groupId: string;
  /** 组内前序切片 id（按执行序） */
  previousSlices: string[];
  /** 每片的冻结哈希 + 合入 commit + 一句话摘要 */
  summaries: Array<{ sliceId: string; frozenHash: string | null; commit: string | null; summary: string }>;
}
```

约束：

- 摘要来源只能是已冻结规格、已合入 commit、门禁结论三样，不含 agent 会话记忆。
- 摘要文本可由 `llm/` 草拟，但只是建议（C7），不参与准入 / 冲突 / 审计任何判定。
- 前片未合入时只给冻结哈希与规格路径，不给 worktree 路径，防止下片读未验收产物。

### 3.4 事件（不新增类型）

不新增事件类型（事件类型是契约）。复用已有：

| 事件 | 新增 payload | 说明 |
|---|---|---|
| `coord.phase_ready` | `affinity: Record<string, string \| null>` | 每片所属组，可为空 |
| `run.started` | `affinityGroup: string \| null`、`previousSlices: string[]` | 本片连续性来源，可查 |
| `run.finished` | `affinityGroup: string \| null` | 与 started 对齐，便于审计 |

归属键不变：版本级用 `version-<label>`，`run --parallel` 用 `batch`。

---

## 4. 实现位置

| 内容 | 位置 |
|---|---|
| 亲和分组纯函数 | `src/core/sched/batch.ts` 新增 `planAffinityGroups(members, deps, moduleMap?)` |
| 类型 | `src/core/sched/batch.ts`（`AffinityGroup`）与 `src/core/sched/types.ts`（`ConstraintBundle.affinity?`） |
| 事实读取 | `src/cli/commands/batch-facts.ts` 复用写集/依赖读取，新增设计模块读取 |
| 计划构建 | `src/cli/commands/execution-plan.ts` 的 `buildExecutionPlan()` 附加亲和分组 |
| 执行排序 | `src/cli/commands/parallel-executor.ts` 阶段内同组串行，其余并行 |
| 上下文注入 | `src/core/sched/engine.ts` 的 `buildConstraints()` 读前片冻结信息 |
| 判定测试 | `tests/affinity-groups.test.ts`（分组确定性、同输入同计划、跨阶段不分组） |

`core/` 侧只用 Node 内置、不 import `adapters/`（C2）；判定不调模型不触网（C3）。

---

## 5. 约束合规检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C1** | 分组计划现算不落盘；快照式摘要只读切片文件与 git，不写新状态 | ✅ |
| **C2** | `core/sched` 只用内置模块，不 import `adapters/` | ✅ |
| **C3** | 分组为字符串/集合运算；上下文注入只读文件；无模型无网络 | ✅ |
| **C4** | 分组结论进 `coord.phase_ready`；每片起止带 `affinityGroup` | ✅ |
| **C5** | 不碰保护域判定顺序（ADR-014 §3.2 不变） | ✅ |
| **C7** | 摘要仅为建议；分组不依赖 LLM；不自动 confirm | ✅ |
| **C9** | 每片独立预约与钩子；串行不共享预约；缺预约仍 fail closed | ✅ |

禁区检查：无常驻 daemon、无自动合并、无自动改规格、无路由自动学习。
`--resume` 不跨片，签字仍由人行使（ADR-018 不变）。

---

## 6. 后果

**好的**

- 同模块/同写集/依赖链切片连续执行，预热成本摊薄，风格更一致。
- 并行度仍是算出来的：亲和只排序，不放宽冲突判定。
- 追溯链不断：每片仍是新会话 + 冻结规格 + 独立预约 + 独立事件。

**代价与边界**

- 同组串行意味着那一组变慢，换一致性。这是刻意取舍，与 G-2 降级同理。
- 分组错了比不分组更伤：规则宁严勿宽，无命中即 `null`。
- 摘要可能过时：只认冻结哈希与合入 commit，worktree 中间态不注入。

**明确不做**

- 同一 agent 会话连续做多片。
- 常驻 agent 池 / 预热 daemon。
- 按历史表现自动选 agent 或自动调分组权重。
- 跨片复用 `agentSessionId`。

---

## 7. 验收标准

1. 同写集前缀的两片被分到同组，阶段内串行执行，且每片 `run.started` 带相同 `affinityGroup`。
2. 依赖 `B -> A` 时 `A`、`B` 同组，`B` 的约束包含 `A` 的冻结哈希与合入 commit。
3. 同输入两次排分组结果完全一致（含组内排序）。
4. 跨阶段的两片不同组（亲和不跨阶段）。
5. 无命中时 `affinityGroup` 为 null，执行语义与 ADR-019 完全一致。
6. 全程每片独立预约与钩子；任一片越界只拦该片，不污染同组后片。
