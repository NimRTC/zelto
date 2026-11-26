# ADR-124 监督进程无收尾死亡之后，孤立的会话/任务记录必须能被看见、被收掉

- 状态：实施（修法一、修法二、修法三均已落地）
- 日期：2026-11-26
- 关联：ADR-047（停机分类与退回 frozen）、ADR-055（续跑）、ADR-074（看门狗与续跑）、ADR-112（驾驶舱按根扫描）、ADR-123（看门狗放弃不算在跑）、D-49、D-64、D-65

## 背景

实测 nimrtc-v14 `v4-d5-audio-dtx`（2026-11-26）：

1. 14:57 `zelto run <id> --detach` → 监督进程 pid 53052 起来了，14:58:28 起了 agent。
2. **约 86 秒后监督进程无声消失**：日志止于「agent 已启动」，没有 `agent 已退出`，
   没有 `监督进程异常`，没有收尾 —— `waitForAgentExit → finishRun` 整段没走到。
   agent 也随之消失。事后无收尾动作，写集预约停在 `acquired`。
3. 同一晚 `v4-d4-camera-hotplug` 的监督进程在收尾阶段打出
   `监督进程异常：ENOSPC: no space left on device, write` 后退出，同样没走完收尾。
   两片相邻两分钟发生，指向环境级故障（磁盘/内存耗尽），而非 agent 侧错误。
4. 现场落在盘上的样子：
   - 切片 `state: running`、`runs: []`、`stall.class: null`；
   - 任务文件 `status: running`，有 `lastActivityAt`、有 `supervisorPid`，**没有 `pid`/`agentPid`**；
   - 会话文件被适配器覆盖写，成了 **0 字节**；
   - 事件流止于 `run.started`，没有 `run.finished` / `run.aborted` / `stall.classified`。
5. 驾驶舱显示：「stale，2 小时 8 分没动静（阈值 3 分，且没有 pid 可查）」。

**三份数据各自都对，拼起来是错的**：

- 驾驶舱读**任务文件** → 有 running 记录、没过阈值判活 → `stale`（ADR-123 把它单列成「需人收」—— 这一步是对的）；
- `zelto stall --reap` 的空壳判据读**会话文件优先**（`readSliceLivenessRecord` 会话目录在前），
  读到 0 字节 → `null` → 退到任务文件 → 看到 running 记录 → 判 `active` → **看不见这片**；
- 于是人手里能用的一条路都没有：
  - `stall --reap` 说「没有死切片」；
  - `resume` 说「is not stalled」（没有停机分类，正确地拒绝）；
  - `run` 被重复 agent 守卫拦住 —— 它拿到的记录是 `status: running` 但**没有 pid**，
    按既有语义「没有心跳记录也没有 pid 可查（老会话文件）」判 `stale`；
  - 唯一出路是 `abandon` —— 整个切片作废、规格重写。

实测收尾路径（本次人工执行）：
`halt --scope <id>`（写拉闸请求）→ `halt --scope <id> --rollback`（running → frozen，标 `human_halt`）
→ `reservation release` → `halt --clear` → `resume` → `run`，到第 4 步才走通。
前 3 步都只能靠人**知道要这么做**；第 4 步之前 `reap` 仍然说自己没看见这片。

## 决策

### 一、空壳判据：以「本轮是否还有人管」为准，**任何来源**的 running 记录都算「有人管」

现状（`core/stall/reap.ts` `classifyOrphanShell`）的口径是：

- 会话目录和任务目录**分开**取「最新 running 记录」（`readSliceLivenessRecord` 会话优先）；
- 只看那一条的活性，**另一目录里同时存在的 running 记录完全不影响判定**。

这正是 d5 的坑：会话文件空（判不了）→ 退到任务文件 → 看到 running 记录 → 判活。
但任务文件里那条记录的 `lastActivityAt` 已经 2 小时没动、`supervisorPid` 已经死了，
它的「running」只是**没人收尾**，不是「有人在管」。

新判据（四步，全部只读文件、纯计算 —— C3）：

1. 汇总**两个目录**里该切片的全部运行记录（`readSliceLivenessRecords` —— 已有）；
2. 只看 `status` 为 `running` 或未标注的记录（其余都是已收尾的，不参与判活）；
3. 对每条 running 记录判活性（`classifyLiveness`）。**只要有一条 `active`，就不是空壳**；
4. 所有 running 记录都是 `stale` / `dead`（或一条 running 记录都没有）→ **是空壳**，
   `reason` 里要写清是哪几条记录、各自多久没动静、有没有 pid。

安全边界：宁可漏（判成空壳）也不可误（判成活着的 agent 被清掉）——
判据第 3 步保证了「任何一条记录看起来还活着」都会让整片不被判空壳。
stale 被算进空壳的依据与 ADR-123 / 既有注释一致：**几个钟头没有任何心跳、没有 pid，
它还能是什么** —— 何况这里还叠加了「另一条记录的空壳判定」。

### 二、重复 agent 守卫：**stale 且无 pid** 不得升级成「拒绝起跑、退回 frozen」

现状（`cli/commands/core-slice.ts` 重复 agent 守卫）：`active` 和 `stale` 一视同仁地拒绝。
但 `stale` 的语义是「可疑」，不是「确定活着」（`core/activity/liveness.ts` 的注释如此说）。
d5 里这条守卫把一个**已经死了**的切片反复弹回去，还每次都写一条 `run.aborted`，
把「人想重跑」和「agent 已死」混成同一种痕迹。

新判据：

- `active` → 拒绝（原样保留）；
- `stale` 且记录里**有** pid → 拒绝（可能只是长时间构建，不下死手）；
- `stale` 且记录里**没有**任何 pid → **放行**，但把这件事写进事件流
  （`run.started` 的 payload 带 `staleNoPid: true` 与那条记录的时间），
  并在起跑前**把那条没有任何 pid 的残留记录收尾**（`status: failed`，
  与 `stall --reap` 的 `closeOrphanTasks` 同一口径、同一理由文案），避免下一轮守卫再撞上它。

### 三、收尾路径必须能一步走完

给 `zelto stall --reap <id>` 补一条「单片」用法：

- 它只处理指定切片，语义与批量 reap 完全一致（退回 frozen、留 `run.aborted` 证据、
  收尾名下的 running 任务文件），**不写停机分类**（与 ADR-047 §6 一致：停机分类只留给
  `markSliceStalled` / 拉闸回滚这种「agent 跑了没成」的路径）；
- 对「被判成空壳」的切片，`reason` 里带上 `liveness` 的判据原文，人不用再翻一遍盘。

这样「环境抖一下把监督进程带走了」的恢复流程收敛为：
`stall --reap <id>` → `reservation release <id>`（防空预约）→ `run <id>`。

## 影响

- `core/stall/reap.ts` 的 `classifyOrphanShell` 口径变化：**两个目录合并判定**。
  数据形状不变（仍是 `OrphanShell[]`），驾驶舱与 CLI 的读法不变。
- `cli/commands/core-slice.ts` 的重复 agent 守卫：多一个放行分支（stale + 无 pid），
  多一条收尾动作（置残留任务记录为 failed）。
- 新事件字段：`run.started` 可带 `staleNoPid`；无新事件类型，不改 schema。
- **不做的事**（防止顺手越界）：
  - 不给 `reap` 写停机分类；
  - 不自动 reaper / 不常驻巡检（那是 daemon，在负向清单里）；
  - 不把「stale 无 pid」直接判成 dead —— 判据仍是「没人管」，不是「死了」。

## 落地实况（2026-11-26）

| 修法 | 落点 | 状态 |
|---|---|---|
| 一：空壳判据两目录合并 | `core/stall/reap.ts` `classifyOrphanShell` | ✅ |
| 二：守卫 stale 无 pid 放行 | `cli/commands/orphan-records.ts` `judgeDuplicateAgent` | ✅ |
| 三：`stall --reap <id>` 单片 | `cli/commands/info-help.ts` | ✅ |

### 修法二的实现要点

判据抽成**唯一一份** `judgeDuplicateAgent`（`cli/commands/orphan-records.ts`），
`zelto run` 与 `zelto start` 两条路径**都调它** —— 两道门不许分叉
（`zelto start` 原先**根本没有**这道守卫，直接起第二个 agent）。

放行分支的三步：

1. 汇总**两个目录**里该切片全部 running 记录（会话 + 任务）；
2. 逐条判活 —— `active` 或（`stale` 且**有** pid）→ 拒绝；否则继续；
3. 放行时把「`stale` 且**无** pid」的那条记录收尾成 `failed`
   （**只改状态字段，不删文件** —— 现场本身是证据，C4）。

「有 pid / 无 pid」的分界：

- **有 pid** = 有具体进程可以问进程表 → 判活**确定** → 不下死手（拒绝）；
- **无 pid** = 没有任何东西能证明它还活着，只能靠时间推断 → 放行。

`run.started` 的 payload 带 `staleNoPid: true` + 那条记录的文件名与最后活动时间，
事后审计能看出「这一轮为什么被放行」。

### 修法三的实现要点

`zelto stall --reap <id>` 只处理指定切片，语义与批量完全一致
（同一份判据、同样退回 frozen、同样留 `run.aborted` 证据、
同样收尾名下 running 记录）。

收尾范围从「只收任务目录」扩到「**两个目录都收**」——
守卫读的是两个目录的全部记录，只收一个的话，另一目录里的残留会挡住下一轮起跑。

### 回归测试

- `tests/adr-124-duplicate-agent-guard.test.ts`（14 条断言 —— 修法二的判据与收尾）
- `tests/adr-053-dead-slice-reap.test.ts`（修法一：两目录合并判定）
- `tests/d065-stuck-running-shell.test.ts`（空壳判据口径变化）
