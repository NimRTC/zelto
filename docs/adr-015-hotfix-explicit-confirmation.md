# ADR-015: hotfix 路径（跳过门禁② 的显式确认）

**状态**: 已实现
**日期**: 2026-11-04
**作者**: 系统架构
**关联约束**: C1, C3, C4, C7
**关联文档**: `AGENTS.md`, `docs/adr-014-runtime-policy-enforcement.md`, `docs/zelto-技术架构.md`

---

## 1. 摘要

`zelto run --hotfix <id>` 跳过门禁②（验收测试），把切片直接置为 `GATE_PASS`
并自动批准签字。这条路径一直存在，但**没有写进任何 ADR**，事件类型
`slice.hotfix` 也不在 `contracts/schemas/event-envelope.json` 的 enum 里——
代码在写一个契约里没有的事件。

本 ADR 把这条路径写进契约，并且给它加一道**显式确认**：
`--hotfix` 必须配 `--yes` 一起用，否则拒绝执行。

---

## 2. 动机

### 2.1 现状

| 事实 | 位置 | 影响 |
|---|---|---|
| `--hotfix` 跳过门禁②并自动批准签字 | `src/cli/commands/core-slice.ts` 的 `run` | 「签字前必须过门禁」这条约束在这条路径上不存在 |
| 没有任何文档说明这条路径 | — | 用的人不知道自己在放弃什么 |
| `slice.hotfix` 不在事件 schema 的 enum 里 | `contracts/schemas/event-envelope.json` | 事件流里出现契约外的类型，校验器不认识它 |
| 负向清单写着「一键批准」不做 | `AGENTS.md#禁区` | 现状与负向清单直接冲突 |

### 2.2 为什么不能简单删掉

「线上出事了，需要立刻把这一处改掉，不想等验收测试跑完」是真实存在的场景。
把这条路径整个删掉，等于逼着人在紧急情况下绕开 zelto 自己去改文件——
那时候连写集约束、越界审计都没有，比现在更糟。

所以：**保留路径，但让放弃约束这件事变成显式的、留痕的**。

---

## 3. 设计

### 3.1 显式确认

```
zelto run <id> --hotfix        → 拒绝执行，提示补 --yes
zelto run <id> --hotfix --yes  → 执行
```

`--yes` 只在 `--hotfix` 存在时才有意义；其他命令不受影响。

拒绝时的输出（文本模式）：

```
zelto run --hotfix 会跳过门禁②（验收测试），并把切片直接置为已签字。
        这等于放弃「签字前必须过门禁」这条约束，所以必须显式确认：
        zelto run <slice-id> --hotfix --yes
```

JSON 模式返回 `{ sliceId, error: 'hotfix requires --yes', message }`，退出码 1。

### 3.2 留痕

hotfix 跑完写一条 `slice.hotfix` 事件（ADR-014 的 C4 要求）：

```json
{
  "type": "slice.hotfix",
  "actor": "zelto",
  "payload": {
    "sliceId": "<id>",
    "elapsed": 42,
    "note": "hotfix — gate skipped, auto-approved"
  }
}
```

事件里记录了「门禁被跳过、签字是自动的」这件事。审计追踪
（`core/audit/trail.ts`）给它一条摘要：

```
Hotfix applied (gate skipped, auto-approved) in 42s: hotfix — gate skipped, auto-approved
```

看审计的人一眼就知道：这次改动**没有经过验收测试**。

### 3.3 仍然生效的约束

hotfix 只跳过**门禁②**。其余约束一条不少：

| 约束 | hotfix 下是否生效 |
|---|---|
| 写集预约（hook 运行时强制，C9） | ✅ 生效 |
| 运行后写集审计 | ✅ 生效——越界照样不进签字流程 |
| 保护域不可写（C5/C8） | ✅ 生效 |
| 事件流留痕（C4） | ✅ 生效，另加 `slice.hotfix` |
| 门禁② 验收测试 | ❌ 跳过——这是 hotfix 的全部含义 |

**hotfix 不是「无约束运行」**，它是「跳过验收测试的受约束运行」。
越界的 hotfix 照样会被审计拦下来。

---

## 4. 契约变更

| 变更 | 位置 | 说明 |
|---|---|---|
| 新增事件类型 `slice.hotfix` | `contracts/schemas/event-envelope.json` 的 enum | 纯追加，不改已有取值。补的是**实现早于契约**的漂移 |
| `zelto run --hotfix` 要求配 `--yes` | `src/cli/commands/core-slice.ts` | 没有 `--yes` 时退出码 1，不执行 |
| `slice.hotfix` 加进事件 schema 的审计摘要 | `src/core/audit/trail.ts` | 补齐后，45 种事件类型全部有摘要，不再退化成 `Event: X` |

改 schema 按 AGENTS.md 的规矩走——这份 ADR 就是那笔账。

---

## 5. 约束合规检查

| 约束 | 检查 | 合规 |
|---|---|---|
| **C1** | 状态只在文件里；hotfix 不引入内存状态或数据库 | ✅ |
| **C3** | hotfix 的判定（有没有 `--yes`）是字符串匹配，不调模型、不触网 | ✅ |
| **C4** | hotfix 写 `slice.hotfix` 事件 | ✅ |
| **C7** | 签字是 zelto 自己批的，不涉及模型产出参与判定 | ✅ |
| **C9** | 写集预约与越界审计在 hotfix 下照常执行（见 §3.3） | ✅ |

---

## 6. 替代方案

### 方案 A：删掉 `--hotfix`

**放弃理由**：见 §2.2。紧急情况下绕开 zelto 反而更不安全。

### 方案 B：交互式确认（`[y/N]`）

**放弃理由**：`zelto run` 可能跑在 CI 或 `--detach` 的后台进程里，没有人应答。
非交互场景下「等确认」等于「永远不跑」。`--yes` 是同一个意思，但是显式且可脚本化。

### 方案 C：让 hotfix 也跑门禁，只是忽略结果

**放弃理由**：那就还是 hotfix 的语义（跳过门禁），但白白付出跑一遍验收测试的时间。

---

## 7. 决定

1. 保留 `zelto run --hotfix <id>`，但**必须**配 `--yes`，否则拒绝执行
2. 拒绝时退出码 1，JSON 模式给出 `hotfix requires --yes`
3. hotfix 跑完写 `slice.hotfix` 事件，并在审计追踪里给出「门禁被跳过」的摘要
4. `slice.hotfix` 补进 `contracts/schemas/event-envelope.json` 的 enum——
   契约追认实现，而不是反过来删实现
5. hotfix 只跳过门禁②；写集预约、越界审计、保护域、事件流全部照常
6. 补齐事件审计摘要后，事件类型与摘要一一对应（45 : 45）
