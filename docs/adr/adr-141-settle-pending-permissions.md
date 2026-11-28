# ADR-141：终止路径必须结算挂起的 permission 请求

**状态**：已决（2026-11-28）· 已落地（提交 `d7a623b`）
**日期**：2026-11-28
**相关**：ADR-133（ACP 执行器）、ADR-083（多 harness 判定内核）、C1/C3/C4/C9

**背景来源**：T3 Code 的 `docs/internals/03_providers.md`（2026-11-28 核对源码）。

## 背景

### zelto 的 fail closed 靠的是「不回答 = 拒绝」

ADR-133 决策四的核心是：ACP 路线下 C9 的主判定点是
`session/request_permission` 回调 —— **agent 主动来问，zelto 回答**。
文件头写着：

> **不回答 = 拒绝**（协议语义自带 fail closed），不依赖任何一家的配置默认值。

这个设计的前提是：**每一次 permission 请求都有一次明确的答复**。
「不回答」之所以等于「拒绝」，是因为 agent 侧拿不到答复就一直等，
而 zelto 侧的进程一死，连接就断了 —— agent 于是知道「没批准」。

### 但 zelto 终止进程时，没有结算任何挂起的请求

`src/adapters/acp/index.ts` 的 `handleExit()` 只做三件事：

```ts
private handleExit(sessionId: string, exitCode: number | null): void {
  const timeout = this.timeouts.get(sessionId);
  if (timeout) { clearTimeout(timeout); this.timeouts.delete(sessionId); }
  const interval = this.progressIntervals.get(sessionId);
  if (interval) { clearInterval(interval); this.progressIntervals.delete(sessionId); }
  // ... 改 session 状态、写会话文件
}
```

**没有结算挂起的 `session/request_permission`。**

同样的问题在另外两条终止路径上：

| 路径 | 触发点 | 现在做什么 | 挂起的请求 |
|---|---|---|---|
| **进程自然退出** | `child.on('exit')` | 清 timer、写状态 | **不结算** |
| **空转超时** | `handleTimeout()` | 杀进程树、写状态 | **不结算** |
| **人工停止** | `stop()` | 杀进程树、写状态 | **不结算** |

### 为什么这不是「无所谓」

**第一，挂着的请求是一条永不返回的判定。**

zelto 的判定链是：agent 问 → zelto 判 → zelto 答。
挂起的那一步意味着：**这一次写入既没被判成允许，也没被判成拒绝** ——
它悬在中间。而 C9 写的是「每个动作写 append-only 事件」「判定必须确定性」。

从追溯链看：这次写入**在事件流里没有 `policy.decision`** ——
和 ADR-139 修的「续跑段没有守卫」是**同一种断链**，只是成因不同。

**第二，它在 agent 侧会占住请求槽。**

ACP 是 JSON-RPC，请求有 id。agent 发出 `session/request_permission` 后
就在等答复。zelto 不答 → agent 那个 turn 永远不结束。

这正是 T3 踩过的坑（PR #21439，`fix(acp): recover sessions after cancellation fails or stalls`）：

> A failed ACP cancellation can leave a turn active, and a successful
> cancellation can leave a prompt that never acknowledges Stop.

**第三，zelto 自己有「以后都允许」的机制，放大了这个问题的形状。**

ADR-133 决策四之二：zelto 侧维护 `always-grants.ts` 的授权记忆，
命中就**直接放行**（不问人）。也就是说 zelto 自己就会产生
「秒回」与「要问人（TTY）」两种不同长度的等待。

**非 TTY 下**（CI、后台跑）`promptAlwaysAllow` 直接返回 `'once'` ——
不提问。所以非 TTY 路径下 permission 回调是**同步**的，不存在挂起。

**TTY 下**如果用户选了「拒绝」或直接回车，那也是同步返回。
只有「问人」这一步是异步的（等 `rl.question`）。

**但真正的挂起来源不是这里** —— 是**终止发生时回调还在跑**：

```
agent 发 permission 请求
  → zelto 的回调开始判定
  → 人正在回答（readline 在等）
  → 这时进程被超时杀掉 / 被人 stop / agent 自己退了
  → 回调永远不返回 → 那个 JSON-RPC 请求永远没有答复
```

### T3 的原则

T3 的 `docs/internals/03_providers.md` 里，「Cross-provider traps and testing」
一节列了一条被反复踩到的陷阱：

> **Terminal settlement.** Every terminal path (completion, Stop, provider error,
> process exit) must settle open tool calls, subagents, and pending requests.

而且 T3 把它列在「**反复坑到多个 adapter**」的清单里 ——
说明这不是某一家 agent 的怪癖，是**协议形状决定的通病**。

`01_architecture.md` 里还有一条配套的：

> A run is `completed` when its provider turn ends; the turn-end checkpoint is
> captured afterwards as an outbox effect on the thread's effect lane.
> Until that capture commits, readers treat the missing checkpoint as pending.

—— 「**结算是一道独立的关卡，不是一句随口的收尾**」。

## 决策

### 决策一：三条终止路径都必须结算挂起的 permission 请求

统一成一个方法，在 `handleExit` / `handleTimeout` / `stop` 里都调：

```
settlePendingPermissions(sessionId, reason)
```

它做两件事：

1. 对每个挂起的请求，回一个**拒绝**（`reject_once`；没有该选项时回 `cancelled`）；
2. 每个都写一条 `policy.decision` 事件，理由写明「进程终止，未及判定」。

**为什么回拒绝而不是回允许**：终止时我们**不知道**这次写入该不该允许。
回允许 = 在没有判据的情况下放行 = 违反 C9 的 fail closed。
回拒绝 = 保守，且 agent 侧看到的是「没批准」而不是「批准了但进程死了」。

**为什么还要写 `policy.decision` 事件**：C4 说事件是追溯的唯一证据载体。
这次写入「被拒绝了」是**一个判定事实**，必须留痕。
事件里要能区分「判成拒绝（越界）」与「进程终止，未及判定」——
所以 `basis` 取一个**独立值**（见决策三）。

### 决策二：判定进行中（人在回答）时，终止要先中止判定，再结算

时序问题：如果 `handleExit` 在回调**正在跑**的时候执行，
那个回调可能稍后才返回 —— 那时再回一个拒绝就晚了（连接已断）。

所以：**终止时先把「正在跑的判定」标记掉，让回调知道「这一轮已经结束了」**，
回调返回时**不再写答复**（连接已断，写了也没用），但**仍然写事件**。

具体地，`AcpSessionState` 加一个 `terminated: boolean`（已有的 `terminated`
字段是 `'timeout' | 'killed' | null`，正好复用它的语义）。

回调在写答复**之前**检查 `state.terminated`：
- 已终止 → **不写答复**（连接已断），但**仍然写 `policy.decision` 事件**
  （理由写「进程终止，未及判定」）；
- 未终止 → 正常写答复。

**为什么仍然要写事件**：事件是**给人看的追溯**，不是给 agent 看的。
「agent 在终止前请求写 X，zelto 来不及判定就退出了」——
这条事实必须留在事件流里，否则事后审计看到「没有 decision 也没有文件」
会以为「没发生过」。

### 决策三：事件里用一个独立的 `basis`，与「判成拒绝」区分

`policy.decision` 的 `basis` 取值：

| basis | 含义 | 决策 |
|---|---|---|
| `acp:terminated` | **进程终止，判定未完成** | 拒绝（fail closed） |

它与已有的 `acp:unknown-tool`（判不出写目标 → 拒绝）**形状不同**：
- `acp:unknown-tool` —— 我们**看了**这次调用，判不出写目标；
- `acp:terminated` —— 我们**根本没判**（进程没了）。

**为什么必须分开**：事后审计要能回答「这次写入为什么没被处理」。
「判不出」是 agent 的问题（工具类别怪），「没来得及判」是 zelto 的问题
（进程终止）。混成一个 → 审计分不清。

### 决策四：终止原因要写进事件

`reason` 字段带上终止原因（`timeout` / `killed` / `exit`），
让人能看出这是哪种终止。

### 决策五：结算必须**幂等**且**不抛异常**

终止路径本身已经在处理「进程要死了」这种异常状态 ——
结算代码**绝不能抛**，否则会掩盖真正的终止原因。

所以：结算里的每个动作都包在 try/catch 里；写事件失败只记警告，不影响终止流程。

**幂等**：`settlePendingPermissions` 清空挂起集合，重复调用是空操作。

### 决策五之二：「谁写事件」用**归属权**决定，不用「谁先取到谁写」

这一条是**落地时才发现的坑**，值得单独记下来。

**最初的实现**（也是本文第一版的字面读法）是：

> 「判定方与结算方**赛跑**着取下这条请求（`take()` 取下就移走）——
> **取到的那一方**负责写那条 `policy.decision`。」

**这个实现是错的**，而且错得很隐蔽 —— 它**恰好把 ADR-141 要修的断链又造了一遍**。

**为什么错**：判定方（permission 回调）在写答复**之前**要先**问人**
（「以后都允许吗」，`handleAlwaysGrant` 会等 readline）。
如果判定方在**一开始**就把请求从登记册里「取走」，
那么**终止路径就 `drain()` 不到它** → 终止路径认为「没有挂起的请求」
→ **不写事件** → 追溯链断链 —— 正是本 ADR 要修的那个形状。

实测（2026-11-28，`tests/adr-141-settle-permissions.test.ts`）：
判定方阻塞 5 秒问人期间进程退出 → 终止路径看到 `pending = 0` → 零事件。

**正确的协议：归属权（`resolved`）**，两条路径**都先干活、最后抢归属权**：

```
判定方：判定（可能问人很久） → resolve(requestId, 'judge') → 抢到就写事件
结算方：drain（拿到全部）    → resolve(requestId, 'termination') → 抢到就写事件
```

`resolve()` 只给一次 —— 抢到的那一方写事件，另一方**不写**（不重复）。

**关键点：判定方在判定完成前，请求**仍留在登记册里**。**
所以终止路径 `drain()` 得到得到它 → 结算得到 → 写「因终止未处理」事件。

两种时序**都恰好一条事件**：

| 时序 | 判定方 | 结算方 | 事件 |
|---|---|---|---|
| 终止**先**到（判定还在问人） | 抢不到 → 不写 | 抢到 → 写 | 1 条 `acp:terminated` |
| 判定**先**完成 | 抢到 → 写正常判定 | 抢不到 → 不写 | 1 条正常 `policy.decision` |

**为什么不留「取走」语义**：`take()` 是**破坏性**的，
用它做「谁写事件」的裁判 = 裁判本身会**销毁**被裁判的对象。
归属权是**非破坏性**的标记 —— 裁判不改变现场。

**实现**：`PendingPermissionRegistry` 的 `resolve(requestId, owner)` 返回
布尔（抢到 = `true`）、`ownerOf(requestId)` 返回归属方。
`take()` / `drain()` **不再**清归属权 —— 判定方醒来后还要靠它
判断「终止路径已经结算过了」→ 不写重复事件。

### 决策六：挂起集合按**会话**记，不按进程记

`AcpSessionState` 里维护 `pendingPermissions: Map<string, PendingPermission>`，
key 是 JSON-RPC 请求 id。

**为什么按会话不按进程**：终止是**会话**级的事实（这个会话的 agent 死了），
不是一个进程号的事实。而且 `resume()` 会起**新进程**但属于**同一逻辑轮次** ——
挂起集合必须跟着会话走，否则新进程起来后会以为没有挂起请求。

### 决策七：预留一个「拒答也是答复」的边界 —— 不给 `allow_always` 的原则不变

结算时回的拒绝，仍然遵守 ADR-133 决策四硬规则 1：
**只回 `reject_once` / `reject_always` / `cancelled`，绝不回 `allow_always`**。

**为什么这条要在本 ADR 里重申**：结算是一个「程序化」的答复路径，
不像正常判定路径那样有「判定 → 选选项」的流程。
如果实现时图省事直接回 agent 提供的第一个选项，
可能回出 `allow_always` —— 那就打开了 agent 自己的持久化 allowlist
（ADR-133 决策四之二的实测：条目写进 `.cursor/permissions.json`，
之后不再问 zelto，逐写判定被永久绕过）。

**所以：结算路径只允许「拒绝」这一个方向**，不允许任何形式的放行。

## 被否决的方案

1. **终止时不管挂起的请求**（现状）：
   追溯链断一次写入；agent 侧那个 turn 永远不结束。ADR-141 要修的就是它。
2. **终止时回「允许」**（让 agent 的 turn 干净结束）：
   在没有判据的情况下放行 = 违反 C9 的 fail closed。
3. **终止时回「拒绝」，但不写事件**：
   那这次写入在事件流里**完全不存在** ——
   审计看到「没有 decision、也没有文件变化」会推断「没发生过」。
   C4 说事件是追溯的唯一证据载体。
4. **把 `acp:terminated` 复用成 `acp:unknown-tool`**：
   两种原因形状不同（见决策三），混了审计就分不清是 agent 的问题还是 zelto 的问题。
5. **给 `ExecutorAdapter` 端口加一个 `settlePending()` 方法**：
   本问题**只在 ACP 路线存在**（hook 路线没有「请求/答复」这个形状）。
   往端口上加一个只有一家实现的方法，是 ADR-133 决策二批评过的
   「让用户去配用哪套闸门」同形状 —— 在端口上开一个口子。
   **判断留在 ACP adapter 内部**。

## 影响面

| 文件 | 改动 |
|---|---|
| `src/adapters/acp/index.ts` | 挂起集合；结算方法；三条终止路径调用它；回调检查 terminated |
| `src/adapters/acp/permission.ts`（**新增**） | 挂起请求的登记 / 取下 / 结算（纯数据结构 + 事件写入） |
| `tests/acp-adapter.test.ts` | 结算的用例（终止 / 超时 / 停止三条路径） |

**不涉及**：判定内核（`src/hook/acp.ts` 的 `judgeAcpPermission` 一行不改）、
端口（`src/core/ports/executor.ts`）、事件**类型**清单
（`policy.decision` 已存在，只加 `basis` 取值与负载字段）。

## 验收标准

1. **进程退出时挂起的请求被回绝** ——
   验证方式：单测让 mock agent 发一个 permission 请求后**不等待答复**就退出，
   断言 zelto 侧**写了** `policy.decision`，`basis === 'acp:terminated'`。
2. **超时路径同样结算** ——
   验证方式：单测走 `handleTimeout`，断言同样有 `acp:terminated` 事件。
3. **人工停止路径同样结算** ——
   验证方式：单测走 `stop()`，断言同样有 `acp:terminated` 事件。
4. **结算回的是拒绝，绝不是允许** ——
   验证方式：单测断言事件里的 `decision === 'deny'`，
   且**断言代码路径里没有任何 `allow_always`**（源码扫描或行为断言）。
   > **为什么这条不能省**：结算是程序化答复，图省事回第一个选项就可能
   > 回出 `allow_always` → agent 持久化 allowlist → 逐写判定被永久绕过
   > （ADR-133 决策四之二的实测）。
5. **终止原因写进事件** ——
   验证方式：单测断言事件负载里有终止原因（`timeout` / `killed` / `exit`）。
6. **判定进行中被终止 → 回调不再写答复，但仍写事件** ——
   验证方式：单测模拟「回调已开始、此时终止」，断言
   **没有**向 agent 写答复、**但有** `policy.decision` 事件。
7. **结算幂等、不抛异常** ——
   验证方式：单测连调两次结算，断言不抛、事件不重复写。
8. **终止路径本身不被结算异常掩盖** ——
   验证方式：单测让写事件失败（mock 抛错），断言终止流程正常完成、
   退出码照常上报。
9. **现有 ACP 单测与端到端测试全绿、`npm test` 全绿、`npm run lint` 通过。**
10. **不越界** —— 改动只在写集内。

## 参考

- T3 Code `docs/internals/03_providers.md`（「Terminal settlement」）
- T3 Code `docs/internals/01_architecture.md`（「Turn completion and checkpoints」）
- T3 Code PR #21439（`fix(acp): recover sessions after cancellation fails or stalls`）
- 本仓库：`docs/adr/adr-133-acp-executor-and-permission-as-write-guard.md`、
  `src/adapters/acp/index.ts`

---

## 版本追溯

| 字段 | 值 |
| --- | --- |
| 所属版本号 | v0.7.1 |
| 关联 ADR 编号 | ADR-141 |
| 提交哈希 | d7a623b6c745b883eb901540f800578558637082 |
| 验证方式 | [tests/adr-141-settle-permissions.test.ts 18 个用例全绿 + npm test 全绿 + npm run lint 通过 + 人工复核] |
