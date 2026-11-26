# ADR-123 驾驶舱总览不许把「看门狗的尸体」算成「在跑」

- 状态：已采纳
- 日期：2026-11-26
- 关联：D-30（被动活性）、ADR-074（看门狗与续跑）、ADR-041（停机分类）、ADR-112（驾驶舱按根扫描）

## 背景

实测 nimrtc-v14（2026-11-26）驾驶舱显示「0 停机 · 2 在跑」，对照盘上事实：

| 切片 | 状态文件 | 进程 | 看门狗账本 | 驾驶舱 |
|---|---|---|---|---|
| `v4-d5-audio-dtx` | `running`（updatedAt 06:57） | 没了 | 自愈 7 次 | 计入「在跑」 |
| `v1-rtcp-processor-collaborator` | `running`（updatedAt 06:04） | 没了 | 自愈 2 次 + 已上报(escalate)，之后又起跑一次又死了 | 计入「在跑」 |

三份数据各自都对，拼起来的画面是错的：

- **停机**（`/api/stalls`、`stalledCount`）只认 `stall.class !== null`（ADR-041 的 9 类）。
  这两片的 `stall.class` 都是 `null` —— 看门狗自愈走的是「把 running 片视为假死」这条路，
  从没写过停机分类。于是「停机 0」在字面上成立，在语义上撒谎。
- **活性**只影响详情页的徽标；总览页的「在跑」只数 `liveness === 'active'`，
  而概要行（页头）更是只数 active —— 两处都没有 stale/dead/came-up-empty 的口径。
- **看门狗**自愈到上限后会 `escalate`，但 escalate 只是一条事件 + 一个标记；
  `zelto run` 之后再死一次，进程没了，状态仍停在 running —— 没有任何组件会再管它。

## 决策

**一、`SliceSummary` 增加 `watchdogGaveUp`（只读派生字段，不写状态）。**

```
watchdogGaveUp = slice.state === 'running' && (liveness === 'dead' || liveness === 'stale')
```

它只做**文件事实的拼装**（状态 + 活性），不另立停机判据，不触发任何看门狗动作（C1、C3）。
命名表达的是「这片已经不是『在跑』，需要人收」；具体原因（死了 / 静默 / 自愈几次 / 是否已上报）
由后端已有的 `liveness` / `recoveries` / `escalated` 字段一并呈现。

**二、`/api/summary` 在 `live` 下新增 `gaveUp` 列表**，带 `liveness` / `recoveries` /
`escalated` / `lastActivityAt` / `reason`，供总览页单列一节「需人收（看门狗已停救）」。

**三、页头概要行口径修正**：

```
在跑 = active + stale - gaveUp          // gaveUp 那批进程都没了/没动静，不算在跑
已死 = dead.length                      // 单列
需人收（看门狗已停救）= gaveUp.length    // 单列
```

**四、总览页新增「需人收」一节**，说明这些片不属于停机分类、因此「停机」数里没有它们，
并给出处置命令（`zelto resume <id>` 重跑 / `zelto abandon <id>` 收掉）。

## 影响

- `/api/summary` 的 `live` 多一个 `gaveUp` 键；`SliceSummary` 多一个 `watchdogGaveUp` 布尔。
  都是**新增只读字段**，老前端拿到多余字段无影响。
- 总览页与页头概要行的计数口径变化：过去的「2 在跑」现在如实变成「0 在跑 · 2 需人收」。
- 不改 `core/` 任何判定；看门狗、停机分类、状态机全部原样。
