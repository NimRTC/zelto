# ADR-055：超时要杀干净，而且要接着跑

## 状态

已接受（2026-11-11）

## 背景

在 `nimrtc-zelto` 上跑 `v1-remb-parse-and-trust` 切片时，zelto 判了失败，
但 agent 其实把活干完了。

时间线（全部来自 `.zelto/sessions/` 与 agent 自己的会话记录）：

| 时刻 | 事件 |
|---|---|
| 15:05:32 | zelto 启动 agent（`agent.timeout: 1800`） |
| 15:35:32 | zelto 超时 → 判失败 → 自动重试，起第二个 agent |
| 15:45:57 | **第一个 agent 结束**，交出一份报告：4 条门禁全过、8/8 验收全过 |
| 15:59:50 | 第二个 agent 结束，门禁②通过，签字请求已生成 |

也就是说：**第一个 agent 在被判「失败」之后，又活了 10 分钟，
并交出了一份完整的成功报告 —— 而那份报告被丢弃了。**

代价是实打实的：两次 agent 运行（第一次 ~7.35 美元），切片白跑了一遍，
而且第二次是在第一个 agent 还在写的目录上跑的。

## 根因：Windows 上 `child.kill()` 杀不掉 agent

zelto 在 Windows 上用 `shell: true` 起 agent：

```typescript
spawn(`${agentCommand}${claudeFlags} < "${tmpFile}"`, [], { shell: true, ... })
```

`shell: true` 时 Node 起的是 `cmd.exe`，拿到的 `child.pid` 是 **cmd.exe 的
pid**，不是 agent 的。而超时处理当时是：

```typescript
session.child.kill('SIGTERM');
setTimeout(() => session.child.kill('SIGKILL'), 3000);
```

这两句只作用于 cmd.exe。cmd.exe 一死，**真正干活的 `npx` → `node` →
`claude` 那条链变成了孤儿**：

- 它继续跑，继续改文件，继续烧 token；
- 它把自己的 stdout 写进了一条已经没人读的管道；
- 它最后交出的成功报告，zelto 根本不知道 —— 因为 zelto 早就不看了。

## 决策

### A. 杀干净（`src/adapters/process-tree.ts`）

超时与停止时杀的是**整棵进程树**，不是 shell 包装：

| 平台 | 手段 |
|---|---|
| Windows | `taskkill /pid <pid> /T`（`/T` = 连子进程一起），宽限后 `/F` 强杀 |
| POSIX | 子进程以 `detached: true` 起（独立进程组），`kill(-pid, SIGTERM)` 杀整组，宽限后 `SIGKILL` |

Windows 用任务树、POSIX 用进程组，是因为两个平台对「一组进程」的表达方式
不同：Windows 有任务树（`taskkill /T`），POSIX 有进程组（`kill` 负 pid）。

终止失败**不抛异常** —— 调用方的真实意图是「别让它继续跑」，失败时能做的
只有记一笔，把调用方带崩没有意义。

### B. 超时是超时，不是失败

被信号杀掉时 exitCode 是 `null`，原来的代码一律把会话状态写成 `failed`，
把「跑超时了」和「agent 报错退出」混成同一件事。前者重试有意义
（接着跑就行），后者往往没意义（得先看现场）。

现在超时保留 `timeout` 状态。这不是为了好看 —— `zelto status` 与
`zelto stall` 靠这个字段区分「环境抖动」和「agent 逻辑崩了」。

### C. 重试要接着跑

超时被杀时，agent 已经做掉的工作**都留在 worktree 里了**：代码改了一半、
测试跑了一半、上下文摸清了一半。从头再跑一遍等于：

1. 把那些工作重做一遍（编译、跑测试、改代码）；
2. 把 agent 的上下文清零，让它重新摸索已经摸清的东西。

所以重试改为**续跑同一个 agent 会话**：新增 `ExecutorAdapter.continueSession()`
端口方法（CLI 适配器用 `--resume <agentSessionId>` 复用同一个 agent 会话
id 与同一个工作目录），提示词是「接着上次做，别从头重做」。

`resume()` 保留给问答回路 —— 它的补丁是「人给的答复」，措辞也按那个语义
写的。两者语义不同，所以给重试单开一个入口，而不是硬掰 `resume()` 的语义。

续不上（适配器不支持 / 没有 agent 会话 id）时退回从头跑，不是致命错误。

## 影响面

- 超时不再留下孤儿 agent —— 不会再出现「两个 agent 抢同一批文件」。
- 超时重试不再把工作重做一遍，也不再丢 agent 摸清的上下文。
- `zelto status` / `zelto stall` 能区分「超时」与「失败」。
- 对被 `zelto halt` 停掉的 agent 同样生效（原先也只杀了 cmd.exe）。

## 备选方案

**把 `agent.timeout` 调大到跑得完的长度就算修好了。** 否决：那把「超时是
什么」的问题推到每个项目自己配参数 —— 而超时**本来就该发生**（agent 会
卡死、会死循环）。调大只是让这个 bug 更少见出现，不是修好它。

**超时后不杀，让 agent 自己跑完。** 否决：那 zelto 就失去了对运行时的
控制权。一个卡死的 agent 会永远占着写集预约。

**超时后从头重跑，但先清空 worktree。** 否决：清空 worktree 意味着丢弃
agent 已经做掉的工作 —— 那正是决策 C 要避免的事。

**在 zelto 侧识别 agent 的最终报告并把它当成成功。** 备选，未采纳：
agent 的报告是**自述**，不能作为「这次运行成功了」的依据 —— 它可能报告
成功但门禁没过。真正的判据是门禁（zelto 有独立的门禁机制）。本 ADR 只
保证「agent 跑完了这件事被如实记录」，判定权仍在门禁手里。
