# Slice: adr-141-settle-pending-permissions

## 目的

实施 ADR-141（`docs/adr/adr-141-settle-pending-permissions.md`）：
ACP 的**三条终止路径**（进程退出 / 空转超时 / 人工停止）都必须
**结算挂起的 `session/request_permission` 请求**。

## 背景：现在的洞

`src/adapters/acp/index.ts` 的 `handleExit()` 只清 timer、写状态，
**不结算任何挂起的 permission 请求**。`handleTimeout()` 与 `stop()` 同样。

后果：

1. **追溯链断一次写入** —— 挂起的那次写入既没被判允许、也没被判拒绝，
   在事件流里**没有 `policy.decision`**（与 ADR-139 修的断链同形状）；
2. **agent 侧那个 turn 永远不结束** —— JSON-RPC 请求有 id，
   不答复就一直等（T3 PR #21439 踩过这个：ACP 取消失败会让 turn 卡住）；
3. **判定进行中被终止时**，回调永远不返回。

## 范围

要改的：

- `src/adapters/acp/index.ts` —— 挂起集合；结算方法；三条终止路径调用它
- `src/adapters/acp/permission.ts`（**新增**） —— 挂起请求的登记 / 取下 / 结算
- `tests/adr-141-settle-permissions.test.ts`（**新增**）

只读参考（**不得修改**）：

- 只读 `docs/adr/adr-141-settle-pending-permissions.md` —— 本片的规则真源。
- 只读 `src/hook/acp.ts` —— 判定内核（本片一行不改）。
- 只读 `src/adapters/acp/always-grants.ts` —— 授权记忆（本片不改）。

## 需求

- 无（本片没有关联的需求条目；验收口径见下）。

## 验收标准

1. **进程退出时挂起的请求被回绝** ——
   验证方式：单测让 mock agent 发一个 permission 请求后**不等待答复**就退出，
   断言 zelto 侧**写了** `policy.decision`，`basis === 'acp:terminated'`。
   > **为什么这条不能省**：这是「终止时也要留痕」这条规则的核心。

2. **超时路径同样结算** ——
   验证方式：单测走 `handleTimeout`，断言同样有 `acp:terminated` 事件。

3. **人工停止路径同样结算** ——
   验证方式：单测走 `stop()`，断言同样有 `acp:terminated` 事件。
   > **为什么这条不能省**：三条路径各漏一条，就会出现「换个终止方式就绕过」
   > 的形状 —— 结算必须是**所有**终止路径的共同出口。

4. **结算回的是拒绝，绝不是允许** ——
   验证方式：单测断言事件里的 `decision === 'deny'`，
   且断言代码路径里**没有任何 `allow_always`**。
   > **为什么这条不能省**：结算是程序化答复，图省事回第一个选项就可能
   > 回出 `allow_always` → agent 持久化 allowlist → 逐写判定被永久绕过
   > （ADR-133 决策四之二的实测）。

5. **终止原因写进事件** ——
   验证方式：单测断言事件负载里有终止原因（`timeout` / `killed` / `exit`）。

6. **判定进行中被终止 → 回调不再写答复，但仍写事件** ——
   验证方式：单测模拟「回调已开始、此时终止」，断言
   **没有**向 agent 写答复、**但有** `policy.decision` 事件。
   > **为什么这条不能省**：终止时连接已断，写答复无意义；
   > 但「这次写入没被处理」这个**事实**必须留痕。

7. **结算幂等、不抛异常** ——
   验证方式：单测连调两次结算，断言不抛、事件不重复写。

8. **终止路径不被结算异常掩盖** ——
   验证方式：单测让写事件失败（mock 抛错），断言终止流程正常完成、
   退出码照常上报。
   > **为什么这条不能省**：结算是在「进程要死了」时跑的 ——
   > 它抛异常会掩盖真正的终止原因。

9. **判定内核一行不改** ——
   验证方式：单测断言 `judgeAcpPermission()` 的既有行为不变
   （既有 hook 单测全绿）。

10. **既有 ACP 单测与端到端测试全绿、`npm test` 全绿、`npm run lint` 通过。**

11. **不越界** —— 改动只在写集内；
    `docs/adr/adr-141-*.md` 的规则正文不得改动。
    验证方式：`git status --porcelain` 断言改动路径全部落在写集内。

## 关键实现要点（规格里已定，实施时不要重新发明）

### 挂起集合按**会话**记

`AcpSessionState` 加 `pendingPermissions: Map<string, PendingPermission>`，
key 是 JSON-RPC 请求 id。

**为什么按会话不按进程**：终止是**会话**级的事实；
且 `resume()` 会起**新进程**但属于**同一逻辑轮次** ——
挂起集合必须跟着会话走。

### 结算只允许「拒绝」这一个方向

回 `reject_once`；没有该选项时回 `cancelled`。
**绝不回 `allow_always`**（ADR-133 决策四硬规则 1）。

### `basis` 取独立值 `acp:terminated`

与 `acp:unknown-tool` 形状不同：

- `acp:unknown-tool` —— 我们**看了**这次调用，判不出写目标（agent 的问题）；
- `acp:terminated` —— 我们**根本没判**（zelto 的问题，进程终止了）。

混成一个 → 事后审计分不清是 agent 的问题还是 zelto 的问题。

### 事件里要带终止原因

`reason` 字段带 `timeout` / `killed` / `exit`。

### 终止时先中止判定

`AcpSessionState` 已有 `terminated: 'timeout' | 'killed' | null` 字段 ——
复用它的语义。回调在写答复**之前**检查它：
已终止 → 不写答复，但**仍然写事件**。

## 边界（规格里已定，实施时不要越界）

- **不改**判定内核（`src/hook/acp.ts` 一行不改）；
- **不改** `ExecutorAdapter` 端口（本问题只在 ACP 路线存在）；
- **不改**事件**类型**清单（`policy.decision` 已存在，只加 `basis` 取值）；
- **不引入**第三方依赖。

## 一个自查提醒（实施时不要按直觉走）

**「终止时进程都死了，写不写答复有区别吗」** —— 有，而且是**关键**的区别。

- **写答复**：连接已断 → 写不出去 → 写了也是**抛异常**，
  而终止路径上的异常会**掩盖真正的终止原因**（决策五）；
- **不写事件**：追溯链上这次写入**完全不存在** ——
  审计看到「没有 decision、也没有文件变化」会推断「没发生过」（C4）。

所以：**不写答复，但一定要写事件。**
