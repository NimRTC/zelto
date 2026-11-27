# Slice: adr-136-checkable-path-shape

## 目的

实施 ADR-136（`docs/adr/adr-136-checkable-path-shape.md`）：
给路径加一道**形状判据** —— 不是路径的东西（空串 / NUL 字节 / `~` 开头 /
URL scheme / POSIX 上的反斜杠）**不许进入判定流程**。

形状非法的值**不许被静默忽略**成「没有写目标」——
那等于让 agent 用一个畸形路径骗过判定。

## 背景：这一片修的是「判定的对象不是 agent 真正会写的那个文件」

### 现在的洞

```ts
// src/hook/acp.ts:158
if (typeof v === 'string' && v) return v;    // ← 只看「是不是非空字符串」
```

**只检查「是不是非空字符串」，不检查「它是不是一个路径」。**

于是这些值会被当成路径塞进判定流程：

| 值 | 实际是什么 | 词法归一化后的下场 |
|---|---|---|
| `file:///etc/passwd` | URL | 变成 `<worktree>/file:/etc/passwd` → **落在 worktree 内、可能落在写集内 → 放行** |
| `~/../../etc/passwd` | agent 的 home 展开 | `~` 被当普通目录名 |
| `C:\Windows\x` | Windows 盘符路径 | 在 POSIX 上被当相对路径 |
| `a\0b` | 含 NUL 字节 | `fs` 调用抛 `ERR_INVALID_ARG_VALUE` → **判定层崩掉** |

**两个具体后果**：

1. **判定结果取决于归一化技巧**，而不是「这个值根本不是合法路径」。
   `file:///etc/passwd` 会被归一化成 worktree 内的路径 → 放行 ——
   而 agent 真正要写的是 `/etc/passwd`。
2. **NUL 字节让判定流程抛异常**（ADR-134 引入的 realpath 会撞上这个）——
   崩掉，而不是 fail closed。

### 一条规则的根据（T3 的原话）

> may mean another file to the agent than it does when joined to the working directory

—— 「**对 agent 来说可能指另一个文件**，比拼起来之后指的文件不同」。
判定的对象必须是「agent 真正会写的那个文件」，而不是「一个我们能归一化的字符串」。

## 范围

要改的：

- `src/hook/paths.ts`（**新增**，若 ADR-134 那片已建则并入同一文件）—— `isCheckablePath()`
- `src/hook/acp.ts` —— 每个路径来源过形状判据；形状非法 → unknown
- `src/hook/harness.ts` —— `pickPath()` 同样过形状判据（三条 hook 路线共用）
- `tests/hook/paths.test.ts`（**新增**，若 ADR-134 那片已建则并入同一文件）

只读参考（**不得修改**）：

- 只读 `docs/adr/adr-136-checkable-path-shape.md` —— 本片的规则真源。

## 需求

- 无（本片没有关联的需求条目；验收口径见下）。

## 验收标准

1. **`~/../../etc/passwd` → 不是路径** ——
   验证方式：单测 `isCheckablePath('~/../../etc/passwd') === false`；
   且走完整判定时**拒绝**（不是「没有写目标」）。

2. **`file:///etc/passwd` → 不是路径** ——
   验证方式：单测断言 false；走完整判定时**拒绝**。

3. **含 `\0` 的值 → 不是路径，且判定流程不抛异常** ——
   验证方式：单测构造含 NUL 的路径，断言 `isCheckablePath()` 为 false，
   且整个判定调用**正常返回**（不抛）。
   > **为什么这条不能省**：这是**崩溃**风险 ——
   > ADR-134 的 realpath 遇到 NUL 会抛 `ERR_INVALID_ARG_VALUE`。
   > 只测「返回 false」不够，要测「整条流程不崩」。

4. **纯空白 / 空串 → 不是路径** ——
   验证方式：单测断言 `'   '` 与 `''` 都为 false。

5. **Windows 盘符 `C:\foo\bar`（在 Windows 上）→ 是路径** ——
   验证方式：单测在 Windows 上断言 `isCheckablePath('C:\\foo\\bar') === true`。
   > **为什么这条不能省**：zelto 是**跨平台**的。T3 的规则把盘符也拒了
   > （它只跑 POSIX），zelto **不能**照抄 —— 否则 Windows 上所有绝对路径
   > 都会被当成「不是路径」。

6. **POSIX 主机上的 `a\b` → 不是路径** ——
   验证方式：单测在 POSIX 上断言 false（Windows 上允许）。

7. **正常相对路径 / 绝对路径 → 是路径，行为不变** ——
   验证方式：单测断言 `isCheckablePath('src/a.ts') === true`；
   且现有 hook 单测全绿。

8. **形状非法的值不能被静默忽略** ——
   验证方式：单测走 ACP 完整判定，给一个形状非法的路径，
   断言结果是 **`'unknown'`**（ADR-135 的三态），**不是** `[]`。
   > **为什么这条不能省**：静默忽略 = 把「可能有写目标」当成「没有写目标」。
   > agent 故意传 `file:///etc/passwd` 就能骗过判定。
   > 这正是 ADR-083 §2「不认识 ≠ 放行」。

9. **三条 hook 路线共用同一判据** ——
   验证方式：断言 `src/hook/harness.ts` 的 `pickPath()` 也调用了
   `isCheckablePath()`；且断言 `src/hook/paths.ts` 只有**一处**实现
   （不在别处重复实现同一套规则）。

10. **`npm test` 全绿、`npm run lint` 通过。**

11. **不越界** —— 改动只在写集内；
    `docs/adr/adr-136-*.md` 的规则正文不得改动。
    验证方式：`git status --porcelain` 断言改动路径全部落在写集内。

## 关键实现要点（规格里已定，实施时不要重新发明）

### 形状判据的规则

```
不是路径，当且仅当：
  1. 不是字符串                        -> 不是路径
  2. trim 后为空                        -> 不是路径
  3. 含 NUL 字节（\0）                  -> 不是路径
  4. 以 '~' 开头                        -> 不是路径（展开规则猜不出）
  5. 含 URL scheme（^[A-Za-z][A-Za-z0-9+.-]*:）且不是 Windows 盘符 -> 不是路径
  6. 在 POSIX 主机上含反斜杠             -> 不是路径
```

**第 5 条要排除盘符**：`^[A-Za-z]:[\\/]` 是 Windows 盘符形态，是**正常路径**。
zelto 跨平台，不能照抄 T3（它只跑 POSIX）。

### 形状判据的位置：最前面

```
agent 给的原始值
  -> 形状判据（isCheckablePath）    ← 不通过 = 不是路径，出局
  -> 提取（rawInput / content / locations / title）
  -> 归一化（relativizeTarget，词法）
  -> canonical 化（ADR-134）
  -> 判定（保护域 / 写集 / 逃逸）
```

**为什么在最前面**：它回答「**这是不是一条路径**」，
后面的步骤回答「**这条路径在哪**」。
顺序反了就会出现「把 `file:///etc/passwd` 归一化成
`<worktree>/file:/etc/passwd` 再判它安不安全」。

### 形状不通过 ≠ 判定通过

**这是本片最容易做错的地方。**

形状不通过时**不是**「这个路径安全，放行」，**也不是**「立刻拒绝」，
而是：**这个来源不提供可用的写目标**。

但它**必须上报为 `unknown`**（ADR-135 的三态），而不是静默变成 `undefined`：

- 值**存在**但**形状不对** → 形状非法的写目标 → **`'unknown'`** → 拒绝；
- 值**根本不存在**（字段没有）→ 这才是「没有写目标」→ `[]`。

### 为什么不自己做 tilde 展开 / URL 解析

zelto 不替 agent 猜它的意图。`~` 的展开规则、URL 的语义都不是 zelto 说了算的
（AGENTS.md：「规格里没写的行为 → 停下来问，不许按『更合理』的直觉补全」）。
猜错了 = 判错文件 = 越界。

### 共用，不各写一遍

`isCheckablePath()` 放 `src/hook/paths.ts`，**三条 hook 路线共用**。
`harness.ts` 的 `pickPath()` 也是「取第一个非空字符串」，同样不过滤 ——
**修一条漏两条**不可接受。

**但注意**：hook 路线上「形状不通过」的后果与 ACP 不同 ——
hook 路线判不出写目标时本来就是**拒绝**（ADR-083 §2），
所以那里**不需要** ADR-135 的三态，只需要**把形状过滤加上**。

## 边界（规格里已定，实施时不要越界）

- **不改**保护域清单（ADR-083）；
- **不改**写集匹配规则；
- **不改**事件流格式（C4）；
- **不动** `core/`（C2 保持）；
- **不引入**第三方依赖（只用 Node 内置）。
