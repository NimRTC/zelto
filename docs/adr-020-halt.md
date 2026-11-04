# ADR-020: 拉闸 —— 人能主动喊停正在跑的批次

**状态**: 已实现
**日期**: 2026-11-04
**作者**: 系统架构
**关联约束**: C1, C3, C4, C9
**关联文档**: `AGENTS.md`, `docs/zelto-项目目标.md`,
`docs/adr-017-version-level-orchestration.md`, `docs/adr-019-phased-execution.md`

---

## 1. 摘要

zelto 过去只有**被动停机**：agent 自己挂了、被 hook 拦了、或者人按 Ctrl-C。
批次跑偏时，人唯一的手段是杀进程 —— 而杀掉正在写的 agent 会留下半截文件、
半写的 worktree 和没释放的写集预约，恢复全靠手工。

本 ADR 引入**拉闸**：人从另一个终端喊停，正在跑的批次在安全点上收手，
现场（worktree、写集预约、切片状态）原样保留，交回给人。

三条设计线：

1. **通道是文件，不是信号** —— `zelto halt` 写一份暂停请求到 `.zelto/halts/<scope>.json`，
   正在跑的批次在安全点上读到它就收手（C1）。
2. **作用域分两级** —— `all` 停所有批次；批次键（`version-v1`、`batch`）只停自己。
3. **停 ≠ 杀** —— 被拉闸的 agent 走 `adapter.stop()`，不进入门禁、不发签名请求，
   切片的结局标成 `halted`，不计入失败。

---

## 2. 动机

### 2.1 现状

| 事实 | 位置 | 影响 |
|---|---|---|
| 只有被动停机（agent 挂了 / hook 拒了） | `src/cli/commands/core-slice.ts` | 人对「跑偏」无能为力 |
| 人要停批次只能 Ctrl-C | — | 进程一死，半成品 worktree、写集预约、切片状态全留在盘上 |
| zelto 不常驻（AGENTS.md 禁区） | — | 两个进程之间没有信号通道可用 |

### 2.2 为什么不用信号

信号（SIGINT / SIGUSR）看起来更直接，但它与 zelto 的形态冲突：

- zelto **不许常驻**（AGENTS.md 负向清单：「常驻 daemon」）。
  没有一个进程在等着接信号，信号就无从送达。
- 硬杀正在写的 agent 会留下**半截文件**。安全点停手能把现场交回给人，
  这正是「人被交还控制权」这条产品目标的含义。
- 信号无法携带「为什么停」与「停哪个批次」。批次键是执行期才确定的概念
  （`version-v1`、`batch`），文件能承载它。

### 2.3 为什么停完不算失败

被拉闸的 agent 退出码不是 0，也不是 1 —— 它是被**人**叫停的。
把它算成失败会：

- 触发自动重试（`handleAgentFailure`），人喊停的结果是 agent 又被拉起来跑；
- 让批次小结里出现「❌ 失败」，而真相是「⏸️ 人喊停」；
- 让人以为出了技术故障，去查不该查的地方。

所以结局是独立的一种状态：`halted`。它不进门禁、不发签名请求、
不触发重试，`ok` 判定里也不算数 —— 但批次整体不算成功。

---

## 3. 设计

### 3.1 通道：文件

```
zelto halt [--scope <scope>] [--reason <text>]
  └─ 写 .zelto/halts/<scope>.json
       { id, scope, requestedBy, reason, requestedAt }

zelto halt --clear [--scope <scope>]   # 不带 --scope 时解除全部
zelto halt --list                       # 查看
```

存储实现在 `src/core/halt/store.ts`（`core/` 只用 Node 内置、不调模型、不触网）。
作用域里的非法字符被替换，路径不会逃出目录。

`--clear` 不带 `--scope` 时**解除全部**：全局拉闸之后要恢复，
逐个 scope 去解容易漏 —— 漏掉一个，那批次就永远起不来。

### 3.2 作用域语义

| 作用域 | 生效范围 |
|---|---|
| `all` | 所有批次 |
| `batch` | `zelto run --parallel` |
| `version-<label>` | `zelto version start <ver>` |

`isHalted(scope)` 先看 `all`，再看具体 scope —— 全局拉闸优先。

### 3.3 安全点

批次里有三个地方可以安全地收手：

| 安全点 | 位置 | 行为 |
|---|---|---|
| ① 拉起之前 | `executeSlicesParallel` Phase 3 | 不再启动新的 agent，已启动的走安全点 ② |
| ② 等待 agent 时 | `waitForExitOrHalt` | `adapter.stop()` 停掉这个 agent，现场保留 |
| ③ 阶段之间 | `executeSlicesByPhase` | 后续阶段不再启动 |

安全点 ② 是关键 —— **「边等边听」**。批次跑起来之后，人往往是在看到某个
agent 跑偏了才想喊停。等到 agent 自己结束再停，就没有「拉闸」可言了。
实现是 `waitForExit()` 与一个 1 秒轮询的 watcher 并行：
watcher 看到暂停请求就调 `adapter.stop()`；agent 先退出则 watcher 收摊。

### 3.4 事件

新增事件类型 `batch.halted`（事件类型是契约，改它要写 ADR —— 就是本篇）。
在 `core/events/stream.ts`、`contracts/schemas/event-envelope.json`
与 `core/audit/trail.ts` 的摘要表里同步登记。

| 时机 | 归属键 | payload |
|---|---|---|
| 人喊停 | `batch` | `scope`、`reason`、`haltId`、`requestedAt` |
| 批次在安全点 ① 读到请求 | `batch` / `version-<label>` | `scope`、`reason`、`stage: 'before_start'`、`slices` |
| 某个 agent 被停掉 | 切片 id | `scope`、`reason`、`sliceId` |
| 阶段之间读到请求 | `batch` / `version-<label>` | `scope`、`reason`、`stage: 'between_phases'`、`phase`、`slices` |
| 切片被回退并标记停机 | 切片 id | `class: 'human_halt'`、`reason`、`scope`、`from`、`to`、`halted: true` |

最后一行复用已有的 `stall.classified` 事件（不新增事件类型）——
回退的实质就是「这个切片停机了，分类是人工拉闸」。

### 3.5 结局与判定

`SliceOutcomeStatus` 新增 `halted`。被拉闸的切片：

- 不进写集审计、不进门禁②、不发签名请求；
- **回退到 `frozen`**（`RUN_FINISH`），并标记 `stall.class = 'human_halt'` ——
  不回退的话切片会永远卡在 `running`，而准入只认 `frozen` / `completed`，
  「处理完继续」这条路直接断了；
- worktree 保留 —— 现场交回给人；
- **写集预约也保留** —— 释放预约会让仍在跑（或没死透）的 agent 失去写集约束（C9）。
  人处理完用 `zelto reservation release <id>` 释放。

`human_halt` 是第 9 类停机（`src/core/stall/classifier.ts`），且**不可自动恢复**：
人喊停要的就是「停下来等人」，agent 自己把它重试起来就违背了拉闸的意图。
人处理完走 `zelto resume <id>`（清掉停机分类）→ `zelto run <id>`。

> **实现说明（2026-11-04 修订）**：本 ADR 初稿写的是「切片状态保持 `running`，
> 不自动回退」。实现时改成了回退到 `frozen` + 标记 `human_halt` ——
> 理由如上：`running` 态的切片准入不通过，等于被人拉闸之后这个切片就废了，
> 而拉闸的语义是「处理完继续」。回退实现见 `src/core/halt/rollback.ts`。

`ParallelExecutionResult` 新增 `halted` 计数与 `haltScope`（解除时要用它）。
批次的 `ok` 判定里 `halted !== 0` 即为不成功（批次整体不算过），
但它与 `failed` 分开计数，小结里也分开显示。

### 3.6 `zelto halt` 的现场回看

喊停之后立刻打印现场：哪些切片在 `running`、各自的 worktree 在哪、
写集预约在谁手上，并留一份快照（`captureSnapshot`）供事后回看。

### 3.7 `zelto halt --rollback` —— 批次死掉后的强制回退

拉闸只能救「还活着的批次」。还有一种情况没人管：**批次进程崩了 / 被 Ctrl-C 杀了** ——
切片永远卡在 `running`，准入只认 `frozen`，它再也跑不了，只能手工 `abandon`。

```
zelto halt --rollback [--scope <scope>] [--reason <text>]
```

判定标准是确定性的（C3）：切片状态是 `running`，**且**它没有生效中的写集预约，
或者持有预约的进程已经死了。反过来 —— 批次还活着的时候预约由活着的进程持有，
不算卡住，也不能回退：那会跟正在跑的批次抢切片。

`--rollback` **不写暂停请求**：这些切片对应的批次已经死了，再喊停没有意义，
反而会把后续的批次也挡住。

---

## 4. 约束合规性

| 约束 | 怎么满足 |
|---|---|
| C1 状态只在文件里 | 暂停请求是 `.zelto/halts/<scope>.json`，不引入数据库、不放内存 |
| C2 `core/` 零 SDK 依赖 | `core/halt/store.ts` 只用 `node:fs` / `node:path` |
| C3 判定确定性 | 停不停只由「读文件 + 比对作用域」决定，没有模型参与 |
| C4 append-only 事件 | 喊停、解除、每个安全点命中都写 `batch.halted` |
| C9 写集预约运行时强制 | 拉闸不碰守卫逻辑；被停的切片保留预约，人处理完再释放 |

---

## 5. 后果

**好的**

- 人能主动喊停，且不用杀进程、不丢现场。
- 拉闸请求可事后回看（事件 + 快照 + `zelto halt --list`）。
- 全局拉闸（`all`）给「整个项目都得停」留了通道。

**代价与边界**

- 停止不是瞬时的：安全点 ② 的轮询间隔是 1 秒，agent 最多多跑 1 秒。
- 拉闸不撤销已跑的 agent —— 已经完成的切片照常进门禁；被停的切片只是停在原地。
- 被拉闸的切片回退到 `frozen` 并标记 `stall.class = 'human_halt'`。
  它仍然不自动跑 —— `human_halt` 是不可自动恢复的停机类，
  必须由人显式 `zelto resume` 才清掉分类。人被交还控制权，
  但**人决定什么时候交还给 agent**。
- 被拉闸的切片保留写集预约 —— 别的批次想碰同一批文件会被挡住。
  这是有意的（C9），代价是人处理完要记得 `zelto reservation release <id>`。
- 批次本身不退出：拉闸之后批次仍会走完收尾流程（打印小结、留事件），
  然后以非零退出码结束。人重跑批次即可继续。

**明确没做**

- 不做常驻 daemon 监听暂停请求（AGENTS.md 禁区）。
- 不做「一键回滚」—— 拉闸只停，不删 worktree、不改分支。
  `zelto halt --rollback` 只把卡在 `running` 的切片状态回退成 `frozen`，
  同样不删 worktree、不改分支、不撤代码改动。
- 不做自动合并，签字与合并仍然分开（ADR-018 不变）。

---

## 6. 实现位置

| 内容 | 位置 |
|---|---|
| 暂停请求存储 | `src/core/halt/store.ts` |
| 拉闸后的回退 | `src/core/halt/rollback.ts` |
| 卡死切片的判定 | 同上，`findStuckRunningSlices` |
| `zelto halt` 命令 | `src/cli/commands/halt.ts` |
| 边等边听的等待器 | `src/cli/commands/parallel-executor.ts` 的 `waitForExitOrHalt` |
| 安全点 ① / ② | 同上，`executeSlicesParallel` |
| 安全点 ③ | 同上，`executeSlicesByPhase` |
| 事件类型登记 | `src/core/events/stream.ts`、`contracts/schemas/event-envelope.json`、`src/core/audit/trail.ts` |
| 判定测试 | `tests/core/halt/store.test.ts`、`tests/core/halt/rollback.test.ts`、`tests/halt-wait.test.ts` |
