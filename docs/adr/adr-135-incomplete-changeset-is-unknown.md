# ADR-135：读不全的改动集必须表达为「unknown」，不得当作「读全了」

**状态**：已决（2026-11-27）· 待落地
**日期**：2026-11-27
**相关**：ADR-133（ACP 执行器）、ADR-083（多 harness 判定内核）、C3/C9

**背景来源**：ADR-133 补记的「T3 值得学的三处」第二条。

## 背景

C9 的 fail closed 有一个前提：**判定内核知道 agent 到底要改哪些文件**。
判据不完整 → 判定结论不可信 → 必须拒绝。

zelto 现在的 ACP 路径提取是**「找到第一个就返回」**：

```ts
// src/hook/acp.ts:272
function pickPathFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const direct = pickPath(block as Record<string, unknown>);
    if (direct) return direct;      // ← 只取第一个命中的
  }
  return undefined;
}
```

**问题**：`content` 是一个**块数组**，而一个改动集可以有多个块，
且块内还可以嵌套 `changes[]`（每个 change 带自己的路径）。

`content` 的实际形状（ACP 规范 + 各家 agent 的实际用法）：

```
content: [
  { type: "diff", path: "src/a.ts", changes: [
      { operation: "modify", path: "src/a.ts" },
      { operation: "move",   path: "src/b.ts", oldPath: "src/c.ts" },
  ]},
  { type: "diff", path: "src/d.ts", changes: [ ... ] },   ← 第二块，zelto 看不见
]
```

zelto 只取**第一块**的第一个路径。**其余的写目标就消失了** ——
判据是**不完整**的，但判定内核以为它完整，于是按一个**残缺的目标集**做放行判断。

**更糟的情况**：第一块恰好在写集内、第二块在写集外 →
zelto 只看到第一块 → **放行** → 实际写了写集外的文件。

### 参照实现：T3 Code 的三态建模

T3（`pingdotgg/t3code`，MIT）的
`packages/provider-acp/src/server/clientPolicy.ts` 把结果建模成**三态**
而不是「数组或空」：

```ts
/**
 * Every path a file change touches, each exactly as the agent sent it, or "unknown" when any
 * part of the change could not be read. An unknown change is never approved by a folder check.
 */
export type AcpChangedPaths = ReadonlyArray<string> | "unknown";
```

核心函数 `acpChangedPathsOfToolCall()` 的做法：

1. **收齐所有来源**（不是第一个）：
   - `locations[].path`
   - `content[].diff.path`
   - `content[].diff.changes[].path`
   - `content[].diff.changes[].oldPath`（`move` 的源）
   - `rawInput` 的路径键（`path` / `filePath` / `file_path`）
2. **任何一块读不明白 → 整体变 `"unknown"`**（不是「跳过那一块」）：
   - `locations` 不是数组 → unknown
   - `content` 不是数组 → unknown
   - `content` 里有非 `diff` / 非 `content` / 非 `terminal` 的块 → unknown
   - `diff.changes` 不是数组 → unknown
   - `change.operation` 不认识 → unknown
3. **数量上限**：`MAX_ACP_CHANGED_PATHS = 256`，超过 → unknown
4. **合并传播**：

```ts
export function mergeAcpChangedPaths(left, right) {
  if (left === "unknown" || right === "unknown") return "unknown";
  ...
}
```

**那句话是整段设计的题眼**：

> An unknown change is never approved by a folder check.

—— 「读不全的改动集**永远不许**被目录检查放行」。

### `copy` 与 `move` 的区别

T3 对 `change.operation` 的处理有一处细节值得学：

```ts
case "move":
  requirePath(change.oldPath);   // 源
  requirePath(change.path);      // 目标
  break;
case "add":
case "delete":
case "modify":
// A copy only reads its source.
case "copy":
  requirePath(change.path);      // 源不算是写目标
  break;
default:
  // An operation this client does not know may write where its fields do not show.
  complete = false;
```

- **`move`**：**两个**路径都算写目标（源被移走 = 源也被改了）；
- **`copy`**：**只有目标**算写目标，**源只读**；
- **不认识的 operation**：→ unknown（不能假设它只读）。

## 决策

### 决策一：路径提取的结果类型改成三态

`src/hook/acp.ts` 的路径提取不再返回 `string | undefined`，改成：

```ts
export type AcpChangedPaths = string[] | 'unknown';
```

**语义**：

| 值 | 含义 | 判定内核的反应 |
|---|---|---|
| `['src/a.ts']` | 完整读到了，**就这些** | 正常判定 |
| `[]` | 完整读到了，**确实没有写目标** | 只读操作 → 放行 |
| `'unknown'` | **读不全** —— 可能还有别的写目标 | **拒绝**（fail closed） |

**关键**：`'unknown'` 与 `[]` **必须区分**。
今天 zelto 的 `undefined` 把「没有写目标」和「没找到」混在一起 ——
这是 ADR-083 §2「不认识 ≠ 放行」的同形状问题，
但方向相反：**「没找到」被当成了「没有」**。

### 决策二：**每一块都读**，且读不明白就整体 unknown

提取函数（重写 `pickPathFromContent()`）必须：

1. 遍历**全部** `content` 块，收集**所有**路径；
2. `locations` / `content` 不是数组 → `'unknown'`；
3. `content` 里有非 `diff` 类型的块 → `'unknown'`
   （`content` / `terminal` 除外 —— 它们不含路径）；
4. `diff.changes` 存在但不是数组 → `'unknown'`；
5. `change.operation` 不认识 → `'unknown'`；
6. 路径总数 > 256 → `'unknown'`。

**为什么整体 unknown 而不是「跳过坏块」**：跳过 = 把「可能有写目标」当成「没有写目标」。
C9 要的是 fail closed —— **不确定就拒**。

### 决策三：`copy` 的源路径**不算**写目标，`move` 的源路径**算**

- `move`：源被移走 = 源也被改了 → 源 + 目标**都**算写目标；
- `copy`：源只被读 → **只有目标**算写目标。

这与 zelto 现有语义一致（`Write` 的写目标提取），
但 ACP 之前根本没走到这一步（只取第一个块）。

### 决策四：判定内核接受三态

`judgeWriteTargets()` 的入参从 `string[]` 改成接受 `string[] | 'unknown'`：

- `'unknown'` → 直接返回 **deny**，`basis: 'acp:incomplete-targets'`，
  `ruleId: 'acp:incomplete-targets'`，
  reason 明确写「改动集读不完整，无法确认写入范围，默认拒绝」；
- `string[]` → 现有逻辑不变。

**为什么不改 `judgeWriteTargets()` 的语义**：它的语义是「给定一组写目标，
逐个判定」—— 那是对的，不用改。只是**入参**多了一种可能。

### 决策五：事件流记录 `unknown`

`policy.decision` 事件（ADR-083 §6 的字段）里，
`targets` 字段在 `unknown` 时记 `[]`，
`basis` 记 `'acp:incomplete-targets'`，
`reason` 里写明「读不完整」——
**不能**让审计看到「没有目标」（那会被读成「这次没写东西」）。

## 被否决的方案

1. **只收齐所有块、读不明白的块跳过**：
   那正是今天的洞 —— 「跳过」= 把不确定当成不存在。
   C9 的 fail closed 要求「不确定」直接升级成「拒绝」。
2. **保留 `undefined` 但加一个 `complete: boolean` 标志**：
   两个字段可以表达同样的三态，但**状态机更长**（每个返回点都要记得设标志）。
   一个三态联合类型让「漏了就当没有」在**类型上**不可能发生。
3. **给 unknown 加「尽力而为」的放行**：
   「读不全但看起来都在写集内 → 放行」—— 这是把 fail closed 换成 fail open。
   不可接受。
4. **把 `MAX_ACP_CHANGED_PATHS` 提到很大**：
   数量上限只是**兜底**（防 DoS），不是主要防线。
   真正要防的是「读不全」，那靠 unknown 传播，不靠上限。

## 影响面

| 文件 | 改动 |
|---|---|
| `src/hook/acp.ts` | 路径提取重写为三态；`copy`/`move` 区分 |
| `src/hook/pretool.ts` | `judgeWriteTargets()` 入参接受 `'unknown'` → 拒绝 |
| `tests/hook/acp.test.ts` | 三态提取的单测（多块 / 坏块 / copy / move / 超限） |
| `tests/hook/pretool.test.ts` | `unknown` → 拒绝的用例 |

**不涉及**：hook 路线（Claude Code / Cursor / Codex）的路径提取 —— 它们的载荷形状
不同，且**判据本身是完整的**（`rawInput` 里的路径是 agent 直接给的）。
本 ADR 只动 ACP 路线 —— 但 `judgeWriteTargets()` 的入参类型是共用的，
所以改动会**波及**共用签名（这是类型层面的，不改共用路线的行为）。

## 验收标准

1. 多块 `content`（两块以上）→ **所有**路径都被收集，不再只取第一块；
2. 第一块在写集内、第二块在写集外 → **拒绝**（今天会放行 —— 这是核心用例）；
3. `content` 里有非 `diff` 块 → `'unknown'` → 拒绝；
4. `diff.changes` 不是数组 → `'unknown'` → 拒绝；
5. 不认识的 `change.operation` → `'unknown'` → 拒绝；
6. `move` → 源与目标**都**算写目标；`copy` → **只有**目标算；
7. 路径数 > 256 → `'unknown'` → 拒绝；
8. 完整读到、确实没有写目标 → `[]` → 只读放行（**与 unknown 区分**）；
9. `unknown` 时的 `policy.decision` 事件：`basis: 'acp:incomplete-targets'`，
   reason 说明「读不完整」（审计不能读成「没写东西」）。
