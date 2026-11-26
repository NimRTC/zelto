# ADR-129 「这一轮是谁、怎么结束的」必须可判定：runId 贯穿、收尾先落事实后释放、主管运行期可观测

- 状态：已采纳（实现随同落地）
- 日期：2026-11-26
- 关联：ADR-041（运行记录）、ADR-047（停机唯一落点）、ADR-053（运行期预算闸门）、ADR-074（活进程看门狗）、ADR-092（`runs[*].phase`）、ADR-121（版本上下文凭 git 事实）、ADR-123（看门狗放弃 ≠ 在跑）、ADR-124（孤立记录可见可收）、ADR-125（主管收尾后不许卡住）；缺陷：ZD-049 / ZD-050 / ZD-051

## 背景

nimrtc-v14 的 `v1-rtcp-processor-collaborator` 一天里被拉起五次，事件流里只有两轮有「结束」（ZD-051）。
逐个追溯，是三个**互相放大**的缺口：

1. **没有「第几轮」这个维度**（ZD-051）。`run.started` / `run.finished` / `run.aborted` 之间
   只能靠时间戳配对；会话文件的数字是「启动时刻」，retry 会话靠 `-retry-1` 后缀区分 ——
   「取当前那轮」的逻辑（看门狗、`status`）用的是「最新文件」，而 retry 文件可能比主会话**先落**，
   于是「最新」指向的已经是**死掉的那一轮**。缺一端就是「没有结论」，而门禁 / 驾驶舱把
   「缺一端」当成了「还在跑」或「没跑完」。
2. **收尾不是原子的**（ZD-050）。`run.finished` 落在收尾**最后**、预约释放之前；主管 / CLI
   在收尾中途消失时，「这一轮结束了」这个事实本身丢了 —— 之后的人只看到 `run.started`，
   好像这一轮**还在跑**。事后回顾：真正的写集守卫是在**人都以为没人管**的时候失效的。
3. **detach 主管没有运行期可见性**（ZD-049）。前台的 `zelto run` 有活进程看门狗（ADR-074），
   主管没有。它半路退出时，写集审计 / 收尾 / 任务状态 / 预约释放**一个都没跑**，
   而没有任何地方能看见这件事；`run.aborted` 里的 pid 取自会话文件（agent 的 pid），
   不是主管的 pid；`run.aborted` 与 `task` 的 pid 也不在同一条引用链上。

## 决策

### 一、`runId` 作为每轮运行的唯一身份（ZD-051）

`runId` 的格式是确定性的、可离线算出的（C3）：

```
runId = `<sliceId>#<startedAt 的 ISO 秒>`  + （attempt>0 时）`/r<attempt>`
例：v1-rtcp-processor-collaborator#2026-11-26T09:30:12Z
    v1-rtcp-processor-collaborator#2026-11-26T09:30:12Z/r1
```

- **起跑方**（前台 `zelto run` / `zelto start` / `parallel-executor` / detach 主管）在
  **开跑前**算好 `runId`，写进 `run.started` 的 `runId` 字段，并写进任务文件的
  `runId`（`task.runId` = **当前这一轮**的 runId）。
- **收尾方**（`finishRun`、看门狗、主管异常路径）只接受**显式传入**的 runId，写进
  `run.finished` / `run.aborted` 的 `runId`。
- **禁止**用「最新会话文件」推断「当前轮」。读「当前轮是谁」一律读 `task.runId`；
  会话文件只用来取「这一轮的产物与退出码」。

兼容：`runId` 是**新增字段**。没有 `runId` 的旧事件仍是合法历史（不补写）；
按 runId 聚合时，缺 `runId` 的起跑端归入 `<sliceId>#legacy-<序号>`，并在
`zelto audit` / 驾驶舱里显式标为「无法配对」—— 不假装配对成功。

### 二、收尾「先落事实、后释放」（ZD-050）

任何收尾路径（前台、主管、看门狗接管）的**落盘顺序**固定为：

```
1. run.finished   （或 run.aborted）        ← 「这一轮结束了」这个事实
2. 任务文件 status: completed|failed + completedAt + exitCode
3. reservation.released（以及撤钩子）
```

`run.finished` 必须**先于** `reservation.released` 落盘。判据是**事件流里有无本轮收尾**，
不是「会话文件状态」：下一次准入时，若 `task.runId` 指的那一轮在事件流里
**既无 `run.finished` 也无 `run.aborted`**，且 `task.supervisorPid` / 会话 pid 都不在，
则按「结果不明」处理 —— 拒绝静默起跑，提示 `zelto resume`（复用 ADR-124 的「孤立记录」判定，
不新造一套）。

### 三、detach 主管的运行期可见性（ZD-049）

1. **心跳文件**：主管每 `SUPERVISOR_HEARTBEAT_MS`（30s）写一次
   `.zelto/supervisor/<taskId>.heartbeat`（内容：`{ pid, pidStart, runId, agentPid, at }`，整份覆盖 ——
   它是一个**状态快照**，不是账本；账本是事件流）。
2. **收尾时写结论**：主管在正常收尾与异常路径上都写本轮的 `run.finished` / `run.aborted`
   （带 `runId` 与 `supervisorPid` / `agentPid`）。主管**自身**异常退出（异常抛出、看门狗接管）
   的结论在事件里用 `phase: 'supervisor'`（`run.aborted`）表达 —— 这是 ADR-092
   `runs[*].phase` 的唯一新取值；正常 agent 结束仍按 ADR-092 的 `foreground` / `supervisor` 记账。
3. **接管收尾由看门狗做**：已有单步处置 `maybeRecoverDeadTask` 的 `dead` 判据扩一条
   —— 「`task.status === 'running'` 且 `task.runId` 的那一轮没有收尾事件 且
   `supervisorPid` 不在」→ 先写 `run.aborted`（`actor: 'watchdog'`，带 `runId`、`supervisorPid`、
   `phase: 'supervisor'`），再按原有路径退回 `frozen` / 上报。这样「主管半路死了」**一定**
   在事件流里留下一条「它已经不管了」，而不是三处状态同时说谎。
4. **pid 拆开**：`run.aborted` / `run.finished` 里同时可带 `supervisorPid` 与 `agentPid`；
   会话文件的 `pid` **不再**被写成「主管 pid」的位置。日志里两行都打：
   `supervisor pid=…` / `agent pid=…`。

## 影响

- 事件 payload：`run.started` / `run.finished` / `run.aborted` 新增 `runId`（可选字段，向后兼容）；
  `run.aborted` 新增 `supervisorPid` / `agentPid`（可选）。
- 任务文件：新增 `runId`（可选）。
- 新增文件：`.zelto/supervisor/<taskId>.heartbeat`（状态快照，可丢；丢了只是少一份现场）。
- 看门狗 `maybeRecoverDeadTask` 的 `dead` 判据扩一条；**不改变**原有「进程都没了」的路径。
- 不改状态机（`running --RUN_FINISH--> frozen` 仍是唯一退路）；权限与 policy 判定（C5）不变；
  `core/` 不新增依赖、不触网（心跳与事件由 CLI / 主管进程写，`core/` 只做判定）。

## 不做什么

- 不把 `runId` 做成随机 UUID：它要能被离线重算（C3、便于按 runId 在日志/事件里 grep）。
- 不改「提交的 pid 语义」之外的任何会话文件格式；不改 ADR-041 的运行记录结构
  （`runs[*].phase` 仍是 `foreground|supervisor|watchdog`，新增的结论语义放在事件里）。
- 不自动合并、不自动签字（ADR-018）；接管收尾只做「如实记录 + 退回可重跑」。
