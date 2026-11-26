# ADR-130 hook 判定事件必须能归属到「哪一轮跑」

- 状态：已采纳（实现随同落地）
- 日期：2026-11-27
- 关联：ADR-129（`runId` 贯穿）、ADR-083（hook 归一化与真实来源）、ADR-092（`runs[*].phase`）、ADR-100（事件哈希链）；缺陷：ZD-051「剩余问题」

## 背景

ADR-129 给每次运行一个确定性身份 `runId = <sliceId>#<ISO 秒>[/r<attempt>]`，
`run.started` / `run.finished` / `run.aborted` 与任务文件都带上了它。事后按 `runId` 聚合，
**运行层的起跑与结束两端终于能精确配对**。

但写集守卫的判定事件（hook 进程写的 `policy.decision`）**没有带 `runId`**：

- hook 进程的 `EVENT` 信封里 `run` 字段恒为 `null`；
- payload 只有 `sliceId` / `tool` / `harness` / `policyVersion` 等。

后果就是 ZD-051 的「剩余问题」：同一天五轮里有两轮**时间重叠**（ZD-050 的场景），
`policy.decision` 只能靠 `sliceId` + 时间戳归到某一轮 —— 时间交错时**归属只能近似**。
而这恰恰是 C9 最需要精确的时刻：**要回答「那一轮跑里，守卫到底判过什么」**，
却只能回答「那一片今天判过什么」。

特别是 ZD-050 里那次「钩子指向已经死掉的那一轮进程」：事后想证明「后来的 agent
的写入没有经过任何判定」，需要的是「本轮 runId 下一条 `policy.decision` 都没有」——
没有 `runId` 就说不清「一条都没有」是本轮没有，还是根本没归进来。

## 决策

### 一、hook 判定事件带上本轮的 `runId`

- `policy.decision` 的信封 `run` 字段填本轮的 `runId`（原来恒为 `null`）；
  payload 同时带 `runId`（与 ADR-129 各事件同口径，便于不解包信封的消费者直接用）。
- `runId` 由 **运行进程**（前台 / 主管）在拉起 agent 时通过环境变量传给 hook 进程 ——
  与 `ZELTO_SLICE_ID` 同一机制；hook 进程**不自己判定**「当前是哪一轮」，
  它只按优先级取一个**带来源标记**的引用：命令行 `--run-id` > 环境变量
  `ZELTO_RUN_ID` > 任务文件 `task.runId`（仅 `status=running` 时，且标 `derived:` 前缀）。
  前两者是真 runId；`derived:` 是「推导值」，消费方一眼能看出它不是本轮显式声明的身份
  （ADR-129 禁止的是**冒充**，不是标注来源）。
- 续跑（`resume` / `continueSession`，含问答回路 `zelto answer`）仍属**同一轮**：
  适配器的会话文件记下这一轮的 `runId`，续跑从那里读回再注入。`zelto answer`
  只在任务文件那轮「起跑过、已有 `run.started`、之后停在 `agent_question`、
  且没有 `run.finished`/`run.aborted`」时才沿用它，否则不注入。

### 二、取不到 `runId` 时如实留空，不猜

- 环境变量与命令行都没有 `runId` → 信封 `run` 仍为 `null`，payload 省略 `runId`。
  这是**旧数据与无运行上下文调用**的合法形态；消费方（`zelto audit` / 驾驶舱）
  必须把它显示为「无法归属到轮次」，不许按时间「补」一个。
- 原因：`runId` 的价值在于**确定性引用**。凭空推断出来的 id 比 `null` 更坏 ——
  它会让「查不到本轮判定」变成「查到了错误的判定」。

### 三、判定语义零变化（C3 / C5 / C9）

- `runId` 只是**留痕维度**：不参与 allow / deny 的任何计算，
  写盘失败也不影响判定结果（与现有 `appendDecisionEvent` 同口径）。
- 保护域、写集判定、fail-closed 行为一律不变。

## 影响

- 契约：`policy.decision` 的 payload 新增可选 `runId`；信封 `run` 字段从恒 `null`
  变为「有运行上下文时填 runId」（字段本身 ADR-041 早已定义，**无 schema 变更**）。
- 运行进程：拉起 agent 时导出 `ZELTO_RUN_ID=<runId>`（与 `ZELTO_SLICE_ID` 并列）；
  前台 / `zelto start` / 并行执行 / detach 主管四条路径都要传，且**同一个 runId**
  与 `run.started` 里的一致（同一个变量派生，不各算一份；`start()` 的 `runId`
  与 `run.started` 已在同一处算一次）。
- 适配器：`start` / `resume` / `continueSession` 接受 `runId`（`core/ports/executor.ts`
  的可选参数），并写入会话文件 `PersistentSessionData.runId`，续跑时读回。
- 任务文件：`TaskInfo` 增加 `writtenAt`（每次 `saveTask` 落下盘时刻）。
- hook：`parseArgs` 增 `runId`；`appendDecisionEvent` 填信封 `run` 与 payload；
  无真 runId 时用任务文件的 `derived:<task.runId>`，都没有则为 `null`。
- `core/` 不动：hook 本就独立编译，`runId` 的读写都在 CLI 侧完成。

## 不做什么

- 不在 hook 进程里推断 `runId`（不读任务文件、不看会话文件）。
- 不给 `policy.decision` 换成新的事件类型（会破坏 `rework_rate` 等按类型计数的度量，ADR-086 §6 的教训）。
- 不把 `runId` 加进保护域判定或策略里（C5 不变）。
