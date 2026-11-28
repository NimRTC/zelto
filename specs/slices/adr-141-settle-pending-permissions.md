# Slice: adr-141-settle-pending-permissions

## 目的

实施 ADR-141（`docs/adr/adr-141-settle-pending-permissions.md`）：
**终止路径必须结算挂起的 permission 请求**。

现在的洞：`src/adapters/acp/index.ts` 的三条终止路径
（进程自然退出 / 空转超时 / 人工停止）**都没有结算挂起的
`session/request_permission`** —— 那些请求永远悬着。

## 背景：这一片修的是「一次写入既没被判允许、也没被判拒绝」

### zelto 的 fail closed 靠的是「不回答 = 拒绝」

ADR-133 决策四的核心是：ACP 路线下 C9 的主判定点是
`session/request_permission` 回调 —— **agent 主动来问，zelto 回答**。

这个设计的前提是：**每一次 permission 请求都有一次明确的答复**。

### 但终止时什么都没结算

`handleExit()` 只做三件事：

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

| 路径 | 触发点 | 现在做什么 | 挂起的请求 |
|---|---|---|---|
| **进程自然退出** | `child.on('exit')` | 清 timer、写状态 | **不结算** |
| **空转超时** | `handleTimeout()` | 杀进程树、写状态 | **不结算** |
| **人工停止** | `stop()` | 杀进程树、写状态 | **不结算** |

### 为什么这不是「无所谓」

**第一，挂着的请求是一条永不返回的判定。**
这次写入**既没被判成允许，也没被判成拒绝** —— 它悬在中间。
从追溯链看：这次写入**在事件流里没有 `policy.decision`** ——
和 ADR-139 修的「续跑段没有守卫」是**同一种断链**，只是成因不同。

**第二，它在 agent 侧会占住请求槽。**
ACP 是 JSON-RPC，请求有 id。agent 发出 `session/request_permission` 后就在等答复。
zelto 不答 → agent 那个 turn 永远不结束。

**第三，真正的挂起来源是「终止发生时回调还在跑」**：

```
agent 发 permission 请求
  → zelto 的回调开始判定
  → 人正在回答（readline 在等）
  → 这时进程被超时杀掉 / 被人 stop / agent 自己退了
  → 回调永远不返回 → 那个 JSON-RPC 请求永远没有答复
```

### T3 的原则

T3 的 `docs/internals/03_providers.md` 把这条列在「**反复坑到多个 adapter**」的
陷阱清单里：

> **Terminal settlement.** Every terminal path (completion, Stop, provider error,
> process exit) must settle open tool calls, subagents, and pending requests.

## 范围

要改的：

- `src/adapters/acp/index.ts` —— 挂起集合；结算方法；三条终止路径调用它；
  回调检查 terminated
- `src/adapters/acp/permission.ts`（**新增**）—— 挂起请求的登记 / 取下 / 结算
- `tests/adr-141-settle-pending-permissions.test.ts`（**新增**）——
  结算的用例（终止 / 超时 / 停止三条路径）

只读参考（**不得修改**）：

- 只读 `docs/adr/adr-141-settle-pending-permissions.md` —— 本片的规则真源。
- 只读 `src/hook/acp.ts` —— 判定内核（**本片不改它**；`judgeAcpPermission` 一行不改）。
- 只读 `src/core/ports/executor.ts` —— 端口（**本片不改它**）。
- 只读 `AGENTS.md` —— 项目约定。

## 需求

- 无（本片没有关联的需求条目；验收口径见下）。

## 验收标准

1. **进程退出时挂起的请求被回绝** ——
   验证方式：单测让 mock agent 发一个 permission 请求后**不等待答复**就退出，
   断言 zelto 侧**写了** `policy.decision`，`basis === 'acp:terminated'`。
   > **为什么这条不能省**：这次写入在事件流里**完全不存在** ——
   > 审计看到「没有 decision、也没有文件变化」会推断「没发生过」。C4。

2. **超时路径同样结算** ——
   验证方式：单测走 `handleTimeout`，断言同样有 `acp:terminated` 事件。

3. **人工停止路径同样结算** ——
   验证方式：单测走 `stop()`，断言同样有 `acp:terminated` 事件。

4. **结算回的是拒绝，绝不是允许** ——
   验证方式：单测断言事件里的 `decision === 'deny'`，
   且**断言代码路径里没有任何 `allow_always`**（源码扫描或行为断言）。
   > **为什么这条不能省**：结算是程序化答复，图省事回第一个选项就可能
   > 回出 `allow_always` → agent 持久化 allowlist → 逐写判定被永久绕过
   > （ADR-133 决策四之二的实测：条目写进 `.cursor/permissions.json`，
   > 之后不再问 zelto）。

5. **终止原因写进事件** ——
   验证方式：单测断言事件负载里有终止原因（`timeout` / `killed` / `exit`）。
   > **为什么这条不能省**：事后审计要能回答「这次写入为什么没被处理」。

6. **判定进行中被终止 → 回调不再写答复，但仍写事件** ——
   验证方式：单测模拟「回调已开始、此时终止」，断言
   **没有**向 agent 写答复、**但有** `policy.decision` 事件。
   > **为什么这条不能省**：连接已断，写了答复也没用；
   > 但事件是**给人看的追溯**，必须留。

7. **结算幂等、不抛异常** ——
   验证方式：单测连调两次结算，断言不抛、事件不重复写。

8. **终止路径本身不被结算异常掩盖** ——
   验证方式：单测让写事件失败（mock 抛错），断言终止流程正常完成、
   退出码照常上报。
   > **为什么这条不能省**：结算代码**绝不能抛** ——
   > 否则会掩盖真正的终止原因。

9. **现有 ACP 单测与端到端测试全绿、`npm test` 全绿、`npm run lint` 通过。**

10. **不越界** —— 改动只在写集内。

## 关键实现要点（规格里已定，实施时不要重新发明）

### 挂起集合按**会话**记，不按进程记

`AcpSessionState` 里维护 `pendingPermissions: Map<string, PendingPermission>`，
key 是 JSON-RPC 请求 id。

**为什么按会话不按进程**：终止是**会话**级的事实（这个会话的 agent 死了），
不是一个进程号的事实。而且 `resume()` 会起**新进程**但属于**同一逻辑轮次** ——
挂起集合必须跟着会话走。

### `basis` 取独立值 `acp:terminated`

| basis | 含义 |
|---|---|
| `acp:terminated` | **进程终止，判定未完成** |

它与已有的 `acp:unknown-tool`（判不出写目标 → 拒绝）**形状不同**：
- `acp:unknown-tool` —— 我们**看了**这次调用，判不出写目标（agent 的问题）；
- `acp:terminated` —— 我们**根本没判**（进程没了，zelto 的问题）。

混成一个 → 审计分不清。

### 判定进行中被终止的时序

`AcpSessionState` 已有 `terminated: 'timeout' | 'killed' | null` 字段，
正好复用它的语义。回调在写答复**之前**检查它：
- 已终止 → **不写答复**（连接已断），但**仍然写 `policy.decision` 事件**；
- 未终止 → 正常写答复。

### 结算路径只允许「拒绝」这一个方向

**绝不回 `allow_always`**。结算时只在 agent 提供的选项里找
`reject_once` / `reject_always` / `cancelled`；
**一个都找不到**就回 `cancelled`（协议允许的自定义 outcome）——
**绝不回 agent 提供的第一个选项**（那可能就是 `allow_always`）。

## 边界（规格里已定，实施时不要越界）

- **不改**判定内核（`src/hook/acp.ts`）；
- **不改**端口（`src/core/ports/executor.ts`）——
  本问题**只在 ACP 路线存在**（hook 路线没有「请求/答复」这个形状）；
- **不改**事件**类型**清单 —— `policy.decision` 已存在，只加 `basis` 取值与负载字段；
- **不引入**第三方依赖。

## 一个自查提醒（实施时不要按直觉走）

**「反正进程都死了，agent 那边自然就知道了」** —— 这是错的。

1. 进程死的是 **zelto 这边**。agent 可能是一个**独立的长驻进程**
   （T3 的 provider-acp 就是独立服务），它的那个 turn 会**永远等下去**；
2. zelto 这边的**追溯链断一次写入** —— 事件流里查不到这次写入，
   事后审计看到「没有 decision 也没有文件」会以为「没发生过」；
3. 「不回答 = 拒绝」这个 fail closed 靠的是**连接断开**，
   而**结算**是主动回一个明确的拒绝 —— 前者让 agent 猜，
   后者让 agent 知道「被拒了，可以改道」。
