# Slice: adr-135-incomplete-changeset

## 目的

实施 ADR-135（`docs/adr/adr-135-incomplete-changeset-is-unknown.md`）：
把 ACP 路线的写目标提取从「**找到第一个就返回**」改成
「**读不全就表达为 unknown**」—— 判据不完整时**拒绝**，而不是按残缺判据放行。

## 背景：这一片修的是「判据不完整却按完整判定」

### 现在的洞

```ts
// src/hook/acp.ts:272
function pickPathFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    ...
    if (direct) return direct;      // ← 只取第一个命中的
  }
  return undefined;
}
```

`content` 是**块数组**，一个改动集可以有多个块，块内还能嵌套 `changes[]`
（每个 change 带自己的路径）：

```
content: [
  { type: "diff", path: "src/a.ts", changes: [ ... ] },   ← zelto 只看这块
  { type: "diff", path: "src/d.ts", changes: [ ... ] },   ← 看不见
]
```

**后果**：第一块在写集内、第二块在写集外 → zelto 只看到第一块 → **放行**
→ 实际写了写集外的文件。

而且今天的 `undefined` 把「**没有写目标**」和「**没找到**」混在一起 ——
方向和 ADR-083 §2「不认识 ≠ 放行」相反：**「没找到」被当成了「没有」**。

## 范围

要改的：

- `src/hook/acp.ts` —— 路径提取重写为三态；`copy` / `move` 区分
- `src/hook/pretool.ts` —— `judgeWriteTargets()` 入参接受 `'unknown'` → 拒绝
- `tests/hook/acp.test.ts` —— 三态提取的单测
- `tests/hook/pretool.test.ts` —— `unknown` → 拒绝的用例

只读参考（**不得修改**）：

- 只读 `docs/adr/adr-135-incomplete-changeset-is-unknown.md` —— 本片的规则真源。
- 只读 `src/a.ts` —— 测试里临时造的样例路径（**不是仓库里的文件**，
  只在验收用例里用来演示多块改动集；本片不改它）。
- 只读 `src/d.ts` —— 测试里临时造的样例路径（同上）。

## 需求

- 无（本片没有关联的需求条目；验收口径见下）。

## 验收标准

1. **多块 `content` → 收齐所有路径** ——
   验证方式：单测给两块 `diff`，断言提取结果是**两个**路径（不是第一个）。

2. **第一块在写集内、第二块在写集外 → 拒绝**（**本片的核心用例**）——
   验证方式：单测走完整的 `judgeAcpPermission()`，
   断言 deny。
   > **为什么这条不能省**：这是今天**会放行**的形状 ——
   > 修好了它才说明「收齐了」不只是形式上的。

3. **`content` 里有非 `diff` 块 → `'unknown'` → 拒绝** ——
   验证方式：单测给一个 `{ type: "unknown_block" }`，断言提取结果是 `'unknown'`。

4. **`diff.changes` 存在但不是数组 → `'unknown'`** ——
   验证方式：单测给 `changes: "not-an-array"`，断言 `'unknown'`。

5. **不认识的 `change.operation` → `'unknown'`** ——
   验证方式：单测给 `operation: "frobnicate"`，断言 `'unknown'`。

6. **`move` → 源与目标都算写目标；`copy` → 只有目标算** ——
   验证方式：单测 `operation: "move"` 且 `oldPath` 在写集外 → **拒绝**；
   单测 `operation: "copy"` 且 `oldPath` 在写集外 → 目标在写集内则**放行**。

7. **路径数 > 256 → `'unknown'`** ——
   验证方式：单测构造 257 个路径，断言 `'unknown'`。

8. **「确实没有写目标」与「读不全」必须区分** ——
   验证方式：单测给一个合法的只读调用（`kind: "read"`），
   断言提取结果是 `[]`（**不是** `'unknown'`），
   且判定为放行（只读豁免）。
   > **为什么这条不能省**：`'unknown'` 与 `[]` 混在一起，
   > 会把只读操作全部误拒 —— 那等于把 ACP 路线改废了。

9. **`unknown` 时的 `policy.decision` 事件可审计** ——
   验证方式：断言事件里 `basis === 'acp:incomplete-targets'`，
   且 `reason` 含「读不完整」之类的说明。
   > **为什么这条不能省**：审计不能把「读不全」读成「这次没写东西」——
   > 那会让一次**越界尝试**在追溯链上消失。

10. **`npm test` 全绿、`npm run lint` 通过。**

11. **不越界** —— 改动只在写集内；
    `docs/adr/adr-135-*.md` 的规则正文不得改动。
    验证方式：`git status --porcelain` 断言改动路径全部落在写集内。

## 关键实现要点（规格里已定，实施时不要重新发明）

### 三态的类型形状

```ts
export type AcpChangedPaths = string[] | 'unknown';
```

| 值 | 含义 | 判定内核的反应 |
|---|---|---|
| `['src/a.ts']` | 完整读到，**就这些** | 正常判定 |
| `[]` | 完整读到，**确实没有写目标** | 只读豁免 → 放行 |
| `'unknown'` | **读不全** —— 可能还有别的写目标 | **拒绝** |

### 「读不明白就整体 unknown」，不是「跳过坏块」

跳过 = 把「可能有写目标」当成「没有写目标」。
**C9 要的是 fail closed —— 不确定就拒。**

具体地，下面每一种情况都让整体变成 `'unknown'`：

- `locations` 存在但不是数组；
- `content` 存在但不是数组；
- `content` 里有非 `diff` / 非 `content` / 非 `terminal` 的块；
- `diff.changes` 存在但不是数组；
- `change.operation` 不认识；
- 收集到的路径数 > 256。

### `copy` 与 `move` 的区别

```
operation = "move"  → oldPath 与 path 都算写目标（源被移走 = 源也被改了）
operation = "copy"  → 只有 path 算写目标（源只被读）
```

### `judgeWriteTargets()` 的入参

从 `string[]` 改成 `string[] | 'unknown'`：

- `'unknown'` → 直接返回 deny，
  `basis: 'acp:incomplete-targets'`、`ruleId: 'acp:incomplete-targets'`；
- `string[]` → 现有逻辑**一字不改**。

**为什么不改判定内核的语义**：它的语义是「给定一组写目标，逐个判定」—— 那是对的。
只是**入参**多了一种可能。

## 边界（规格里已定，实施时不要越界）

- **不改** hook 路线（Claude Code / Cursor / Codex）的路径提取 ——
  它们的载荷形状不同，且**判据本身是完整的**
  （`rawInput` 里的路径是 agent 直接给的）。
  但 `judgeWriteTargets()` 的**入参类型**是共用的，改签名会波及共用签名
  （这是类型层面的，不改共用路线的**行为**）。
- **不改**事件流格式（C4）—— 只在 `unknown` 时用新的 `basis` 值。
- **不动** `core/`（C2 保持）。
- **不引入**第三方依赖。
