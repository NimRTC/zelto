# ADR-019: 版本内并行改为阶段化执行（依赖分层 + 写集冲突降级）

**状态**: 已实现
**日期**: 2026-11-04
**作者**: 系统架构
**关联约束**: C1, C3, C4, C9
**关联文档**: `AGENTS.md`, `docs/zelto-项目目标.md`（§6 差距 G-1 / G-2、§7 待决策 D1 / D2）,
`docs/adr-012-parallel-coordination.md`, `docs/adr-017-version-level-orchestration.md`

---

## 1. 摘要

`zelto version start` 过去把版本里的所有切片**一次性全部并行**：
不看切片之间的依赖，也不管写集是不是撞了。撞了就整批 abort —— 一个 agent 都不启动。

本 ADR 把并行执行改为**阶段化**：

1. **依赖分层（G-1）**：切片之间的依赖来自规格的「前置切片 / Prerequisites」章节，
   拓扑分层，阶段之间串行、阶段内并行。
2. **写集冲突降级（G-2）**：同一层里写集重叠的切片自动拆成先后两个阶段，
   批次继续跑，不再整批 abort。

两处判定都在 `core/sched/batch.ts` 里，是确定性计算（C3）。

---

## 2. 动机

### 2.1 现状

| 事实 | 位置 | 影响 |
|---|---|---|
| `version start` 一次性把所有切片丢进 `executeSlicesParallel` | `src/cli/commands/ai-pipeline.ts` | 版本内并行不认依赖 |
| 并行执行器对写集冲突整批 abort | `src/cli/commands/parallel-executor.ts` | 两个切片都碰 `types.ts` → 整个版本一个 agent 都不跑 |
| 依赖分层能力其实早就有了 | `core/sched/batch.ts` 的 `planBatchPhases` | 写好了没人调用 |
| 依赖信息其实也早就有了 | 规格「前置切片」章节，`core/spec/scope.ts` 的 `parsePrerequisites` | 有真源，没接线 |
| 「高速并行」是产品的核心卖点 | `docs/zelto-项目目标.md` §2.1 G2 | 并行度算错，卖点就是假的 |

### 2.2 为什么依赖必须算进并行度

「把 3~4 个 agent 同时拉起来」听起来是并行度，实质上是**协调成本爆炸**。
手工协调时人靠直觉判断谁该等谁；zelto 必须把这件事变成确定性判定，否则：

- 依赖 B→A 时 B 抢跑：A 的产物还不存在，B 要么改错东西，要么失败，
  然后人还得回头收拾。
- 失败还只是开始 —— B 的错误改动会留在 worktree 里，
  后面合并时才炸，那时候已经分不清是谁的问题。

阶段化把「谁等谁」固化下来：**阶段之间串行，阶段内并行**。
并行度只发生在真正独立的那一组切片上。

### 2.3 为什么冲突要降级而不是 abort

写集来自规格（多数情况下由模型生成），重叠是可预期的 —— 两个切片都碰
`src/types.ts` 是常态，不是异常。整批 abort 的代价是：

- 明明有一个切片可以跑，却一个都没跑；
- 人必须回去改规格才能重试，而改规格要走重新冻结；
- 「版本启动」这个动作变得脆弱 —— 一次重叠就废掉整批。

降级成串行是**确定性判定**，符合 C3：重叠的两个切片排成先后两个阶段，
批次继续跑。代价是这一组失去并行（慢一点），收益是批次不停摆。

---

## 3. 设计

### 3.1 依赖从哪来（D1 = A）

依赖的**真源是规格的「前置切片 / Prerequisites」章节**，
`--depends-on <id>=<dep>` 只是命令行覆盖。

不把依赖提到版本计划的 `VersionSlice` 上：那样要改 schema，
而且是同一份信息的第二次表达 —— 规格里已经写了，重复声明反而可能两边打架。

### 3.2 判定在哪

全部在 `core/sched/batch.ts`（`core/` 只用 Node 内置、不调模型、不触网）：

```
planExecutionPhases(members, deps)
  ├─ 依赖分层：planBatchPhases → 拓扑分层
  └─ 写集降级：层内贪心着色
       - 按 id 排序依次放切片（保证同输入同计划）
       - 放进第一个与已有切片都不冲突的阶段；都冲突就新开一个阶段
```

跨阶段的写集重叠**不处理** —— 阶段之间本来就允许改同一批文件，
那正是依赖关系的含义。

### 3.3 执行怎么走

```
zelto version start <ver>
  ├─ Phase 1 准备切片（建切片 → 写规格 → 冻结）      ← 不变
  ├─ Phase 2a 排阶段（依赖分层 + 写集降级）           ← 新增
  │     └─ 依赖成环 → 报环路径，退出 1（coord.cycle_detected 事件）
  ├─ Phase 2b 按阶段顺序执行                          ← 由「一次性全并行」改为「阶段串行」
  │     ├─ 阶段内：与原并行路径完全一致（隔离 worktree + 写集预约 + 门禁② + 签名请求）
  │     └─ 阶段之间：前一个阶段没全过就停，后续阶段不启动
  └─ Phase 3 结果                                     ← 不变
```

`zelto run --parallel` 走同一条路径 —— 两条入口共用同一份排法
（ADR-017 的「单一并行执行路径」）。

### 3.4 事件

不新增事件类型（事件类型是契约，改它要另写 ADR）。复用已有的：

| 事件 | 时机 | payload |
|---|---|---|
| `coord.phase_ready` | 阶段开始 | `phase`、`slices`、`totalPhases` |
| `coord.phase_complete` | 阶段结束 | `phase`、`slices`、`ok` |
| `coord.cycle_detected` | 依赖成环 | `cycle`、`slices` |

事件归属键：版本级用 `version-<label>`，`run --parallel` 用 `batch`。

### 3.5 `zelto batch` 与执行口径一致

`zelto batch`（只查不跑）此前把写集重叠报成**阻断项**，而执行器会 abort ——
两边一致。现在执行器改成降级，`zelto batch` 也就必须改成同一口径：
重叠不再是阻断项，而是「已降级为串行」的提示。
**审核结论与实际执行不允许出现两套答案。**

---

## 4. 约束合规性

| 约束 | 怎么满足 |
|---|---|
| C1 状态只在文件里 | 阶段计划不落盘，每次执行现算；切片状态与事件仍在文件里 |
| C2 `core/` 零 SDK 依赖 | `planExecutionPhases` 只用 `core/sched/paths.ts` 的写集判定 |
| C3 判定确定性 | 不调模型、不触网；贪心着色按 id 排序，同输入必得同计划 |
| C4 append-only 事件 | 阶段开始/结束/成环都写事件 |
| C9 写集预约运行时强制 | 阶段化只改「谁跟谁一起跑」，写集预约与运行时守卫一字未改 |

---

## 5. 后果

**好的**

- 版本内并行不再算错：依赖 respected，写集冲突不再整批 abort。
- 「高速」第一次是真的：并行只发生在真正独立的切片上。
- 并行度可解释：`zelto batch` / `version start` 都打印出阶段与降级原因。

**代价与边界**

- 一个阶段没全过，后续阶段不启动（宁可停，也不跑出错的产物）。
- 依赖只能来自规格「前置切片」章节 —— 规格里没写依赖，就按无依赖并行。
  这是 D1=A 的直接后果：依赖信息的责任落回规格编写者。
- 写集重叠降级成串行，那一组就变慢了。这是刻意的取舍：
  慢一点 > 整批停摆。

**明确没做**

- 不改 schema（`VersionSlice` 仍无依赖字段），不新增事件类型。
- 不做「agent 重新算写集后重试」——那需要 agent 参与判定，违反 C3。
- 不做自动合并，签字与合并仍然分开（ADR-018 不变）。

---

## 6. 实现位置

| 内容 | 位置 |
|---|---|
| 阶段规划判定 | `src/core/sched/batch.ts` 的 `planExecutionPhases` |
| 事实读取（写集/依赖/冻结/追溯） | `src/cli/commands/batch-facts.ts` |
| 计划构建与渲染 | `src/cli/commands/execution-plan.ts` |
| 分阶段执行 | `src/cli/commands/parallel-executor.ts` 的 `executeSlicesByPhase` |
| 版本入口接线 | `src/cli/commands/ai-pipeline.ts`（`version start`） |
| 并行入口接线 | `src/cli/commands/core-slice.ts`（`run --parallel`） |
| 审核口径同步 | `src/cli/commands/batch.ts`（`zelto batch`） |
| 判定测试 | `tests/execution-phases.test.ts` |
