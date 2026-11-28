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
- `src/hook/pretool.ts` —— **判定内核**加形状闸门：形状非法的写目标 → 拒绝
    （`hook:malformed-path`）。三条路线共用这一处
- `src/hook/acp.ts` —— 每个路径来源过形状判据；形状非法 → unknown
- `tests/hook/paths.test.ts`（**新增**，若 ADR-134 那片已建则并入同一文件）

**不改** `src/hook/harness.ts` —— 提取层过滤会制造绕过（见下「一个实测纠正的前提」）。

只读参考（**不得修改**）：

- 只读 `docs/adr/adr-136-checkable-path-shape.md` —— 本片的规则真源。
- 只读 `src/a.ts` —— 测试里临时造的样例路径（**不是仓库里的文件**，
  只在验收用例里用来演示正常相对路径；本片不改它）。
- 只读 `AGENTS.md` —— 项目约定（**不是仓库里待改的文件**；
  本片引用它是为了说明「规格里没写的行为要停下来问」这条纪律）。
- 只读 `tests/hook/pretool.test.ts` —— 既有 hook 判定单测
  （**本片不改它**；引用它是为了说明「空目标是放行」这条既有行为）。

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

9. **判定内核的形状闸门（hook 路线共用）** ——
   验证方式：单测走 `judgeWriteTargets()`，给一个形状非法的写目标，
   断言**拒绝**且 `basis === 'hook:malformed-path'`。
   > **为什么这条不能省**：这是本片**唯一**能让三条 hook 路线
   > 都堵上洞的地方。提取层不给判定内核足够的信息
   > （ACP 能分辨「字段不存在」与「字段畸形」，hook 路线不能）。

10. **宽写集不放松** ——
    验证方式：单测写集给 `**`，写目标给 `file:///etc/passwd`，断言**拒绝**。
    > **为什么这条不能省**：实测（2026-11-27）—— 不加形状闸门时，
    > `file:///etc/passwd` 归一化成 `<worktree>/file:/etc/passwd`
    > 落在写集内 → **放行**。agent 真的写到 `/etc/passwd`。
    > 窄写集（`src/**`）下它被写集检查挡住，所以只测窄写集会漏掉这个洞。

11. **`npm test` 全绿、`npm run lint` 通过。**

12. **不越界** —— 改动只在写集内；
    `docs/adr/adr-136-*.md` 的规则正文不得改动。
    验证方式：`git status --porcelain` 断言改动路径全部落在写集内。

## 一个实测纠正的前提（实施时不要按直觉走）

规格初稿里写过一句：

> hook 路线判不出写目标时本来就是**拒绝**（ADR-083 §2）

**这句话是错的**（实测 2026-11-27）：`judgeWriteTargets([])` 返回
`{ decision: 'allow', basis: 'hook:no-target' }` —— **空目标是放行**，
不是拒绝（既有测试 只读 `tests/hook/pretool.test.ts`
「allows when there are no targets to judge」断言了这个行为）。

所以「在提取层把形状非法的值过滤掉」会**制造一个新的绕过**：

```
Write 的 file_path = "file:///etc/passwd"
  → 提取层过滤掉（形状非法）
  → 提取结果 = []
  → judgeWriteTargets([]) = allow      ← 放行！
```

**这正是本片要堵的洞，被「过滤」这个动作亲手放开了。**
静默过滤 = 把「可能有写目标」当成「没有写目标」。

**结论**：形状闸门放在**判定内核**（`judgeWriteTargets()`），
不在各路线的提取层。提取层（ACP）可以更早发现形状非法并报 `unknown`，
但那不是**唯一**的闸门。


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

### 形状判据的位置：**判定内核的入口**

```
agent 给的原始值
  -> 提取（rawInput / content / locations / title）
  -> 形状判据（isCheckablePath）    ← 不通过 = 不是路径 → 拒绝
  -> 归一化（relativizeTarget，词法）
  -> canonical 化（ADR-134）
  -> 判定（保护域 / 写集 / 逃逸）
```

**为什么在提取之后、归一化之前**：它回答「**这是不是一条路径**」，
归一化回答「**这条路径在哪**」。顺序反了就会出现「把 `file:///etc/passwd`
归一化成 `<worktree>/file:/etc/passwd` 再判它安不安全」。

**为什么闸门在判定内核**（而不是提取层）：见上面「一个实测纠正的前提」——
提取层过滤掉畸形值 = 空目标 = **放行**。判定内核是所有路线
唯一共用的收口点（`judgeAcpPermission()` 与 `runPreTool()` 都调它）。

### 形状不通过 ≠ 判定通过

**这是本片最容易做错的地方。**

形状不通过时**不是**「这个路径安全，放行」——
它必须**拒绝**，并让事件里能看出**为什么**：

- **判定内核**（三条路线共用）：形状非法的写目标 → **拒绝**，
  `basis: 'hook:malformed-path'`，reason 写明是哪一条形状规则不通过。
- **ACP 提取层**（更早发现）：值**存在**但**形状不对** →
  `'unknown'`（ADR-135 的三态）→ 拒绝；
  值**根本不存在**（字段没有）→ 这才是「没有写目标」→ `[]`。

**为什么 ACP 用 `unknown` 而内核用 `malformed-path`**：
`'unknown'` 的语义是「**读不全** —— 可能还有别的写目标」；
形状非法是「**读到了**，但它不是路径」。两者都拒绝，但**理由不同**，
事件里要能区分 —— 否则事后审计分不清「载荷读不出来」（适配器问题）
与「载荷里有畸形路径」（更可能是**故意试探**）。

### 为什么不自己做 tilde 展开 / URL 解析

zelto 不替 agent 猜它的意图。`~` 的展开规则、URL 的语义都不是 zelto 说了算的
（AGENTS.md：「规格里没写的行为 → 停下来问，不许按『更合理』的直觉补全」）。
猜错了 = 判错文件 = 越界。

### 共用，不各写一遍

`isCheckablePath()` 放 `src/hook/paths.ts` —— **判定内核**用它，
**只有一处实现**（不在别处重复实现同一套规则）。

提取层（ACP 的 `pickPathChecked()`）也用它，但那是**上游更严格**，
不是第二份实现 —— 它调用同一个函数。

## 边界（规格里已定，实施时不要越界）

- **不改**保护域清单（ADR-083）；
- **不改**写集匹配规则；
- **不改**事件流格式（C4）；
- **不动** `core/`（C2 保持）；
- **不引入**第三方依赖（只用 Node 内置）。
