# ADR-021: 签字可撤销 —— 签错了要能回退

**状态**: 已实现
**日期**: 2026-11-04
**作者**: 系统架构
**关联约束**: C1, C4
**关联文档**: `AGENTS.md`, `docs/zelto-项目目标.md`,
`docs/adr-018-no-auto-merge-on-sign.md`（签字与合并的职责切分）

---

## 1. 摘要

zelto 的签字是**一次性的**：签字记录一旦落盘，状态就是 `approved`，
没有第二条路能改回去。人总会犯错 —— 签错切片、签了还没改完的版本、
签了不该签的那一版。

ADR-018 把「签字」和「合并」拆开了（签字只改状态，合并是显式动作），
但没有解决「签错了怎么办」。本 ADR 补上这一条：**签字可以撤销**。

新增事件类型 `sign.revoked` 与命令 `zelto sign <id> --revoke`。

---

## 2. 动机

### 2.1 现状

| 事实 | 位置 | 影响 |
|---|---|---|
| 签字记录只有 `pending` / `approved` / `rejected` | `src/core/gate/sign.ts` | 签错了只能手改 `.zelto/locks/*.json` |
| 没有撤销的事件类型 | `src/core/events/stream.ts` | 撤销无法留痕，审计链断一节 |
| 签字与合并已分离（ADR-018） | `src/cli/commands/gate-sign.ts` | 合并是可逆动作，但签字不可逆 —— 不对称 |

### 2.2 为什么不是「删掉那条记录」

签字记录在 `.zelto/locks/` 下，是**证据**。删掉它等于把这段历史从链上抹掉 ——
事后没人能回答「这一版到底批过没有」。撤销是**追加**而不是**抹除**：
记录还在，只是状态变成 `revoked`，并且留一条 `sign.revoked` 事件。

### 2.3 为什么撤销不改变切片状态

签字本身**没有真的改切片状态** —— 看 `SignManager.approve()` 的实现：
它尝试 `SIGN_APPROVE` 转移，但 `SIGN_APPROVE` 从 `frozen` 出发也是到 `completed`，
而正常路径上门禁②通过时切片已经是 `completed` 了（`GATE_PASS`）。
所以「批准」这条记录本身并不承载状态语义。

撤销因此也**不改切片状态**：切片仍是 `completed` ——
门禁②的结论（测试通过、规格对上）依然成立，撤销的是「人批准」这个动作。

要真正让切片回到未签字的状态，正确做法是：修好之后**重新发起签名请求**，
走一遍新的 `--approve`。这样链上有两条记录：一次撤销、一次新的批准。

### 2.4 与 ADR-018 的分工

| 动作 | 语义 | 命令 |
|---|---|---|
| 撤销签字 | 「这条批准记录作废了」 | `zelto sign <id> --revoke` |
| 撤销合并 | 「合并结果不要了」 | `zelto merge --abort`（合并编排层） |

两者都是「可回退」，但管的是不同的东西。撤销签字**不影响已经发生的合并** ——
合并是显式动作，签字不是它的前置条件（ADR-018 已把这条依赖去掉）。

---

## 3. 设计

### 3.1 状态机

签字请求的状态从 3 个变 4 个：

```
pending ──approve──> approved ──revoke──> revoked
   │                    │
   └──reject──> rejected
```

只有 `approved` 能撤销：
- `pending` 直接作废走 `reject`（语义更准，也不该有「待批准」的撤销）；
- `rejected` 没什么可撤 —— 已经是「不批准」了；
- `revoked` 不可再撤 —— 撤销过一次就够了，反复撤销没有新信息。

### 3.2 命令

```
zelto sign <slice-id> --revoke [--comment <text>]
```

- 找不到 `approved` 的记录 → 报错退出码 1（不静默成功）；
- 撤销成功 → 打印说明：切片仍是 `completed`，需要重新发起签名请求才能再合入主干。

### 3.3 事件

新增事件类型 `sign.revoked`（事件类型是契约，改它要写 ADR —— 就是本篇）。
在 `core/events/stream.ts`、`contracts/schemas/event-envelope.json`
与 `core/audit/trail.ts` 的摘要表里同步登记。

| 时机 | 归属键 | payload |
|---|---|---|
| 撤销一条已通过的签字 | 切片 id | `signId`、`sliceId`、`comment` |

事件总数：47 → 49（ADR-020 加 `batch.halted`，本 ADR 加 `sign.revoked`）。

### 3.4 实现位置

| 内容 | 位置 |
|---|---|
| 撤销逻辑 | `src/core/gate/sign.ts` 的 `SignManager.revoke()` |
| CLI 入口 | `src/cli/commands/gate-sign.ts` 的 `--revoke` 分支 |
| 事件类型登记 | `src/core/events/stream.ts`、`contracts/schemas/event-envelope.json`、`src/core/audit/trail.ts` |
| 判定测试 | `tests/core/gate/sign.test.ts` |

---

## 4. 约束合规性

| 约束 | 怎么满足 |
|---|---|
| C1 状态只在文件里 | 签字记录仍在 `.zelto/locks/<signId>.json`，只改 `status` 字段 |
| C4 append-only 事件 | 撤销追加 `sign.revoked` 事件，不改写历史事件 |
| C3 判定确定性 | 能不能撤销只看 `status === 'approved'`，没有模型参与 |

---

## 5. 后果

**好的**

- 签字可回退：签错了不用手改文件、不用删记录。
- 审计链完整：撤销留痕，事后能回答「批过没有、后来撤了没有」。
- 与合并的对称性：签字、合并都是可回退的显式动作。

**代价与边界**

- 撤销**不撤回已发生的合并**。要撤合并结果，走合并编排层。
- 撤销**不把切片退回 `frozen`**。要重新走门禁②，人得自己把切片状态处理掉
  （目前没有「打回重做」的直接命令 —— 这是个已知的缺口，见 §6）。
- 撤销只撤**一条**记录：同一切片有多条 `approved` 记录时，
  `--revoke` 撤的是最新的一条。

**明确没做**

- 不做「撤销并重新排队」—— 重新发起签名请求是显式动作。
- 不做批量撤销 —— 一次撤一条，理由要能写进 `comment`。
- 不改 ADR-018：签字仍然不自动合并。

---

## 6. 已知缺口

撤销之后切片留在 `completed`，但人实际上想表达的是「这一版不行，重做」。
当前没有直接命令把 `completed` 切片打回 `frozen`。
补这一条需要动状态机（`completed → frozen` 的合法转移），属于契约变更，
应另写 ADR，不在本篇范围内。
