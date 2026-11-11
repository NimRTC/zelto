# ADR-047：agent 失败不该把切片卡在 `running`

**状态**: 已实施
**日期**: 2026-11-11
**作者**: 系统架构
**关联约束**: C1, C3, C4, C9
**关联文档**: `docs/adr-037-violation-recovery-and-refreeze.md`（越界回退，同一条退路）,
`docs/adr-020-halt.md`（拉闸回退，同一个问题域）,
`docs/zelto-技术架构.md`（§3.2 状态机）

---

## 1. 摘要

**agent 失败之后，切片卡在 `running` —— 人救不回来。**

病灶（已核对 v0.5.0 源码）：

| # | 位置 | 现状 | 后果 |
|---|---|---|---|
| 1 | `run-support.ts` `handleAgentFailure()` 末尾 | 写 `slice.stall.class` 前**不迁状态** | 切片停在 `running` + 停机分类 |
| 2 | `core-slice.ts` 后台监控失败分支（`bgSlice.stall.class = stallClass`） | 同上 | 后台任务失败也卡 `running` |
| 3 | `engine.ts` `resume()` | **只清** `stall.class`，**不迁状态** | resume 后仍 `running`，提示「可以重跑了」是假话 |
| 4 | `engine.ts` `admit()` 写集冲突表 | 收集所有 `state==='running'` 的切片 | 死切片持续阻塞别的切片 |
| 5 | `parallel-executor.ts` 最终失败分支 | 根本不写停机 | 并行批次里的失败片既不可见也不可重跑 |
| 6 | `tests/acceptance/stall-resume/stall-resume.test.ts:145` | 断言 `state === 'running'` | **把 bug 写成了期望** |

### 1.1 为什么「卡在 running」是死路

切片卡在 `running` 时，四条路全堵死：

| 命令 | 卡在 running 时的行为 |
|---|---|
| `zelto run <id>` | `Cannot run: Slice is in state "running"` —— 准入只认 `frozen` / `completed` |
| `zelto merge <id>` | 不收它（没签字） |
| `zelto resume <id>` | 清了停机分类，**状态还是 `running`** —— 「可以重跑了」是句假话 |
| `zelto next` | 指着这个已经跑过的切片（或者干脆不提它） |

唯一出路是 `zelto abandon` —— 整个切片作废，规格得重写。

也就是**「agent 挂一次，切片就废了」**。这不是设计意图：agent 失败通常意味着
**重跑就能过**（环境抖动、上下文超限、写集划窄）。人是来看情况的，不是来重写规格的。

### 1.2 这与 ADR-037 是同一个病

ADR-037 修过一遍：**写集越界之后切片永久卡死**，四条路全堵死。
当时的处置是「越界时退回 `frozen`」，用的是状态机里现成的
`running --RUN_FINISH--> frozen`。

但那次只修了**越界**这一条路径。**agent 失败**这一条路径上，同样的病还在 ——
而且它比越界更常见（越界是偶发，agent 失败是常事）。

> 同一个病修了一次只修了一条路，等于没修 —— 病人下次换个入口进来，
> 还是同样的症状。

---

## 2. 决策

### 2.1 停机 = 退状态 + 写分类 + 留痕（三件事，一个落点）

**停机的唯一落点**是 `markSliceStalled()`（`src/cli/commands/run-support.ts`）：

```
1. 退状态：running → frozen（RUN_FINISH）
2. 写停机分类：slice.stall.class = <class>
3. 写事件：slice.state.changed + stall.classified
```

**顺序不能换**：先退状态，再写分类。这样哪怕写分类失败，切片也已经是
可重跑的 `frozen`，而不是卡死的 `running`。

三条执行路径（单片前台、并行、后台）**全部走这一个落点** —— 病灶 #5 就是
因为并行路径压根不写停机，跟单片路径各写各的，行为漂移了。

### 2.1.1 停机只做一次（重复调用会写两遍事件）

前台 `run` / `start` 两条循环里原本有**两次** `handleAgentFailure` 调用：
一次在「还能重试」的分支里拿返回值，一次在分支外面的「不再重试」兜底。

问题：`handleAgentFailure` 返回 `stall` 时**它已经把切片停机了**
（退状态 + 写分类 + 写两条事件）。外层那次兜底再调一遍 →
`slice.state.changed` 与 `stall.classified` 各写两遍。

修法：内层拿到 `stall` 就置 `stalled = true`，外层只在**没停过**时才兜底。
停机是一个**事实**，不是一个要重复执行的动作。

### 2.2 状态机不用改

`running --RUN_FINISH--> frozen` 本来就在状态机里（`src/core/slice/state.ts:44`），
语义是「这一轮跑完了，回到可以再跑的状态」。

agent 失败确实**跑完了**（进程退出了），只是这一轮**不算数**
（门禁没跑、签字没发）—— 与 ADR-037 的越界回退语义完全一致。

> 不新增状态、不新增转换 —— 修法落在**调用点**，不在状态机。

### 2.3 `resume()` 必须迁状态，不能只清分类

病灶 #3 是**半截修复**：只清停机分类，切片仍卡在 `running`，
于是 `zelto run` 仍然拒绝它 —— 而 resume 的提示语说「可以重跑了」。
提示与事实不符，比没有提示更坏。

所以 `resume()` 现在做三件事，顺序是：**迁状态 → 清分类 → 写事件**。

> 迁状态在前：迁移失败（状态被别处改过）时分类还在，切片仍标记为
> 「待人处理」，不会变成「什么都没发生」。

**实现要点**：迁状态之后必须**重新读一遍**切片再写回 —— 否则
「清停机分类」写的是迁移**前**那份快照，会把刚迁好的状态改回 `running`，
正好把修复抵消掉。

### 2.4 `admit()` 的写集冲突表排除死切片

病灶 #4：冲突表收集所有 `state==='running'` 的切片。死切片（状态还停在
running，但 agent 早就挂了）于是**持续阻塞**别的切片 —— 写集重叠的切片
永远拿不到准入。

现在的判据：**带停机分类 = 不占着写集**（纯读文件，C3 确定性）。

**例外：提问回路（`agent_question`）**。那不是「跑挂了」—— agent 还活着，
只是停下来等人数码，答完在**原地续跑**（ADR-013）。它的会话仍然会写文件，
仍然占着写集。把它排除掉 = 两个 agent 同时改同一批文件。

### 2.5 准入被拒时要说清出路

病灶 #3 的最后一环：准入只说「must be "frozen" or "completed"」，
但人照着这句话去找「为什么不是 frozen」，答案不在状态机里 —— 在停机分类里。

所以准入被拒时，理由里直接给出下一步：

| 情形 | 理由 |
|---|---|
| `running` + 停机分类 | `Slice is stalled (X) and stuck in "running" — resume it first: zelto resume <id>` |
| `running` + `agent_question` | `Slice is waiting for an answer (agent_question) — answer it first: zelto ask` |
| 其它 | 原样：`Slice is in state "Y", must be "frozen" or "completed"` |

---

## 3. 影响面

| 文件 | 变更 |
|---|---|
| `src/cli/commands/run-support.ts` | 新增 `rollbackStalledSlice()` / `markSliceStalled()`（停机的唯一落点）；`handleAgentFailure()` 改走它 |
| `src/cli/commands/core-slice.ts` | 后台监控失败分支改走 `markSliceStalled()`；前台 `run` / `start` 两处循环去掉重复的停机调用 |
| `src/cli/commands/parallel-executor.ts` | 最终失败分支补走 `markSliceStalled()`（原本完全不写停机） |
| `src/cli/commands/question.ts` | 续跑失败退 `frozen`（原本留在 `running`） |
| `src/core/sched/engine.ts` | `resume()` 迁状态；`admit()` 冲突表排除死切片 + 理由带出路 |
| `tests/adr-047-agent-failure-unsticks-slice.test.ts` | 新增（resume 迁移 + 冲突表三条判据） |
| `tests/core/stall/auto-retry.test.ts` | 停机路径的事件断言改为按类型找（现在有两条） |
| `tests/acceptance/stall-resume/stall-resume.test.ts` | 断言从 `running` 改为 `frozen`（原来把 bug 写成了期望） |
| `tests/resume-command.test.ts` | 同上 |
| `tests/agent-execution.test.ts` | 同上，并断言留有停机分类 |

**事件类型没有新增** —— `slice.state.changed` 与 `stall.classified`
都已在契约里（`contracts/schemas/event-envelope.json`）。
所以本次**没有契约变更**，不需要改 schema。

---

## 4. 不变式自查

| 约束 | 核对 | 合规 |
|---|---|---|
| **C1** 状态只在文件里 | 退回 `frozen` 是写切片状态文件；事件追加到 `.zelto/events/`；未新增内存状态或常驻进程 | ✅ |
| **C2** `core/` 零第三方依赖 | 改动只用了 Node 内置；未新增任何 npm 依赖；`core/` 未 import `adapters/` | ✅ |
| **C3** 判定必须确定性 | 死切片判据是「读切片文件里的停机分类」；无模型参与、无网络 | ✅ |
| **C4** append-only 事件 | `slice.state.changed` / `stall.classified` 都是追加；未改写或删除既有事件 | ✅ |
| **C5** 保护域与锚点外部化 | 未动策略锚点机制 | ✅ |
| **C7** `llm/` 只产草稿 | 全程无模型参与 | ✅ |
| **C9** 写集预约运行时强制 | **判定逻辑一字未改** —— 越界照样拦、照样不进 gate；退状态不释放预约（预约由 `guard.release()` 管） | ✅ |

禁区检查：未新增自动批准、自动合并、自动改规格、自动改锚点。

> C9 值得单独说一句：本次改的是**失败之后怎么恢复**，不是**失败要不要拦**。
> 写集判定、hook 逐写拦截、运行后审计兜底全部没动。

---

## 5. 验证方式

### 5.1 单元测试

新增 `tests/adr-047-agent-failure-unsticks-slice.test.ts`：

- `resume()` 后切片回到 `frozen`（不是 `running`）；
- `resume()` 留下 `slice.state.changed` 事件；
- `resume()` 不动本来就在 `frozen` 的切片；
- `--abandon` 仍然直接作废（不受影响）；
- 死切片（`running` + 停机分类）不再阻塞别的切片；
- **真正在跑的切片仍然占着写集**（这条不能被放松）；
- 提问回路的切片仍然占着写集（agent 还活着）；
- 准入被拒的理由里带得出路（`resume`）。

`tests/core/stall/auto-retry.test.ts` 补 3 个用例：

- 停机时把 `running` 迁回 `frozen`；
- 不在 `running` 的切片不动状态、不发多余转换；
- 停机事件里带上状态迁移的起止。

### 5.2 验收测试（跑真实 CLI 进程）

- `tests/acceptance/stall-resume/stall-resume.test.ts`：断言从 `running` 改为 `frozen`；
- `tests/agent-execution.test.ts`：
  - agent 非零退出后切片是 `frozen` 且带停机分类；
  - 状态迁移只发生一次、停机只写一次；
  - **重跑一个已经停机的切片不会停机两次**（§2.1.1 的回归）。

最后这条用例做过**反向验证**：临时撤掉修复后它失败
（`停机应当只发生一次，实际 2`），恢复修复后通过 ——
它真的咬住了这个 bug，不是摆设。

### 5.3 回归

`npm test` 全量通过（1568 个用例 / 343 个套件）；`biome check src/ tests/` 干净；
编码检查通过。

---

## 6. 遗留（需人拍板）

**死切片的批量清理**。现在死切片不再阻塞别人，但它们仍占着 `zelto status`
的「running」计数。人得逐片 `zelto resume`。

是否加一条 `zelto stall --reap`（把所有「running + 带停机分类」的切片批量
退回 `frozen`）？现在 `zelto halt --rollback` 只处理「持有预约的进程已死」
那一类 —— 死切片**没有预约**（agent 挂了，预约已释放），所以它扫不到。

> 倾向：先不加。批量改状态的动作必须是显式的，而逐片 `resume` 已经可用；
> 真要加，也该是 `zelto stall --reap` 这种独立命令，不该悄悄塞进 halt。

**提问回路的写集占用时长**。`agent_question` 的切片一直占着写集，
人迟迟不答，它就一直挡着别人。是否给它加个超时？
现在没有 —— 人不答就是不走，这个语义本身是清楚的（ADR-013 §3.5）。

**自动重试预算不会随重跑重置**。`stall.autoResolved` 是切片级计数，
只在自动重试时 +1，`resume()` 不清它，`startRun()` 也不清它。

后果：一片因为 `environment_failure` 退到 `frozen` 之后，人修好环境、
`zelto resume` + `zelto run` 重跑 —— 但计数器还停在 `maxRetries`，
于是**第一次失败就直接停机**（不再自动重试）。

这是本次修复**顺带暴露**的：修复前切片卡在 `running`，压根跑不了第二次，
所以「预算不重置」这个语义从来没被触发过。现在能重跑了，它才变成真问题。

> 倾向：**本次不动**。理由是「自动重试预算是一次性的」本身说得通 ——
> zelto 不该无限重试同一片同一个失败。但要让人看得见：现在
> `zelto stall --auto-resolved` 会列出这些片，`zelto slice show` 也会显示
> `Auto-resolved: N`。真要重置，得做成显式动作（比如 `zelto resume --reset-retry`），
> 不能悄悄清 —— 悄悄清就等于「重跑一次预算就无限」，那才是真问题。
>
> 这一点需要人拍板，见下节。
