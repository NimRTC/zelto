# ADR-052：自动重试预算的重置必须是显式动作

**状态**: 已实施
**日期**: 2026-11-11
**作者**: 系统架构
**关联约束**: C1, C3, C4, C9
**关联文档**: `docs/adr-047-agent-failure-unsticks-slice.md`（§6 遗留项之三）,
`docs/zelto-技术架构.md`（§3.2 状态机）

---

## 1. 摘要

**ADR-047 修好「agent 失败后切片卡在 running」之后，一个原本永远触发不了的
语义变成了真问题：自动重试预算不随重跑重置。**

后果：一片因为 `environment_failure` 自动重试耗尽而停机之后，人修好环境、
`zelto resume` + `zelto run` 重跑 —— 但 `stall.autoResolved` 计数器还停在
`maxRetries`，于是**第一次失败就直接停机**，一次都不自动重试。

人在重跑前完全看不出这件事：他看到的是「我修好环境了，我重跑」，实际发生的是
「我重跑了，但自动重试没了」。

## 2. 为什么它此前从未触发

ADR-047 之前，切片失败后卡在 `running`：

| 命令 | 卡在 running 时的行为 |
|---|---|
| `zelto run` | 拒绝（准入只认 `frozen` / `completed`） |
| `zelto merge` | 不收（没签字） |
| `zelto resume` | 清了停机分类，**状态还是 `running`** —— 「可以重跑了」是句假话 |
| 唯一出路 | `zelto abandon` —— 整个切片作废，规格得重写 |

也就是说：**修复前切片压根跑不了第二次**，「第二次跑的时候预算还没重置」
这个语义从来没被触发过。是 ADR-047 修好了重跑路径，它才变成真问题。

## 3. 决策

### 3.1 重置是显式动作，不是隐式行为

`zelto resume <id> --reset-retry` 显式重置自动重试预算。

**为什么不能悄悄清**：悄悄清 = 「重跑一次预算就无限」—— zelto 会对同一片
同一个失败无限重试。那是把一个真问题换成了另一个真问题。

**为什么不能一直不给重置**：预算是「zelto 最多自动重试几次」的承诺，
它的目的是防止 zelto 对着一个坏掉的切片无限烧钱。但**人是环境的主人** ——
环境故障（磁盘满、依赖装错、子模块没初始化）恰恰是**人修得好的那一类**。
修好环境之后还坚持「一次都不自动重试」，是把「防无限烧钱」误用成了
「惩罚人」。

所以：**预算有限，但重置是人的动作。**

### 3.2 重置独立于停机状态

`--reset-retry` 在**没有停机分类**时也允许执行。

理由是它与「恢复停机」是**两件事**：

| | 做什么 | 前置条件 |
|---|---|---|
| `resume`（不带 flag） | 清停机分类 + 把 `running` 迁回 `frozen` | 必须有停机分类 |
| `resume --reset-retry` | 只把自动重试预算清零 | 无 |

为什么必须分开：**预算重置的时机通常晚于 resume。** 人看到「重跑后第一次
失败就停机」的警告时，切片已经 resume 过了 —— 停机分类已经清掉。这时候
再跑 `resume --reset-retry`，若沿用「没有停机就报错」，那**警告里给的
那条命令是走不通的**。

> 这条是**实测发现的**：第一次实现把重置挂在「必须有停机分类」的前提上，
> 跑真实 CLI 时立刻撞上「Error: Slice is not stalled」—— 建议给的是一条
> 走不通的命令。测试用例「resume 之后仍能重置预算」就是为这条加的。

顺带：纯重置预算**不动切片状态**。切片可能正在跑（人只是想把预算腾出来），
把它退成 `frozen` 是副作用。

### 3.3 预算在哪里

`stall.autoResolved` 是切片级计数：

- 自动重试时 +1（`handleAgentFailure`）；
- 停机时**不清** —— 它记录的是「这片历史上被自动重试过几次」；
- `resume()` 不清它（本次之前）；
- `startRun()` 不清它。

判定阈值是 `config.agent.maxRetries`（默认 2）。

### 3.4 三处让人看得见

「预算耗尽」这件事必须在**人做决定之前**就说出来，不能等跑挂了才发现：

| 位置 | 说什么 |
|---|---|
| `zelto stall <id>` | `Retry budget: EXHAUSTED (2/2) —— 重跑后第一次失败就会停机` + 给出 `zelto resume <id> --reset-retry` |
| `zelto resume <id>`（不带 `--reset-retry`） | 预算已用尽时给出警告 + 给出 `--reset-retry` 的完整命令 |
| 停机通知（`handleAgentFailure`） | 预算耗尽导致的停机，明确说「不重置预算的话，下次失败会直接停机」 |

第三处最要紧 —— 它出现在**人正要决定要不要重跑**的那一刻。

### 3.5 重置要留痕

`resume --reset-retry` 追加一条 `run.resumed` 事件，`resolution` 为
`retry_budget_reset`，payload 带 `previousAutoResolved`。

用的是**已有的** `run.resumed` 事件类型，没有新增事件类型 ——
契约（`contracts/schemas/event-envelope.json`）不动。

> 为什么留痕：预算是「zelto 花了多少自动重试的钱」的账。悄悄清掉它，
> 追溯链上就看不出「这一片被重置过预算，于是又自动重试了两次」。
> 人做过的决定要留痕（C4）。

### 3.6 不在本次范围内

- **不改自动重试的默认行为**：`resume`（不带 flag）**仍然不清预算**。
  默认语义不变，只有显式要求才重置。
- **不加 `--no-retry` 之类的开关**：`maxRetries: 0` 已经能做这件事，
  不需要第二个旋钮。
- **不做批量重置**：逐片 `--reset-retry` 就够。批量改状态的动作必须是
  显式的，而 ADR-047 §6 里另一项遗留（`zelto stall --reap`）已定为「先不加」。

## 4. 影响面

| 文件 | 变更 |
|---|---|
| `src/core/sched/engine.ts` | `resume()` 增加 `resetRetry` 选项；重置独立于停机状态（§3.2）；纯重置不动切片状态；返回 `{ retryBudgetReset }` |
| `src/cli/commands/info-help.ts` | `zelto resume --reset-retry`；`zelto stall <id>` 显示预算状态 |
| `src/cli/commands/run-support.ts` | 停机通知在预算耗尽时说明后果与恢复命令 |
| `src/cli/commands/catalog.ts` | 命令目录补 `--reset-retry` |
| `tests/ADR-052-retry-budget-reset.test.ts` | 新增（重置语义 + 默认不清 + 留痕 + 独立于停机状态） |

**事件类型没有新增** —— `run.resumed` 已在契约里。**契约不变。**

## 5. 不变式自查

| 约束 | 核对 | 合规 |
|---|---|---|
| **C1** 状态只在文件里 | 预算清零是写切片状态文件；事件追加到 `.zelto/events/`；无内存状态、无 daemon | ✅ |
| **C2** `core/` 零第三方依赖 | 只用 Node 内置；未新增 npm 依赖 | ✅ |
| **C3** 判定必须确定性 | 预算是否耗尽是「读切片文件里的计数 vs 配置阈值」；无模型、无网络 | ✅ |
| **C4** append-only 事件 | `run.resumed` 追加；未改写或删除既有事件 | ✅ |
| **C5** 保护域与锚点外部化 | 未动策略锚点机制 | ✅ |
| **C7** `llm/` 只产草稿 | 全程无模型参与 | ✅ |
| **C9** 写集预约运行时强制 | **判定逻辑一字未改** —— 本次改的是「失败之后怎么恢复」 | ✅ |

禁区检查：未新增自动批准、自动合并、自动改规格、自动改锚点。

## 6. 验证方式

新增 `tests/ADR-052-retry-budget-reset.test.ts`：

- `resume --reset-retry` 把 `stall.autoResolved` 清零；
- **默认 `resume` 不清**（语义不变 —— 这条是回归锁）；
- `resetRetry` 在预算本来就是 0 时不报错、不写多余的重置事件；
- 重置留下 `run.resumed`（`resolution=retry_budget_reset`）事件；
- `--abandon` 不受重置影响（直接作废，预算清零无意义）；
- **resume 之后仍能重置预算**（警告里给的那条命令必须走得通 —— §3.2）；
- **纯重置预算不动切片状态**（不该有副作用）；
- 既没停机又没要求重置时，照实报「not stalled」（不假装做了什么）。

另做了一次真实 CLI 手工验证（`zelto init` 起的临时项目 + 手写切片状态文件）：
`zelto stall <id>` 显示 `EXHAUSTED (2/2)`；`zelto resume <id>` 给出警告与恢复命令；
`zelto resume <id> --reset-retry` 报「已重置（2 → 0）」；事件流里留下
`resolution=retry_budget_reset` 与 `previousAutoResolved: 2`。

## 7. 关联

- ADR-047：agent 失败不该把切片卡在 `running`（§6 遗留项之三，本次拍板）
- ADR-013：agent 提问回路
- ADR-020：拉闸回退
