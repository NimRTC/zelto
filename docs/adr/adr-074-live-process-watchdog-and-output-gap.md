# ADR-074：活进程看门狗 —— 停机判定不再只看「跑完一个循环」；进度行区分「在跑但没输出」与「空壳」

**状态**: 已实施
**日期**: 2026-11-17
**作者**: 系统架构
**关联约束**: C1, C3, C4
**关联文档**: `src/core/sched/watchdog-policy.ts`, `src/core/activity/liveness.ts`,
`src/cli/commands/core-slice.ts`, `src/cli/commands/run-support.ts`,
`src/cli/commands/info-help.ts`, `src/adapters/web/api.ts`,
`src/adapters/claude-agent/index.ts`
**关联 ADR**: ADR-047（agent 失败必须退回 frozen）、ADR-052（自动重试预算）、
ADR-055（整棵进程树判活）、ADR-072（驾驶舱只读）

---

## 1. 摘要

第七轮演练（nimrtc-zelto，2026-11-17）暴露一条**会让切片永远卡在 running** 的死角：

1. **停机判定只在「agent 退出之后」执行**。可 CLI 进程本身会先死
   （实测于 nimrtc：四次 run 的外层 `cmd.exe` 全部退出，agent 却还跑了一段），
   `waitForExit` 的 Promise 没人等、`handleAgentFailure` 没人跑 ——
   切片停在 `running`、写集预约锁不释放，准入永远挡。
   唯一的出路是 `zelto stall --reap`，而它写在「假死 19 小时之后才想起去查」的时刻。

2. **进度行把「agent 活着但没产出」说成 `null`**。`--output-format json`
   让 Claude Code 只在结束时吐一次 stdout；运行中 `progressLine` 恒为空，
   驾驶舱上的「进度」看起来和「空壳」一模一样 —— 人于是以为它死了。

**决策**：

- **A**：新增 `core/sched/watchdog-policy.ts`（纯函数，C3）：输入「切片当前态 +
  最新运行记录 + run.started 时刻 + 恢复计数」，输出处置
  `none / reap / escalate`。运行记录按**世代**挑选（见 §2.3），
  已被停机理由收走的老记录不得再被当作现场。
- **B**：前台运行等待期间（`core-slice.ts` 两处 `waitForExit` 循环），
  每 5 秒用同一判据查一次：最新运行记录「进程已死 / 状态非 running」
  → { @code reapStaleRun() }（走 `handleAgentFailure` 同一条停机落点：
  退 frozen + 写分类 + 留痕）。
- **C**：`zelto status` / `zelto stall` / Web `/api/slices` 共用同一条判据：
  running 但进程已死 → 报告「活进程看门狗会收走」；看门狗次数用尽 → 「需人处理」。
  `zelto stall --reap` 照旧可显式收走（人手动作，不依赖阈值）。
- **D**：`SliceSummary` 增加 `elapsedIdleMs`（最新输出距今多久），
  前端进度行显示「已运行 12m34s · 3 分钟无输出」，不再对「在跑但没输出」
  显示空白。
- **E**：Claude Code 的启动噪声（`[claude-code:unrecognized_model] …` 等
  以 `[claude-code:` 开头的 stderr 行）只在**运行失败**时写回会话输出与界面；
  运行成功时丢弃 —— 它不改变运行事实，留在「最后一条输出」里只会骗人。

---

## 2. 背景与证据

### 2.1 实测：切片卡在 running，进程早已不在

`nimrtc-zelto`，2026-11-17：

```text
05:16:39 run.started           v2-input-binder
05:18:32 slice.state.changed   running → frozen（--reap，人工发现）
05:19:52 run.started           v2-input-binder
05:40:14 slice.state.changed   running → frozen（--reap）
06:01:50 run.started           v2-input-binder
（直到 15:19 仍停在 running，会话文件 pid=48092，该 pid 早已不存在）
```

同一天 `v2-ai-decision` 同样卡在 running。两份切片文件 `runs` 都是空数组 ——
`recordRun` 在 `waitForExit` 之后，而那一行从没被执行到。

另一次 run（06:01:50）的会话文件至今写着 `status: running, pid: 48092`，
而该 pid 已不存在；两次 run 记录的包装 pid 分别是 40528 / 40460，**严格不同** ——
不是「只有一个 CLI 进程卡住」，而是**每一次**运行都以「监视者不在了、
记录停在 running」收场。根因因此不能归给某一次偶发崩溃，
只能是监视路径本身没有把所有退出路径兑现完。

### 2.2 为什么 `stall --reap` 不够

它需要人**先意识到**要去收。而一片卡住的切片：准入拒绝重跑、合并拒绝无签字、
resume 说它没停机 —— 人拿到的是一个消失的命令，不是一条能执行的建议。
判定越早发生，代价越小：进程死了的那一刻就该退 frozen。

### 2.3 为什么按「世代」挑运行记录

一个切片被收走一次（`reap` → 退 frozen），它的会话文件**还留在盘上**，
status 仍是 `running`（进程死时没人写 `failed`）。下一个 `run.started`
在没有会话文件时会怎么办？如果判据只看「最新运行记录」，会把**上一代的尸体**
当成本轮现场 —— 刚起跑就判死，秒收。

所以判据输入必须包含「本轮 run.started 的时刻」：会话文件的 `startedAt`
早于那个时刻 → 不是本轮的，跳过（`none`，理由写明「还没发现本轮记录」）；
一个会话文件都没有 → 本轮 agent 可能还在 npx 解析阶段，给一个 2 分钟宽限。

同样的年龄过滤也用在 `readSliceLivenessRecord`（它服务的是「有没有活 agent 在跑」
这个不同的问题——重跑守卫、驾驶舱展示——但同样不得把上一代的尸体当现场）。

---

## 3. 契约变化

### 3.1 事件

无新事件类型。看门狗收走运行复用停机的唯一落点
（`run.aborted` + `stall.classified` + `slice.state.changed`），
`run.aborted` 的 payload 增补可选字段：

```json
{ "sliceId": "...", "exitCode": null, "reason": "live-process watchdog: ...", "watchdog": true }
```

### 3.2 API（只读驾驶舱）

- `GET /api/slices`：每片新增 `elapsedIdleMs: number | null`
  （最新输出距今毫秒；没有输出时为从起跑算起的毫秒）。
- 既有字段语义不变。

### 3.3 会话文件

`PersistentSessionData` 字段不变。适配器在运行**成功**时不再把
`[claude-code:` 前缀的 stderr 行追加进 `output`；失败时照旧保留。

---

## 4. 不做的事

- 不常驻 daemon：看门狗只在有 zelto 进程在等的时候跑（前台运行、status、
  stall、Web 轮询读取），与 C1 一致。
- 不自动 merge / 不自动 sign：收走运行只是退回 frozen，控制权交还给人。
- 不重试：看门狗收走 = 停机，重跑由人决定（与 ADR-047 一致）。

## 5. 验证

- 单元：`tests/watchdog-live-process.test.ts`（判据代数：无记录 / 宽限 /
  本轮记录死 / 上一代尸体 / 次数用尽上报 / 运行被收走后不再报警）。
- 集成：`tests/activity-liveness-watchdog.test.ts` 增补世代过滤用例。
- 端到端（人工）：`nimrtc-zelto` 两片僵尸 running 在 `zelto status` 中
  被标为「进程已死」，`zelto stall --reap` 一轮收走。
