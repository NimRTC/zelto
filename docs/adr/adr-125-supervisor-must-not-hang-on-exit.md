# ADR-125 监督进程收尾之后不许「卡在退出」：正常返回必须自己退，挂住要有 watchdog

- 状态：已采纳（2026-11-26 实现；根因定位见下文「决策」前的复现记录）
- 日期：2026-11-26
- 关联：ADR-124（无收尾死亡的收尾路径）、D-50（监督进程搬家）、D-55（空转超时）、ADR-055（续跑）、D-59（结果不明≠失败）

## 背景

实测 nimrtc-v14 `v4-d5-audio-dtx`（2026-11-26 17:26 起跑的那一轮）：

1. 监督进程 pid 43956 起来了，agent 17:26:47 起跑。
2. 17:45 起跑 18 分钟后，`claude.exe` 进程消失，监督日志紧接着打出：
   ```
   [17:45:09] agent 已退出，退出码 0（会话状态 completed）
   [17:45:15] ✅ Agent completed successfully (1105s)
   ```
3. 同一时刻切片被写回 `frozen`，`runs` 追加 `{ ok: true, phase: 'supervisor' }`，
   写集预约释放，签字请求正常发出 —— **收尾本身是对的**。
4. **但监督进程 43956 一直没退出**：过了一小时（18:56）仍能 `tasklist` 查到，
   CPU 时间只有几秒（空闲），11 个线程，父进程早已消失。
5. 结果：切片状态是对的（frozen），但「被 mand 在跑的监督进程」永远挂在进程表上；
   它不会写任何东西，也没有任何组件知道该把它收掉。

同一天早上的另一处现象与之互为镜像（ADR-124 背景里的 d5 首次运行）：
监督进程**在收尾之前**无声消失（日志止于「agent 已启动」）。
两次都可能与**同一类「进程生命周期收尾」问题**有关：
- 前一次：收尾流程根本没开始（进程在等待中途被带走，日志连异常都没写出）；
- 这一次：收尾流程做完了，但进程没走 `process.exit`。

## 现状分析（从代码看，后来由实现证实）

`supervisor-entry.ts` 原来的写法是：

```ts
runSupervisor(args).then((code) => { process.exit(code); })
```

`process.exit` 只在 `runSupervisor` 的 Promise **resolve** 之后才调用。而 Node 的事件循环
要等所有一次性任务清空才会自然结束 —— agent 子进程退出后，如果还挂着
**没有 `unref()` 的定时器或句柄**，Promise 一旦 resolve 了但事件循环还有句柄，
`process.exit` 就**可能永远不被调用**，进程就停在「空闲但活着」。

**根因（本次实现时从代码确认）**：`claude-agent` 适配器在 `start()` 里装了心跳
`setInterval`（每 5 秒写 `lastActivityAt`），它**没有 `unref`**。而
`runSupervisor` 的收尾流水线（`finishRun` → 预算核对）里还会调
`adapter.markProgress(sessionId)` → `resetIdleTimer` → **重新装一次心跳**——
`resetIdleTimer` 的「会话已不在」守卫在收尾时恰好不成立（`sessions` 里还留着这条
`exited: true` 的记录）。于是会话结束后的进程里又长出一个不 `unref` 的
`setInterval`，事件循环永远不空。

这解释了为什么是「条件性」的：`markProgress` 在收尾时是否被调用、上一轮里
有没有残留定时器，决定进程退不退。复现记录里 18:58 那一轮就没有再卡。

## 复现记录（2026-11-26 18:58 那一轮）

同一台机器、同一片、同一条命令（改完 ADR-124 + 清掉损坏 PDB 之后）：

- 监督进程 pid 3836 起跑，18:33 agent 退出（码 0），18:42 收尾完成，
  **日志最后一行「监督进程退出」之后进程随即消失**（`Get-Process 3836` 返回 false）。
- 说明「卡在退出」不是必然复现，而是**条件性**的：收尾路径上只要有一个不
  `unref` 的句柄被重建，进程就会待机——而这取决于上一轮里有没有调用
  `markProgress` / 有没有残留定时器，不是每轮都会发生。

由此选定的修法方向：不去赌「这次没有残留句柄」，而是**两层都修**——
根因（心跳不许拖住进程）与契约（收尾完必须退）各改一道，见下文。

## 决策（本次已实现的部分标注 ✅，其余仍待做）

### ✅ 零、根因：心跳定时器一律 `unref`

三个 shell/sdk 适配器（`claude-agent`、`claude-agent-sdk`、`cursor-agent`）的
心跳 `setInterval` 与 sdk 适配器的空转 `setTimeout` 全部 `unref()`。
心跳的职责是「落盘活性证据」，不是「让进程活着」——进程该不该活由监督进程的
收尾负责，不由一个定时器决定。

### ✅ 一、正常路径：`runSupervisor` 返回后，不论事件循环是否清空，都必须退出

`supervisor-entry.ts` 已改为：

```ts
runSupervisor(args).then((code) => { exitAfterFinish(code); })
// exitAfterFinish(code): process.exitCode = code;
//   setTimeout(() => { 诊断活动句柄; process.exit(code); }, EXIT_GRACE_MS)
```

`EXIT_GRACE_MS` 固定 3000（收尾里能落盘的都走同步写，窗口只为极少数流式一侧留余量；
它不是「等子进程」——子进程早被 `waitForAgentExit` 等过了）。

窗口内若有活动句柄残留，往 stderr 打一行「收尾已完成，但仍有 N 个活动句柄（ADR-125）：…」。
异常路径（`.catch`）同样直接 `process.exit(1)` —— **报错也不许挂在进程表上**。

「收尾做完就该走」是监督进程的契约，不能依赖「事件循环自然清空」这种副作用。

### 二、异常路径：`runSupervisor` 自己要有 watchdog（「收尾挂住」要能被看见）—— 待做

`run.aborted` 的 `reason` 里补上「卡在哪一步」：
收尾流水线（`finishRun`）里的每一步都写一条进度事件（`gate.executed` / `gate.result`
已经有），如果**最后一条进度事件**距今超过 `GATE_TIMEOUT`（配置里的 `gate.timeoutSec`），
监督进程应当主动退出并写 `run.aborted`，而不是静默挂住。

（本节的知识：收尾**过程中**挂住与本 ADR 修的「收尾**之后**挂住」是两件事；
第一条只保证「收尾完成必然退出」，不解决「收尾本身卡死」。见复现记录里
17:26 那一轮的另一种表现可能是前者。）

### 三、隐形约束：不要把「进程还活着」当成「这一轮还在跑」

驾驶舱 / `stall --reap` / 重复 agent 守卫，读的都是**会话/任务文件的 `lastActivityAt`**，
而不是「监督进程的 pid 是否还活着」。ADR-124 的修法一已经保证了「有 running 记录 +
没有心跳 = 空壳」。这一条保留：不因为 43956 还活就把它当成「这轮还在跑」——
它已经写完了 `run.started` 之后的所有事件。

## 影响

- `supervisor-entry.ts` 的行为变化：**正常路径会在收尾后 3 秒内强制退出**，
  不再依赖事件循环自然清空。
- 异常路径新增 `run.aborted` 的「卡在哪一步」字段（`phase` / `lastProgressAt`），不改 schema。
- 本 ADR **不**动 `runSupervisor` 的收尾逻辑本身（记账、门禁、签字请求全部照旧）。
- 本 ADR **不**自动杀「僵尸监督进程」—— 那是操作者的动作；本 ADR 只保证
  「下一次不会留下」，以及「卡住要能被看见」。
